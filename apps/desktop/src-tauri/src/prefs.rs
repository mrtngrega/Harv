//! The app's own settings, kept on this device in ~/.harv/app.json (not synced): the hotkey that
//! brings Harv up, and whether Harv opens at login (stored by the OS, read back from it).

use std::str::FromStr;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::harv::harv_home;

pub const DEFAULT_HOTKEY: &str = "Ctrl+Alt+H";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Saved {
    hotkey: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub hotkey: String,
    pub autostart: bool,
    /// False on Wayland, where apps can't grab a global hotkey (KDE's shortcut runs `harv` instead).
    pub hotkey_works: bool,
    pub version: String,
}

fn file() -> std::path::PathBuf {
    harv_home().join("app.json")
}

fn saved_hotkey() -> String {
    std::fs::read_to_string(file())
        .ok()
        .and_then(|text| serde_json::from_str::<Saved>(&text).ok())
        .map(|s| s.hotkey)
        .filter(|h| Shortcut::from_str(h).is_ok())
        .unwrap_or_else(|| DEFAULT_HOTKEY.to_string())
}

pub fn hotkey_works() -> bool {
    !(cfg!(target_os = "linux") && std::env::var("XDG_SESSION_TYPE").is_ok_and(|s| s == "wayland"))
}

/// Registers the hotkey (replacing the old one); an error names a combination taken by another program.
fn register(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let shortcut =
        Shortcut::from_str(hotkey).map_err(|_| format!("{hotkey} isn't a key combination"))?;
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    if hotkey_works() {
        shortcuts
            .register(shortcut)
            .map_err(|_| format!("{hotkey} is taken by another program"))?;
    }
    Ok(())
}

pub fn apply_saved(app: &AppHandle) {
    let _ = register(app, &saved_hotkey());
}

pub fn current(app: &AppHandle) -> AppSettings {
    AppSettings {
        hotkey: saved_hotkey(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        hotkey_works: hotkey_works(),
        version: app.package_info().version.to_string(),
    }
}

pub fn set(
    app: &AppHandle,
    hotkey: Option<String>,
    autostart: Option<bool>,
) -> Result<AppSettings, String> {
    if let Some(hotkey) = hotkey {
        let old = saved_hotkey();
        if let Err(e) = register(app, &hotkey) {
            let _ = register(app, &old);
            return Err(e);
        }
        std::fs::create_dir_all(harv_home()).map_err(|e| e.to_string())?;
        let text = serde_json::to_string_pretty(&Saved { hotkey }).map_err(|e| e.to_string())?;
        std::fs::write(file(), text).map_err(|e| e.to_string())?;
    }
    if let Some(on) = autostart {
        let launch = app.autolaunch();
        let result = if on {
            launch.enable()
        } else {
            launch.disable()
        };
        result.map_err(|e| format!("Couldn't change autostart: {e}"))?;
    }
    Ok(current(app))
}
