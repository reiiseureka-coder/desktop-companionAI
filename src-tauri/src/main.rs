// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod claude;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            claude::send_to_claude,
            claude::stop_claude,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
