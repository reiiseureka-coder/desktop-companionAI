import { useEffect, useState, useCallback } from "react";
import { appWindow } from "@tauri-apps/api/window";
import Character from "./components/Character";
import ChatWindow from "./components/ChatWindow";
import { loadPosition, savePosition } from "./utils/storage";

export default function App() {
  const [chatOpen, setChatOpen] = useState(false);
  const [visible, setVisible] = useState(true);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  // Load saved position on mount
  useEffect(() => {
    const saved = loadPosition();
    if (saved) setPosition(saved);
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Tab: toggle visibility
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Only toggle if no input is focused
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
        e.preventDefault();
        setVisible((v) => {
          if (!v) setChatOpen(false);
          return !v;
        });
      }
      // ESC: close chat
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

  const handleOutsideClick = useCallback(() => {
    setChatOpen(false);
  }, []);

  if (!visible) return null;

  return (
    <div className="app-root">
      <Character
        position={position}
        onClick={handleCharacterClick}
        onPositionChange={handlePositionChange}
      />
      {chatOpen && (
        <ChatWindow
          characterPosition={position}
          onClose={handleOutsideClick}
        />
      )}
    </div>
  );
}
