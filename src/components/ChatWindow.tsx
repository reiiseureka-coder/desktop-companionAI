import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { exit } from "@tauri-apps/api/process";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/api/dialog";
import { readBinaryFile } from "@tauri-apps/api/fs";
import { homeDir } from "@tauri-apps/api/path";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/api/notification";
import { getVersion } from "@tauri-apps/api/app";
import { appWindow } from "@tauri-apps/api/window";
import ReactMarkdown from "react-markdown";
import {
  loadSettings, saveSettings,
  loadChatSize, saveChatSize,
  saveCurrentSession, popCurrentSession, peekCurrentSession,
  loadSessions, saveSessions,
  loadCalendarCache, saveCalendarCache,
  loadTaskMemo, saveTaskMemo, TASK_REMINDER_TIMES,
  loadFavoriteMessages, saveFavoriteMessages,
  loadPromptTemplates, savePromptTemplates,
  Session, DEFAULT_SYSTEM_PROMPT, MODELS, ModelId, CalendarItem, TaskMemoItem,
  COMPANION_MODES, CompanionMode, ProactiveLevel,
  FavoriteMessage, PromptTemplate, DailySupportSetting,
} from "../utils/storage";

interface Message {
  id: number;
  role: "user" | "assistant" | "error";
  content: string;
  streaming?: boolean;
}

interface RuntimeDiagnostics {
  codex_found: boolean;
  codex_version: string;
  working_directory_ok: boolean;
  git_repository: boolean;
  git_remote: string;
}

interface DiagnosticsView extends RuntimeDiagnostics {
  appVersion: string;
  notificationGranted: boolean;
  shortcutReady: boolean;
}

const SLASH_COMMANDS = [
  { command: "/task ", label: "タスクを追加", example: "/task 資料を確認する" },
  { command: "/remind ", label: "時刻つきタスク", example: "/remind 15:30 先方へ連絡" },
  { command: "/today", label: "今日のタスクを開く", example: "/today" },
  { command: "/history ", label: "履歴を検索", example: "/history 昨日の相談" },
  { command: "/template ", label: "依頼テンプレートを保存", example: "/template 校正 | この文章を校正して" },
  { command: "/diagnostics", label: "診断画面を開く", example: "/diagnostics" },
  { command: "/clear", label: "現在の会話を整理", example: "/clear" },
] as const;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

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

function getNextTaskReminderDelay(reminderTime: string): number {
  const [rawHour, rawMinute] = reminderTime.split(":");
  const next = new Date();
  next.setSeconds(0, 0);
  next.setHours(Number(rawHour), Number(rawMinute), 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next.getTime() - Date.now();
}

export default function ChatWindow({
  chatOpen, characterPosition, onClose, onImageChange,
  currentImage, charSize, onSizeChange, compactCharSize,
  onCompactSizeChange, onToggleVisible,
}: Props) {
  const savedSettings = loadSettings();
  const cachedSchedule = loadCalendarCache();
  const initialTodayKey = getTodayDateKey();
  const [todayKey, setTodayKey] = useState(initialTodayKey);

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
  const [showGoogleCalendarIntegration, setShowGoogleCalendarIntegration] = useState(
    savedSettings.showGoogleCalendarIntegration
  );
  const [taskReminderTimes, setTaskReminderTimes] = useState(savedSettings.taskReminderTimes);
  const [companionMode, setCompanionMode] = useState<CompanionMode>(savedSettings.companionMode);
  const [memory, setMemory] = useState(savedSettings.memory);
  const [proactiveLevel, setProactiveLevel] = useState<ProactiveLevel>(savedSettings.proactiveLevel);
  const [dailySupports, setDailySupports] = useState<DailySupportSetting[]>(savedSettings.dailySupports);

  const [sessions, setSessions] = useState<Session[]>(() => {
    const existing = loadSessions();
    if (!savedSettings.resetOnOpen) return existing;
    const prev = popCurrentSession();
    if (prev.length === 0) return existing;
    const newSessions = [...existing, { id: Date.now(), timestamp: Date.now(), messages: prev }].slice(-30);
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
  const [showTaskMemo, setShowTaskMemo] = useState(false);
  const [scheduleItems, setScheduleItems] = useState<CalendarItem[]>(
    cachedSchedule?.dateKey === todayKey ? cachedSchedule.items : []
  );
  const [scheduleLastSyncedAt, setScheduleLastSyncedAt] = useState<number | null>(
    cachedSchedule?.dateKey === todayKey ? cachedSchedule.lastSyncedAt : null
  );
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [taskMemos, setTaskMemos] = useState<TaskMemoItem[]>(() => loadTaskMemo(initialTodayKey));
  const [taskMemoInput, setTaskMemoInput] = useState("");
  const [taskMemoStatus, setTaskMemoStatus] = useState<string | null>(null);
  const [taskReminderDraft, setTaskReminderDraft] = useState("10:00");
  const [attachedPaths, setAttachedPaths] = useState<string[]>([]);
  const [fileDropActive, setFileDropActive] = useState(false);
  const [contextStatus, setContextStatus] = useState<string | null>(null);
  const [activeTaskActionId, setActiveTaskActionId] = useState<string | null>(null);
  const [favoriteMessages, setFavoriteMessages] = useState<FavoriteMessage[]>(() => loadFavoriteMessages());
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplate[]>(() => loadPromptTemplates());
  const [historySearch, setHistorySearch] = useState("");
  const [templateLabel, setTemplateLabel] = useState("");
  const [templateContent, setTemplateContent] = useState("");
  const [diagnostics, setDiagnostics] = useState<DiagnosticsView | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [showCommandList, setShowCommandList] = useState(false);

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
  const scheduleRequestInFlightRef = useRef(false);
  const calendarAutoRefreshAttemptedRef = useRef(false);
  const taskReminderTimeoutsRef = useRef<number[]>([]);
  const perTaskReminderTimeoutsRef = useRef<number[]>([]);
  const dailySupportTimeoutsRef = useRef<number[]>([]);

  useEffect(() => {
    homeDir().then((home) => {
      homeDirRef.current = home;
      if (!workingDir) setWorkingDir(home);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (chatOpen && !showTodaySchedule && !showTaskMemo) inputRef.current?.focus();
  }, [chatOpen, showTaskMemo, showTodaySchedule]);

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
    const unlisten = appWindow.onFileDropEvent((event) => {
      if (event.payload.type === "hover") {
        setFileDropActive(true);
        return;
      }
      if (event.payload.type === "cancel") {
        setFileDropActive(false);
        return;
      }
      setFileDropActive(false);
      if (event.payload.type !== "drop") return;
      const paths = event.payload.paths.filter(Boolean).slice(0, 5);
      if (paths.length === 0) return;
      setAttachedPaths((current) => [...new Set([...current, ...paths])].slice(0, 5));
      setContextStatus(`${paths.length}件のファイルを添付しました`);
    });
    return () => { unlisten.then((dispose) => dispose()); };
  }, []);

  useEffect(() => {
    saveFavoriteMessages(favoriteMessages);
  }, [favoriteMessages]);

  useEffect(() => {
    savePromptTemplates(promptTemplates);
  }, [promptTemplates]);

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
      showGoogleCalendarIntegration,
      taskReminderTimes,
      companionMode,
      memory,
      proactiveLevel,
      dailySupports,
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
    showGoogleCalendarIntegration,
    taskReminderTimes,
    companionMode,
    memory,
    proactiveLevel,
    dailySupports,
  ]);

  useEffect(() => {
    saveChatSize({ width: chatWidth, height: chatHeight });
  }, [chatWidth, chatHeight]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const currentDayKey = getTodayDateKey();
      setTodayKey((current) => current === currentDayKey ? current : currentDayKey);
    }, 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    setTaskMemos(loadTaskMemo(todayKey));
    if (cachedSchedule?.dateKey !== todayKey) {
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
    if (scheduleRequestInFlightRef.current) return;
    scheduleRequestInFlightRef.current = true;
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
      scheduleRequestInFlightRef.current = false;
      setScheduleLoading(false);
    }
  }, [calendarTags, googleCalendarId, googleClientId, googleClientSecret]);

  useEffect(() => {
    if (!showTodaySchedule || !showGoogleCalendarIntegration) {
      calendarAutoRefreshAttemptedRef.current = false;
      return;
    }
    if (
      scheduleLastSyncedAt
      || scheduleLoading
      || calendarAutoRefreshAttemptedRef.current
    ) return;
    calendarAutoRefreshAttemptedRef.current = true;
    void refreshSchedule(false);
  }, [showTodaySchedule, showGoogleCalendarIntegration, scheduleLastSyncedAt, scheduleLoading, refreshSchedule]);

  useEffect(() => {
    if (!showGoogleCalendarIntegration || !autoDailyCalendarSync) return;
    const timeoutId = window.setTimeout(() => {
      void refreshSchedule(false);
    }, getNextDailySyncDelay(dailyCalendarSyncTime));
    return () => window.clearTimeout(timeoutId);
  }, [showGoogleCalendarIntegration, autoDailyCalendarSync, dailyCalendarSyncTime, refreshSchedule, scheduleLastSyncedAt]);

  useEffect(() => {
    scheduleTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    scheduleTimeoutsRef.current = [];

    if (!showGoogleCalendarIntegration || proactiveLevel === "quiet") return;

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
  }, [ensureNotificationPermission, proactiveLevel, scheduleItems, showGoogleCalendarIntegration, todayKey]);

  useEffect(() => {
    taskReminderTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    taskReminderTimeoutsRef.current = [];
    let cancelled = false;

    const scheduleNextReminder = (reminderTime: string) => {
      if (cancelled) return;
      const timeoutId = window.setTimeout(async () => {
        const granted = await ensureNotificationPermission();
        if (granted) {
          const pending = taskMemos.filter((item) => !item.completed);
          const preview = pending.slice(0, 2).map((item) => item.text).join(" / ");
          await sendNotification({
            title: "Shaolon AIのタスクメモ",
            body: pending.length > 0
              ? `未完了${pending.length}件：${preview}`
              : "今日のタスクを確認しよう",
          });
        }
        scheduleNextReminder(reminderTime);
      }, getNextTaskReminderDelay(reminderTime));
      taskReminderTimeoutsRef.current.push(timeoutId);
    };

    taskReminderTimes.forEach(scheduleNextReminder);
    return () => {
      cancelled = true;
      taskReminderTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      taskReminderTimeoutsRef.current = [];
    };
  }, [ensureNotificationPermission, taskMemos, taskReminderTimes]);

  useEffect(() => {
    perTaskReminderTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    perTaskReminderTimeoutsRef.current = [];
    let cancelled = false;

    taskMemos.filter((item) => !item.completed && (item.reminderTime || item.snoozedUntil)).forEach((item) => {
      const delay = item.snoozedUntil && item.snoozedUntil > Date.now()
        ? item.snoozedUntil - Date.now()
        : item.reminderTime
          ? getNextTaskReminderDelay(item.reminderTime)
          : 0;
      if (delay <= 0) return;
      const timeoutId = window.setTimeout(async () => {
        if (cancelled) return;
        const granted = await ensureNotificationPermission();
        if (granted) {
          await sendNotification({
            title: "Shaolon AI：タスクの時間です",
            body: `${item.text}（アプリで「完了」または「10分後」を選べます）`,
          });
        }
        setActiveTaskActionId(item.id);
        if (item.snoozedUntil) {
          setTaskMemos((current) => {
            const next = current.map((entry) => entry.id === item.id ? { ...entry, snoozedUntil: null } : entry);
            saveTaskMemo(todayKey, next);
            return next;
          });
        }
      }, delay);
      perTaskReminderTimeoutsRef.current.push(timeoutId);
    });

    return () => {
      cancelled = true;
      perTaskReminderTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      perTaskReminderTimeoutsRef.current = [];
    };
  }, [ensureNotificationPermission, taskMemos, todayKey]);

  useEffect(() => {
    dailySupportTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    dailySupportTimeoutsRef.current = [];
    let cancelled = false;

    const scheduleSupport = (support: DailySupportSetting) => {
      if (cancelled || !support.enabled) return;
      const timeoutId = window.setTimeout(async () => {
        const pending = taskMemos.filter((item) => !item.completed);
        const priority = pending.filter((item) => item.priority);
        const granted = await ensureNotificationPermission();
        if (granted) {
          const body = support.id === "morning"
            ? pending.length > 0
              ? `今日の未完了は${pending.length}件。最優先は「${(priority[0] ?? pending[0]).text}」です。`
              : "今日のタスクを決めて、気持ちよく始めよう。"
            : support.id === "midday"
              ? pending.length > 0
                ? `残り${pending.length}件です。次は「${(priority[0] ?? pending[0]).text}」からどう？`
                : "今日のタスクは完了しています。お疲れさま！"
              : pending.length > 0
                ? `未完了${pending.length}件。明日へ自動で引き継ぎます。`
                : "今日のタスクはすべて完了。お疲れさまでした！";
          await sendNotification({ title: `Shaolon AI：${support.label}`, body });
        }
        scheduleSupport(support);
      }, getNextTaskReminderDelay(support.time));
      dailySupportTimeoutsRef.current.push(timeoutId);
    };

    dailySupports.forEach(scheduleSupport);
    return () => {
      cancelled = true;
      dailySupportTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      dailySupportTimeoutsRef.current = [];
    };
  }, [dailySupports, ensureNotificationPermission, taskMemos]);

  const createTaskMemo = useCallback((rawText: string, reminderTime: string | null = null, priority = false) => {
    const text = rawText.trim();
    if (!text) return false;
    let added = false;
    setTaskMemos((current) => {
      const priorityCount = current.filter((item) => item.priority && !item.completed).length;
      const shouldPrioritize = priority && priorityCount < 3;
      const next = [
        ...current,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          text,
          completed: false,
          createdAt: Date.now(),
          priority: shouldPrioritize,
          reminderTime,
          snoozedUntil: null,
          carriedFrom: null,
        },
      ];
      saveTaskMemo(todayKey, next);
      added = true;
      return next;
    });
    if (reminderTime) void ensureNotificationPermission();
    return added;
  }, [ensureNotificationPermission, todayKey]);

  const refreshDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true);
    try {
      const [runtime, appVersion, notificationGranted, shortcutStatuses] = await Promise.all([
        invoke<RuntimeDiagnostics>("runtime_diagnostics", { workingDir: workingDir || null }),
        getVersion(),
        isPermissionGranted().catch(() => false),
        invoke<string[]>("ensure_global_shortcuts").catch(() => []),
      ]);
      setDiagnostics({
        ...runtime,
        appVersion,
        notificationGranted,
        shortcutReady: shortcutStatuses.some((status) => status.startsWith("registered:")),
      });
    } catch (error) {
      setContextStatus(`診断に失敗しました：${String(error)}`);
    } finally {
      setDiagnosticsLoading(false);
    }
  }, [workingDir]);

  const executeLocalCommand = useCallback((rawText: string): boolean => {
    const text = rawText.trim();
    const taskMatch = text.match(/^\/(?:task|memo)\s+(.+)$/s)
      ?? text.match(/^タスク(?:に)?追加[：:]\s*(.+)$/s);
    if (taskMatch) {
      createTaskMemo(taskMatch[1]);
      setInput("");
      setContextStatus("今日のタスクへ追加しました");
      return true;
    }

    if (/これ.*タスク.*追加/.test(text)) {
      const lastAnswer = [...messages].reverse().find((message) => message.role === "assistant" && message.content.trim());
      if (lastAnswer) {
        const summary = lastAnswer.content.split("\n").find((line) => line.trim())?.replace(/^#+\s*/, "").slice(0, 120);
        if (summary) {
          createTaskMemo(summary);
          setInput("");
          setContextStatus("直前の回答をタスクへ追加しました");
          return true;
        }
      }
    }

    const remindMatch = text.match(/^\/remind\s+((?:[01]\d|2[0-3]):[0-5]\d)(?:\s+(.+))?$/s);
    if (remindMatch) {
      const [, time, taskText] = remindMatch;
      if (taskText?.trim()) {
        createTaskMemo(taskText, time);
        setContextStatus(`${time}の通知つきタスクを追加しました`);
      } else if (TASK_REMINDER_TIMES.includes(time)) {
        setTaskReminderTimes((current) => [...new Set([...current, time])].sort());
        void ensureNotificationPermission();
        setContextStatus(`${time}の定時リマインドを追加しました`);
      } else {
        setContextStatus("内容も入力してください。例：/remind 15:30 先方へ連絡");
      }
      setInput("");
      return true;
    }

    if (text === "/today") {
      setShowTaskMemo(true);
      setShowTodaySchedule(false);
      setShowSettings(false);
      setInput("");
      return true;
    }

    if (text.startsWith("/history")) {
      setHistorySearch(text.slice("/history".length).trim());
      setShowSettings(true);
      setShowTaskMemo(false);
      setShowTodaySchedule(false);
      setInput("");
      return true;
    }

    if (text.startsWith("/template ")) {
      const [label, ...contentParts] = text.slice("/template ".length).split("|");
      const content = contentParts.join("|").trim();
      if (!label.trim() || !content) {
        setContextStatus("例：/template 校正 | この文章を校正して");
      } else {
        setPromptTemplates((current) => [...current, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          label: label.trim(),
          content,
          createdAt: Date.now(),
        }]);
        setContextStatus(`「${label.trim()}」をテンプレートへ保存しました`);
      }
      setInput("");
      return true;
    }

    if (text === "/diagnostics") {
      setShowSettings(true);
      setShowTaskMemo(false);
      setShowTodaySchedule(false);
      setInput("");
      void refreshDiagnostics();
      return true;
    }

    if (text === "/clear") {
      const filtered = messages.filter((message) => !message.streaming);
      if (filtered.length > 0) {
        setSessions((current) => {
          const next = [...current, { id: Date.now(), timestamp: Date.now(), messages: filtered }].slice(-30);
          saveSessions(next);
          return next;
        });
      }
      setMessages([]);
      setInput("");
      saveCurrentSession([]);
      return true;
    }

    return false;
  }, [createTaskMemo, ensureNotificationPermission, messages, refreshDiagnostics]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    if (executeLocalCommand(text)) return;

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
      const imagePaths = attachedPaths.filter((path) => IMAGE_EXTENSIONS.has(path.split(".").pop()?.toLowerCase() ?? ""));
      const documentPaths = attachedPaths.filter((path) => !imagePaths.includes(path));
      const attachmentPrompt = documentPaths.length > 0
        ? `\n\n添付ファイルを確認してください:\n${documentPaths.map((path) => `- ${path}`).join("\n")}`
        : "";
      await invoke("send_to_codex", {
        message: `${text}${attachmentPrompt}`,
        context: contextMessages,
        workingDir: workingDir || null,
        autoPermissions,
        systemPrompt: `${systemPrompt.trim()}\n\n現在の作業モード: ${modePrompt}${memoryPrompt}`.trim() || null,
        model: model || null,
        imagePaths: imagePaths.length > 0 ? imagePaths : null,
      });
      setAttachedPaths([]);
      setContextStatus(null);
    } catch (e) {
      setIsLoading(false);
      setMessages((prev) => {
        const filtered = prev[prev.length - 1]?.streaming ? prev.slice(0, -1) : prev;
        return [...filtered, { id: ++msgId, role: "error", content: `起動エラー: ${String(e)}` }];
      });
    }
  }, [attachedPaths, autoPermissions, companionMode, executeLocalCommand, input, isLoading, memory, messages, model, systemPrompt, workingDir]);

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

  const resizeInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  useEffect(() => {
    resizeInput();
  }, [input, resizeInput]);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    justEndedCompositionRef.current = false;
    setInput(e.target.value);
  }, []);

  const attachCurrentScreen = useCallback(async () => {
    try {
      setContextStatus("画面を取得中…");
      const path = await invoke<string>("capture_current_screen");
      setAttachedPaths([path]);
      setContextStatus("現在の画面を添付しました");
      inputRef.current?.focus();
    } catch (error) {
      setContextStatus(String(error));
    }
  }, []);

  const copyLatestMessage = useCallback(async () => {
    const latestMessage = [...messages].reverse().find((message) => (
      message.role === "assistant" && !message.streaming && message.content.trim()
    )) ?? [...messages].reverse().find((message) => !message.streaming && message.content.trim());
    if (!latestMessage) {
      setContextStatus("コピーできる直前のやりとりがありません");
      return;
    }
    try {
      await invoke("write_clipboard_text", { text: latestMessage.content });
      setContextStatus(latestMessage.role === "assistant"
        ? "直前のAI回答をコピーしました"
        : "直前のメッセージをコピーしました");
    } catch (error) {
      setContextStatus(String(error));
    }
  }, [messages]);

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
        const updated = [...prev, newSession].slice(-30);
        saveSessions(updated);
        return updated;
      });
    }
    setMessages([]);
    setInput("");
    saveCurrentSession([]);
    window.requestAnimationFrame(resizeInput);
  }, [messages, resizeInput]);

  const restoreSession = useCallback((session: Session) => {
    setMessages(session.messages.map((m) => ({ ...m, streaming: false })));
    saveCurrentSession(session.messages);
    setShowSettings(false);
    setShowTodaySchedule(false);
    setShowTaskMemo(false);
  }, []);

  const toggleSettings = useCallback(() => {
    setShowSettings((current) => {
      const next = !current;
      if (next) {
        setShowTodaySchedule(false);
        setShowTaskMemo(false);
      }
      return next;
    });
  }, []);

  const toggleTodaySchedule = useCallback(() => {
    setShowTodaySchedule((current) => {
      const next = !current;
      if (next) {
        setShowSettings(false);
        setShowTaskMemo(false);
      }
      return next;
    });
  }, []);

  const toggleTaskMemoPanel = useCallback(() => {
    setShowTaskMemo((current) => {
      const next = !current;
      if (next) {
        setShowSettings(false);
        setShowTodaySchedule(false);
      }
      return next;
    });
  }, []);

  const returnToChat = useCallback(() => {
    setShowSettings(false);
    setShowTodaySchedule(false);
    setShowTaskMemo(false);
    window.requestAnimationFrame(() => inputRef.current?.focus());
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

  const addTaskMemo = useCallback(() => {
    const text = taskMemoInput.trim();
    if (!text) return;
    createTaskMemo(text);
    setTaskMemoInput("");
  }, [createTaskMemo, taskMemoInput]);

  const toggleTaskMemo = useCallback((id: string) => {
    setTaskMemos((current) => {
      const next = current.map((item) => item.id === id
        ? { ...item, completed: !item.completed, snoozedUntil: null }
        : item);
      saveTaskMemo(todayKey, next);
      return next;
    });
    if (activeTaskActionId === id) setActiveTaskActionId(null);
  }, [activeTaskActionId, todayKey]);

  const toggleTaskPriority = useCallback((id: string) => {
    setTaskMemos((current) => {
      const target = current.find((item) => item.id === id);
      if (!target) return current;
      if (!target.priority && current.filter((item) => item.priority && !item.completed).length >= 3) {
        setTaskMemoStatus("最優先タスクは3件までです");
        return current;
      }
      const next = current.map((item) => item.id === id ? { ...item, priority: !item.priority } : item);
      saveTaskMemo(todayKey, next);
      setTaskMemoStatus(null);
      return next;
    });
  }, [todayKey]);

  const updateTaskReminder = useCallback((id: string, reminderTime: string) => {
    setTaskMemos((current) => {
      const next = current.map((item) => item.id === id
        ? { ...item, reminderTime: reminderTime || null, snoozedUntil: null }
        : item);
      saveTaskMemo(todayKey, next);
      return next;
    });
    if (reminderTime) void ensureNotificationPermission();
  }, [ensureNotificationPermission, todayKey]);

  const snoozeTask = useCallback((id: string) => {
    const snoozedUntil = Date.now() + (10 * 60 * 1000);
    setTaskMemos((current) => {
      const next = current.map((item) => item.id === id ? { ...item, snoozedUntil } : item);
      saveTaskMemo(todayKey, next);
      return next;
    });
    setActiveTaskActionId(null);
    setTaskMemoStatus("10分後にもう一度通知します");
    void ensureNotificationPermission();
  }, [ensureNotificationPermission, todayKey]);

  const removeTaskMemo = useCallback((id: string) => {
    setTaskMemos((current) => {
      const next = current.filter((item) => item.id !== id);
      saveTaskMemo(todayKey, next);
      return next;
    });
    if (activeTaskActionId === id) setActiveTaskActionId(null);
  }, [activeTaskActionId, todayKey]);

  const toggleFavoriteMessage = useCallback((content: string) => {
    setFavoriteMessages((current) => {
      const existing = current.find((item) => item.content === content);
      if (existing) return current.filter((item) => item.id !== existing.id);
      return [...current, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        content,
        createdAt: Date.now(),
      }];
    });
  }, []);

  const toggleSessionFavorite = useCallback((id: number) => {
    setSessions((current) => {
      const next = current.map((session) => session.id === id
        ? { ...session, favorite: !session.favorite }
        : session);
      saveSessions(next);
      return next;
    });
  }, []);

  const addPromptTemplate = useCallback(() => {
    const label = templateLabel.trim();
    const content = templateContent.trim();
    if (!label || !content) return;
    setPromptTemplates((current) => [...current, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      label,
      content,
      createdAt: Date.now(),
    }]);
    setTemplateLabel("");
    setTemplateContent("");
  }, [templateContent, templateLabel]);

  const usePromptTemplate = useCallback((template: PromptTemplate) => {
    setInput(template.content);
    returnToChat();
  }, [returnToChat]);

  const addTaskReminderTime = useCallback(() => {
    if (taskReminderTimes.includes(taskReminderDraft)) return;
    setTaskReminderTimes((current) => [...current, taskReminderDraft].sort());
    void ensureNotificationPermission();
  }, [ensureNotificationPermission, taskReminderDraft, taskReminderTimes]);

  const removeTaskReminderTime = useCallback((time: string) => {
    setTaskReminderTimes((current) => current.filter((entry) => entry !== time));
  }, []);

  const activeTaskAction = taskMemos.find((item) => item.id === activeTaskActionId && !item.completed) ?? null;
  const sortedTaskMemos = [...taskMemos].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (Boolean(a.priority) !== Boolean(b.priority)) return a.priority ? -1 : 1;
    return a.createdAt - b.createdAt;
  });
  const normalizedHistorySearch = historySearch.trim().toLowerCase();
  const historyDateKey = normalizedHistorySearch === "今日"
    ? getTodayDateKey()
    : normalizedHistorySearch === "昨日"
      ? getTodayDateKey(new Date(Date.now() - (24 * 60 * 60 * 1000)))
      : null;
  const filteredSessions = sessions
    .filter((session) => {
      if (historyDateKey) return getTodayDateKey(new Date(session.timestamp)) === historyDateKey;
      return !normalizedHistorySearch || session.messages.some((message) => (
        message.content.toLowerCase().includes(normalizedHistorySearch)
      ));
    })
    .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || b.timestamp - a.timestamp);
  const slashSuggestions = input.startsWith("/") && !input.includes("\n")
    ? SLASH_COMMANDS.filter((entry) => (
      entry.command.trim().startsWith(input.trim().split(/\s/)[0])
      || entry.label.includes(input.slice(1))
    )).slice(0, 6)
    : [];
  const visibleCommands = showCommandList ? SLASH_COMMANDS : slashSuggestions;

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
              className={`btn-bubble-icon ${showTaskMemo ? "active" : ""}`}
              onClick={toggleTaskMemoPanel}
              title="タスクメモ"
            >
              📝
            </button>
            <button
              className={`btn-bubble-icon ${showTodaySchedule ? "active" : ""}`}
              onClick={toggleTodaySchedule}
              title="Google Calendar"
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
            <button className="btn-bubble-icon" onClick={returnToChat} title="チャットに戻る">
              ↩
            </button>
            <button className="btn-bubble-quit" onClick={() => exit(0)} title="アプリを終了">
              ⏻
            </button>
          </div>
        </div>

        <section className={`settings-panel panel-view ${showSettings ? "" : "panel-view--hidden"}`} aria-hidden={!showSettings}>
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
            <div className="settings-row settings-card">
              <span className="settings-label">会話履歴（最大30件）</span>
              <input
                className="settings-text-input"
                value={historySearch}
                onChange={(event) => setHistorySearch(event.target.value)}
                placeholder="履歴を検索"
              />
              {filteredSessions.length === 0 ? (
                <div className="task-memo-empty">一致する履歴はありません</div>
              ) : (
                <div className="session-list">
                  {filteredSessions.map((session) => {
                    const userCount = session.messages.filter((message) => message.role === "user").length;
                    const preview = session.title
                      || session.messages.find((message) => message.role === "user")?.content.slice(0, 28)
                      || "会話";
                    return (
                      <div key={session.id} className="session-entry">
                        <button className="btn-session" onClick={() => restoreSession(session)}>
                          <span className="btn-session-date">{formatSessionDate(session.timestamp)}</span>
                          <span className="btn-session-preview">「{preview}…」({userCount}件)</span>
                        </button>
                        <button
                          className={`session-favorite ${session.favorite ? "active" : ""}`}
                          onClick={() => toggleSessionFavorite(session.id)}
                          title="会話をお気に入り"
                        >
                          {session.favorite ? "★" : "☆"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="settings-row settings-card">
              <span className="settings-label">依頼テンプレート</span>
              <div className="template-editor">
                <input
                  className="settings-text-input"
                  value={templateLabel}
                  onChange={(event) => setTemplateLabel(event.target.value)}
                  placeholder="名前（例：文章校正）"
                />
                <textarea
                  className="settings-system-prompt"
                  value={templateContent}
                  onChange={(event) => setTemplateContent(event.target.value)}
                  rows={2}
                  placeholder="よく使う依頼文"
                />
                <button className="btn-pick" onClick={addPromptTemplate} disabled={!templateLabel.trim() || !templateContent.trim()}>
                  保存
                </button>
              </div>
              <div className="template-list">
                {promptTemplates.map((template) => (
                  <div key={template.id} className="template-item">
                    <button className="template-use" onClick={() => usePromptTemplate(template)} title={template.content}>
                      {template.label}
                    </button>
                    <button onClick={() => setPromptTemplates((current) => current.filter((item) => item.id !== template.id))}>×</button>
                  </div>
                ))}
              </div>
            </div>

            <div className="settings-row settings-card">
              <span className="settings-label">保存した回答</span>
              {favoriteMessages.length === 0 ? (
                <div className="task-memo-empty">回答の☆を押すとここに保存されます</div>
              ) : (
                <div className="favorite-message-list">
                  {favoriteMessages.slice().reverse().map((favorite) => (
                    <div key={favorite.id} className="favorite-message-item">
                      <button onClick={() => { setInput(favorite.content); returnToChat(); }} title={favorite.content}>
                        {favorite.content.slice(0, 60)}{favorite.content.length > 60 ? "…" : ""}
                      </button>
                      <button onClick={() => setFavoriteMessages((current) => current.filter((item) => item.id !== favorite.id))}>×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="settings-row settings-card diagnostics-card">
              <div className="settings-label-row">
                <span className="settings-label">状態・診断</span>
                <button className="btn-pick btn-pick--small" onClick={() => void refreshDiagnostics()} disabled={diagnosticsLoading}>
                  {diagnosticsLoading ? "確認中…" : "確認"}
                </button>
              </div>
              {diagnostics ? (
                <div className="diagnostics-list">
                  <span className={diagnostics.codex_found ? "ok" : "ng"}>Codex CLI：{diagnostics.codex_found ? diagnostics.codex_version || "利用可能" : "未検出"}</span>
                  <span className={diagnostics.working_directory_ok ? "ok" : "ng"}>作業フォルダ：{diagnostics.working_directory_ok ? "正常" : "未設定・参照不可"}</span>
                  <span className={diagnostics.notificationGranted ? "ok" : "ng"}>通知権限：{diagnostics.notificationGranted ? "許可済み" : "未許可"}</span>
                  <span className={diagnostics.shortcutReady ? "ok" : "ng"}>呼び出しショートカット：{diagnostics.shortcutReady ? "登録済み" : "未登録"}</span>
                  <span className={diagnostics.git_repository ? "ok" : "warn"}>Git：{diagnostics.git_repository ? "リポジトリ" : "通常フォルダ"}</span>
                  <span className={diagnostics.git_remote ? "ok" : "warn"}>GitHub接続先：{diagnostics.git_remote || "未設定"}</span>
                  <span className="ok">Shaolon AI：v{diagnostics.appVersion}</span>
                  <span className="warn">画面収録：画面添付ボタンでmacOS権限を確認</span>
                </div>
              ) : (
                <div className="task-memo-empty">「確認」を押すと動作環境をまとめて診断します</div>
              )}
            </div>
        </section>
        <main className={`schedule-panel panel-view ${showTaskMemo ? "" : "panel-view--hidden"}`} aria-hidden={!showTaskMemo}>
            <div className="schedule-panel-header">
              <div>
                <div className="schedule-panel-title">タスクメモ</div>
                <div className="schedule-panel-meta">
                  未完了 {taskMemos.filter((item) => !item.completed).length}件
                </div>
              </div>
            </div>

            {activeTaskAction && (
              <div className="task-action-banner">
                <div>
                  <strong>⏰ {activeTaskAction.text}</strong>
                  <span>通知したタスクをどうしますか？</span>
                </div>
                <div className="task-action-buttons">
                  <button onClick={() => toggleTaskMemo(activeTaskAction.id)}>完了</button>
                  <button onClick={() => snoozeTask(activeTaskAction.id)}>10分後</button>
                </div>
              </div>
            )}

            {taskMemoStatus && <div className="task-memo-status">{taskMemoStatus}</div>}

            <section className="task-memo-card">
              <div className="task-section-title">今日のタスクメモ</div>
              <div className="task-memo-editor">
                <input
                  className="settings-text-input"
                  value={taskMemoInput}
                  onChange={(e) => setTaskMemoInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTaskMemo();
                    }
                  }}
                  placeholder="今日やることを入力"
                />
                <button className="btn-pick" onClick={addTaskMemo} disabled={!taskMemoInput.trim()}>
                  追加
                </button>
              </div>
              {taskMemos.length === 0 ? (
                <div className="task-memo-empty">まだタスクはありません</div>
              ) : (
                <div className="task-memo-list">
                  {sortedTaskMemos.map((item) => (
                    <div key={item.id} className={`task-memo-item ${item.completed ? "completed" : ""} ${item.priority ? "priority" : ""}`}>
                      <div className="task-memo-main">
                        <button
                          className="task-memo-check"
                          onClick={() => toggleTaskMemo(item.id)}
                          title={item.completed ? "未完了に戻す" : "完了にする"}
                        >
                          {item.completed ? "✓" : ""}
                        </button>
                        <button className="task-memo-text" onClick={() => toggleTaskMemo(item.id)}>
                          {item.text}
                          {item.carriedFrom && <small>前日から引き継ぎ</small>}
                        </button>
                        <button
                          className={`task-priority ${item.priority ? "active" : ""}`}
                          onClick={() => toggleTaskPriority(item.id)}
                          title="最優先に固定（最大3件）"
                        >
                          {item.priority ? "★" : "☆"}
                        </button>
                        <button
                          className="task-memo-delete"
                          onClick={() => removeTaskMemo(item.id)}
                          title="削除"
                        >
                          ×
                        </button>
                      </div>
                      {!item.completed && (
                        <div className="task-memo-controls">
                          <label>
                            通知
                            <input
                              type="time"
                              value={item.reminderTime ?? ""}
                              onChange={(event) => updateTaskReminder(item.id, event.target.value)}
                            />
                          </label>
                          {item.reminderTime && <button onClick={() => updateTaskReminder(item.id, "")}>解除</button>}
                          <button onClick={() => snoozeTask(item.id)}>10分後</button>
                          {item.snoozedUntil && (
                            <span>{new Date(item.snoozedUntil).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}に通知</span>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

        </main>
        <aside className={`schedule-panel panel-view ${showTodaySchedule ? "" : "panel-view--hidden"}`} aria-hidden={!showTodaySchedule}>
            <div className="schedule-panel-header">
              <div>
                <div className="schedule-panel-title">リマインド・Calendar</div>
                <div className="schedule-panel-meta">毎日の声かけと予定連携</div>
              </div>
            </div>

            <section className="task-reminder-card">
              <div className="task-section-title">デイリーサポート</div>
              <div className="task-section-help">
                朝・昼・夕方に未完了タスクを確認します（アプリ起動中のみ）
              </div>
              <div className="daily-support-list">
                {dailySupports.map((support) => (
                  <div key={support.id} className="daily-support-row">
                    <label className="settings-toggle">
                      <input
                        type="checkbox"
                        checked={support.enabled}
                        onChange={(event) => setDailySupports((current) => current.map((item) => (
                          item.id === support.id ? { ...item, enabled: event.target.checked } : item
                        )))}
                      />
                      <span>{support.label}</span>
                    </label>
                    <input
                      type="time"
                      className="settings-time-input"
                      value={support.time}
                      disabled={!support.enabled}
                      onChange={(event) => setDailySupports((current) => current.map((item) => (
                        item.id === support.id ? { ...item, time: event.target.value } : item
                      )))}
                    />
                  </div>
                ))}
              </div>
            </section>

            <section className="task-reminder-card">
              <div className="task-section-title">定時リマインド</div>
              <div className="task-section-help">
                追加した時刻に、未完了タスクを毎日通知します（アプリ起動中のみ）
              </div>
              <div className="task-reminder-editor">
                <select
                  className="settings-select"
                  value={taskReminderDraft}
                  onChange={(e) => setTaskReminderDraft(e.target.value)}
                >
                  {TASK_REMINDER_TIMES.map((time) => (
                    <option key={time} value={time}>{time}</option>
                  ))}
                </select>
                <button
                  className="btn-pick"
                  onClick={addTaskReminderTime}
                  disabled={taskReminderTimes.includes(taskReminderDraft)}
                >
                  追加
                </button>
              </div>
              {taskReminderTimes.length === 0 ? (
                <div className="task-memo-empty">通知時刻は設定されていません</div>
              ) : (
                <div className="task-reminder-active-list">
                  {taskReminderTimes.map((time) => (
                    <div key={time} className="task-reminder-active-item">
                      <span>{time}</span>
                      <button
                        onClick={() => removeTaskReminderTime(time)}
                        title={`${time}の通知を解除`}
                      >
                        解除 ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <button
              className={`calendar-integration-toggle ${showGoogleCalendarIntegration ? "active" : ""}`}
              onClick={() => setShowGoogleCalendarIntegration((current) => !current)}
            >
              <span>Google Calendar連携</span>
              <span>{showGoogleCalendarIntegration ? "隠す ▲" : "表示する ▼"}</span>
            </button>

            {showGoogleCalendarIntegration && (
              <section className="calendar-integration-section">
                <div className="calendar-integration-header">
                  <div>
                    <div className="task-section-title">Google Calendar</div>
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
                  <div className="schedule-empty">Google Client ID を設定すると予定を読み込めます</div>
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
              </section>
            )}
        </aside>
        {!showSettings && !showTaskMemo && !showTodaySchedule && (
          <>
            {fileDropActive && <div className="file-drop-overlay">ここにファイルをドロップ</div>}
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
                        {!msg.streaming && msg.content && (
                          <div className="message-actions">
                            <button
                              className={favoriteMessages.some((item) => item.content === msg.content) ? "active" : ""}
                              onClick={() => toggleFavoriteMessage(msg.content)}
                              title="回答を保存"
                            >
                              {favoriteMessages.some((item) => item.content === msg.content) ? "★ 保存済み" : "☆ 保存"}
                            </button>
                            <button onClick={() => { createTaskMemo(msg.content.split("\n")[0].replace(/^#+\s*/, "").slice(0, 120)); setContextStatus("回答をタスクへ追加しました"); }}>
                              ＋ タスク
                            </button>
                          </div>
                        )}
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

            {activeTaskAction && (
              <div className="task-action-banner compact">
                <strong>⏰ {activeTaskAction.text}</strong>
                <div className="task-action-buttons">
                  <button onClick={() => toggleTaskMemo(activeTaskAction.id)}>完了</button>
                  <button onClick={() => snoozeTask(activeTaskAction.id)}>10分後</button>
                </div>
              </div>
            )}

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
              <button className="btn-context" onClick={() => void copyLatestMessage()} disabled={isLoading} title="直前のAI回答をコピー">
                ⧉ コピー
              </button>
              <button
                className={`btn-context ${showCommandList ? "btn-context--active" : ""}`}
                onClick={() => setShowCommandList((current) => !current)}
                disabled={isLoading}
                title="利用できるコマンドを表示"
              >
                ⌘ コマンド
              </button>
              {attachedPaths.length > 0 && (
                <button className="btn-context btn-context--active" onClick={() => { setAttachedPaths([]); setContextStatus(null); }}>
                  添付 {attachedPaths.length}件 ×
                </button>
              )}
            </div>
            {contextStatus && <div className="context-status">{contextStatus}</div>}
            {visibleCommands.length > 0 && (
              <div className="slash-menu">
                {visibleCommands.map((entry) => (
                  <button key={entry.command} onClick={() => { setInput(entry.command); setShowCommandList(false); inputRef.current?.focus(); }}>
                    <strong>{entry.command.trim()}</strong>
                    <span>{entry.label}</span>
                    <small>{entry.example}</small>
                  </button>
                ))}
              </div>
            )}
            <div className="chat-input-area">
              <textarea
                ref={inputRef}
                className="chat-input"
                placeholder={isLoading ? "考え中…" : "メッセージまたは / コマンド"}
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
