const POSITION_KEY = "companion_position";
const SETTINGS_KEY = "companion_settings";
const IMAGE_KEY = "companion_image";
const SIZE_KEY = "companion_size";
const COMPACT_SIZE_KEY = "companion_compact_size";
const CHAT_SIZE_KEY = "companion_chat_size";
const CURRENT_SESSION_KEY = "companion_current_session";
const SESSIONS_KEY = "companion_sessions";
const CALENDAR_CACHE_KEY = "companion_calendar_cache";
const TASK_MEMO_KEY = "companion_task_memo";

export const DEFAULT_SYSTEM_PROMPT =
  `あなたはデスクトップ上に常駐するコンパニオンAIです。
ユーザーのPC画面の隅に小さなキャラクターとして表示され、いつでも話しかけられる存在です。
コーディング・調査・ファイル操作など何でも手伝いますが、気軽な雑談にも応じてください。
返答は簡潔に、必要なときだけ長く書いてください。`;

export const MODELS = [
  { id: "",              label: "Codex既定値" },
  { id: "gpt-5.6-sol",   label: "GPT-5.6 Sol（最高性能）" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra（バランス）" },
  { id: "gpt-5.6-luna",  label: "GPT-5.6 Luna（高速・軽量）" },
] as const;

export type ModelId = typeof MODELS[number]["id"];
export const DEFAULT_MODEL: ModelId = "";

export const COMPANION_MODES = [
  { id: "general", label: "相談", prompt: "日常の相談相手として、結論を先に簡潔に答えてください。" },
  { id: "developer", label: "開発", prompt: "ソフトウェア開発パートナーとして、原因を確認し、安全に実装・検証してください。" },
  { id: "writer", label: "文章", prompt: "編集者として、目的と読み手に合う明快な文章を作ってください。" },
  { id: "research", label: "調査", prompt: "調査担当として、事実と推測を分け、根拠を示してください。" },
  { id: "secretary", label: "秘書", prompt: "秘書として、予定・優先順位・次の行動を簡潔に整理してください。" },
] as const;

export type CompanionMode = typeof COMPANION_MODES[number]["id"];
export type ProactiveLevel = "quiet" | "standard" | "proactive";
export const DEFAULT_CALENDAR_TAGS = ["MTG", "移動"];
export const TASK_REMINDER_TIMES = Array.from({ length: 27 }, (_, index) => {
  const totalMinutes = (8 * 60) + (index * 30);
  const hour = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const minute = String(totalMinutes % 60).padStart(2, "0");
  return `${hour}:${minute}`;
});

function normalizeCompanionMode(mode: unknown): CompanionMode {
  if (typeof mode !== "string") return "general";
  return COMPANION_MODES.some((entry) => entry.id === mode) ? (mode as CompanionMode) : "general";
}

function normalizeModelId(model: unknown): ModelId {
  if (typeof model !== "string") return DEFAULT_MODEL;
  return MODELS.some((entry) => entry.id === model) ? (model as ModelId) : DEFAULT_MODEL;
}

function normalizeCalendarTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [...DEFAULT_CALENDAR_TAGS];
  return [...new Set(tags
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim().replace(/^【/, "").replace(/】$/, "").trim())
    .filter(Boolean))];
}

function normalizeTaskReminderTimes(times: unknown): string[] {
  if (!Array.isArray(times)) return [];
  const allowed = new Set(TASK_REMINDER_TIMES);
  return [...new Set(times.filter((time): time is string => (
    typeof time === "string" && allowed.has(time)
  )))].sort();
}

export interface CompanionSettings {
  workingDir: string;
  autoPermissions: boolean;
  resetOnOpen: boolean;
  systemPrompt: string;
  model: ModelId;
  googleClientId: string;
  googleClientSecret: string;
  googleCalendarId: string;
  calendarTags: string[];
  autoDailyCalendarSync: boolean;
  dailyCalendarSyncTime: string;
  showGoogleCalendarIntegration: boolean;
  taskReminderTimes: string[];
  companionMode: CompanionMode;
  memory: string;
  proactiveLevel: ProactiveLevel;
}

export interface CalendarItem {
  id: string;
  title: string;
  startsAt: string;
  startsLabel: string;
  kind: string;
  allDay: boolean;
}

export interface CalendarCache {
  dateKey: string;
  lastSyncedAt: number | null;
  items: CalendarItem[];
}

export interface TaskMemoItem {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
}

interface TaskMemoStore {
  dateKey: string;
  items: TaskMemoItem[];
}

const DEFAULT_SETTINGS: CompanionSettings = {
  workingDir: "",
  autoPermissions: false,
  resetOnOpen: true,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  model: DEFAULT_MODEL,
  googleClientId: "",
  googleClientSecret: "",
  googleCalendarId: "primary",
  calendarTags: [...DEFAULT_CALENDAR_TAGS],
  autoDailyCalendarSync: false,
  dailyCalendarSyncTime: "09:00",
  showGoogleCalendarIntegration: false,
  taskReminderTimes: [],
  companionMode: "general",
  memory: "",
  proactiveLevel: "standard",
};

export function saveSettings(settings: CompanionSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (_) {}
}

export function loadSettings(): CompanionSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<CompanionSettings>;
    return {
      workingDir: parsed.workingDir ?? DEFAULT_SETTINGS.workingDir,
      autoPermissions: parsed.autoPermissions ?? DEFAULT_SETTINGS.autoPermissions,
      resetOnOpen: parsed.resetOnOpen ?? DEFAULT_SETTINGS.resetOnOpen,
      systemPrompt: parsed.systemPrompt ?? DEFAULT_SETTINGS.systemPrompt,
      model: normalizeModelId(parsed.model),
      googleClientId: parsed.googleClientId ?? DEFAULT_SETTINGS.googleClientId,
      googleClientSecret: parsed.googleClientSecret ?? DEFAULT_SETTINGS.googleClientSecret,
      googleCalendarId: parsed.googleCalendarId ?? DEFAULT_SETTINGS.googleCalendarId,
      calendarTags: normalizeCalendarTags(parsed.calendarTags),
      autoDailyCalendarSync: parsed.autoDailyCalendarSync ?? DEFAULT_SETTINGS.autoDailyCalendarSync,
      dailyCalendarSyncTime: parsed.dailyCalendarSyncTime ?? DEFAULT_SETTINGS.dailyCalendarSyncTime,
      showGoogleCalendarIntegration: parsed.showGoogleCalendarIntegration
        ?? DEFAULT_SETTINGS.showGoogleCalendarIntegration,
      taskReminderTimes: normalizeTaskReminderTimes(parsed.taskReminderTimes),
      companionMode: normalizeCompanionMode(parsed.companionMode),
      memory: parsed.memory ?? DEFAULT_SETTINGS.memory,
      proactiveLevel: parsed.proactiveLevel === "quiet" || parsed.proactiveLevel === "proactive"
        ? parsed.proactiveLevel
        : "standard",
    };
  } catch (_) {
    return DEFAULT_SETTINGS;
  }
}

export interface StoredPosition {
  x: number;
  y: number;
}

export interface StoredMessage {
  id: number;
  role: "user" | "assistant" | "error";
  content: string;
}

export interface Session {
  id: number;
  timestamp: number;
  messages: StoredMessage[];
}

export interface ChatSize {
  width: number;
  height: number;
}

export function savePosition(x: number, y: number): void {
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify({ x, y }));
  } catch (_) {}
}

export function loadPosition(): StoredPosition | null {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredPosition;
  } catch (_) {
    return null;
  }
}

export function saveCharacterImage(dataUrl: string): void {
  try {
    localStorage.setItem(IMAGE_KEY, dataUrl);
  } catch (_) {}
}

export function loadCharacterImage(): string | null {
  try {
    return localStorage.getItem(IMAGE_KEY);
  } catch (_) {
    return null;
  }
}

export function clearCharacterImage(): void {
  try {
    localStorage.removeItem(IMAGE_KEY);
  } catch (_) {}
}

export function saveCharacterSize(size: number): void {
  try {
    localStorage.setItem(SIZE_KEY, String(size));
  } catch (_) {}
}

export function loadCharacterSize(): number {
  try {
    const raw = localStorage.getItem(SIZE_KEY);
    if (!raw) return 80;
    const n = parseInt(raw, 10);
    return isNaN(n) ? 80 : n;
  } catch (_) {
    return 80;
  }
}

export function saveCompactCharacterSize(size: number): void {
  try {
    localStorage.setItem(COMPACT_SIZE_KEY, String(size));
  } catch (_) {}
}

export function loadCompactCharacterSize(normalSize = 80): number {
  try {
    const raw = localStorage.getItem(COMPACT_SIZE_KEY);
    if (!raw) return Math.max(24, Math.round(normalSize / 2));
    const n = parseInt(raw, 10);
    return isNaN(n) ? Math.max(24, Math.round(normalSize / 2)) : n;
  } catch (_) {
    return Math.max(24, Math.round(normalSize / 2));
  }
}

export function saveChatSize(size: ChatSize): void {
  try {
    localStorage.setItem(CHAT_SIZE_KEY, JSON.stringify(size));
  } catch (_) {}
}

export function loadChatSize(): ChatSize {
  try {
    const raw = localStorage.getItem(CHAT_SIZE_KEY);
    if (!raw) return { width: 340, height: 460 };
    return JSON.parse(raw) as ChatSize;
  } catch (_) {
    return { width: 340, height: 460 };
  }
}

/** Save messages for the current running session (updated continuously). */
export function saveCurrentSession(messages: StoredMessage[]): void {
  try {
    localStorage.setItem(CURRENT_SESSION_KEY, JSON.stringify(messages));
  } catch (_) {}
}

/**
 * On app launch: load the previous session's messages and delete them from
 * localStorage so the next launch starts fresh.
 */
export function popCurrentSession(): StoredMessage[] {
  try {
    const raw = localStorage.getItem(CURRENT_SESSION_KEY);
    localStorage.removeItem(CURRENT_SESSION_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as StoredMessage[];
  } catch (_) {
    return [];
  }
}

/**
 * Load the current session's messages without deleting them.
 * Used when resetOnOpen=false to restore the session.
 */
export function peekCurrentSession(): StoredMessage[] {
  try {
    const raw = localStorage.getItem(CURRENT_SESSION_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as StoredMessage[];
  } catch (_) {
    return [];
  }
}

/** Persist the last 3 sessions (oldest first). */
export function saveSessions(sessions: Session[]): void {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions.slice(-3)));
  } catch (_) {}
}

export function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Session[];
  } catch (_) {
    return [];
  }
}

export function saveCalendarCache(cache: CalendarCache): void {
  try {
    localStorage.setItem(CALENDAR_CACHE_KEY, JSON.stringify(cache));
  } catch (_) {}
}

export function loadCalendarCache(): CalendarCache | null {
  try {
    const raw = localStorage.getItem(CALENDAR_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CalendarCache;
  } catch (_) {
    return null;
  }
}

export function saveTaskMemo(dateKey: string, items: TaskMemoItem[]): void {
  try {
    localStorage.setItem(TASK_MEMO_KEY, JSON.stringify({ dateKey, items } satisfies TaskMemoStore));
  } catch (_) {}
}

export function loadTaskMemo(dateKey: string): TaskMemoItem[] {
  try {
    const raw = localStorage.getItem(TASK_MEMO_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<TaskMemoStore>;
    if (parsed.dateKey !== dateKey || !Array.isArray(parsed.items)) return [];
    return parsed.items.filter((item): item is TaskMemoItem => (
      typeof item?.id === "string"
      && typeof item?.text === "string"
      && typeof item?.completed === "boolean"
      && typeof item?.createdAt === "number"
    ));
  } catch (_) {
    return [];
  }
}
