fn main() {
    // The app's own commands, so capabilities/ can allow them to the dashboard (a remote URL to Tauri).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "window_action",
            "set_status",
            "notify",
            "app_settings",
            "set_app_settings",
            "check_updates",
            "apply_update",
            "pick_paths",
            "set_see_through",
        ]),
    ))
    .expect("failed to run tauri-build");
}
