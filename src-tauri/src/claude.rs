use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Manager};

/// Shared state: track if a Claude process is running
pub struct ClaudeState {
    pub running: bool,
}

/// Send a message to Claude Code CLI and stream the output back via Tauri events.
///
/// Events emitted:
///   "claude-output" – streamed text chunks (String)
///   "claude-done"   – process finished (String: empty or exit message)
///   "claude-error"  – error occurred (String)
#[tauri::command]
pub async fn send_to_claude(
    message: String,
    app: AppHandle,
) -> Result<(), String> {
    // Run the Claude CLI in a thread so we don't block the async runtime
    thread::spawn(move || {
        run_claude(message, app);
    });
    Ok(())
}

/// Stop any running Claude process (best-effort)
#[tauri::command]
pub async fn stop_claude() -> Result<(), String> {
    // Currently a no-op placeholder; process management can be added if needed
    Ok(())
}

fn run_claude(message: String, app: AppHandle) {
    // Attempt to find claude binary
    // Priority: `claude` in PATH, then common install locations
    let claude_bin = find_claude_binary();

    let mut cmd = match claude_bin {
        Some(bin) => Command::new(bin),
        None => {
            emit_error(&app, "claude コマンドが見つかりません。`npm install -g @anthropic-ai/claude-code` でインストールしてください。");
            return;
        }
    };

    // Run: claude --print "<message>"
    // --print: non-interactive, single response mode, outputs to stdout
    cmd.arg("--print")
        .arg(&message)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Ensure no TTY attachment that might cause hanging
        .stdin(Stdio::null());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit_error(&app, &format!("プロセス起動失敗: {}", e));
            return;
        }
    };

    // Stream stdout
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    let payload = format!("{}\n", l);
                    let _ = app.emit_all("claude-output", payload);
                }
                Err(e) => {
                    emit_error(&app, &format!("読み取りエラー: {}", e));
                    break;
                }
            }
        }
    }

    // Capture stderr for error reporting
    let mut stderr_output = String::new();
    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            stderr_output.push_str(&line);
            stderr_output.push('\n');
        }
    }

    // Wait for process to exit
    match child.wait() {
        Ok(status) if status.success() => {
            let _ = app.emit_all("claude-done", "");
        }
        Ok(status) => {
            let msg = if !stderr_output.is_empty() {
                stderr_output.trim().to_string()
            } else {
                format!("プロセスが終了コード {:?} で終了", status.code())
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

/// Find the claude binary in common locations
fn find_claude_binary() -> Option<String> {
    // Check if `claude` is in PATH
    let which_result = Command::new("which").arg("claude").output();
    if let Ok(output) = which_result {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }

    // Fallback: common install paths for macOS
    let candidates = [
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
        // npm global installs via nvm
        &format!(
            "{}/node_modules/.bin/claude",
            std::env::var("HOME").unwrap_or_default()
        ),
        "/usr/bin/claude",
    ];

    for candidate in &candidates {
        if std::path::Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }

    None
}
