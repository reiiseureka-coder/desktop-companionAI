import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/api/dialog";
import { loadHistory, saveHistory, loadSettings, saveSettings } from "../utils/storage";

interface Message {
  id: number;
  role: "user" | "assistant" | "error";
  content: string;
  streaming?: boolean;
}

interface Props {
  characterPosition: { x: number; y: number };
  onClose: () => void;
}

const MAX_HISTORY = 20;
let msgId = 0;

export default function ChatWindow({ characterPosition, onClose }: Props) {
  const [messages, setMessages] = useState<Message[]>(() => loadHistory());
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const savedSettings = loadSettings();
  const [workingDir, setWorkingDir] = useState(savedSettings.workingDir);
  const [autoPermissions, setAutoPermissions] = useState(savedSettings.autoPermissions);

  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    const toSave = messages.filter((m) => !m.streaming).slice(-MAX_HISTORY);
    saveHistory(toSave);
  }, [messages]);

  // Persist settings on change
  useEffect(() => {
    saveSettings({ workingDir, autoPermissions });
  }, [workingDir, autoPermissions]);

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
        return [...filtered, { id: ++msgId, role: "error", content: `エラー: ${event.payload}` }];
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

    setMessages((prev) => [
      ...prev,
      { id: ++msgId, role: "user", content: text },
      { id: ++msgId, role: "assistant", content: "", streaming: true },
    ]);

    try {
      await invoke("send_to_claude", {
        message: text,
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
  }, [input, isLoading, workingDir, autoPermissions]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
      if (e.key === "Escape") onClose();
    },
    [sendMessage, onClose]
  );

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose]
  );

  const pickDirectory = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "作業ディレクトリを選択" });
      if (typeof selected === "string") {
        setWorkingDir(selected);
      }
    } catch (_) {}
  }, []);

  const clearHistory = useCallback(() => {
    setMessages([]);
    saveHistory([]);
  }, []);

  const dirName = workingDir ? workingDir.split("/").pop() || workingDir : null;

  return (
    <div ref={overlayRef} className="chat-overlay" onClick={handleOverlayClick}>
      <div className="chat-window">
        {/* Header */}
        <div className="chat-header">
          <span>
            AI Assistant
            {dirName && <span className="chat-header-dir"> / {dirName}</span>}
          </span>
          <div className="chat-header-actions">
            <button
              className={`btn-icon ${showSettings ? "active" : ""}`}
              onClick={() => setShowSettings((s) => !s)}
              title="設定"
            >
              ⚙
            </button>
            <button className="btn-clear" onClick={clearHistory} title="履歴をクリア">
              ✕ Clear
            </button>
            <button className="btn-close" onClick={onClose} title="閉じる (ESC)">
              ×
            </button>
          </div>
        </div>

        {/* Settings panel */}
        {showSettings && (
          <div className="settings-panel">
            <div className="settings-row">
              <span className="settings-label">作業ディレクトリ</span>
              <div className="settings-dir-row">
                <span className="settings-dir-path" title={workingDir}>
                  {workingDir || "未設定（カレントディレクトリ）"}
                </span>
                <button className="btn-pick" onClick={pickDirectory}>
                  フォルダ選択
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
                  Auto実行モード
                  <small>（ファイル編集・コマンド実行を自動承認）</small>
                </span>
              </label>
              {autoPermissions && (
                <div className="settings-warn">
                  ⚠ 指定ディレクトリのファイルが自動で変更される場合があります
                </div>
              )}
            </div>
          </div>
        )}

        {/* Chat log */}
        <div className="chat-log" ref={logRef}>
          {messages.length === 0 && (
            <div className="chat-empty">
              {workingDir
                ? `📂 ${dirName} のプロジェクトについて聞いてください`
                : "何か質問してください。Claude Codeが回答します。"}
              {!workingDir && (
                <div className="chat-empty-hint">
                  ⚙ 設定からVSCodeのプロジェクトフォルダを指定すると<br />
                  ファイルの読み書きや実行ができます
                </div>
              )}
            </div>
          )}
          {messages.map((msg) => (
            <div key={msg.id} className={`chat-msg chat-msg--${msg.role}`}>
              <span className="chat-msg-label">
                {msg.role === "user" ? "You" : msg.role === "error" ? "⚠" : "AI"}
              </span>
              <div className="chat-msg-content">
                <pre>{msg.content}</pre>
                {msg.streaming && <span className="cursor-blink">▋</span>}
              </div>
            </div>
          ))}
        </div>

        {/* Input */}
        <div className="chat-input-area">
          <input
            ref={inputRef}
            type="text"
            className="chat-input"
            placeholder={
              autoPermissions
                ? "例: src/App.tsx のバグを直して (Enterで送信)"
                : "メッセージを入力... (Enter送信 / ESCで閉じる)"
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
          />
          <button className="btn-send" onClick={sendMessage} disabled={isLoading || !input.trim()}>
            {isLoading ? "…" : "送信"}
          </button>
        </div>
      </div>
    </div>
  );
}
