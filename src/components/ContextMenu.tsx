import { useEffect, useMemo, useState } from "react";

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  /** Red hover treatment for destructive actions. */
  danger?: boolean;
  /** Two-step: first click arms the item, second click runs it. */
  confirm?: boolean;
  onClick: () => void;
}

const ITEM_H = 28;
const MENU_W = 176;

/**
 * Right-click menu — same popover language as the rest of the app
 * (fixed click-catcher + panel), position clamped to the viewport.
 */
export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const [arming, setArming] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose]);

  const style = useMemo(() => {
    const h = items.length * ITEM_H + 8;
    return {
      left: Math.min(x, window.innerWidth - MENU_W - 8),
      top: Math.min(y, window.innerHeight - h - 8),
      width: MENU_W,
    };
  }, [x, y, items.length]);

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        role="menu"
        className="fade-in fixed z-50 rounded-xl border border-stone-800 bg-stone-900 p-1 shadow-2xl shadow-black/60"
        style={style}
      >
        {items.map((item) => {
          const armed = arming === item.label;
          return (
            <button
              key={item.label}
              role="menuitem"
              onClick={() => {
                if (item.confirm && !armed) {
                  setArming(item.label);
                  return;
                }
                onClose();
                item.onClick();
              }}
              className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                armed
                  ? "bg-red-950/70 text-red-300"
                  : item.danger
                    ? "text-stone-300 hover:bg-red-950/60 hover:text-red-300"
                    : "text-stone-300 hover:bg-stone-800/70"
              }`}
            >
              <span className={armed ? "" : "text-stone-500"}>{item.icon}</span>
              {armed ? "Click again to confirm" : item.label}
            </button>
          );
        })}
      </div>
    </>
  );
}
