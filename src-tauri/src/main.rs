// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod claude;

use tauri::Manager;

#[tauri::command]
fn set_cursor_passthrough(window: tauri::Window, passthrough: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(passthrough)
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // macOS: run as accessory (no Dock icon, no menu bar takeover)
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Resize the window to cover the full primary monitor
            if let Some(window) = app.get_window("main") {
                if let Ok(Some(monitor)) = window.primary_monitor() {
                    let size = monitor.size();
                    let scale = monitor.scale_factor();
                    let logical_w = size.width as f64 / scale;
                    let logical_h = size.height as f64 / scale;
                    let _ = window.set_size(tauri::LogicalSize::new(logical_w, logical_h));
                    let _ = window.set_position(tauri::LogicalPosition::new(0.0, 0.0));
                }

                // macOS: disable the system window shadow
                #[cfg(target_os = "macos")]
                {
                    use objc::{msg_send, sel, sel_impl, runtime::Object};
                    if let Ok(ptr) = window.ns_window() {
                        let ns_win = ptr as *mut Object;
                        unsafe { let _: () = msg_send![ns_win, setHasShadow: false]; }
                    }
                }

            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            claude::send_to_claude,
            claude::stop_claude,
            set_cursor_passthrough,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
