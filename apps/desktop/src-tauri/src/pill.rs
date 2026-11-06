//! Desktop control's pill (docs/PLAN.md §6t item 1 "The pill"): while Harv uses the mouse and
//! keyboard, a small glass window floats over every other window, top centre of the monitor Harv
//! acts on (it follows the action across monitors), with what Harv is doing and a STOP button. It never takes the focus (Harv's typing has to land in the app it
//! works in), stays out of screenshots (Windows-MCP's and the user's), and is the bundled
//! `pill.html`, so it gets only the one command it needs (capabilities/pill.json).

use std::sync::Mutex;

use tauri::{AppHandle, Manager, Monitor, WebviewUrl, WebviewWindowBuilder};

use crate::tray;

const LABEL: &str = "pill";
const WIDTH: f64 = 460.0;
const HEIGHT: f64 = 64.0;
/// Space between the top of the screen and the pill.
const TOP: f64 = 14.0;
/// The monitor the pill was last put on (it only moves when the action moves to another one).
static PLACED_ON: Mutex<Option<String>> = Mutex::new(None);

/// The pill's text, or `None` to hide it. Called by the dashboard (`desktop.control` events);
/// `at` is where Harv acts, in physical pixels of the whole desktop (Windows-MCP's coordinates).
/// Async on purpose: a synchronous command runs on the main thread, and building a window there
/// waits for that same thread, so the whole app froze on Windows (found in the first live test).
#[tauri::command]
pub async fn desktop_pill(
    app: AppHandle,
    action: Option<String>,
    chat: Option<String>,
    at: Option<(f64, f64)>,
) {
    match action {
        Some(action) => show(&app, &action, chat.as_deref().unwrap_or(""), at),
        None => hide(&app),
    }
}

/// STOP on the pill: the dashboard stops the chat that's using the desktop.
#[tauri::command]
pub async fn pill_stop(app: AppHandle) {
    crate::harv::log("desktop control: STOP pressed on the pill");
    hide(&app);
    if let Some(dashboard) = app.get_webview("main") {
        let _ = dashboard.eval("window.dispatchEvent(new Event('harv-pill-stop'))");
    }
}

fn show(app: &AppHandle, action: &str, chat: &str, at: Option<(f64, f64)>) {
    let text = serde_json::json!({ "action": action, "chat": chat }).to_string();
    let window = match app.get_webview_window(LABEL) {
        Some(window) => {
            let _ = window.eval(format!("window.setPill && window.setPill({text})"));
            window
        }
        // A new pill's page isn't loaded yet: it gets its first text before its own script runs.
        None => match create(app, &text) {
            Ok(window) => window,
            Err(e) => {
                crate::harv::log(&format!("desktop control: the pill couldn't open ({e})"));
                return;
            }
        },
    };
    let visible = window.is_visible().unwrap_or(false);
    if let Some(monitor) = monitor_at(app, &window, at) {
        let name = monitor.name().cloned().unwrap_or_default();
        let mut placed = PLACED_ON.lock().unwrap();
        if !visible || placed.as_deref() != Some(name.as_str()) {
            place(&window, &monitor);
            *placed = Some(name);
        }
    }
    if !visible {
        show_quietly(&window);
    }
    tray::set_desktop(app, true);
}

fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        hide_quietly(&window);
    }
    tray::set_desktop(app, false);
}

fn create(app: &AppHandle, text: &str) -> tauri::Result<tauri::WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("pill.html".into()))
        .initialization_script(format!("window.__pill = {text};"))
        .title("Harv is using your desktop")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build()?;
    #[cfg(windows)]
    keep_out_of_screenshots(&window);
    Ok(window)
}

/// The monitor with the point Harv acts on; without one, the monitor Harv's window is on (or the primary).
fn monitor_at(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    at: Option<(f64, f64)>,
) -> Option<Monitor> {
    let hit = at.and_then(|(x, y)| {
        window.available_monitors().ok()?.into_iter().find(|m| {
            let (p, s) = (m.position(), m.size());
            x >= p.x as f64
                && x < p.x as f64 + s.width as f64
                && y >= p.y as f64
                && y < p.y as f64 + s.height as f64
        })
    });
    hit.or_else(|| {
        app.get_window("main")
            .and_then(|w| w.current_monitor().ok().flatten())
    })
    .or_else(|| window.primary_monitor().ok().flatten())
}

/// Top centre of that monitor, in its own pixels (monitors can have different scaling).
fn place(window: &tauri::WebviewWindow, monitor: &Monitor) {
    let scale = monitor.scale_factor();
    let (p, s) = (monitor.position(), monitor.size());
    let _ = window.set_position(tauri::PhysicalPosition::new(
        p.x + ((s.width as f64 - WIDTH * scale) / 2.0) as i32,
        p.y + (TOP * scale) as i32,
    ));
}

/// Shows the pill without taking the focus from the app Harv works in. Tauri's `show()` activates
/// the window even with `focusable(false)` (the first live test: the pill became the foreground
/// window), so on Windows it's shown by hand: never activated, not even by a click on STOP, and
/// kept on top of everything.
#[cfg(windows)]
fn show_quietly(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOPMOST,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_SHOWNOACTIVATE,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    };
    let Ok(hwnd) = window.hwnd() else {
        let _ = window.show();
        return;
    };
    let hwnd = hwnd.0 as _;
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let quiet = (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST) as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | quiet);
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
}

#[cfg(not(windows))]
fn show_quietly(window: &tauri::WebviewWindow) {
    let _ = window.show();
}

/// Hidden the same way it was shown: Tauri never saw the pill shown, so its `hide()` did nothing.
#[cfg(windows)]
fn hide_quietly(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    match window.hwnd() {
        Ok(hwnd) => unsafe {
            ShowWindow(hwnd.0 as _, SW_HIDE);
        },
        Err(_) => {
            let _ = window.hide();
        }
    }
}

#[cfg(not(windows))]
fn hide_quietly(window: &tauri::WebviewWindow) {
    let _ = window.hide();
}

/// Screenshots (Windows-MCP's Screenshot, the user's own) leave the pill out, so Harv never
/// reads its own pill as part of the app it works in.
#[cfg(windows)]
fn keep_out_of_screenshots(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
    };
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            SetWindowDisplayAffinity(hwnd.0 as _, WDA_EXCLUDEFROMCAPTURE);
        }
    }
}
