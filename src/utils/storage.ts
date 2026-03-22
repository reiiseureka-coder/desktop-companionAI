const POSITION_KEY = "companion_position";
const HISTORY_KEY = "companion_history";
const SETTINGS_KEY = "companion_settings";

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
