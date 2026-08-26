use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use serde_json::Value;
use tauri::{AppHandle, Manager};

/// Holds the PID of the currently running Codex process so it can be killed.
static CURRENT_PID: Mutex<Option<u32>> = Mutex::new(None);

#[derive(serde::Deserialize)]
pub struct ContextMessage {
    pub role: String,
    pub content: String,
}

/// Send a message to Codex CLI and emit the final response via Tauri events.
///
/// Events emitted:
///   "codex-output" – final text output (String)
///   "codex-done"   – process finished successfully
///   "codex-error"  – error occurred (String)
#[tauri::command]
pub async fn send_to_codex(
    message: String,
    context: Vec<ContextMessage>,
    working_dir: Option<String>,
    auto_permissions: bool,
    system_prompt: Option<String>,
    model: Option<String>,
    image_paths: Option<Vec<String>>,
    app: AppHandle,
) -> Result<(), String> {
    thread::spawn(move || {
        run_codex(
            message,
            context,
            working_dir,
            auto_permissions,
            system_prompt,
            model,
            image_paths,
            app,
        );
    });
    Ok(())
}

/// Kill the currently running Codex process if any.
#[tauri::command]
pub async fn stop_codex() -> Result<(), String> {
    if let Ok(mut guard) = CURRENT_PID.lock() {
        if let Some(pid) = guard.take() {
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

fn run_codex(
    message: String,
    context: Vec<ContextMessage>,
    working_dir: Option<String>,
    auto_permissions: bool,
    system_prompt: Option<String>,
    model: Option<String>,
    image_paths: Option<Vec<String>>,
    app: AppHandle,
) {
    log_debug("send_to_codex: start");
    let codex_bin = match find_codex_binary() {
        Some(bin) => bin,
        None => {
            log_debug("send_to_codex: codex binary not found");
            emit_error(
                &app,
                "codex コマンドが見つかりません。ターミナルで `npm install -g @openai/codex` を実行してください。",
            );
            return;
        }
    };

    let full_message = build_prompt(message, context, system_prompt);
    log_debug(&format!("send_to_codex: using binary {}", codex_bin));

    let workspace_dir = match prepare_codex_workspace(working_dir.as_deref()) {
        Ok(dir) => dir,
        Err(e) => {
            log_debug(&format!("send_to_codex: workspace error: {}", e));
            emit_error(&app, &format!("Codex ワークスペース準備に失敗しました: {}", e));
            return;
        }
    };
    log_debug(&format!("send_to_codex: workspace {}", workspace_dir.display()));

    let mut cmd = Command::new(&codex_bin);
    cmd.env("PATH", build_extended_path());
    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", home);
    }
    cmd.current_dir(&workspace_dir);
    cmd.arg("exec")
        .arg("--skip-git-repo-check")
        .arg("--json")
        .arg("--color")
        .arg("never")
        .arg("--ephemeral");

    if auto_permissions {
        cmd.arg("--approve-for-me");
    } else {
        cmd.arg("--sandbox").arg("read-only");
    }

    if let Some(ref m) = model {
        if !m.trim().is_empty() {
            cmd.arg("--model").arg(m);
        }
    }

    if let Some(paths) = image_paths {
        for path in paths.into_iter().filter(|path| !path.trim().is_empty()) {
            cmd.arg("--image").arg(path);
        }
    }

    cmd.arg("--cd").arg(&workspace_dir);

    cmd.arg(&full_message);

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            log_debug(&format!("send_to_codex: spawn failed: {}", e));
            emit_error(&app, &format!("Codex の起動に失敗しました: {}", e));
            return;
        }
    };
    log_debug(&format!("send_to_codex: spawned pid {}", child.id()));

    if let Ok(mut guard) = CURRENT_PID.lock() {
        *guard = Some(child.id());
    }

    let mut final_message: Option<String> = None;
    let mut streamed_message = String::new();
    let mut event_errors: Vec<String> = Vec::new();

    let stderr_output = Arc::new(Mutex::new(String::new()));
    let stderr_handle = if let Some(stderr) = child.stderr.take() {
        let stderr_output = Arc::clone(&stderr_output);
        Some(thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                log_debug(&format!("stderr: {}", line));
                if let Ok(mut buf) = stderr_output.lock() {
                    buf.push_str(&line);
                    buf.push('\n');
                }
            }
        }))
    } else {
        None
    };

    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(raw) => {
                    let line = raw.trim();
                    if line.is_empty() {
                        continue;
                    }
                    log_debug(&format!("stdout: {}", line));
                    if let Ok(event) = serde_json::from_str::<Value>(line) {
                        handle_codex_event(
                            &event,
                            &app,
                            &mut final_message,
                            &mut streamed_message,
                            &mut event_errors,
                        );
                    }
                }
                Err(e) => {
                    emit_error(&app, &format!("読み取りエラー: {}", e));
                    break;
                }
            }
        }
    }

    if let Some(handle) = stderr_handle {
        let _ = handle.join();
    }

    if let Ok(mut guard) = CURRENT_PID.lock() {
        *guard = None;
    }

    let stderr_output = stderr_output
        .lock()
        .map(|buf| buf.clone())
        .unwrap_or_default();

    match child.wait() {
        Ok(status) if status.success() => {
            log_debug("send_to_codex: process exited successfully");
            if let Some(text) = final_message {
                let _ = app.emit_all("codex-output", text);
                let _ = app.emit_all("codex-done", "");
            } else if !streamed_message.trim().is_empty() {
                let _ = app.emit_all("codex-output", streamed_message);
                let _ = app.emit_all("codex-done", "");
            } else if !event_errors.is_empty() {
                log_debug(&format!("send_to_codex: event errors: {}", event_errors.join(" | ")));
                emit_error(&app, &event_errors.join("\n"));
            } else {
                log_debug("send_to_codex: no response message found");
                emit_error(&app, "Codex の応答を取得できませんでした。");
            }
        }
        Ok(_) if !event_errors.is_empty() => {
            log_debug(&format!("send_to_codex: non-zero exit with event errors: {}", event_errors.join(" | ")));
            emit_error(&app, &event_errors.join("\n"));
        }
        Ok(_) if stderr_output.contains("interrupted") || stderr_output.is_empty() => {
            log_debug("send_to_codex: process interrupted or stderr empty");
            let _ = app.emit_all("codex-done", "");
        }
        Ok(_) => {
            let mut errors = event_errors.join("\n");
            if errors.trim().is_empty() {
                let trimmed = stderr_output.trim();
                if !trimmed.is_empty() {
                    let capped: String = trimmed.chars().take(500).collect();
                    errors = if trimmed.chars().count() > 500 {
                        format!("{}…", capped)
                    } else {
                        capped
                    };
                }
            }

            if errors.trim().is_empty() {
                log_debug("send_to_codex: process failed without detailed error");
                emit_error(&app, "Codex が予期せず終了しました。");
            } else {
                log_debug(&format!("send_to_codex: process failed: {}", errors));
                emit_error(&app, &errors);
            }
        }
        Err(e) => {
            log_debug(&format!("send_to_codex: wait error: {}", e));
            emit_error(&app, &format!("プロセス待機エラー: {}", e));
        }
    }
}

fn build_prompt(
    message: String,
    context: Vec<ContextMessage>,
    system_prompt: Option<String>,
) -> String {
    let mut parts: Vec<String> = Vec::new();

    if let Some(sp) = system_prompt {
        if !sp.trim().is_empty() {
            parts.push(format!("【システム指示】\n{}", sp.trim()));
        }
    }

    if !context.is_empty() {
        let mut ctx = String::from("【直近の会話】\n");
        for msg in &context {
            let role = if msg.role == "user" {
                "ユーザー"
            } else {
                "AI"
            };
            let body: String = msg.content.chars().take(300).collect();
            let truncated = if msg.content.chars().count() > 300 {
                format!("{}…", body)
            } else {
                body
            };
            ctx.push_str(&format!("{}: {}\n", role, truncated));
        }
        parts.push(ctx);
    }

    parts.push(format!("【今回の依頼】\n{}", message));
    parts.join("\n\n")
}

fn emit_error(app: &AppHandle, msg: &str) {
    let _ = app.emit_all("codex-error", msg.to_string());
}

fn handle_codex_event(
    event: &Value,
    app: &AppHandle,
    final_message: &mut Option<String>,
    streamed_message: &mut String,
    event_errors: &mut Vec<String>,
) {
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match event_type {
        "task_complete" => {
            if let Some(text) = event.get("last_agent_message").and_then(extract_text) {
                *final_message = Some(text.clone());
                *streamed_message = text;
            }
        }
        "item.completed" | "item_completed" => {
            if let Some(item) = event.get("item") {
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
                if item_type == "agent_message" {
                    if let Some(text) = extract_text(item) {
                        *final_message = Some(text.clone());
                        *streamed_message = text.clone();
                        let _ = app.emit_all("codex-output", text);
                    }
                }
            }
        }
        "agent_message" => {
            if let Some(text) = event.get("message").and_then(extract_text).or_else(|| extract_text(event)) {
                *final_message = Some(text.clone());
                *streamed_message = text.clone();
                let _ = app.emit_all("codex-output", text);
            }
        }
        "agent_message_delta" | "agent_message_content_delta" => {
            if let Some(delta) = event.get("delta").and_then(extract_text).or_else(|| extract_text(event)) {
                streamed_message.push_str(&delta);
                let _ = app.emit_all("codex-output", streamed_message.clone());
            }
        }
        "error" | "stream_error" => {
            if let Some(msg) = event.get("message").and_then(extract_text) {
                event_errors.push(msg);
            }
        }
        "turn.failed" | "turn_failed" => {
            if let Some(msg) = event
                .get("error")
                .and_then(|err| err.get("message"))
                .and_then(extract_text)
                .or_else(|| event.get("message").and_then(extract_text))
            {
                event_errors.push(msg);
            }
        }
        _ => {}
    }
}

fn extract_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(extract_text).collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        Value::Object(map) => {
            for key in ["text", "message", "delta", "content"] {
                if let Some(text) = map.get(key).and_then(extract_text) {
                    return Some(text);
                }
            }
            None
        }
        _ => None,
    }
}

fn prepare_codex_workspace(working_dir: Option<&str>) -> Result<std::path::PathBuf, String> {
    let target = if let Some(dir) = working_dir {
        let path = std::path::PathBuf::from(dir);
        if !path.is_dir() {
            return Err(format!("ディレクトリが存在しません: {}", dir));
        }
        path
    } else {
        std::env::current_dir().map_err(|e| e.to_string())?
    };

    if target.to_string_lossy().is_ascii() {
        return Ok(target);
    }

    let mut base = std::env::temp_dir();
    base.push("desktop-companion-ai-codex");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;

    let hash = stable_path_hash(&target);
    let link_path = base.join(format!("workspace-{}", hash));

    if link_path.exists() {
        let meta = std::fs::symlink_metadata(&link_path).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            let existing = std::fs::read_link(&link_path).map_err(|e| e.to_string())?;
            if existing == target {
                return Ok(link_path);
            }
        }
        let _ = std::fs::remove_file(&link_path);
    }

    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link_path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(&target, &link_path).map_err(|e| e.to_string())?;

    Ok(link_path)
}

fn stable_path_hash(path: &std::path::Path) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    hasher.finish()
}

/// Extend PATH so the GUI app can find codex and its runtime.
fn build_extended_path() -> String {
    let current_path = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();

    let mut extra_dirs = vec![
        format!("{}/.codex-local/node_modules/.bin", home),
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{}/.npm-global/bin", home),
        format!("{}/node_modules/.bin", home),
        format!("{}/.local/bin", home),
    ];

    let nvm_node_dir = format!("{}/.nvm/versions/node", home);
    if let Ok(entries) = std::fs::read_dir(&nvm_node_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                extra_dirs.push(format!("{}/bin", entry.path().display()));
            }
        }
    }

    let nvm_default = format!("{}/.nvm/alias/default", home);
    if let Ok(version) = std::fs::read_to_string(&nvm_default) {
        let version = version.trim();
        extra_dirs.push(format!("{}/.nvm/versions/node/{}/bin", home, version));
    }

    format!("{}:{}", current_path, extra_dirs.join(":"))
}

fn log_debug(message: &str) {
    let home = match std::env::var("HOME") {
        Ok(home) => home,
        Err(_) => return,
    };

    let dir = std::path::PathBuf::from(home)
        .join("Library")
        .join("Logs")
        .join("Desktop Companion AI");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }

    let log_path = dir.join("codex.log");
    let line = format!("[{}] {}\n", timestamp_string(), message);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
    {
        use std::io::Write;
        let _ = file.write_all(line.as_bytes());
    }
}

fn timestamp_string() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs().to_string(),
        Err(_) => "0".to_string(),
    }
}

fn find_codex_binary() -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let extended_path = build_extended_path();

    let candidates = [
        format!("{}/.codex-local/node_modules/.bin/codex", home),
        "/usr/local/bin/codex".to_string(),
        "/opt/homebrew/bin/codex".to_string(),
        format!("{}/.npm-global/bin/codex", home),
        format!("{}/node_modules/.bin/codex", home),
        "/usr/bin/codex".to_string(),
    ];

    for candidate in &candidates {
        if std::path::Path::new(candidate).exists() {
            return Some(candidate.clone());
        }
    }

    if let Ok(output) = Command::new("which")
        .arg("codex")
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

    None
}
