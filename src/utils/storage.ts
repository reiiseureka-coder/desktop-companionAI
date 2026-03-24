const POSITION_KEY = "companion_position";
const HISTORY_KEY = "companion_history";
const SETTINGS_KEY = "companion_settings";
const IMAGE_KEY = "companion_image";
const SIZE_KEY = "companion_size";
const CHAT_SIZE_KEY = "companion_chat_size";

export interface CompanionSettings {
  workingDir: string;
  autoPermissions: boolean;
}

export function saveSettings(settings: CompanionSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (_) {}
}

export function loadSettings(): CompanionSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { workingDir: "", autoPermissions: false };
    return JSON.parse(raw) as CompanionSettings;
  } catch (_) {
    return { workingDir: "", autoPermissions: false };
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

export interface ChatSize {
  width: number;
  height: number;
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

export function saveHistory(messages: StoredMessage[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-20)));
  } catch (_) {}
}

export function loadHistory(): StoredMessage[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as StoredMessage[];
  } catch (_) {
    return [];
  }
}
