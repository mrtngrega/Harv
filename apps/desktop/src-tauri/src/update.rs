//! Updates: Harv runs from its git repo, so an update is a `git pull` and a restart. The app checks
//! now and then and says how far behind it is; it pulls only when asked, and never over local changes.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::harv::{command, repo, script};
use crate::notify;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// New commits on the remote that this copy doesn't have.
    pub behind: u32,
    /// Uncommitted changes (an update would wait for them).
    pub dirty: bool,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct Updates(pub Mutex<UpdateInfo>);

const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

fn git(args: &[&str]) -> Result<String, String> {
    let out = command("git")
        .arg("-C")
        .arg(repo())
        .args(args)
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn check(app: &AppHandle) -> UpdateInfo {
    let info = match git(&["fetch", "--quiet"]) {
        Err(e) => UpdateInfo {
            error: Some(format!("Couldn't check: {e}")),
            ..Default::default()
        },
        Ok(_) => UpdateInfo {
            behind: git(&["rev-list", "--count", "HEAD..@{u}"])
                .ok()
                .and_then(|n| n.parse().ok())
                .unwrap_or(0),
            dirty: git(&["status", "--porcelain", "--untracked-files=no"])
                .map(|s| !s.is_empty())
                .unwrap_or(false),
            error: None,
        },
    };
    let old = std::mem::replace(&mut *app.state::<Updates>().0.lock().unwrap(), info.clone());
    crate::tray::show_updates(app, info.behind);
    if info.behind > old.behind {
        notify::show(
            app,
            "Harv has an update",
            &format!(
                "{} new change(s). Open the tray menu or Settings › App to update.",
                info.behind
            ),
        );
    }
    info
}

/// Pulls the new commits (fast-forward only), installs packages if they changed, and restarts Harv.
pub fn apply(app: &AppHandle) -> Result<UpdateInfo, String> {
    let info = check(app);
    if info.dirty {
        return Err("Harv's folder has uncommitted changes, so the update waits (commit or discard them first).".into());
    }
    if info.behind == 0 {
        return Ok(info);
    }
    let before = git(&["rev-parse", "HEAD"])?;
    git(&["pull", "--ff-only", "--quiet"]).map_err(|e| format!("The update didn't apply: {e}"))?;
    let changed = git(&["diff", "--name-only", &before, "HEAD"])?;
    if changed.lines().any(|f| f == "package-lock.json") {
        let mut npm = if cfg!(windows) {
            let mut c = command("cmd.exe");
            c.args(["/c", "npm", "install", "--no-audit", "--no-fund"]);
            c
        } else {
            let mut c = command("npm");
            c.args(["install", "--no-audit", "--no-fund"]);
            c
        };
        let ok = npm
            .current_dir(repo())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            return Err(
                "The update was pulled, but npm install failed. Run it in Harv's folder.".into(),
            );
        }
    }
    if changed.lines().any(|f| f.starts_with("apps/desktop/")) {
        notify::show(
            app,
            "Harv updated",
            "The app itself changed too: rebuild it with npm run app to get that part.",
        );
    }
    script("restart");
    Ok(check(app))
}

/// A first check a minute after start, then every 6 hours.
pub fn schedule(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        loop {
            check(&app);
            std::thread::sleep(EVERY);
        }
    });
}
