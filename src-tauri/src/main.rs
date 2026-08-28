// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod codex;
mod google_oauth;

use std::io::Write;
use std::process::Command;
use std::thread;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{GlobalShortcutManager, Manager};

fn log_shortcut(message: &str) {
    let path = std::env::temp_dir().join("shaolon-shortcut.log");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{}", message);
    }
}

#[cfg(target_os = "macos")]
fn configure_macos_overlay(window: &tauri::Window) {
    use objc::{msg_send, runtime::Object, sel, sel_impl};

    if let Ok(ptr) = window.ns_window() {
        let ns_window = ptr as *mut Object;
        unsafe {
            let _: () = msg_send![ns_window, setHasShadow: false];
            let _: () = msg_send![ns_window, setHidesOnDeactivate: false];

            // CanJoinAllSpaces | Transient | IgnoresCycle |
            // FullScreenAuxiliary | CanJoinAllApplications
            //
            // CanJoinAllApplications (macOS 13+) is the crucial flag that
            // permits a floating overlay to join another application's native
            // full-screen Space. CanJoinAllSpaces alone only covers Spaces
            // owned by this application.
            let behavior: u64 =
                (1 << 0) | (1 << 3) | (1 << 6) | (1 << 8) | (1 << 18);
            let _: () = msg_send![ns_window, setCollectionBehavior: behavior];
            let _: () = msg_send![ns_window, setLevel: 3_i64];

            let actual_behavior: u64 = msg_send![ns_window, collectionBehavior];
            let actual_level: i64 = msg_send![ns_window, level];
            log_shortcut(&format!(
                "window configured: behavior={actual_behavior}, level={actual_level}"
            ));
        }
    }
}

fn reveal_companion(app: &tauri::AppHandle) {
    let reveal_app = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if let Some(window) = reveal_app.get_window("main") {
            #[cfg(target_os = "macos")]
            configure_macos_overlay(&window);

            let _ = window.set_always_on_top(true);
            let _ = window.show();
            let _ = window.unminimize();

            // Accessory apps are not reliably brought forward by set_focus()
            // alone, especially while another app owns a full-screen Space.
            #[cfg(target_os = "macos")]
            {
                use objc::{class, msg_send, runtime::Object, sel, sel_impl};
                if let Ok(ptr) = window.ns_window() {
                    let ns_window = ptr as *mut Object;
                    unsafe {
                        let ns_app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
                        let _: () = msg_send![ns_app, activateIgnoringOtherApps: true];
                        let nil: *mut Object = std::ptr::null_mut();
                        let _: () = msg_send![ns_window, makeKeyAndOrderFront: nil];
                        let _: () = msg_send![ns_window, orderFrontRegardless];
                    }
                }
            }

            let _ = window.set_focus();
        }
        let _ = reveal_app.emit_all("show-chat", ());
    }) {
        log_shortcut(&format!("reveal scheduling failed: {error}"));
    }
}

fn register_reveal_shortcut(app: &tauri::AppHandle, accelerator: &str) -> tauri::Result<()> {
    let shortcut_app = app.clone();
    let shortcut_name = accelerator.to_string();
    app.global_shortcut_manager().register(accelerator, move || {
        log_shortcut(&format!("pressed: {}", shortcut_name));
        reveal_companion(&shortcut_app);
    })?;
    Ok(())
}

fn ensure_reveal_shortcuts(app: &tauri::AppHandle) -> Vec<String> {
    // Tauri maps macOS Option to the cross-platform Alt modifier. Using the
    // canonical name here also keeps the accelerator ID stable across retries.
    let shortcuts = ["Alt+Space", "CommandOrControl+Shift+Space"];
    let mut statuses = Vec::new();

    for accelerator in shortcuts {
        let manager = app.global_shortcut_manager();
        match manager.is_registered(accelerator) {
            Ok(true) => {
                statuses.push(format!("registered: {accelerator}"));
            }
            Ok(false) => match register_reveal_shortcut(app, accelerator) {
                Ok(()) => {
                    let status = format!("registered: {accelerator}");
                    log_shortcut(&status);
                    statuses.push(status);
                }
                Err(error) => {
                    let status = format!("registration failed: {accelerator}: {error}");
                    log_shortcut(&status);
                    statuses.push(status);
                }
            },
            Err(error) => {
                let status = format!("registration check failed: {accelerator}: {error}");
                log_shortcut(&status);
                statuses.push(status);
            }
        }
    }

    statuses
}

#[tauri::command]
fn ensure_global_shortcuts(app: tauri::AppHandle) -> Vec<String> {
    ensure_reveal_shortcuts(&app)
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
        .manage(google_oauth::GoogleOAuthState::default())
        .setup(|app| {
            // macOS: run as accessory (no Dock icon, no menu bar takeover)
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            for status in ensure_reveal_shortcuts(&app.handle()) {
                eprintln!("Shortcut: {status}");
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

                // macOS: configure this as a cross-application overlay,
                // including native full-screen Spaces.
                #[cfg(target_os = "macos")]
                configure_macos_overlay(&window);

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
            ensure_global_shortcuts,
            google_oauth::google_calendar_access_token,
            google_oauth::google_calendar_clear_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
