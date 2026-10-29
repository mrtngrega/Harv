//! Starting, stopping and talking to Harv (the server on :4317 and the dashboard on :5173).
//! The app runs the same scripts as the old desktop shortcuts (scripts/harv.ps1, harv.sh), so
//! there's one tested way to start and stop Harv, and Harv's own Restart button keeps working.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Url};

pub const DASHBOARD: &str = "http://127.0.0.1:5173";
const SERVER_PORT: u16 = 4317;
const DASHBOARD_PORT: u16 = 5173;

/// The Harv repo: the app is built from it and runs Harv from it (HARV_REPO overrides).
pub fn repo() -> PathBuf {
    if let Some(dir) = std::env::var_os("HARV_REPO") {
        return PathBuf::from(dir);
    }
    // apps/desktop/src-tauri → the repo root.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("repo root")
        .to_path_buf()
}

/// ~/.harv (HARV_HOME overrides), like the server's paths.ts.
pub fn harv_home() -> PathBuf {
    if let Some(dir) = std::env::var_os("HARV_HOME") {
        return PathBuf::from(dir);
    }
    let home =
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    PathBuf::from(home).join(".harv")
}

/// One line in ~/.harv/logs/app.log: what the app did when starting, stopping or updating Harv.
pub fn log(text: &str) {
    use std::io::Write as _;
    let dir = harv_home().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("app.log"))
    {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "{secs} {text}");
    }
}

/// A command with no console window on Windows, and the per-user Node on the PATH on Linux
/// (an app started from the menu doesn't get ~/.bashrc's PATH).
pub fn command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env(
            "PATH",
            format!("{home}/.local/opt/node/bin:{home}/.local/bin:{path}"),
        );
    }
    cmd
}

/// Runs scripts/harv.ps1 (Windows) or harv.sh (Linux) with start, stop or restart, never opening a browser.
/// Waits for it to finish (start waits until Harv answers).
pub fn script(action: &str) -> bool {
    let scripts = repo().join("scripts");
    let mut cmd = if cfg!(windows) {
        let mut c = command("powershell.exe");
        c.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
        ])
        .arg(scripts.join("harv.ps1"))
        .args(["-Action", action, "-NoBrowser"]);
        c
    } else {
        let mut c = command("bash");
        c.arg(scripts.join("harv.sh"))
            .args([action, "--no-browser"]);
        c
    };
    let ok = cmd
        .current_dir(repo())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    log(&format!("{action}: {}", if ok { "done" } else { "failed" }));
    ok
}

/// A tiny HTTP request to Harv on localhost; the status code, or None if nothing answered.
/// Sends the dashboard's Origin, which the server requires.
pub fn http(method: &str, port: u16, path: &str) -> Option<u16> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let body = if method == "POST" { "{}" } else { "" };
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: {DASHBOARD}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut head = [0u8; 64];
    let n = stream.read(&mut head).ok()?;
    // "HTTP/1.1 200 OK"
    std::str::from_utf8(&head[..n])
        .ok()?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

pub fn is_up() -> bool {
    http("GET", SERVER_PORT, "/api/health") == Some(200)
        && http("GET", DASHBOARD_PORT, "/") == Some(200)
}

/// Starts LibreHardwareMonitor through Harv (Windows asks for permission).
pub fn start_sensors() {
    http("POST", SERVER_PORT, "/api/sensors/start");
}

/// Starts Harv unless it's already running, then moves the window from the starting page to the dashboard.
pub fn boot(app: AppHandle) {
    std::thread::spawn(move || {
        if is_up() {
            log("Harv was already running");
        } else {
            script("start");
        }
        let deadline = Instant::now() + Duration::from_secs(120);
        while !is_up() {
            if Instant::now() > deadline {
                let harv_log = harv_home().join("logs").join("harv.log");
                let text = format!("Harv didn't start. See {}", harv_log.display())
                    .replace('\\', "\\\\")
                    .replace('\'', "\\'");
                if let Some(window) = app.get_webview("main") {
                    let _ =
                        window.eval(format!("window.harvFailed && window.harvFailed('{text}')"));
                }
                log("Harv didn't start in 2 minutes");
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        if let Some(window) = app.get_webview("main") {
            log("showing the dashboard");
            let _ = window.navigate(Url::parse(DASHBOARD).expect("dashboard url"));
        }
        keep_dashboard(&app);
    });
}

/// The window must stay on the dashboard: a page reload (WebKit restarting it, Harv restarting
/// while it loaded) can leave it on the starting page or a failed load. While Harv is up, the
/// window goes back to the dashboard by itself (twice on the notebook, 2026-10-29).
fn keep_dashboard(app: &AppHandle) {
    loop {
        std::thread::sleep(Duration::from_secs(5));
        if !is_up() {
            continue;
        }
        let Some(window) = app.get_webview("main") else {
            continue;
        };
        let on_dashboard = window
            .url()
            .map(|u| u.port() == Some(DASHBOARD_PORT))
            .unwrap_or(false);
        if !on_dashboard {
            log("the window left the dashboard: showing it again");
            let _ = window.navigate(Url::parse(DASHBOARD).expect("dashboard url"));
        } else {
            // A failed load keeps the address but has no dashboard in it.
            let _ = window.eval(format!(
                "if (!document.getElementById('root')) location.replace('{DASHBOARD}')"
            ));
        }
    }
}

/// Restarts Harv in the background; the dashboard reconnects by itself.
pub fn restart() {
    std::thread::spawn(|| {
        script("restart");
    });
}

/// Stops Harv cleanly, then closes the app.
pub fn quit(app: &AppHandle) {
    if let Some(window) = app.get_window("main") {
        let _ = window.hide();
    }
    let app = app.clone();
    std::thread::spawn(move || {
        script("stop");
        app.exit(0);
    });
}
