const POSITION_KEY = "companion_position";
const SETTINGS_KEY = "companion_settings";
const IMAGE_KEY = "companion_image";
const SIZE_KEY = "companion_size";
const CHAT_SIZE_KEY = "companion_chat_size";
const CURRENT_SESSION_KEY = "companion_current_session";
const SESSIONS_KEY = "companion_sessions";

export interface CompanionSettings {
  workingDir: string;
  autoPermissions: boolean;
  resetOnOpen: boolean;
}

export function saveSettings(settings: CompanionSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (_) {}
}

export function loadSettings(): CompanionSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { workingDir: "", autoPermissions: false, resetOnOpen: true };
    const parsed = JSON.parse(raw) as Partial<CompanionSettings>;
    return {
      workingDir: parsed.workingDir ?? "",
      autoPermissions: parsed.autoPermissions ?? false,
      resetOnOpen: parsed.resetOnOpen ?? true,
    };
  } catch (_) {
    return { workingDir: "", autoPermissions: false, resetOnOpen: true };
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
