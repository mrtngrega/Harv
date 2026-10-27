//! Harv's desktop app: a frameless window around the dashboard, a tray icon with Harv's status,
//! a hotkey to bring it up, notifications, autostart and updates. Harv itself (server and
//! dashboard) still runs from the repo; the app starts it, shows it and stops it. docs/PLAN.md §6p.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod harv;
mod notify;
mod paths;
mod prefs;
mod tray;
mod update;

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::window::Color;
use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// Which window change is the latest, so only the last one of a drag or resize saves.
static WINDOW_CHANGE: AtomicU64 = AtomicU64::new(0);

/// The window's size, place and maximized state, saved a moment after it changes: the plugin
/// saves only on a clean quit, so a logout, a crash or a kill lost them (found 2026-10-27).
fn save_window_soon(app: &AppHandle) {
    let n = WINDOW_CHANGE.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(800));
        if WINDOW_CHANGE.load(Ordering::SeqCst) == n {
            let _ = app.save_window_state(StateFlags::all() & !StateFlags::VISIBLE);
        }
    });
}

/// Brings the window to the front with the cursor in the `harv>` line.
pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.eval("window.dispatchEvent(new Event('harv-focus'))");
    }
}

/// `harv --restart`, `--quit`, `--sensors`, `--update` do what the tray menu does; anything else shows the window.
fn flag_action(args: &[String]) -> &'static str {
    let has = |flag: &str| args.iter().any(|a| a == flag);
    if has("--restart") {
        "restart"
    } else if has("--quit") {
        "quit"
    } else if has("--sensors") {
        "sensors"
    } else if has("--update") {
        "update"
    } else {
        "open"
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

/// The dashboard's ground colour, behind the page while it loads (and whenever see-through is off).
const GROUND: Color = Color(10, 16, 24, 255);

/// Settings › Look › See-through window: the desktop shows behind the dashboard, or the solid
/// window again. `blur` (the Blur slider above 0) frosts it with Acrylic on Windows, which has one
/// strength only; Linux gets plain transparency (Tauri can't ask KWin for blur).
#[tauri::command]
fn set_see_through(window: WebviewWindow, on: bool, blur: Option<bool>) {
    let _ = window.set_background_color(Some(if on { Color(0, 0, 0, 0) } else { GROUND }));
    #[cfg(windows)]
    {
        use tauri::window::{Effect, EffectsBuilder};
        let frosted = on && blur.unwrap_or(true);
        let _ = window
            .set_effects(frosted.then(|| EffectsBuilder::new().effect(Effect::Acrylic).build()));
    }
    #[cfg(not(windows))]
    let _ = blur;
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

/// ATTACH in the app: the system's own picker, for files or for folders (one picker can't do both).
#[tauri::command]
async fn pick_paths(app: AppHandle, folders: bool) -> Vec<paths::Picked> {
    paths::pick(&app, folders)
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
    let args: Vec<String> = std::env::args().collect();
    let hidden = args.iter().any(|a| a == "--hidden");
    let quitting = flag_action(&args) == "quit";

    tauri::Builder::default()
        // First: a second launch (the menu entry, KDE's hotkey) shows this one, or runs its --flag.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show(app)
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
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
            apply_update,
            pick_paths,
            set_see_through
        ])
        .setup(move |app| {
            let handle = app.handle();
            // `harv --quit` with no app running: stop Harv (if the scripts started it) and close.
            if quitting {
                harv::quit(handle);
                return Ok(());
            }
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
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
                    save_window_soon(window.app_handle())
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Harv");
}
