import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ExternalLink, FileUp, Inbox, Palette, StickyNote, X } from "lucide-react";
import { useStore } from "../store";
import type { Sticky, StickyColor } from "../types";

// Free placement on a fixed-width wall that scrolls vertically (no zoom, no
// infinite canvas). Drag is raw-pointer (HTML5 DnD is dead in the Tauri
// webview, and free placement doesn't fit dnd-kit's sortable model).

const STICKY_W = 172;
/** Pointer travel before a press becomes a drag (vs a click/double-click). */
const DRAG_THRESHOLD = 4;
const SOFT_CAP = 280;

const COLORS: StickyColor[] = [
  "yellow",
  "green",
  "blue",
  "pink",
  "orange",
  "purple",
  "gray",
];

/** Bright paper backgrounds with dark ink — stickies pop against the muted UI. */
const COLOR_BG: Record<StickyColor, string> = {
  yellow: "bg-amber-200",
  green: "bg-lime-200",
  blue: "bg-sky-200",
  pink: "bg-pink-200",
  orange: "bg-orange-200",
  purple: "bg-violet-200",
  gray: "bg-stone-300",
};

const reduceMotion =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Stable ±1.6° rest tilt derived from the id, so it doesn't jitter per render. */
function tiltFor(id: string): number {
  if (reduceMotion) return 0;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h % 100) / 100 - 0.5) * 3.2;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A live drag session (raw pointer), tracked in a ref to dodge stale closures. */
interface DragSession {
  id: string;
  grabDx: number;
  grabDy: number;
  fromPlaced: boolean;
  sticky: Sticky;
  moved: boolean;
}

export default function Wall() {
  const stickies = useStore((s) => s.stickies);
  const focusStickyId = useStore((s) => s.focusStickyId);
  const highlightStickyId = useStore((s) => s.highlightStickyId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pulsingId, setPulsingId] = useState<string | null>(null);
  /** Modifier-click selection — drives the Roll-up / Discard action bar. */
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clearSelected = () => setSelected((s) => (s.size ? new Set() : s));
  /** The sticky riding the pointer mid-drag (also dims the original). */
  const [ghost, setGhost] = useState<{ x: number; y: number; sticky: Sticky } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const inboxRef = useRef<HTMLDivElement>(null);
  const session = useRef<DragSession | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const boxRef = useRef(box);
  boxRef.current = box;

  useEffect(() => {
    void useStore.getState().refreshStickies();
  }, []);

  // A freshly-captured sticky (⌘⇧K) opens straight into edit mode.
  useEffect(() => {
    if (focusStickyId) {
      setEditingId(focusStickyId);
      useStore.getState().setFocusSticky(null);
    }
  }, [focusStickyId]);

  // A sticky opened from a search hit scrolls into view and pulses.
  useEffect(() => {
    if (!highlightStickyId) return;
    const id = highlightStickyId;
    useStore.getState().setHighlightSticky(null);
    // Wait a frame so a just-mounted Wall has rendered the sticky.
    const raf = requestAnimationFrame(() => {
      document
        .querySelector(`[data-sticky="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
      setPulsingId(id);
    });
    const t = setTimeout(() => setPulsingId(null), 1800);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [highlightStickyId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const placed = stickies.filter((s) => s.placed);
  const inbox = stickies.filter((s) => !s.placed);

  const maxX = Math.max(0, box.w - STICKY_W - 8);
  const contentBottom = placed.reduce((m, s) => Math.max(m, s.y + 240), 0);
  const layerMinHeight = Math.max(box.h, contentBottom + 80, 480);

  // ---- drag (window listeners live only for the duration of a session) ----

  const onMove = (e: PointerEvent) => {
    const s = session.current;
    if (!s) return;
    if (!s.moved) {
      // Below threshold this is still a click — don't start the ghost.
      if (
        Math.abs(e.clientX - (s.grabDx + lastDown.current.x)) < DRAG_THRESHOLD &&
        Math.abs(e.clientY - (s.grabDy + lastDown.current.y)) < DRAG_THRESHOLD
      ) {
        return;
      }
      s.moved = true;
    }
    setGhost({ x: e.clientX - s.grabDx, y: e.clientY - s.grabDy, sticky: s.sticky });
  };

  const onUp = (e: PointerEvent) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    const s = session.current;
    session.current = null;
    setGhost(null);
    if (!s || !s.moved) return; // a click, not a drag

    const inboxRect = inboxRef.current?.getBoundingClientRect();
    if (inboxRect && pointIn(e, inboxRect)) {
      // Dropped on the Inbox strip: send a placed sticky back to the Inbox.
      if (s.fromPlaced) void useStore.getState().saveSticky(s.id, { placed: false });
      return;
    }
    const layer = layerRef.current?.getBoundingClientRect();
    if (!layer) return;
    const x = clamp(e.clientX - s.grabDx - layer.left, 0, Math.max(0, boxRef.current.w - STICKY_W - 8));
    const y = Math.max(0, e.clientY - s.grabDy - layer.top);
    void useStore.getState().saveSticky(s.id, { x, y, placed: true });
  };

  const lastDown = useRef({ x: 0, y: 0 });
  const startDrag = (e: React.PointerEvent, sticky: Sticky) => {
    if (e.button !== 0) return;
    // Modifier-click toggles selection instead of dragging.
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      toggleSelected(sticky.id);
      return;
    }
    const card = e.currentTarget.getBoundingClientRect();
    lastDown.current = { x: card.left, y: card.top };
    session.current = {
      id: sticky.id,
      grabDx: e.clientX - card.left,
      grabDy: e.clientY - card.top,
      fromPlaced: sticky.placed,
      sticky,
      moved: false,
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const createAt = async (clientX: number, clientY: number) => {
    const layer = layerRef.current?.getBoundingClientRect();
    if (!layer) return;
    const x = clamp(clientX - layer.left - STICKY_W / 2, 0, maxX);
    const y = Math.max(0, clientY - layer.top - 18);
    const created = await useStore.getState().createSticky("", "yellow", x, y, true);
    if (created) setEditingId(created.id);
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {inbox.length > 0 && (
        <div
          ref={inboxRef}
          className="shrink-0 border-b border-stone-800/80 bg-stone-900/40 px-4 py-2"
        >
          <p className="flex items-center gap-1.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-stone-500">
            <Inbox size={11} />
            Inbox · {inbox.length}
            <span className="ml-1 normal-case tracking-normal text-stone-600">
              drag onto the wall to place
            </span>
          </p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {inbox.map((s) => (
              <StickyCard
                key={s.id}
                sticky={s}
                variant="inbox"
                editing={editingId === s.id}
                dimmed={ghost?.sticky.id === s.id}
                pulse={pulsingId === s.id}
                selected={selected.has(s.id)}
                onEdit={() => setEditingId(s.id)}
                onStopEdit={() => setEditingId(null)}
                onDragStart={(e) => startDrag(e, s)}
              />
            ))}
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        className="relative flex-1 overflow-auto"
        onClick={(e) => {
          if (e.target === e.currentTarget || e.target === layerRef.current) clearSelected();
        }}
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget || e.target === layerRef.current) {
            void createAt(e.clientX, e.clientY);
          }
        }}
      >
        <div ref={layerRef} className="relative" style={{ minHeight: layerMinHeight }}>
          {placed.length === 0 && inbox.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-stone-600">
              <StickyNote size={26} strokeWidth={1.5} />
              <p className="text-xs">Double-click anywhere to add a sticky</p>
              <p className="text-[10px] text-stone-700">⌘⇧K drops one from anywhere</p>
            </div>
          )}
          {placed.map((s) => (
            <div
              key={s.id}
              className="absolute"
              style={{ left: s.x, top: s.y, zIndex: s.z }}
            >
              <StickyCard
                sticky={s}
                variant="wall"
                editing={editingId === s.id}
                dimmed={ghost?.sticky.id === s.id}
                pulse={pulsingId === s.id}
                selected={selected.has(s.id)}
                onEdit={() => setEditingId(s.id)}
                onStopEdit={() => setEditingId(null)}
                onDragStart={(e) => startDrag(e, s)}
              />
            </div>
          ))}
        </div>
      </div>

      {/* the sticky riding the pointer */}
      {ghost && (
        <div
          className="pointer-events-none fixed z-50 opacity-90"
          style={{ left: ghost.x, top: ghost.y, width: STICKY_W }}
        >
          <StickyCard sticky={ghost.sticky} variant="wall" editing={false} dimmed={false} ghost />
        </div>
      )}

      {/* selection action bar */}
      {selected.size > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-40 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-1 rounded-xl border border-stone-700 bg-stone-900/95 p-1 shadow-2xl shadow-black/60">
            <span className="px-2 text-[11px] text-stone-400">{selected.size} selected</span>
            <button
              onClick={() => {
                // reading order: top-to-bottom, then left-to-right
                const ids = [...selected]
                  .map((id) => stickies.find((s) => s.id === id))
                  .filter((s): s is Sticky => !!s)
                  .sort((a, b) => a.y - b.y || a.x - b.x)
                  .map((s) => s.id);
                clearSelected();
                void useStore.getState().rollUpStickies(ids);
              }}
              className="flex cursor-pointer items-center gap-1 rounded-lg bg-clay-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-clay-500"
            >
              <FileUp size={12} />
              Roll up into a note
            </button>
            <button
              onClick={() => {
                const ids = [...selected];
                clearSelected();
                void useStore.getState().discardStickies(ids);
              }}
              className="cursor-pointer rounded-lg px-2 py-1 text-[11px] text-stone-400 transition-colors hover:bg-stone-800 hover:text-red-300"
            >
              Discard
            </button>
            <button
              onClick={clearSelected}
              className="cursor-pointer rounded-lg px-2 py-1 text-[11px] text-stone-500 transition-colors hover:bg-stone-800 hover:text-stone-300"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const pointIn = (e: PointerEvent, r: DOMRect) =>
  e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;

interface CardProps {
  sticky: Sticky;
  variant: "wall" | "inbox";
  editing: boolean;
  dimmed: boolean;
  ghost?: boolean;
  pulse?: boolean;
  selected?: boolean;
  onEdit?: () => void;
  onStopEdit?: () => void;
  onDragStart?: (e: React.PointerEvent) => void;
}

const StickyCard = memo(function StickyCard({
  sticky,
  variant,
  editing,
  dimmed,
  ghost,
  pulse,
  selected,
  onEdit,
  onStopEdit,
  onDragStart,
}: CardProps) {
  const [draft, setDraft] = useState(sticky.text);
  const [palette, setPalette] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const linked = sticky.note_id !== null;

  useEffect(() => {
    if (editing) {
      setDraft(sticky.text);
      // focus after the textarea mounts
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = () => {
    const text = draft.trim();
    if (text === sticky.text) {
      onStopEdit?.();
      return;
    }
    if (text === "") {
      // An emptied text sticky evaporates (linked stickies have no own text).
      if (!linked) void useStore.getState().discardSticky(sticky.id);
      onStopEdit?.();
      return;
    }
    void useStore.getState().saveSticky(sticky.id, { text });
    onStopEdit?.();
  };

  const openLinked = () => {
    if (sticky.note_id) void useStore.getState().selectNote(sticky.note_id);
  };

  const tilt = ghost ? 0 : tiltFor(sticky.id);
  const isInbox = variant === "inbox";
  const width = isInbox ? 150 : STICKY_W;

  return (
    <div
      data-sticky={sticky.id}
      onPointerDown={(e) => {
        if (editing) return; // let the textarea own the pointer
        onDragStart?.(e);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (linked) openLinked();
        else onEdit?.();
      }}
      style={{ width, rotate: `${tilt}deg` }}
      className={`group/sticky relative rounded-sm ${COLOR_BG[sticky.color]} px-2.5 py-2 text-stone-900 shadow-md shadow-black/40 transition-[opacity,transform] ${
        editing ? "cursor-text" : ghost ? "cursor-grabbing" : "cursor-grab"
      } ${dimmed ? "opacity-30" : ""} ${pulse ? "sticky-pulse" : ""} ${
        selected ? "ring-2 ring-clay-500 ring-offset-2 ring-offset-stone-950" : ""
      } ${ghost ? "rotate-2 shadow-xl shadow-black/50" : ""}`}
    >
      {linked ? (
        <div className={isInbox ? "min-h-[40px] pr-3" : "min-h-[52px] pr-3"}>
          <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-stone-600">
            <ExternalLink size={9} />
            note
          </p>
          <p className="mt-0.5 line-clamp-1 text-[12px] font-semibold leading-snug">
            {sticky.note_title?.trim() || "Untitled"}
          </p>
          {!isInbox && sticky.note_preview && (
            <p className="mt-0.5 line-clamp-3 text-[11px] leading-snug text-stone-700">
              {sticky.note_preview}
            </p>
          )}
        </div>
      ) : editing ? (
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              commit();
            }
            // ⌘↵ also commits; plain Enter stays a newline (stickies are prose).
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            }
          }}
          placeholder="Jot a thought…"
          rows={isInbox ? 2 : 2}
          className={`w-full resize-none bg-transparent text-[12.5px] leading-snug outline-none placeholder:text-stone-500 ${
            isInbox ? "min-h-[34px]" : "min-h-[40px]"
          }`}
        />
      ) : (
        <p
          className={`whitespace-pre-wrap break-words text-[12.5px] leading-snug ${
            isInbox ? "line-clamp-3" : ""
          } min-h-[28px] ${sticky.text.trim() ? "" : "italic text-stone-500"}`}
        >
          {sticky.text.trim() || "Empty — double-click to write"}
        </p>
      )}

      {draft.length > SOFT_CAP && editing && !linked && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void useStore.getState().promoteSticky(sticky.id)}
          className="mt-1 block w-full rounded bg-stone-900/10 px-1.5 py-0.5 text-left text-[9.5px] font-medium text-stone-700 hover:bg-stone-900/20"
        >
          Bigger than a sticky? → Promote to note
        </button>
      )}

      {/* folded bottom-right corner — the constant "this points to a note"
          mark, legible whatever color the user picks */}
      {linked && (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-0 right-0"
          style={{
            width: 16,
            height: 16,
            background:
              "linear-gradient(135deg, transparent 50%, rgba(0,0,0,0.22) 50%)",
            clipPath: "polygon(100% 0, 0 100%, 100% 100%)",
            borderBottomRightRadius: 2,
          }}
        />
      )}

      {/* hover toolbar */}
      {!ghost && !editing && (
        <div className="absolute -top-2 right-1 hidden items-center gap-0.5 rounded-md bg-stone-900/90 px-0.5 py-0.5 shadow group-hover/sticky:flex">
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setPalette((v) => !v)}
            title="Color"
            className="cursor-pointer rounded p-0.5 text-stone-400 hover:text-stone-100"
          >
            <Palette size={11} />
          </button>
          {linked ? (
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={openLinked}
              title="Open the note"
              className="cursor-pointer rounded p-0.5 text-stone-400 hover:text-stone-100"
            >
              <ExternalLink size={11} />
            </button>
          ) : (
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => void useStore.getState().promoteSticky(sticky.id)}
              title="Promote to a note"
              className="cursor-pointer rounded p-0.5 text-stone-400 hover:text-stone-100"
            >
              <FileUp size={11} />
            </button>
          )}
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => void useStore.getState().discardSticky(sticky.id)}
            title="Discard"
            className="cursor-pointer rounded p-0.5 text-stone-400 hover:text-red-300"
          >
            <X size={11} />
          </button>
        </div>
      )}

      {palette && !ghost && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setPalette(false)} />
          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="absolute -top-9 right-1 z-20 flex gap-1 rounded-lg border border-stone-700 bg-stone-900 p-1 shadow-xl"
          >
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => {
                  void useStore.getState().saveSticky(sticky.id, { color: c });
                  setPalette(false);
                }}
                title={c}
                className={`h-4 w-4 cursor-pointer rounded-full ${COLOR_BG[c]} ${
                  sticky.color === c ? "ring-2 ring-white" : ""
                }`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
});
