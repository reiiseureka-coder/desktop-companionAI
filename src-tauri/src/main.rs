// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod codex;

use std::process::Command;
use std::thread;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{GlobalShortcutManager, Manager};

fn register_reveal_shortcut(app: &tauri::AppHandle, accelerator: &str) -> tauri::Result<()> {
    let shortcut_app = app.clone();
    app.global_shortcut_manager().register(accelerator, move || {
        if let Some(window) = shortcut_app.get_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        let _ = shortcut_app.emit_all("show-chat", ());
    })?;
    Ok(())
}

#[tauri::command]
fn set_cursor_passthrough(window: tauri::Window, passthrough: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(passthrough)
        .map_err(|e| e.to_string())
}

/// Returns the current cursor position in macOS Cocoa screen coordinates
/// (origin = bottom-left of primary display, in logical pixels / points).
/// Returns (-1, -1) on non-macOS platforms.
#[tauri::command]
fn get_cursor_pos_native() -> (f64, f64) {
    #[cfg(target_os = "macos")]
    {
        #[repr(C)]
        #[derive(Copy, Clone)]
        struct NSPoint { x: f64, y: f64 }

        unsafe {
            use objc::{msg_send, sel, sel_impl, class};
            let cls = class!(NSEvent);
            let p: NSPoint = msg_send![cls, mouseLocation];
            (p.x, p.y)
        }
    }
    #[cfg(not(target_os = "macos"))]
    { (-1.0, -1.0) }
}

#[tauri::command]
fn capture_current_screen(window: tauri::Window) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        let path = std::env::temp_dir().join(format!("shaolon-screen-{}.png", stamp));
        let _ = window.hide();
        thread::sleep(Duration::from_millis(180));
        let status = Command::new("/usr/sbin/screencapture")
            .args(["-x", "-m"])
            .arg(&path)
            .status()
            .map_err(|e| format!("画面キャプチャを開始できません: {}", e));
        let _ = window.show();
        let status = status?;
        if !status.success() || !path.exists() {
            return Err("画面を取得できませんでした。システム設定で画面収録を許可してください。".into());
        }
        return Ok(path.to_string_lossy().into_owned());
    }
    #[cfg(not(target_os = "macos"))]
    Err("画面キャプチャは現在macOSのみ対応しています".into())
}

#[tauri::command]
fn read_clipboard_text() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("/usr/bin/pbpaste")
            .output()
            .map_err(|e| format!("クリップボードを読めません: {}", e))?;
        if !output.status.success() {
            return Err("クリップボードを読めませんでした".into());
        }
        return String::from_utf8(output.stdout).map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "macos"))]
    Err("クリップボード取得は現在macOSのみ対応しています".into())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // macOS: run as accessory (no Dock icon, no menu bar takeover)
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // On macOS, Tauri accepts both "Option" and "Alt". Use the
            // user-facing name here and keep a fallback in case another app
            // has already claimed Option+Space.
            if let Err(error) = register_reveal_shortcut(&app.handle(), "Option+Space") {
                eprintln!("Option+Space could not be registered: {error}");
            }
            if let Err(error) = register_reveal_shortcut(
                &app.handle(),
                "CommandOrControl+Shift+Space",
            ) {
                eprintln!("Fallback shortcut could not be registered: {error}");
            }

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
                        unsafe {
                            let _: () = msg_send![ns_win, setHasShadow: false];
                            // CanJoinAllSpaces | Stationary | FullScreenAuxiliary
                            let behavior: u64 = (1 << 0) | (1 << 4) | (1 << 8);
                            let _: () = msg_send![ns_win, setCollectionBehavior: behavior];
                            let _: () = msg_send![ns_win, setLevel: 3_i64];
                        }
                    }
                }

            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            codex::send_to_codex,
            codex::stop_codex,
            set_cursor_passthrough,
            get_cursor_pos_native,
            capture_current_screen,
            read_clipboard_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
