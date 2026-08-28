use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{distributions::Alphanumeric, Rng};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use url::Url;

const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar.readonly";
const OAUTH_LOG_PATH: &str = "/tmp/shaolon-google-oauth.log";

#[derive(Clone)]
struct CachedToken {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: u64,
}

#[derive(Clone, Default)]
pub struct GoogleOAuthState {
    tokens: Arc<Mutex<HashMap<String, CachedToken>>>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

struct AuthorizationCode {
    code: String,
    redirect_uri: String,
    code_verifier: String,
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn random_string(length: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(length)
        .map(char::from)
        .collect()
}

fn form_body(fields: &[(&str, &str)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in fields {
        serializer.append_pair(key, value);
    }
    serializer.finish()
}

fn oauth_log(message: &str) {
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(OAUTH_LOG_PATH)
    {
        let _ = writeln!(file, "{} {message}", unix_now());
    }
}

fn post_token_form(body: String) -> Result<TokenResponse, String> {
    let mut child = Command::new("/usr/bin/curl")
        .args([
            "--silent",
            "--show-error",
            "--connect-timeout",
            "15",
            "--max-time",
            "30",
            "--request",
            "POST",
            "--header",
            "Content-Type: application/x-www-form-urlencoded",
            "--data-binary",
            "@-",
            GOOGLE_TOKEN_URL,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Google認証通信を開始できません: {error}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Google認証通信の入力を開けません".to_string())?;
    stdin
        .write_all(body.as_bytes())
        .map_err(|error| format!("Google認証情報を送信できません: {error}"))?;
    drop(stdin);

    let output = child
        .wait_with_output()
        .map_err(|error| format!("Google認証通信を完了できません: {error}"))?;

    if !output.status.success() && output.stdout.is_empty() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        oauth_log(&format!("token request failed: {detail}"));
        return Err(if detail.is_empty() {
            "Google認証サーバーに接続できませんでした".to_string()
        } else {
            format!("Google認証通信に失敗しました: {detail}")
        });
    }

    let response: TokenResponse = serde_json::from_slice(&output.stdout).map_err(|_| {
        oauth_log("token response was not valid JSON");
        "Google認証サーバーから正しい応答が返りませんでした".to_string()
    })?;

    if !output.status.success() || response.error.is_some() {
        let message = response
            .error_description
            .or(response.error)
            .unwrap_or_else(|| "Google認証に失敗しました".to_string());
        oauth_log(&format!("token response rejected: {message}"));
        return Err(message);
    }

    Ok(response)
}

fn exchange_authorization_code(
    client_id: &str,
    client_secret: &str,
    authorization: AuthorizationCode,
) -> Result<CachedToken, String> {
    let response = post_token_form(form_body(&[
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("code", &authorization.code),
        ("code_verifier", &authorization.code_verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", &authorization.redirect_uri),
    ]))?;

    let access_token = response
        .access_token
        .ok_or_else(|| "Googleからアクセストークンが返りませんでした".to_string())?;

    Ok(CachedToken {
        access_token,
        refresh_token: response.refresh_token,
        expires_at: unix_now() + response.expires_in.unwrap_or(3600),
    })
}

fn refresh_access_token(
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<CachedToken, String> {
    let response = post_token_form(form_body(&[
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
    ]))?;

    let access_token = response
        .access_token
        .ok_or_else(|| "Googleから更新済みトークンが返りませんでした".to_string())?;

    Ok(CachedToken {
        access_token,
        refresh_token: Some(refresh_token.to_string()),
        expires_at: unix_now() + response.expires_in.unwrap_or(3600),
    })
}

fn browser_response(message: &str, success: bool) -> String {
    let color = if success { "#6754d9" } else { "#c03050" };
    format!(
        "<!doctype html><html lang=\"ja\"><meta charset=\"utf-8\"><title>Shaolon AI</title>\
         <body style=\"font-family:-apple-system,sans-serif;text-align:center;padding:64px 24px;color:{color}\">\
         <h1>Shaolon AI</h1><p>{message}</p><p>このタブは閉じて大丈夫です。</p></body></html>"
    )
}

fn write_browser_response(stream: &mut std::net::TcpStream, body: String) {
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.as_bytes().len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn wait_for_authorization_callback(
    listener: TcpListener,
    expected_state: String,
    redirect_uri: String,
    code_verifier: String,
) -> Result<AuthorizationCode, String> {
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("認証待受ポートを設定できません: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(180);

    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut request = [0_u8; 8192];
                let read = stream.read(&mut request).unwrap_or(0);
                let first_line = String::from_utf8_lossy(&request[..read])
                    .lines()
                    .next()
                    .unwrap_or("")
                    .to_string();
                let target = first_line.split_whitespace().nth(1).unwrap_or("/");
                let callback_url = match Url::parse(&format!("http://127.0.0.1{target}")) {
                    Ok(url) => url,
                    Err(_) => {
                        write_browser_response(
                            &mut stream,
                            browser_response("認証結果を読み取れませんでした。", false),
                        );
                        continue;
                    }
                };
                let params: HashMap<String, String> = callback_url.query_pairs().into_owned().collect();

                if let Some(error) = params.get("error") {
                    write_browser_response(
                        &mut stream,
                        browser_response("認証がキャンセルされました。", false),
                    );
                    return Err(format!("Google認証が完了しませんでした: {error}"));
                }

                if params.get("state") != Some(&expected_state) {
                    write_browser_response(
                        &mut stream,
                        browser_response("認証結果を検証できませんでした。", false),
                    );
                    return Err("Google認証の安全性検証に失敗しました".to_string());
                }

                if let Some(code) = params.get("code") {
                    oauth_log("authorization callback received");
                    write_browser_response(
                        &mut stream,
                        browser_response("認証情報を受け取りました。Shaolon AIで接続処理を続けています。", true),
                    );
                    return Ok(AuthorizationCode {
                        code: code.clone(),
                        redirect_uri,
                        code_verifier,
                    });
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(format!("Google認証結果を受信できません: {error}")),
        }
    }

    Err("Google認証がタイムアウトしました。もう一度更新を押してください".to_string())
}

fn authorize_in_browser(
    client_id: &str,
    client_secret: &str,
    app: &AppHandle,
) -> Result<CachedToken, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Google認証用の受付を開けません: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Google認証用のアドレスを取得できません: {error}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}");
    let code_verifier = random_string(64);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
    let state = random_string(40);

    let mut auth_url = Url::parse(GOOGLE_AUTH_URL).map_err(|error| error.to_string())?;
    auth_url
        .query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", CALENDAR_SCOPE)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");

    tauri::api::shell::open(&app.shell_scope(), auth_url.as_str(), None)
        .map_err(|error| format!("Google認証ページを開けません: {error}"))?;

    let authorization = wait_for_authorization_callback(listener, state, redirect_uri, code_verifier)?;
    oauth_log("exchanging authorization code");
    let token = exchange_authorization_code(client_id, client_secret, authorization)?;
    oauth_log("authorization code exchange succeeded");
    Ok(token)
}

fn get_access_token(
    client_id: String,
    client_secret: String,
    interactive: bool,
    app: AppHandle,
    tokens: Arc<Mutex<HashMap<String, CachedToken>>>,
) -> Result<String, String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("Google Client ID を設定してください".to_string());
    }
    if !client_id.ends_with(".apps.googleusercontent.com") {
        return Err("Google Client ID の形式が正しくありません".to_string());
    }
    let client_secret = client_secret.trim().to_string();
    if client_secret.is_empty() {
        return Err("Google Client Secret を設定してください".to_string());
    }

    let cached = tokens.lock().ok().and_then(|guard| guard.get(&client_id).cloned());
    if let Some(token) = cached {
        if token.expires_at > unix_now() + 60 {
            return Ok(token.access_token);
        }
        if let Some(refresh_token) = token.refresh_token {
            if let Ok(refreshed) =
                refresh_access_token(&client_id, &client_secret, &refresh_token)
            {
                let access_token = refreshed.access_token.clone();
                if let Ok(mut guard) = tokens.lock() {
                    guard.insert(client_id.clone(), refreshed);
                }
                return Ok(access_token);
            }
        }
        if let Ok(mut guard) = tokens.lock() {
            guard.remove(&client_id);
        }
    }

    if !interactive {
        return Err("「更新」を押してGoogleカレンダーを認証してください".to_string());
    }

    let token = authorize_in_browser(&client_id, &client_secret, &app)?;
    let access_token = token.access_token.clone();
    if let Ok(mut guard) = tokens.lock() {
        guard.insert(client_id, token);
    }
    oauth_log("token cached in application memory");
    Ok(access_token)
}

fn calendar_error_message(body: &str, status: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        });
    match detail {
        Some(detail) => format!("Google Calendar の取得に失敗しました ({status}): {detail}"),
        None => format!("Google Calendar の取得に失敗しました ({status})"),
    }
}

fn fetch_calendar_events(
    access_token: &str,
    calendar_id: &str,
    time_min: &str,
    time_max: &str,
) -> Result<String, String> {
    let mut url = Url::parse("https://www.googleapis.com/calendar/v3/calendars/")
        .map_err(|error| format!("Google Calendar URLを作成できません: {error}"))?;
    url.path_segments_mut()
        .map_err(|_| "Google Calendar URLを作成できません".to_string())?
        .push(if calendar_id.trim().is_empty() {
            "primary"
        } else {
            calendar_id.trim()
        })
        .push("events");
    url.query_pairs_mut()
        .append_pair("timeMin", time_min)
        .append_pair("timeMax", time_max)
        .append_pair("singleEvents", "true")
        .append_pair("orderBy", "startTime")
        .append_pair("fields", "items(id,summary,start,end)");

    let output = Command::new("/usr/bin/curl")
        .args([
            "--silent",
            "--show-error",
            "--connect-timeout",
            "15",
            "--max-time",
            "30",
            "--header",
            &format!("Authorization: Bearer {access_token}"),
            "--write-out",
            "\n%{http_code}",
            url.as_str(),
        ])
        .output()
        .map_err(|error| format!("Google Calendar 通信を開始できません: {error}"))?;

    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "Google Calendar に接続できませんでした".to_string()
        } else {
            format!("Google Calendar 通信に失敗しました: {detail}")
        });
    }

    let output = String::from_utf8(output.stdout)
        .map_err(|_| "Google Calendar から正しい応答が返りませんでした".to_string())?;
    let (body, status) = output
        .rsplit_once('\n')
        .ok_or_else(|| "Google Calendar の応答状態を確認できませんでした".to_string())?;
    if status != "200" {
        return Err(calendar_error_message(body, status));
    }
    Ok(body.to_string())
}

#[tauri::command]
pub async fn google_calendar_access_token(
    client_id: String,
    client_secret: String,
    interactive: bool,
    app: AppHandle,
    state: State<'_, GoogleOAuthState>,
) -> Result<String, String> {
    let tokens = state.tokens.clone();
    tauri::async_runtime::spawn_blocking(move || {
        get_access_token(client_id, client_secret, interactive, app, tokens)
    })
    .await
    .map_err(|error| format!("Google認証処理に失敗しました: {error}"))?
}

#[tauri::command]
pub async fn google_calendar_events(
    client_id: String,
    client_secret: String,
    calendar_id: String,
    time_min: String,
    time_max: String,
    interactive: bool,
    app: AppHandle,
    state: State<'_, GoogleOAuthState>,
) -> Result<String, String> {
    let tokens = state.tokens.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let token = get_access_token(
            client_id.clone(),
            client_secret,
            interactive,
            app,
            tokens.clone(),
        )?;
        match fetch_calendar_events(&token, &calendar_id, &time_min, &time_max) {
            Ok(body) => Ok(body),
            Err(error) => {
                if error.contains("(401)") {
                    if let Ok(mut guard) = tokens.lock() {
                        guard.remove(client_id.trim());
                    }
                    oauth_log("calendar API returned 401; cached token cleared");
                }
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| format!("Google Calendar 処理に失敗しました: {error}"))?
}

#[tauri::command]
pub fn google_calendar_clear_token(
    client_id: String,
    state: State<'_, GoogleOAuthState>,
) -> Result<(), String> {
    let mut guard = state
        .tokens
        .lock()
        .map_err(|_| "Google認証情報を解除できませんでした".to_string())?;
    guard.remove(client_id.trim());
    Ok(())
}
