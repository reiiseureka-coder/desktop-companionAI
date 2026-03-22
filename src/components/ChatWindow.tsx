import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { loadHistory, saveHistory } from "../utils/storage";

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
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages]);

  // Save history on change (exclude streaming messages)
  useEffect(() => {
    const toSave = messages.filter((m) => !m.streaming).slice(-MAX_HISTORY);
    saveHistory(toSave);
  }, [messages]);

  // Listen for streaming output from Tauri backend
  useEffect(() => {
    const unlisten = listen<string>("claude-output", (event) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.streaming) {
          return [
            ...prev.slice(0, -1),
            { ...last, content: last.content + event.payload },
          ];
        }
        return prev;
      });
    });

    const unlistenDone = listen<string>("claude-done", (event) => {
      setIsLoading(false);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.streaming) {
          return [
            ...prev.slice(0, -1),
            { ...last, streaming: false },
          ];
        }
        return prev;
      });
    });

    const unlistenError = listen<string>("claude-error", (event) => {
      setIsLoading(false);
      setMessages((prev) => {
        // Remove incomplete streaming message if exists
        const filtered = prev[prev.length - 1]?.streaming
          ? prev.slice(0, -1)
          : prev;
        return [
          ...filtered,
          { id: ++msgId, role: "error", content: `エラー: ${event.payload}` },
        ];
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
      await invoke("send_to_claude", { message: text });
    } catch (e) {
      setIsLoading(false);
      setMessages((prev) => {
        const filtered = prev[prev.length - 1]?.streaming
          ? prev.slice(0, -1)
          : prev;
        return [
          ...filtered,
          { id: ++msgId, role: "error", content: `起動エラー: ${String(e)}` },
        ];
      });
    }
  }, [input, isLoading]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
      if (e.key === "Escape") {
        onClose();
      }
    },
    [sendMessage, onClose]
  );

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose]
  );

  const clearHistory = useCallback(() => {
    setMessages([]);
    saveHistory([]);
  }, []);

  return (
    <div
      ref={overlayRef}
      className="chat-overlay"
      onClick={handleOverlayClick}
    >
      <div className="chat-window">
        <div className="chat-header">
          <span>AI Assistant</span>
          <div className="chat-header-actions">
            <button
              className="btn-clear"
              onClick={clearHistory}
              title="履歴をクリア"
            >
              ✕ Clear
            </button>
            <button className="btn-close" onClick={onClose} title="閉じる (ESC)">
              ×
            </button>
          </div>
        </div>

        <div className="chat-log" ref={logRef}>
          {messages.length === 0 && (
            <div className="chat-empty">
              何か質問してください。Claude Codeが回答します。
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

        <div className="chat-input-area">
          <input
            ref={inputRef}
            type="text"
            className="chat-input"
            placeholder="メッセージを入力... (Enter送信 / ESCで閉じる)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
          />
          <button
            className="btn-send"
            onClick={sendMessage}
            disabled={isLoading || !input.trim()}
          >
            {isLoading ? "…" : "送信"}
          </button>
        </div>
      </div>
    </div>
  );
}
