import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { exit } from "@tauri-apps/api/process";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/api/dialog";
import { readBinaryFile } from "@tauri-apps/api/fs";
import { homeDir } from "@tauri-apps/api/path";
import ReactMarkdown from "react-markdown";
import {
  loadSettings, saveSettings,
  loadChatSize, saveChatSize,
  saveCurrentSession, popCurrentSession, peekCurrentSession,
  loadSessions, saveSessions,
  Session, DEFAULT_SYSTEM_PROMPT,
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
  const savedSettings = loadSettings();
  const [workingDir, setWorkingDir] = useState(savedSettings.workingDir);
  const [autoPermissions, setAutoPermissions] = useState(savedSettings.autoPermissions);
  const [resetOnOpen, setResetOnOpen] = useState(savedSettings.resetOnOpen);
  const [systemPrompt, setSystemPrompt] = useState(savedSettings.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);

  const [sessions, setSessions] = useState<Session[]>(() => {
    const existing = loadSessions();
    if (!savedSettings.resetOnOpen) return existing;
    // resetOnOpen=trueの場合：前回セッションを履歴に移して新規スタート
    const prev = popCurrentSession();
    if (prev.length === 0) return existing;
    const newSessions = [...existing, { id: Date.now(), timestamp: Date.now(), messages: prev }].slice(-3);
    saveSessions(newSessions);
    return newSessions;
  });

  const [messages, setMessages] = useState<Message[]>(() => {
    // resetOnOpen=falseの場合は前回のセッションを復元
    if (!savedSettings.resetOnOpen) {
      const prev = peekCurrentSession();
      return prev.map((m) => ({ ...m, streaming: false }));
    }
    return [];
  });
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const savedChatSize = loadChatSize();
  const [chatWidth, setChatWidth] = useState(savedChatSize.width);
  const [chatHeight, setChatHeight] = useState(savedChatSize.height);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const justEndedCompositionRef = useRef(false);
  const homeDirRef = useRef<string>("");

  // 作業ディレクトリ未設定ならホームディレクトリをデフォルトに
  useEffect(() => {
    homeDir().then((home) => {
      homeDirRef.current = home;
      if (!workingDir) setWorkingDir(home);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (chatOpen) inputRef.current?.focus();
  }, [chatOpen]);

  // ネイティブDOMイベントでIMEを確実に検出
  // ReactのonCompositionEndはkeydownより遅れることがあるため使わない
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onStart = () => { isComposingRef.current = true; };
    const onEnd = () => {
      isComposingRef.current = false;
      justEndedCompositionRef.current = true;
    };
    el.addEventListener("compositionstart", onStart);
    el.addEventListener("compositionend", onEnd);
    return () => {
      el.removeEventListener("compositionstart", onStart);
      el.removeEventListener("compositionend", onEnd);
    };
  }, []);

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
    saveSettings({ workingDir, autoPermissions, resetOnOpen, systemPrompt });
  }, [workingDir, autoPermissions, resetOnOpen, systemPrompt]);

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
        systemPrompt: systemPrompt.trim() || null,
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
      if (e.key === "Enter" && !e.shiftKey) {
        if (isComposingRef.current) return; // IME入力中は無視
        if (justEndedCompositionRef.current) {
          justEndedCompositionRef.current = false;
          return; // IME変換確定のEnterは送信しない
        }
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

  const dirName = workingDir
    ? (workingDir === homeDirRef.current ? "~" : workingDir.split("/").pop() || workingDir)
    : null;

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
                {workingDir && workingDir !== homeDirRef.current && (
                  <button
                    className="btn-pick btn-pick--clear"
                    title="ホームに戻す"
                    onClick={() => setWorkingDir(homeDirRef.current)}
                  >
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
            <div className="settings-row">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={resetOnOpen}
                  onChange={(e) => setResetOnOpen(e.target.checked)}
                />
                <span>
                  起動時にリセット
                  <small>（OFFで前回の会話を引き継ぎ）</small>
                </span>
              </label>
            </div>
            <div className="settings-row settings-row--column">
              <div className="settings-label-row">
                <span className="settings-label">AIのキャラクター設定</span>
                <button
                  className="btn-pick btn-pick--small"
                  onClick={() => setSystemPrompt(DEFAULT_SYSTEM_PROMPT)}
                >
                  リセット
                </button>
              </div>
              <textarea
                className="settings-system-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={5}
                placeholder="AIへの指示（ペルソナ・役割・口調など）"
              />
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
              {workingDir === homeDirRef.current
                ? "何でも聞いてください！"
                : `📂 ${dirName} について聞いてください`}
              {workingDir === homeDirRef.current && (
                <div className="chat-empty-hint">
                  ⚙ 設定でプロジェクトフォルダを指定すると<br />
                  特定のプロジェクトに絞れます
                </div>
              )}
            </div>
          )}
          {messages.map((msg) => (
            <div key={msg.id} className={`chat-msg chat-msg--${msg.role}`}>
              <div className="chat-msg-content">
                {msg.role === "assistant" ? (
                  <>
                    <div className="markdown"><ReactMarkdown>{msg.content}</ReactMarkdown></div>
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
