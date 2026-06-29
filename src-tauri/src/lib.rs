// MirrorCam — основная точка входа приложения (библиотечная часть).

mod vcam;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            vcam::vcam_start,
            vcam::vcam_send_frame,
            vcam::vcam_stop,
            vcam::vcam_status,
            vcam::vcam_ensure_registered,
            vcam::vcam_unregister
        ])
        .run(tauri::generate_context!())
        .expect("Ошибка при запуске MirrorCam");
}
