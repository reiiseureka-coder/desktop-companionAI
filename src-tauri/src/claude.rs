use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Manager};

/// Holds the PID of the currently running Claude process so it can be killed.
static CURRENT_PID: Mutex<Option<u32>> = Mutex::new(None);

#[derive(serde::Deserialize)]
pub struct ContextMessage {
    pub role: String,   // "user" | "assistant"
    pub content: String,
}

/// Send a message to Claude Code CLI and stream the output back via Tauri events.
///
/// Parameters:
///   message          – user's prompt
///   context          – recent conversation messages for context (kept short to save tokens)
///   working_dir      – project directory to run Claude Code in (optional)
///   auto_permissions – if true, adds --dangerously-skip-permissions
///
/// Events emitted:
///   "claude-output" – streamed text chunks (String)
///   "claude-done"   – process finished successfully
///   "claude-error"  – error occurred (String)
#[tauri::command]
pub async fn send_to_claude(
    message: String,
    context: Vec<ContextMessage>,
    working_dir: Option<String>,
    auto_permissions: bool,
    system_prompt: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    thread::spawn(move || {
        run_claude(message, context, working_dir, auto_permissions, system_prompt, app);
    });
    Ok(())
}

/// Kill the currently running Claude process if any.
#[tauri::command]
pub async fn stop_claude() -> Result<(), String> {
    if let Ok(mut guard) = CURRENT_PID.lock() {
        if let Some(pid) = guard.take() {
            // SIGTERM on Unix
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/F"])
                    .output();
            }
        }
    }
    Ok(())
}

fn run_claude(
    message: String,
    context: Vec<ContextMessage>,
    working_dir: Option<String>,
    auto_permissions: bool,
    system_prompt: Option<String>,
    app: AppHandle,
) {
    let claude_bin = match find_claude_binary() {
        Some(bin) => bin,
        None => {
            emit_error(
                &app,
                "claude コマンドが見つかりません。\
                 ターミナルで `npm install -g @anthropic-ai/claude-code` を実行してください。",
            );
            return;
        }
    };

    // Build the full prompt: prepend recent conversation context to save tokens.
    // Each assistant reply is truncated to 300 chars to avoid blowing up the context.
    let full_message = if context.is_empty() {
        message.clone()
    } else {
        let mut parts = String::from("【直近の会話】\n");
        for msg in &context {
            let role = if msg.role == "user" { "ユーザー" } else { "AI" };
            let body: String = msg.content.chars().take(300).collect();
            let truncated = if msg.content.chars().count() > 300 {
                format!("{}…", body)
            } else {
                body
            };
            parts.push_str(&format!("{}: {}\n", role, truncated));
        }
        parts.push_str(&format!("\n【今回の質問】\n{}", message));
        parts
    };

    let mut cmd = Command::new(&claude_bin);

    // Extend PATH so the claude Node.js script can find `node` even when
    // launched from a macOS GUI app (which doesn't inherit the full shell PATH).
    cmd.env("PATH", build_extended_path());

    cmd.arg("--print").arg(&full_message);

    if let Some(ref sp) = system_prompt {
        if !sp.trim().is_empty() {
            cmd.arg("--append-system-prompt").arg(sp);
        }
    }

    if auto_permissions {
        cmd.arg("--dangerously-skip-permissions");
    }

    if let Some(ref dir) = working_dir {
        let path = std::path::Path::new(dir);
        if path.is_dir() {
            cmd.current_dir(path);
        } else {
            emit_error(&app, &format!("ディレクトリが存在しません: {}", dir));
            return;
        }
    }

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit_error(&app, &format!("Claude の起動に失敗しました: {}", e));
            return;
        }
    };

    // Store PID for stop_claude()
    if let Ok(mut guard) = CURRENT_PID.lock() {
        *guard = Some(child.id());
    }

    // Stream stdout line by line → "claude-output" events
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    let _ = app.emit_all("claude-output", format!("{}\n", l));
                }
                Err(e) => {
                    emit_error(&app, &format!("読み取りエラー: {}", e));
                    break;
                }
            }
        }
    }

    // Collect stderr for error reporting
    let mut stderr_output = String::new();
    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            stderr_output.push_str(&line);
            stderr_output.push('\n');
        }
    }

    // Clear PID
    if let Ok(mut guard) = CURRENT_PID.lock() {
        *guard = None;
    }

    match child.wait() {
        Ok(status) if status.success() => {
            let _ = app.emit_all("claude-done", "");
        }
        Ok(_) if stderr_output.contains("interrupted") || stderr_output.is_empty() => {
            // Killed by stop_claude — treat as done
            let _ = app.emit_all("claude-done", "");
        }
        Ok(_) => {
            let msg = if !stderr_output.trim().is_empty() {
                // Show stderr but cap length for readability
                let trimmed = stderr_output.trim();
                let capped: String = trimmed.chars().take(400).collect();
                if trimmed.chars().count() > 400 {
                    format!("{}…", capped)
                } else {
                    capped.to_string()
                }
            } else {
                "Claude が予期せず終了しました。".to_string()
            };
            emit_error(&app, &msg);
        }
        Err(e) => {
            emit_error(&app, &format!("プロセス待機エラー: {}", e));
        }
    }
}

fn emit_error(app: &AppHandle, msg: &str) {
    let _ = app.emit_all("claude-error", msg.to_string());
}

/// Build an extended PATH that includes common Node.js binary locations.
/// macOS GUI apps don't inherit the full shell PATH, so node/claude may not be found.
fn build_extended_path() -> String {
    let current_path = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();

    let mut extra_dirs = vec![
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{}/.npm-global/bin", home),
        format!("{}/node_modules/.bin", home),
        format!("{}/.local/bin", home),
    ];

    // Add any nvm-managed node versions
    let nvm_node_dir = format!("{}/.nvm/versions/node", home);
    if let Ok(entries) = std::fs::read_dir(&nvm_node_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                extra_dirs.push(format!("{}/bin", entry.path().display()));
            }
        }
    }

    // Also check ~/.nvm/alias/default symlink
    let nvm_default = format!("{}/.nvm/alias/default", home);
    if let Ok(version) = std::fs::read_to_string(&nvm_default) {
        let version = version.trim();
        extra_dirs.push(format!("{}/.nvm/versions/node/{}/bin", home, version));
    }

    format!("{}:{}", current_path, extra_dirs.join(":"))
}

fn find_claude_binary() -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let extended_path = build_extended_path();

    // Check via `which` with extended PATH
    if let Ok(output) = Command::new("which")
        .arg("claude")
        .env("PATH", &extended_path)
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }

    // Fallback: common macOS install locations
    let candidates = [
        "/usr/local/bin/claude".to_string(),
        "/opt/homebrew/bin/claude".to_string(),
        format!("{}/.npm-global/bin/claude", home),
        format!("{}/node_modules/.bin/claude", home),
        "/usr/bin/claude".to_string(),
    ];

    for candidate in &candidates {
        if std::path::Path::new(candidate).exists() {
            return Some(candidate.clone());
        }
    }

    None
}
