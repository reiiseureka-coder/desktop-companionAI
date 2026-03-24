import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import Character from "./components/Character";
import ChatWindow from "./components/ChatWindow";
import { loadPosition, savePosition, loadCharacterImage, saveCharacterImage, clearCharacterImage, loadCharacterSize, saveCharacterSize } from "./utils/storage";

export default function App() {
  const [chatOpen, setChatOpen] = useState(false);
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
  const passthroughTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Apply size CSS variable on mount
  useEffect(() => {
    document.documentElement.style.setProperty("--char-size", `${charSize}px`);
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

  // Click-through: pass clicks to underlying apps when over transparent area
  useEffect(() => {
    const setPassthrough = (value: boolean) => {
      if (currentPassthrough.current === value) return;
      currentPassthrough.current = value;
      invoke("set_cursor_passthrough", { passthrough: value }).catch(() => {});
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (passthroughTimer.current) {
        clearTimeout(passthroughTimer.current);
        passthroughTimer.current = null;
      }

      if (chatOpenRef.current) {
        setPassthrough(false);
        return;
      }

      const el = document.elementFromPoint(e.clientX, e.clientY);
      const isInteractive = el?.closest(".character, .chat-bubble") !== null;

      if (isInteractive) {
        setPassthrough(false);
      } else {
        setPassthrough(true);
        passthroughTimer.current = setTimeout(() => {
          setPassthrough(false);
        }, 80);
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    invoke("set_cursor_passthrough", { passthrough: true }).catch(() => {});
    currentPassthrough.current = true;

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      if (passthroughTimer.current) clearTimeout(passthroughTimer.current);
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
    setChatOpen((o) => !o);
  }, [visible]);

  const handlePositionChange = useCallback((x: number, y: number) => {
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
