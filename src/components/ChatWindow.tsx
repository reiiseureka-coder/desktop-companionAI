import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { exit } from "@tauri-apps/api/process";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/api/dialog";
import { readBinaryFile } from "@tauri-apps/api/fs";
import { loadHistory, saveHistory, loadSettings, saveSettings, loadChatSize, saveChatSize } from "../utils/storage";

interface Message {
  id: number;
  role: "user" | "assistant" | "error";
  content: string;
  streaming?: boolean;
}

interface Props {
  characterPosition: { x: number; y: number };
  onClose: () => void;
  onImageChange: (dataUrl: string | null) => void;
  currentImage: string | null;
  charSize: number;
  onSizeChange: (size: number) => void;
}

const MAX_HISTORY = 20;
let msgId = 0;

export default function ChatWindow({ characterPosition, onClose, onImageChange, currentImage, charSize, onSizeChange }: Props) {
  const [messages, setMessages] = useState<Message[]>(() => loadHistory());
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const savedSettings = loadSettings();
  const [workingDir, setWorkingDir] = useState(savedSettings.workingDir);
  const [autoPermissions, setAutoPermissions] = useState(savedSettings.autoPermissions);

  const savedChatSize = loadChatSize();
  const [chatWidth, setChatWidth] = useState(savedChatSize.width);
  const [chatHeight, setChatHeight] = useState(savedChatSize.height);

  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    saveSettings({ workingDir, autoPermissions });
  }, [workingDir, autoPermissions]);

  useEffect(() => {
    saveChatSize({ width: chatWidth, height: chatHeight });
  }, [chatWidth, chatHeight]);

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
    setMessages([]);
    saveHistory([]);
  }, []);

  const dirName = workingDir ? workingDir.split("/").pop() || workingDir : null;

  // Character is at absolute (characterPosition.x, characterPosition.y) from top-left
  // Bubble appears above the character, right-aligned to character's right edge
  const GAP = 12;
  const bubbleLeft = Math.max(8, Math.min(
    characterPosition.x + charSize - chatWidth,
    window.innerWidth - chatWidth - 8
  ));
  const bubbleBottom = window.innerHeight - characterPosition.y + GAP;

  return (
    <div
      className="chat-bubble"
      style={{ left: `${bubbleLeft}px`, bottom: `${bubbleBottom}px`, width: `${chatWidth}px` }}
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
            placeholder={isLoading ? "考え中…" : "メッセージを入力（Enter送信）"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
          />
          <button className="btn-send" onClick={sendMessage} disabled={isLoading || !input.trim()}>
            {isLoading ? "…" : "➤"}
          </button>
        </div>
      </div>
    </div>
  );
}
