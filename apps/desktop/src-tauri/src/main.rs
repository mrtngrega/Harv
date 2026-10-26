//! Harv's desktop app: a frameless window around the dashboard, a tray icon with Harv's status,
//! a hotkey to bring it up, notifications, autostart and updates. Harv itself (server and
//! dashboard) still runs from the repo; the app starts it, shows it and stops it. docs/PLAN.md §6p.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod harv;
mod notify;
mod prefs;
mod tray;
mod update;

use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_window_state::StateFlags;

/// Brings the window to the front with the cursor in the `harv>` line.
pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.eval("window.dispatchEvent(new Event('harv-focus'))");
    }
}

/// The hotkey: up if it's hidden or behind other windows, away if it's in front.
fn toggle(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let front = window.is_visible().unwrap_or(false)
            && !window.is_minimized().unwrap_or(false)
            && window.is_focused().unwrap_or(false);
        if front {
            let _ = window.hide();
        } else {
            show(app);
        }
    }
}

/// The dashboard's own title bar: drag, minimize, maximize, and × (which hides to the tray).
#[tauri::command]
fn window_action(window: WebviewWindow, action: &str) {
    let _ = match action {
        "drag" => window.start_dragging(),
        "minimize" => window.minimize(),
        "maximize" => match window.is_maximized() {
            Ok(true) => window.unmaximize(),
            _ => window.maximize(),
        },
        "close" => window.hide(),
        _ => Ok(()),
    };
}

/// Harv's status (idle, thinking, working, waiting, paused, offline) for the tray icon.
#[tauri::command]
fn set_status(app: AppHandle, status: &str) {
    static FIRST: std::sync::Once = std::sync::Once::new();
    FIRST.call_once(|| {
        harv::log(&format!(
            "the dashboard is connected to the app (status {status})"
        ))
    });
    tray::set_status(&app, status);
}

#[tauri::command]
fn notify(app: AppHandle, title: &str, body: &str) {
    notify::unless_seen(&app, title, body);
}

#[tauri::command]
fn app_settings(app: AppHandle) -> prefs::AppSettings {
    prefs::current(&app)
}

#[tauri::command]
fn set_app_settings(
    app: AppHandle,
    hotkey: Option<String>,
    autostart: Option<bool>,
) -> Result<prefs::AppSettings, String> {
    prefs::set(&app, hotkey, autostart)
}

#[tauri::command]
async fn check_updates(app: AppHandle) -> update::UpdateInfo {
    update::check(&app)
}

#[tauri::command]
async fn apply_update(app: AppHandle) -> Result<update::UpdateInfo, String> {
    update::apply(&app)
}

fn main() {
    // Autostart opens the app with --hidden: Harv starts, the window waits in the tray.
    let hidden = std::env::args().any(|a| a == "--hidden");

    tauri::Builder::default()
        // First: a second launch (the menu entry, KDE's hotkey) just shows this one.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show(app)
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        toggle(app);
                    }
                })
                .build(),
        )
        .manage(update::Updates::default())
        .invoke_handler(tauri::generate_handler![
            window_action,
            set_status,
            notify,
            app_settings,
            set_app_settings,
            check_updates,
            apply_update
        ])
        .setup(move |app| {
            let handle = app.handle();
            tray::create(handle)?;
            prefs::apply_saved(handle);
            if !hidden {
                show(handle);
            }
            harv::boot(handle.clone());
            update::schedule(handle.clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // × hides to the tray: replies and background tasks go on. Quit is in the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Harv");
}
