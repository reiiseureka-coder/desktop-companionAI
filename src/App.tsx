import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import Character from "./components/Character";
import ChatWindow from "./components/ChatWindow";
import { loadPosition, savePosition, loadCharacterImage, saveCharacterImage, clearCharacterImage, loadCharacterSize, saveCharacterSize } from "./utils/storage";

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

  const chatOpenRef = useRef(false);
  const currentPassthrough = useRef(false);

  // Apply size CSS variable on mount
  useEffect(() => {
    document.documentElement.style.setProperty("--char-size", `${charSize}px`);
  }, []);

  // macOS global shortcut (Option+Space) opens the companion on the active Space.
  useEffect(() => {
    const unlisten = listen("toggle-chat", () => {
      setVisible(true);
      setChatOpen((open) => !open);
    });
    return () => { unlisten.then((f) => f()); };
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
    document.documentElement.style.setProperty("--char-size", `${size}px`);
  }, []);

  if (!visible) return null;

  return (
    <div className="app-root">
      <Character
        position={position}
        onClick={handleCharacterClick}
        onPositionChange={handlePositionChange}
        onPositionCommit={handlePositionCommit}
        imageSrc={characterImage}
        charSize={charSize}
      />
      <ChatWindow
        chatOpen={chatOpen}
        characterPosition={position}
        onClose={handleClose}
        onImageChange={handleImageChange}
        currentImage={characterImage}
        charSize={charSize}
        onSizeChange={handleSizeChange}
        onToggleVisible={handleToggleVisible}
      />
    </div>
  );
}
