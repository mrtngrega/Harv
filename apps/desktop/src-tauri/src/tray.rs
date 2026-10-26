//! The tray icon: Harv's status as the icon, and a menu to open, restart, update or quit Harv.

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::{harv, update};

const TRAY: &str = "harv";

pub struct TrayMenu {
    update: MenuItem<Wry>,
}

fn icon(status: &str) -> Image<'static> {
    let bytes: &[u8] = match status {
        "thinking" | "working" => include_bytes!("../icons/tray-busy.png"),
        "waiting" => include_bytes!("../icons/tray-waiting.png"),
        "paused" | "offline" => include_bytes!("../icons/tray-off.png"),
        _ => include_bytes!("../icons/tray-idle.png"),
    };
    Image::from_bytes(bytes).expect("tray icon")
}

fn tooltip(status: &str) -> String {
    let what = match status {
        "thinking" => "thinking",
        "working" => "working",
        "waiting" => "waiting for your OK",
        "paused" => "paused (plan limit)",
        "offline" => "not connected",
        _ => "idle",
    };
    format!("Harv · {what}")
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Harv", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart Harv", true, None::<&str>)?;
    let sensors = MenuItem::with_id(app, "sensors", "Start sensors", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "Check for updates", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Harv", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = if cfg!(windows) {
        Menu::with_items(
            app,
            &[&open, &restart, &sensors, &update, &separator, &quit],
        )?
    } else {
        Menu::with_items(app, &[&open, &restart, &update, &separator, &quit])?
    };

    TrayIconBuilder::with_id(TRAY)
        .icon(icon("offline"))
        .tooltip(tooltip("offline"))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| action(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::show(tray.app_handle());
            }
        })
        .build(app)?;

    app.manage(TrayMenu { update });
    Ok(())
}

/// What a menu item does; also `harv --restart` and friends (main.rs), so scripts and the Linux menu can use them.
pub fn action(app: &AppHandle, id: &str) {
    match id {
        "open" => crate::show(app),
        "restart" => harv::restart(),
        "sensors" => {
            std::thread::spawn(harv::start_sensors);
        }
        "update" => {
            let app = app.clone();
            std::thread::spawn(move || {
                let behind = app.state::<update::Updates>().0.lock().unwrap().behind;
                if behind == 0 {
                    update::check(&app);
                } else if let Err(e) = update::apply(&app) {
                    crate::notify::show(&app, "Harv didn't update", &e);
                }
            });
        }
        "quit" => harv::quit(app),
        _ => {}
    }
}

pub fn set_status(app: &AppHandle, status: &str) {
    if let Some(tray) = app.tray_by_id(TRAY) {
        let _ = tray.set_icon(Some(icon(status)));
        let _ = tray.set_tooltip(Some(tooltip(status)));
    }
}

pub fn show_updates(app: &AppHandle, behind: u32) {
    if let Some(menu) = app.try_state::<TrayMenu>() {
        let text = if behind > 0 {
            format!("Update Harv ({behind} new)")
        } else {
            "Check for updates".to_string()
        };
        let _ = menu.update.set_text(text);
    }
}
