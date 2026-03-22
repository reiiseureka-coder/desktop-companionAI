import { useRef, useEffect, useState, useCallback } from "react";

interface Props {
  position: { x: number; y: number };
  onClick: () => void;
  onPositionChange: (x: number, y: number) => void;
}

export default function Character({ position, onClick, onPositionChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const dragStart = useRef({ mx: 0, my: 0, ex: 0, ey: 0 });
  const [pos, setPos] = useState(position);
  const [isDragging, setIsDragging] = useState(false);

  // Sync external position (e.g., initial load)
  useEffect(() => {
    setPos(position);
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    setIsDragging(false);
    dragStart.current = {
      mx: e.clientX,
      my: e.clientY,
      ex: pos.x,
      ey: pos.y,
    };
  }, [pos]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - dragStart.current.mx;
      const dy = e.clientY - dragStart.current.my;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        setIsDragging(true);
      }
      const newX = dragStart.current.ex + dx;
      const newY = dragStart.current.ey + dy;
      setPos({ x: newX, y: newY });
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - dragStart.current.mx;
      const dy = e.clientY - dragStart.current.my;
      const wasDragging = Math.abs(dx) > 3 || Math.abs(dy) > 3;
      dragging.current = false;
      setIsDragging(false);

      const newX = dragStart.current.ex + dx;
      const newY = dragStart.current.ey + dy;
      if (wasDragging) {
        onPositionChange(newX, newY);
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [onPositionChange]);

  const handleClick = useCallback(() => {
    if (!isDragging) onClick();
  }, [isDragging, onClick]);

  return (
    <div
      ref={ref}
      className="character"
      style={{
        transform: `translate(${pos.x}px, ${pos.y}px)`,
        cursor: isDragging ? "grabbing" : "pointer",
      }}
      onMouseDown={onMouseDown}
      onClick={handleClick}
      title="クリックしてチャットを開く (Tabで非表示)"
    >
      <img
        src="/character.png"
        alt="AI Assistant"
        draggable={false}
        className="character-img"
      />
    </div>
  );
}
