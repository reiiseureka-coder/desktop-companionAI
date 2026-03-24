import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { exit } from "@tauri-apps/api/process";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/api/dialog";
import { readBinaryFile } from "@tauri-apps/api/fs";
import ReactMarkdown from "react-markdown";
import {
  loadSettings, saveSettings,
  loadChatSize, saveChatSize,
  saveCurrentSession, popCurrentSession,
  loadSessions, saveSessions,
  Session,
} from "../utils/storage";

interface Message {
  id: number;
  role: "user" | "assistant" | "error";
  content: string;
  streaming?: boolean;
}

interface Props {
  chatOpen: boolean;
  characterPosition: { x: number; y: number };
  onClose: () => void;
  onImageChange: (dataUrl: string | null) => void;
  currentImage: string | null;
  charSize: number;
  onSizeChange: (size: number) => void;
  onToggleVisible: () => void;
}

let msgId = 0;

// How many recent messages to pass as context (user+assistant pairs).
// Keeps token usage low: 3 pairs = up to 6 messages.
const CONTEXT_WINDOW = 6;

function formatSessionDate(timestamp: number): string {
  const d = new Date(timestamp);
  const mo = d.getMonth() + 1;
  const da = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${mo}/${da} ${hh}:${mm}`;
}

export default function ChatWindow({
  chatOpen, characterPosition, onClose, onImageChange,
  currentImage, charSize, onSizeChange, onToggleVisible,
}: Props) {
  const [sessions, setSessions] = useState<Session[]>(() => {
    const prev = popCurrentSession();
    const existing = loadSessions();
    if (prev.length === 0) return existing;
    const newSessions = [...existing, { id: Date.now(), timestamp: Date.now(), messages: prev }].slice(-3);
    saveSessions(newSessions);
    return newSessions;
  });

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const savedSettings = loadSettings();
  const [workingDir, setWorkingDir] = useState(savedSettings.workingDir);
  const [autoPermissions, setAutoPermissions] = useState(savedSettings.autoPermissions);

  const savedChatSize = loadChatSize();
  const [chatWidth, setChatWidth] = useState(savedChatSize.width);
  const [chatHeight, setChatHeight] = useState(savedChatSize.height);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);

  useEffect(() => {
    if (chatOpen) inputRef.current?.focus();
  }, [chatOpen]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    const toSave = messages.filter((m) => !m.streaming);
    saveCurrentSession(toSave);
  }, [messages]);

  useEffect(() => {
    saveSettings({ workingDir, autoPermissions });
  }, [workingDir, autoPermissions]);

  useEffect(() => {
    saveChatSize({ width: chatWidth, height: chatHeight });
  }, [chatWidth, chatHeight]);

  // Listen for global shortcut toggle from Rust
  useEffect(() => {
    const unlisten = listen("toggle-visibility", () => {
      onToggleVisible();
    });
    return () => { unlisten.then((f) => f()); };
  }, [onToggleVisible]);

  // Stream events from Rust backend
  useEffect(() => {
    const unlisten = listen<string>("claude-output", (event) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.streaming) {
          return [...prev.slice(0, -1), { ...last, content: last.content + event.payload }];
        }
        return prev;
      });
    });

    const unlistenDone = listen<string>("claude-done", () => {
      setIsLoading(false);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.streaming) {
          return [...prev.slice(0, -1), { ...last, streaming: false }];
        }
        return prev;
      });
    });

    const unlistenError = listen<string>("claude-error", (event) => {
      setIsLoading(false);
      setMessages((prev) => {
        const filtered = prev[prev.length - 1]?.streaming ? prev.slice(0, -1) : prev;
        return [...filtered, { id: ++msgId, role: "error", content: event.payload }];
      });
    });

    return () => {
      unlisten.then((f) => f());
      unlistenDone.then((f) => f());
      unlistenError.then((f) => f());
    };
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    setInput("");
    setIsLoading(true);

    // Build context: last CONTEXT_WINDOW non-streaming, non-error messages
    const contextMessages = messages
      .filter((m) => !m.streaming && m.role !== "error")
      .slice(-CONTEXT_WINDOW)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    setMessages((prev) => [
      ...prev,
      { id: ++msgId, role: "user", content: text },
      { id: ++msgId, role: "assistant", content: "", streaming: true },
    ]);

    try {
      await invoke("send_to_claude", {
        message: text,
        context: contextMessages,
        workingDir: workingDir || null,
        autoPermissions,
      });
    } catch (e) {
      setIsLoading(false);
      setMessages((prev) => {
        const filtered = prev[prev.length - 1]?.streaming ? prev.slice(0, -1) : prev;
        return [...filtered, { id: ++msgId, role: "error", content: `起動エラー: ${String(e)}` }];
      });
    }
  }, [input, isLoading, messages, workingDir, autoPermissions]);

  const handleStop = useCallback(async () => {
    await invoke("stop_claude").catch(() => {});
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        sendMessage();
      }
      if (e.key === "Escape") onClose();
    },
    [sendMessage, onClose]
  );

  // Auto-resize textarea
  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  const pickImage = useCallback(async () => {
    try {
      const filePath = await open({
        title: "キャラクター画像を選択",
        filters: [{ name: "画像", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
      });
      if (typeof filePath !== "string") return;

      const bytes = await readBinaryFile(filePath);
      const base64 = btoa(
        Array.from(new Uint8Array(bytes))
          .map((b) => String.fromCharCode(b))
          .join("")
      );
      const ext = filePath.split(".").pop()?.toLowerCase() || "png";
      const mime =
        ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : ext === "gif" ? "image/gif"
        : ext === "webp" ? "image/webp"
        : "image/png";
      onImageChange(`data:${mime};base64,${base64}`);
    } catch (_) {}
  }, [onImageChange]);

  const pickDirectory = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "作業ディレクトリを選択" });
      if (typeof selected === "string") {
        setWorkingDir(selected);
      }
    } catch (_) {}
  }, []);

  const clearHistory = useCallback(() => {
    const filtered = messages.filter((m) => !m.streaming);
    if (filtered.length > 0) {
      const newSession: Session = { id: Date.now(), timestamp: Date.now(), messages: filtered };
      setSessions((prev) => {
        const updated = [...prev, newSession].slice(-3);
        saveSessions(updated);
        return updated;
      });
    }
    setMessages([]);
    saveCurrentSession([]);
  }, [messages]);

  const restoreSession = useCallback((session: Session) => {
    setMessages(session.messages.map((m) => ({ ...m, streaming: false })));
    saveCurrentSession(session.messages);
    setShowSettings(false);
  }, []);

  const dirName = workingDir ? workingDir.split("/").pop() || workingDir : null;

  const GAP = 12;
  const bubbleLeft = Math.max(8, Math.min(
    characterPosition.x + charSize - chatWidth,
    window.innerWidth - chatWidth - 8
  ));
  const bubbleBottom = window.innerHeight - characterPosition.y + GAP;

  return (
    <div
      className="chat-bubble"
      style={{
        left: `${bubbleLeft}px`,
        bottom: `${bubbleBottom}px`,
        width: `${chatWidth}px`,
        display: chatOpen ? "block" : "none",
      }}
    >
      <div className="bubble-content" style={{ maxHeight: `${chatHeight}px` }}>
        {/* Header */}
        <div className="bubble-header">
          <div className="bubble-header-title">
            <span className="bubble-header-name">
              AI
              {dirName && <span className="bubble-header-dir"> / {dirName}</span>}
            </span>
          </div>
          <div className="bubble-header-actions">
            <button
              className={`btn-bubble-icon ${showSettings ? "active" : ""}`}
              onClick={() => setShowSettings((s) => !s)}
              title="設定"
            >
              ⚙
            </button>
            <button className="btn-bubble-icon btn-bubble-clear" onClick={clearHistory} title="履歴をクリア">
              🗑
            </button>
            <button className="btn-bubble-close" onClick={onClose} title="閉じる (ESC)">
              ✕
            </button>
            <button className="btn-bubble-quit" onClick={() => exit(0)} title="アプリを終了">
              ⏻
            </button>
          </div>
        </div>

        {/* Settings panel */}
        {showSettings && (
          <div className="settings-panel">
            <div className="settings-row">
              <span className="settings-label">キャラクターサイズ ({charSize}px)</span>
              <input
                type="range"
                min={50}
                max={200}
                value={charSize}
                onChange={(e) => onSizeChange(Number(e.target.value))}
                className="settings-size-slider"
              />
            </div>
            <div className="settings-row">
              <span className="settings-label">チャット幅 ({chatWidth}px)</span>
              <input
                type="range"
                min={280}
                max={600}
                value={chatWidth}
                onChange={(e) => setChatWidth(Number(e.target.value))}
                className="settings-size-slider"
              />
            </div>
            <div className="settings-row">
              <span className="settings-label">チャット高さ ({chatHeight}px)</span>
              <input
                type="range"
                min={250}
                max={700}
                value={chatHeight}
                onChange={(e) => setChatHeight(Number(e.target.value))}
                className="settings-size-slider"
              />
            </div>
            <div className="settings-row">
              <span className="settings-label">キャラクター画像</span>
              <div className="settings-dir-row">
                {currentImage && (
                  <img src={currentImage} className="settings-char-preview" alt="preview" />
                )}
                <button className="btn-pick" onClick={pickImage}>
                  画像を選択
                </button>
                {currentImage && (
                  <button className="btn-pick btn-pick--clear" onClick={() => onImageChange(null)}>
                    ✕
                  </button>
                )}
              </div>
            </div>
            <div className="settings-row">
              <span className="settings-label">作業ディレクトリ</span>
              <div className="settings-dir-row">
                <span className="settings-dir-path" title={workingDir}>
                  {workingDir || "未設定"}
                </span>
                <button className="btn-pick" onClick={pickDirectory}>
                  選択
                </button>
                {workingDir && (
                  <button className="btn-pick btn-pick--clear" onClick={() => setWorkingDir("")}>
                    ✕
                  </button>
                )}
              </div>
            </div>
            <div className="settings-row">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={autoPermissions}
                  onChange={(e) => setAutoPermissions(e.target.checked)}
                />
                <span>
                  Auto実行
                  <small>（自動承認モード）</small>
                </span>
              </label>
              {autoPermissions && (
                <div className="settings-warn">
                  ⚠ ファイルが自動で変更される場合があります
                </div>
              )}
            </div>
            {sessions.length > 0 && (
              <div className="settings-row">
                <span className="settings-label">過去の会話</span>
                <div className="session-list">
                  {sessions.slice().reverse().map((s) => {
                    const userCount = s.messages.filter((m) => m.role === "user").length;
                    const preview = s.messages.find((m) => m.role === "user")?.content.slice(0, 20) || "";
                    return (
                      <button key={s.id} className="btn-session" onClick={() => restoreSession(s)}>
                        <span className="btn-session-date">{formatSessionDate(s.timestamp)}</span>
                        <span className="btn-session-preview">「{preview}…」({userCount}件)</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Chat log */}
        <div className="chat-log" ref={logRef}>
          {messages.length === 0 && (
            <div className="chat-empty">
              {workingDir
                ? `📂 ${dirName} について聞いてください`
                : "何でも聞いてください！"}
              {!workingDir && (
                <div className="chat-empty-hint">
                  ⚙ 設定からプロジェクトフォルダを指定すると<br />
                  ファイルの読み書きができます
                </div>
              )}
            </div>
          )}
          {messages.map((msg) => (
            <div key={msg.id} className={`chat-msg chat-msg--${msg.role}`}>
              <div className="chat-msg-content">
                {msg.role === "assistant" ? (
                  <>
                    <ReactMarkdown className="markdown">{msg.content}</ReactMarkdown>
                    {msg.streaming && <span className="cursor-blink">▋</span>}
                  </>
                ) : (
                  <>
                    <pre>{msg.content}</pre>
                    {msg.streaming && <span className="cursor-blink">▋</span>}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Input */}
        <div className="chat-input-area">
          <textarea
            ref={inputRef}
            className="chat-input"
            placeholder={isLoading ? "考え中…" : "メッセージを入力（Enter送信 / Shift+Enter改行）"}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => { isComposingRef.current = false; }}
            disabled={isLoading}
            rows={1}
          />
          {isLoading ? (
            <button className="btn-stop" onClick={handleStop} title="中断">
              ■
            </button>
          ) : (
            <button className="btn-send" onClick={sendMessage} disabled={!input.trim()}>
              ➤
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
