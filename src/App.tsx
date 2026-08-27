import { useEffect, useLayoutEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import Character from "./components/Character";
import ChatWindow from "./components/ChatWindow";
import {
  loadPosition,
  savePosition,
  loadCharacterImage,
  saveCharacterImage,
  clearCharacterImage,
  loadCharacterSize,
  saveCharacterSize,
  loadCompactCharacterSize,
  saveCompactCharacterSize,
} from "./utils/storage";

export default function App() {
  const [chatOpen, setChatOpen] = useState(true);
  const [visible, setVisible] = useState(true);
  // Default: bottom-right, with some margin from the edges
  const [position, setPosition] = useState({
    x: window.innerWidth - 180,
    y: window.innerHeight - 180,
  });
  const [characterImage, setCharacterImage] = useState<string | null>(() => loadCharacterImage());
  const [charSize, setCharSize] = useState<number>(() => loadCharacterSize());
  const [compactCharSize, setCompactCharSize] = useState<number>(() =>
    loadCompactCharacterSize(charSize)
  );
  const effectiveCharSize = chatOpen ? charSize : compactCharSize;

  const chatOpenRef = useRef(false);
  const currentPassthrough = useRef(false);
  const previousCharSize = useRef(effectiveCharSize);

  // Preserve the character's right and bottom edges while switching sizes.
  // The normal character therefore grows only toward the upper-left.
  useLayoutEffect(() => {
    const previous = previousCharSize.current;
    if (previous === effectiveCharSize) return;
    previousCharSize.current = effectiveCharSize;

    setPosition((current) => {
      const maxX = Math.max(0, window.innerWidth - effectiveCharSize);
      const maxY = Math.max(0, window.innerHeight - effectiveCharSize);
      const next = {
        x: Math.max(0, Math.min(maxX, current.x + previous - effectiveCharSize)),
        y: Math.max(0, Math.min(maxY, current.y + previous - effectiveCharSize)),
      };
      savePosition(next.x, next.y);
      return next;
    });
  }, [effectiveCharSize]);

  // Global shortcuts always reveal the companion on the active Space.
  useEffect(() => {
    const unlisten = listen("show-chat", () => {
      setVisible(true);
      setChatOpen(true);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  // Verify the native shortcuts again after the webview is ready and whenever
  // macOS brings the app back from sleep or another Space. This repairs a
  // registration that was temporarily unavailable during application startup.
  useEffect(() => {
    const ensureShortcuts = () => {
      invoke<string[]>("ensure_global_shortcuts").catch(() => {});
    };

    const initialRetry = window.setTimeout(ensureShortcuts, 750);
    const periodicRetry = window.setInterval(ensureShortcuts, 10_000);
    window.addEventListener("focus", ensureShortcuts);
    document.addEventListener("visibilitychange", ensureShortcuts);

    return () => {
      window.clearTimeout(initialRetry);
      window.clearInterval(periodicRetry);
      window.removeEventListener("focus", ensureShortcuts);
      document.removeEventListener("visibilitychange", ensureShortcuts);
    };
  }, []);

  // Load saved position on mount
  // Ignore old-system positions where both x,y are near 0 (those were bottom-right offsets)
  useEffect(() => {
    const saved = loadPosition();
    if (saved && (saved.x > 50 || saved.y > 50)) {
      setPosition(saved);
    }
  }, []);

  // Keep ref in sync for use in event handlers
  useEffect(() => {
    chatOpenRef.current = chatOpen;
  }, [chatOpen]);

  // Click-through: poll native cursor position every 50ms so we don't depend on
  // mousemove (which is suppressed while ignore_cursor_events=true).
  // Cocoa coords: origin = bottom-left of primary display, logical pixels.
  // Web coords: origin = top-left. Conversion: webY = screen.height - cocoaY.
  useEffect(() => {
    const setPassthrough = (value: boolean) => {
      if (currentPassthrough.current === value) return;
      currentPassthrough.current = value;
      invoke("set_cursor_passthrough", { passthrough: value }).catch(() => {});
    };

    // Start fully transparent so other apps are immediately usable.
    setPassthrough(true);

    const poll = async () => {
      try {
        const [cocoaX, cocoaY] = await invoke<[number, number]>("get_cursor_pos_native");
        if (cocoaX < 0) return; // sentinel: platform not supported
        const webX = cocoaX;
        const webY = window.screen.height - cocoaY;
        const el = document.elementFromPoint(webX, webY);
        const isInteractive = el?.closest(".character, .chat-bubble") !== null;
        setPassthrough(!isInteractive);
      } catch {
        // ignore
      }
    };

    const intervalId = setInterval(poll, 50);

    return () => {
      clearInterval(intervalId);
      invoke("set_cursor_passthrough", { passthrough: false }).catch(() => {});
    };
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
        e.preventDefault();
        setVisible((v) => {
          if (!v) setChatOpen(false);
          return !v;
        });
      }
      if (e.key === "Escape") {
        setChatOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleCharacterClick = useCallback(() => {
    if (!visible) return;
    setChatOpen((open) => !open);
  }, [visible]);

  const handlePositionChange = useCallback((x: number, y: number) => {
    setPosition({ x, y });
  }, []);

  const handlePositionCommit = useCallback((x: number, y: number) => {
    setPosition({ x, y });
    savePosition(x, y);
  }, []);

  const handleClose = useCallback(() => {
    setChatOpen(false);
  }, []);

  const handleToggleVisible = useCallback(() => {
    setVisible((v) => {
      if (v) setChatOpen(false);
      return !v;
    });
  }, []);

  const handleImageChange = useCallback((dataUrl: string | null) => {
    setCharacterImage(dataUrl);
    if (dataUrl) saveCharacterImage(dataUrl);
    else clearCharacterImage();
  }, []);

  const handleSizeChange = useCallback((size: number) => {
    setCharSize(size);
    saveCharacterSize(size);
  }, []);

  const handleCompactSizeChange = useCallback((size: number) => {
    setCompactCharSize(size);
    saveCompactCharacterSize(size);
  }, []);

  if (!visible) return null;

  return (
    <div className="app-root">
      <Character
        position={position}
        onClick={handleCharacterClick}
        onPositionChange={handlePositionChange}
        onPositionCommit={handlePositionCommit}
        imageSrc={chatOpen ? characterImage : "/fullscreen-launcher.png"}
        charSize={effectiveCharSize}
      />
      <ChatWindow
        chatOpen={chatOpen}
        characterPosition={position}
        onClose={handleClose}
        onImageChange={handleImageChange}
        currentImage={characterImage}
        charSize={charSize}
        onSizeChange={handleSizeChange}
        compactCharSize={compactCharSize}
        onCompactSizeChange={handleCompactSizeChange}
        onToggleVisible={handleToggleVisible}
      />
    </div>
  );
}
