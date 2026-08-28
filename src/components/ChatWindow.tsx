import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { exit } from "@tauri-apps/api/process";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/api/dialog";
import { readBinaryFile } from "@tauri-apps/api/fs";
import { homeDir } from "@tauri-apps/api/path";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/api/notification";
import ReactMarkdown from "react-markdown";
import {
  loadSettings, saveSettings,
  loadChatSize, saveChatSize,
  saveCurrentSession, popCurrentSession, peekCurrentSession,
  loadSessions, saveSessions,
  loadCalendarCache, saveCalendarCache,
  Session, DEFAULT_SYSTEM_PROMPT, MODELS, ModelId, CalendarItem,
  COMPANION_MODES, CompanionMode, ProactiveLevel,
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
  compactCharSize: number;
  onCompactSizeChange: (size: number) => void;
  onToggleVisible: () => void;
}

let msgId = 0;

const CONTEXT_WINDOW = 6;
const CALENDAR_REQUEST_TIMEOUT_MS = 45_000;
const MTG_NOTIFICATIONS = [
  "そろそろMTGだよ",
  "あと5分でMTGだよ",
  "もうすぐMTGの時間だよ",
  "MTGまであと少し。準備できてる？",
];
const MOVE_NOTIFICATIONS = [
  "そろそろ移動の時間だよ",
  "あと5分で移動だよ",
  "もう出る準備しておこうか",
  "移動まであと少しだよ",
];

function formatSessionDate(timestamp: number): string {
  const d = new Date(timestamp);
  const mo = d.getMonth() + 1;
  const da = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${mo}/${da} ${hh}:${mm}`;
}

function getTodayDateKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

function getDayRange(now = new Date()): { start: Date; end: Date } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function formatScheduleTimestamp(timestamp: number | null): string {
  if (!timestamp) return "未更新";
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function normalizeScheduleTag(value: string): string {
  return value.trim().replace(/^【/, "").replace(/】$/, "").trim();
}

function parseScheduleItem(raw: {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
}, scheduleTags: string[]): CalendarItem | null {
  const title = raw.summary?.trim();
  if (!title) return null;

  const kind = scheduleTags.find((tag) => title.startsWith(`【${tag}】`));
  if (!kind || !raw.id || !raw.start) return null;

  const startsAt = raw.start.dateTime ?? raw.start.date;
  if (!startsAt) return null;

  const dateTime = raw.start.dateTime;
  if (!dateTime) {
    return {
      id: raw.id,
      title,
      startsAt,
      startsLabel: "終日",
      kind,
      allDay: true,
    };
  }

  const startsLabel = new Date(dateTime).toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

  return {
    id: raw.id,
    title,
    startsAt,
    startsLabel,
    kind,
    allDay: false,
  };
}

function buildNotificationBody(item: CalendarItem): string {
  if (item.kind !== "MTG" && item.kind !== "移動") {
    return `もうすぐ「${item.kind}」の予定だよ`;
  }
  const pool = item.kind === "MTG" ? MTG_NOTIFICATIONS : MOVE_NOTIFICATIONS;
  return pool[Math.floor(Math.random() * pool.length)] ?? pool[0];
}

function getNextDailySyncDelay(syncTime: string): number {
  const [rawHour, rawMinute] = syncTime.split(":");
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const next = new Date();
  next.setSeconds(0, 0);
  next.setHours(Number.isFinite(hour) ? hour : 9, Number.isFinite(minute) ? minute : 0, 0, 0);
  if (next.getTime() <= Date.now()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - Date.now();
}

export default function ChatWindow({
  chatOpen, characterPosition, onClose, onImageChange,
  currentImage, charSize, onSizeChange, compactCharSize,
  onCompactSizeChange, onToggleVisible,
}: Props) {
  const savedSettings = loadSettings();
  const cachedSchedule = loadCalendarCache();
  const todayKey = getTodayDateKey();

  const [workingDir, setWorkingDir] = useState(savedSettings.workingDir);
  const [autoPermissions, setAutoPermissions] = useState(savedSettings.autoPermissions);
  const [resetOnOpen, setResetOnOpen] = useState(savedSettings.resetOnOpen);
  const [systemPrompt, setSystemPrompt] = useState(savedSettings.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);
  const [model, setModel] = useState<ModelId>(savedSettings.model);
  const [googleClientId, setGoogleClientId] = useState(savedSettings.googleClientId);
  const [googleClientSecret, setGoogleClientSecret] = useState(savedSettings.googleClientSecret);
  const [googleCalendarId, setGoogleCalendarId] = useState(savedSettings.googleCalendarId);
  const [calendarTags, setCalendarTags] = useState(savedSettings.calendarTags);
  const [calendarTagInput, setCalendarTagInput] = useState("");
  const [autoDailyCalendarSync, setAutoDailyCalendarSync] = useState(savedSettings.autoDailyCalendarSync);
  const [dailyCalendarSyncTime, setDailyCalendarSyncTime] = useState(savedSettings.dailyCalendarSyncTime);
  const [companionMode, setCompanionMode] = useState<CompanionMode>(savedSettings.companionMode);
  const [memory, setMemory] = useState(savedSettings.memory);
  const [confirmBeforeActions, setConfirmBeforeActions] = useState(savedSettings.confirmBeforeActions);
  const [proactiveLevel, setProactiveLevel] = useState<ProactiveLevel>(savedSettings.proactiveLevel);

  const [sessions, setSessions] = useState<Session[]>(() => {
    const existing = loadSessions();
    if (!savedSettings.resetOnOpen) return existing;
    const prev = popCurrentSession();
    if (prev.length === 0) return existing;
    const newSessions = [...existing, { id: Date.now(), timestamp: Date.now(), messages: prev }].slice(-3);
    saveSessions(newSessions);
    return newSessions;
  });

  const [messages, setMessages] = useState<Message[]>(() => {
    if (!savedSettings.resetOnOpen) {
      const prev = peekCurrentSession();
      return prev.map((m) => ({ ...m, streaming: false }));
    }
    return [];
  });
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTodaySchedule, setShowTodaySchedule] = useState(false);
  const [scheduleItems, setScheduleItems] = useState<CalendarItem[]>(
    cachedSchedule?.dateKey === todayKey ? cachedSchedule.items : []
  );
  const [scheduleLastSyncedAt, setScheduleLastSyncedAt] = useState<number | null>(
    cachedSchedule?.dateKey === todayKey ? cachedSchedule.lastSyncedAt : null
  );
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [contextStatus, setContextStatus] = useState<string | null>(null);

  const savedChatSize = loadChatSize();
  const [chatWidth, setChatWidth] = useState(savedChatSize.width);
  const [chatHeight, setChatHeight] = useState(savedChatSize.height);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const justEndedCompositionRef = useRef(false);
  const homeDirRef = useRef<string>("");
  const scheduleTimeoutsRef = useRef<number[]>([]);
  const notifiedEventKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    homeDir().then((home) => {
      homeDirRef.current = home;
      if (!workingDir) setWorkingDir(home);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (chatOpen && !showTodaySchedule) inputRef.current?.focus();
  }, [chatOpen, showTodaySchedule]);

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
    saveSettings({
      workingDir,
      autoPermissions,
      resetOnOpen,
      systemPrompt,
      model,
      googleClientId,
      googleClientSecret,
      googleCalendarId,
      calendarTags,
      autoDailyCalendarSync,
      dailyCalendarSyncTime,
      companionMode,
      memory,
      confirmBeforeActions,
      proactiveLevel,
    });
  }, [
    workingDir,
    autoPermissions,
    resetOnOpen,
    systemPrompt,
    model,
    googleClientId,
    googleClientSecret,
    googleCalendarId,
    calendarTags,
    autoDailyCalendarSync,
    dailyCalendarSyncTime,
    companionMode,
    memory,
    confirmBeforeActions,
    proactiveLevel,
  ]);

  useEffect(() => {
    saveChatSize({ width: chatWidth, height: chatHeight });
  }, [chatWidth, chatHeight]);

  useEffect(() => {
    const currentDayKey = getTodayDateKey();
    if (cachedSchedule?.dateKey !== currentDayKey && currentDayKey !== todayKey) {
      setScheduleItems([]);
      setScheduleLastSyncedAt(null);
    }
  }, [cachedSchedule?.dateKey, todayKey]);

  useEffect(() => {
    const unlisten = listen("toggle-visibility", () => {
      onToggleVisible();
    });
    return () => { unlisten.then((f) => f()); };
  }, [onToggleVisible]);

  useEffect(() => {
    const unlisten = listen<string>("codex-output", (event) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.streaming) {
          return [...prev.slice(0, -1), { ...last, content: event.payload }];
        }
        return prev;
      });
    });

    const unlistenDone = listen<string>("codex-done", () => {
      setIsLoading(false);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.streaming) {
          return [...prev.slice(0, -1), { ...last, streaming: false }];
        }
        return prev;
      });
    });

    const unlistenError = listen<string>("codex-error", (event) => {
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

  const ensureNotificationPermission = useCallback(async (): Promise<boolean> => {
    try {
      const granted = await isPermissionGranted();
      if (granted) return true;
      const permission = await requestPermission();
      return permission === "granted";
    } catch {
      return false;
    }
  }, []);

  const refreshSchedule = useCallback(async (interactive: boolean) => {
    setScheduleLoading(true);
    setScheduleError(null);

    try {
      if (!googleClientId.trim()) {
        throw new Error("Google Client ID を設定してください");
      }
      if (!googleClientSecret.trim()) {
        throw new Error("Google Client Secret を設定してください");
      }
      const { start, end } = getDayRange();
      const responseBody = await withTimeout(
        invoke<string>("google_calendar_events", {
          clientId: googleClientId.trim(),
          clientSecret: googleClientSecret.trim(),
          calendarId: googleCalendarId.trim() || "primary",
          timeMin: start.toISOString(),
          timeMax: end.toISOString(),
          interactive,
        }),
        CALENDAR_REQUEST_TIMEOUT_MS,
        "Google Calendar の応答がタイムアウトしました。ネットワーク接続を確認してください"
      );
      const payload = JSON.parse(responseBody) as {
        items?: Array<{
          id?: string;
          summary?: string;
          start?: { dateTime?: string; date?: string };
        }>;
      };

      const items = (payload.items ?? [])
        .map((item) => parseScheduleItem(item, calendarTags))
        .filter((item): item is CalendarItem => item !== null);

      const syncedAt = Date.now();
      setScheduleItems(items);
      setScheduleLastSyncedAt(syncedAt);
      saveCalendarCache({
        dateKey: getTodayDateKey(),
        lastSyncedAt: syncedAt,
        items,
      });
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "予定の取得に失敗しました";
      setScheduleError(message);
    } finally {
      setScheduleLoading(false);
    }
  }, [calendarTags, googleCalendarId, googleClientId, googleClientSecret]);

  useEffect(() => {
    if (!showTodaySchedule) return;
    if (scheduleLastSyncedAt || scheduleLoading) return;
    void refreshSchedule(false);
  }, [showTodaySchedule, scheduleLastSyncedAt, scheduleLoading, refreshSchedule]);

  useEffect(() => {
    if (!autoDailyCalendarSync) return;
    const timeoutId = window.setTimeout(() => {
      void refreshSchedule(false);
    }, getNextDailySyncDelay(dailyCalendarSyncTime));
    return () => window.clearTimeout(timeoutId);
  }, [autoDailyCalendarSync, dailyCalendarSyncTime, refreshSchedule, scheduleLastSyncedAt]);

  useEffect(() => {
    scheduleTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    scheduleTimeoutsRef.current = [];

    if (proactiveLevel === "quiet") return;

    const today = getTodayDateKey();
    if (today !== todayKey) {
      notifiedEventKeysRef.current.clear();
    }

    scheduleItems.forEach((item) => {
      if (item.allDay) return;

      const startsAt = new Date(item.startsAt).getTime();
      const leadMinutes = proactiveLevel === "proactive" ? 15 : 5;
      const notifyAt = startsAt - (leadMinutes * 60 * 1000);
      const now = Date.now();
      const notificationKey = `${todayKey}:${item.id}:${item.startsAt}`;

      if (notifiedEventKeysRef.current.has(notificationKey)) return;
      if (startsAt <= now) return;

      const delay = Math.max(0, notifyAt - now);
      const timeoutId = window.setTimeout(async () => {
        if (notifiedEventKeysRef.current.has(notificationKey)) return;
        const granted = await ensureNotificationPermission();
        if (!granted) return;

        await sendNotification({
          title: item.title,
          body: buildNotificationBody(item),
        });
        notifiedEventKeysRef.current.add(notificationKey);
      }, delay);

      scheduleTimeoutsRef.current.push(timeoutId);
    });

    return () => {
      scheduleTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      scheduleTimeoutsRef.current = [];
    };
  }, [ensureNotificationPermission, proactiveLevel, scheduleItems, todayKey]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    if (autoPermissions && confirmBeforeActions) {
      const approved = window.confirm(
        "Auto実行が有効です。Codexがファイル変更やコマンド実行を行う可能性があります。送信しますか？"
      );
      if (!approved) return;
    }

    setInput("");
    setIsLoading(true);

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
      const modePrompt = COMPANION_MODES.find((entry) => entry.id === companionMode)?.prompt ?? "";
      const memoryPrompt = memory.trim()
        ? `\n\nユーザーが明示的に保存した記憶:\n${memory.trim()}`
        : "";
      await invoke("send_to_codex", {
        message: text,
        context: contextMessages,
        workingDir: workingDir || null,
        autoPermissions,
        systemPrompt: `${systemPrompt.trim()}\n\n現在の作業モード: ${modePrompt}${memoryPrompt}`.trim() || null,
        model: model || null,
        imagePaths: attachedImages.length > 0 ? attachedImages : null,
      });
      setAttachedImages([]);
      setContextStatus(null);
    } catch (e) {
      setIsLoading(false);
      setMessages((prev) => {
        const filtered = prev[prev.length - 1]?.streaming ? prev.slice(0, -1) : prev;
        return [...filtered, { id: ++msgId, role: "error", content: `起動エラー: ${String(e)}` }];
      });
    }
  }, [input, isLoading, messages, workingDir, autoPermissions, confirmBeforeActions, systemPrompt, model, companionMode, memory, attachedImages]);

  const handleStop = useCallback(async () => {
    await invoke("stop_codex").catch(() => {});
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && e.metaKey) {
        if (isComposingRef.current) return;
        e.preventDefault();
        justEndedCompositionRef.current = false;
        sendMessage();
      }
      if (e.key === "Escape") onClose();
    },
    [sendMessage, onClose]
  );

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    justEndedCompositionRef.current = false;
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  const attachCurrentScreen = useCallback(async () => {
    try {
      setContextStatus("画面を取得中…");
      const path = await invoke<string>("capture_current_screen");
      setAttachedImages([path]);
      setContextStatus("現在の画面を添付しました");
      inputRef.current?.focus();
    } catch (error) {
      setContextStatus(String(error));
    }
  }, []);

  const insertClipboardContext = useCallback(async () => {
    try {
      const clipboard = (await invoke<string>("read_clipboard_text")).trim();
      if (!clipboard) {
        setContextStatus("クリップボードにテキストがありません");
        return;
      }
      const clipped = clipboard.slice(0, 12000);
      setInput((current) => `${current}${current ? "\n\n" : ""}[クリップボードからペーストした内容]\n${clipped}`);
      setContextStatus("クリップボードの内容をペーストしました");
      inputRef.current?.focus();
    } catch (error) {
      setContextStatus(String(error));
    }
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
    setShowTodaySchedule(false);
  }, []);

  const toggleSettings = useCallback(() => {
    setShowSettings((current) => {
      const next = !current;
      if (next) setShowTodaySchedule(false);
      return next;
    });
  }, []);

  const toggleTodaySchedule = useCallback(() => {
    setShowTodaySchedule((current) => {
      const next = !current;
      if (next) setShowSettings(false);
      return next;
    });
  }, []);

  const invalidateSchedule = useCallback(() => {
    setScheduleItems([]);
    setScheduleLastSyncedAt(null);
    setScheduleError(null);
    saveCalendarCache({
      dateKey: getTodayDateKey(),
      lastSyncedAt: null,
      items: [],
    });
  }, []);

  const addCalendarTag = useCallback(() => {
    const nextTag = normalizeScheduleTag(calendarTagInput);
    if (!nextTag) return;
    setCalendarTags((current) => current.includes(nextTag) ? current : [...current, nextTag]);
    setCalendarTagInput("");
    invalidateSchedule();
  }, [calendarTagInput, invalidateSchedule]);

  const removeCalendarTag = useCallback((tag: string) => {
    setCalendarTags((current) => current.filter((entry) => entry !== tag));
    invalidateSchedule();
  }, [invalidateSchedule]);

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
        <div className="bubble-header">
          <div className="bubble-header-title">
            <span className="bubble-header-name">
              Shaolon AI
              {dirName && <span className="bubble-header-dir"> / {dirName}</span>}
            </span>
          </div>
          <div className="bubble-header-actions">
            <button
              className={`btn-bubble-icon ${showTodaySchedule ? "active" : ""}`}
              onClick={toggleTodaySchedule}
              title="今日の予定"
            >
              🗓︎
            </button>
            <button
              className={`btn-bubble-icon ${showSettings ? "active" : ""}`}
              onClick={toggleSettings}
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

        {showSettings ? (
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
              <span className="settings-label">
                全画面用（待機時）サイズ ({compactCharSize}px)
              </span>
              <input
                type="range"
                min={24}
                max={100}
                value={compactCharSize}
                onChange={(e) => onCompactSizeChange(Number(e.target.value))}
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
              <span className="settings-label">AIモデル</span>
              <select
                className="settings-select"
                value={model}
                onChange={(e) => setModel(e.target.value as ModelId)}
              >
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
            <div className="settings-row">
              <span className="settings-label">作業モード</span>
              <select
                className="settings-select"
                value={companionMode}
                onChange={(e) => setCompanionMode(e.target.value as CompanionMode)}
              >
                {COMPANION_MODES.map((modeEntry) => (
                  <option key={modeEntry.id} value={modeEntry.id}>{modeEntry.label}</option>
                ))}
              </select>
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
                  <small>（Codexの自動実行モード）</small>
                </span>
              </label>
              {autoPermissions && (
                <div className="settings-warn">
                  ⚠ Codex がコマンド実行やファイル変更を進める場合があります
                </div>
              )}
              {autoPermissions && (
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={confirmBeforeActions}
                    onChange={(e) => setConfirmBeforeActions(e.target.checked)}
                  />
                  <span>
                    送信前に実行確認
                    <small>（Auto実行時の誤操作を防止）</small>
                  </span>
                </label>
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
            <div className="settings-row settings-row--column">
              <div className="settings-label-row">
                <span className="settings-label">Shaolonが覚えておくこと</span>
                <button className="btn-pick btn-pick--small btn-pick--clear" onClick={() => setMemory("")}>消去</button>
              </div>
              <textarea
                className="settings-system-prompt"
                value={memory}
                onChange={(e) => setMemory(e.target.value)}
                rows={4}
                placeholder="好み、仕事の前提、よく使う指示など。ここに書いた内容だけを記憶として利用します。"
              />
            </div>
            <div className="settings-row">
              <span className="settings-label">声かけの頻度</span>
              <select
                className="settings-select"
                value={proactiveLevel}
                onChange={(e) => setProactiveLevel(e.target.value as ProactiveLevel)}
              >
                <option value="quiet">静か（通知なし）</option>
                <option value="standard">標準（5分前）</option>
                <option value="proactive">積極的（15分前）</option>
              </select>
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
        ) : showTodaySchedule ? (
          <div className="schedule-panel">
            <div className="schedule-panel-header">
              <div>
                <div className="schedule-panel-title">今日の予定</div>
                <div className="schedule-panel-meta">
                  最終更新 {formatScheduleTimestamp(scheduleLastSyncedAt)}
                </div>
              </div>
              <button
                className="btn-pick btn-pick--small"
                onClick={() => void refreshSchedule(true)}
                disabled={scheduleLoading}
                title="手動で更新"
              >
                {scheduleLoading ? "更新中…" : "更新"}
              </button>
            </div>

            <div className="schedule-panel-note">
              {calendarTags.length > 0
                ? `${calendarTags.map((tag) => `【${tag}】`).join("・")} から始まる予定だけ表示・通知します`
                : "通知対象ラベルが未設定です"}
            </div>

            {googleClientId.trim() && scheduleError && (
              <div className="schedule-error">{scheduleError}</div>
            )}

            <div className="schedule-config">
              <div className="settings-row settings-row--column">
                <div className="settings-label-row">
                  <span className="settings-label">通知対象ラベル</span>
                </div>
                <div className="schedule-tag-editor">
                  <input
                    className="settings-text-input"
                    value={calendarTagInput}
                    onChange={(e) => setCalendarTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCalendarTag();
                      }
                    }}
                    placeholder="例: アライアンス"
                  />
                  <button
                    className="btn-pick"
                    onClick={addCalendarTag}
                    disabled={!normalizeScheduleTag(calendarTagInput)}
                  >
                    追加
                  </button>
                </div>
                <div className="schedule-tag-help">
                  【】は入れなくてもOK。予定名の先頭にあるラベルと一致します。
                </div>
                <div className="schedule-tag-list">
                  {calendarTags.map((tag) => (
                    <button
                      key={tag}
                      className="schedule-tag-chip"
                      onClick={() => removeCalendarTag(tag)}
                      title={`【${tag}】を削除`}
                    >
                      【{tag}】 <span aria-hidden="true">×</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-row settings-row--column">
                <div className="settings-label-row">
                  <span className="settings-label">Google Client ID</span>
                </div>
                <input
                  className="settings-text-input"
                  value={googleClientId}
                  onChange={(e) => setGoogleClientId(e.target.value)}
                  placeholder="Google OAuth Client ID"
                />
                <div className="schedule-tag-help">
                  更新を押すとSafariまたはChromeでGoogle認証が開きます。
                </div>
              </div>
              <div className="settings-row settings-row--column">
                <div className="settings-label-row">
                  <span className="settings-label">Google Client Secret</span>
                </div>
                <input
                  type="password"
                  className="settings-text-input"
                  value={googleClientSecret}
                  onChange={(e) => setGoogleClientSecret(e.target.value)}
                  placeholder="Google OAuth Client Secret"
                  autoComplete="off"
                />
                <div className="schedule-tag-help">
                  デスクトップ用クライアントの作成画面に表示された値を入力します。
                </div>
              </div>
              <div className="settings-row settings-row--column">
                <div className="settings-label-row">
                  <span className="settings-label">Google Calendar ID</span>
                </div>
                <input
                  className="settings-text-input"
                  value={googleCalendarId}
                  onChange={(e) => setGoogleCalendarId(e.target.value)}
                  placeholder="primary"
                />
              </div>
              <div className="settings-row">
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={autoDailyCalendarSync}
                    onChange={(e) => setAutoDailyCalendarSync(e.target.checked)}
                  />
                  <span>
                    毎日決まった時間に予定を更新
                    <small>（アプリ起動中のみ。初期値は9:00）</small>
                  </span>
                </label>
                <input
                  type="time"
                  className="settings-time-input"
                  value={dailyCalendarSyncTime}
                  onChange={(e) => setDailyCalendarSyncTime(e.target.value)}
                  disabled={!autoDailyCalendarSync}
                />
              </div>
            </div>

            {!googleClientId.trim() && (
              <div className="schedule-empty">
                Google Client ID を設定すると予定を読み込めます
              </div>
            )}

            {googleClientId.trim() && !scheduleError && scheduleItems.length === 0 && !scheduleLoading && (
              <div className="schedule-empty">今日は予定なし</div>
            )}

            <div className="schedule-list">
              {scheduleItems.map((item) => (
                <div key={`${item.id}-${item.startsAt}`} className="schedule-item">
                  <span className="schedule-item-time">{item.startsLabel}</span>
                  <span className="schedule-item-title">{item.title}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <>
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

            <div className="context-toolbar">
              <select
                className="context-mode-select"
                value={companionMode}
                onChange={(e) => setCompanionMode(e.target.value as CompanionMode)}
                title="作業モード"
              >
                {COMPANION_MODES.map((modeEntry) => (
                  <option key={modeEntry.id} value={modeEntry.id}>{modeEntry.label}</option>
                ))}
              </select>
              <button className="btn-context" onClick={attachCurrentScreen} disabled={isLoading} title="現在の画面を添付">
                ◉ 画面
              </button>
              <button className="btn-context" onClick={insertClipboardContext} disabled={isLoading} title="クリップボードの文章を入力欄へペースト">
                ⧉ ペースト
              </button>
              {attachedImages.length > 0 && (
                <button className="btn-context btn-context--active" onClick={() => { setAttachedImages([]); setContextStatus(null); }}>
                  画像 ✓
                </button>
              )}
            </div>
            {contextStatus && <div className="context-status">{contextStatus}</div>}
            <div className="chat-input-area">
              <textarea
                ref={inputRef}
                className="chat-input"
                placeholder={isLoading ? "考え中…" : "メッセージを入力（Enter改行 / Cmd+Enter送信）"}
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
          </>
        )}
      </div>
    </div>
  );
}
