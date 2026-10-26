//! Native notifications, for when Harv's window isn't in front.

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

pub fn show(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// The dashboard's toasts already show in the window; outside it (hidden, minimized or behind
/// another program) they become a system notification.
pub fn unless_seen(app: &AppHandle, title: &str, body: &str) {
    let seen = app.get_webview_window("main").is_some_and(|w| {
        w.is_visible().unwrap_or(false)
            && !w.is_minimized().unwrap_or(false)
            && w.is_focused().unwrap_or(false)
    });
    if !seen {
        show(app, title, body);
    }
}
