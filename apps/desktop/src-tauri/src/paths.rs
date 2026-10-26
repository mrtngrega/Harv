//! Files and folders the user hands Harv by path (docs/PLAN.md §6p): the system's own picker.
//! The dashboard attaches them as references; nothing is uploaded. (Drops stay with the page:
//! Tauri taking them would break the page's own drag and drop on Windows, see tauri.conf.json.)

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
pub struct Picked {
    pub path: String,
    pub folder: bool,
}

fn picked(paths: Vec<PathBuf>) -> Vec<Picked> {
    paths
        .into_iter()
        .map(|p| Picked {
            folder: p.is_dir(),
            path: p.to_string_lossy().into_owned(),
        })
        .collect()
}

pub fn pick(app: &AppHandle, folders: bool) -> Vec<Picked> {
    let mut dialog = app.dialog().file();
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let chosen = if folders {
        dialog.blocking_pick_folders()
    } else {
        dialog.blocking_pick_files()
    };
    picked(
        chosen
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.into_path().ok())
            .collect(),
    )
}
