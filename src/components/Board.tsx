import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { CollisionDetection, DragEndEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import { arrayMove, rectSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Check,
  Clock,
  ExternalLink,
  FileText,
  Hand,
  Hourglass,
  LayoutGrid,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Sparkles,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import {
  appendTodo,
  notePreview,
  noteDisplayTitle,
  parseTodos,
  relativeTime,
  toggleTodoAtLine,
} from "../utils";
import ContextMenu from "./ContextMenu";
import Wall from "./Wall";
import type { BoardData, BoardMode, Note } from "../types";

const RECENT_MAX = 15;
/** Server-side excerpt cap: content this long may be truncated. */
const EXCERPT_LEN = 240;
const MAX_TODOS_SHOWN = 8;

// Droppable-container ids must not collide with card (note) ids — a cluster's
// anchor is itself a note on the board, so containers get a prefix.
const CONTAINER_PREFIX = "cluster:";
const LOOSE_ID = "loose";

const MODES: { mode: BoardMode; label: string; icon: React.ReactNode }[] = [
  { mode: "clusters", label: "Clusters", icon: <Sparkles size={12} /> },
  { mode: "recent", label: "Recent", icon: <Clock size={12} /> },
  { mode: "stale", label: "Stale ideas", icon: <Hourglass size={12} /> },
  { mode: "pinned", label: "Pinned", icon: <Pin size={12} /> },
];

/** The Board: a curated wall of note cards in the editor's place. Clusters
 *  are computed (semantic), corrections are human (sticky) — dragging a card
 *  to another cluster records a placement the AI can never silently undo. */
export default function Board() {
  const mode = useStore((s) => s.boardMode);
  const setMode = useStore((s) => s.setBoardMode);
  const setBoardOpen = useStore((s) => s.setBoardOpen);

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      <header className="flex items-center gap-2 px-5 pb-3 pt-4">
        <LayoutGrid size={16} className="text-clay-400" />
        <h1 className="text-sm font-semibold text-stone-100">Board</h1>
        <div className="ml-3 flex items-center gap-0.5 rounded-lg bg-stone-900 p-0.5">
          {/* the Wall (stickies) — set apart from the note-feed Views */}
          <button
            onClick={() => setMode("wall")}
            aria-pressed={mode === "wall"}
            className={`flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
              mode === "wall"
                ? "bg-stone-700/80 text-clay-300"
                : "text-stone-500 hover:text-stone-300"
            }`}
          >
            <StickyNote size={12} />
            Wall
          </button>
          <span className="mx-0.5 h-4 w-px bg-stone-700/70" />
          {MODES.map((m) => (
            <button
              key={m.mode}
              onClick={() => setMode(m.mode)}
              aria-pressed={mode === m.mode}
              className={`flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
                mode === m.mode
                  ? "bg-stone-700/80 text-clay-300"
                  : "text-stone-500 hover:text-stone-300"
              }`}
            >
              {m.icon}
              {m.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setBoardOpen(false)}
          title="Close the Board (⌘⇧B)"
          className="ml-auto cursor-pointer rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-stone-800 hover:text-stone-200"
        >
          <X size={15} />
        </button>
      </header>
      {mode === "wall" && <Wall />}
      {mode === "clusters" && <ClustersBoard />}
      {mode === "recent" && <RecentBoard />}
      {mode === "stale" && <StaleBoard />}
      {mode === "pinned" && <PinnedBoard />}
    </main>
  );
}

// ------------------------------------------------------------- clusters mode

function ClustersBoard() {
  const embedderState = useStore((s) => s.queue?.embedder_state ?? "cold");
  const [data, setData] = useState<BoardData | null>(null);
  const [working, setWorking] = useState(false);
  /** Note id riding the DragOverlay, null when no drag is in flight. */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Snapshot at drag start: revert target + the source container. */
  const dragOrigin = useRef<{ data: BoardData; container: string } | null>(null);

  // Pointer-based dnd (dnd-kit): Tauri's native drag handler swallows HTML5
  // drag events inside the webview, so dragging must not rely on them at all.
  // The 6px activation distance keeps plain clicks (edit, tick a todo) intact.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  // Prefer the card under the pointer over its section, so insertion lands at
  // the hovered card; the section only wins on its own background.
  const collisionDetection: CollisionDetection = useCallback((args) => {
    const hits = pointerWithin(args);
    const collisions = hits.length > 0 ? hits : rectIntersection(args);
    const card = collisions.find(
      (c) => !String(c.id).startsWith(CONTAINER_PREFIX) && String(c.id) !== LOOSE_ID,
    );
    return card ? [card] : collisions;
  }, []);

  const load = useCallback(async () => {
    setWorking(true);
    try {
      setData(await api.boardClusters());
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    } finally {
      setWorking(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- container helpers over the local BoardData ----

  const listOf = (d: BoardData, container: string): Note[] =>
    container === LOOSE_ID
      ? d.loose
      : (d.clusters.find((c) => CONTAINER_PREFIX + c.anchor_id === container)?.notes ?? []);

  const withList = (d: BoardData, container: string, notes: Note[]): BoardData =>
    container === LOOSE_ID
      ? { ...d, loose: notes }
      : {
          ...d,
          clusters: d.clusters.map((c) =>
            CONTAINER_PREFIX + c.anchor_id === container ? { ...c, notes } : c,
          ),
        };

  const findContainer = (d: BoardData, id: string): string | null => {
    if (id === LOOSE_ID || id.startsWith(CONTAINER_PREFIX)) return id;
    const cluster = d.clusters.find((c) => c.notes.some((n) => n.id === id));
    if (cluster) return CONTAINER_PREFIX + cluster.anchor_id;
    return d.loose.some((n) => n.id === id) ? LOOSE_ID : null;
  };

  const replaceNote = (d: BoardData, note: Note): BoardData => ({
    ...d,
    clusters: d.clusters.map((c) => ({
      ...c,
      notes: c.notes.map((n) => (n.id === note.id ? note : n)),
    })),
    loose: d.loose.map((n) => (n.id === note.id ? note : n)),
  });

  // ---- drag lifecycle ----

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setActiveId(id);
    if (data) {
      const container = findContainer(data, id);
      if (container) dragOrigin.current = { data, container };
    }
  };

  /** Cross-container moves happen live, so the cards part to show exactly
   *  where the dragged one will land. */
  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over) return;
    const noteId = String(active.id);
    const overId = String(over.id);
    setData((d) => {
      if (!d) return d;
      const from = findContainer(d, noteId);
      const to = findContainer(d, overId);
      if (!from || !to || from === to) return d;
      const fromList = listOf(d, from);
      const note = fromList.find((n) => n.id === noteId);
      if (!note) return d;
      const toList = listOf(d, to);
      const overIndex = toList.findIndex((n) => n.id === overId);
      const insertAt = overIndex === -1 ? toList.length : overIndex;
      return withList(
        withList(d, from, fromList.filter((n) => n.id !== noteId)),
        to,
        [...toList.slice(0, insertAt), note, ...toList.slice(insertAt)],
      );
    });
  };

  const onDragCancel = () => {
    if (dragOrigin.current) setData(dragOrigin.current.data);
    dragOrigin.current = null;
    setActiveId(null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    const origin = dragOrigin.current;
    dragOrigin.current = null;
    setActiveId(null);
    if (!data || !origin) return;
    if (!over) {
      setData(origin.data); // dropped on nothing — put everything back
      return;
    }

    const noteId = String(active.id);
    let d = data;
    const container = findContainer(d, noteId);
    if (!container) return;

    // Final within-container placement (cross-container was applied live).
    const overContainer = findContainer(d, String(over.id));
    if (overContainer === container && String(over.id) !== noteId) {
      const list = listOf(d, container);
      const oldIndex = list.findIndex((n) => n.id === noteId);
      const newIndex = list.findIndex((n) => n.id === String(over.id));
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        d = withList(d, container, arrayMove(list, oldIndex, newIndex));
        setData(d);
      }
    }

    const orderedIds = listOf(d, container).map((n) => n.id);
    if (container === origin.container) {
      const before = listOf(origin.data, container).map((n) => n.id);
      if (before.join("\n") !== orderedIds.join("\n")) {
        api.setBoardOrder(orderedIds).catch((err) => {
          useStore.getState().toast(String(err), "error");
          void load();
        });
      }
    } else {
      void persistCorrection(d, noteId, container, orderedIds);
    }
  };

  /** A cross-cluster drop is a correction: sticky must-link to the target
   *  cluster's anchor (or a sticky "stay loose"). When the cluster's label is
   *  a real tag, the note picks it up too — the correction compounds instead
   *  of rotting like a remembered pixel position would. */
  const persistCorrection = async (
    d: BoardData,
    noteId: string,
    container: string,
    orderedIds: string[],
  ) => {
    const st = useStore.getState();
    const anchorId =
      container === LOOSE_ID ? null : container.slice(CONTAINER_PREFIX.length);
    const cluster = anchorId ? d.clusters.find((c) => c.anchor_id === anchorId) : null;
    const label = cluster?.label ?? "Loose notes";
    const labelTag = cluster?.label_tag ?? null;
    let taggedWith: string | null = null;
    try {
      await api.setBoardLink(noteId, anchorId);
      const note = listOf(d, container).find((n) => n.id === noteId);
      if (labelTag && note && !note.tags.some((t) => t.tag === labelTag)) {
        const updated = await api.addTag(noteId, labelTag);
        taggedWith = labelTag;
        setData((cur) => (cur ? replaceNote(cur, updated) : cur));
        void st.refreshTags();
      }
      setData((cur) =>
        cur && !cur.corrected.includes(noteId)
          ? { ...cur, corrected: [...cur.corrected, noteId] }
          : cur,
      );
      await api.setBoardOrder(orderedIds);
      st.toast(
        anchorId
          ? `Moved to “${label}”${taggedWith ? ` and tagged #${taggedWith}` : ""} — it'll stay put through re-tidies`
          : "Kept loose — re-tidies won't pull it into a cluster",
        "success",
        {
          label: "Undo",
          run: () => {
            void (async () => {
              await api.clearBoardLink(noteId);
              if (taggedWith) await api.removeTag(noteId, taggedWith);
              await load();
            })();
          },
        },
      );
    } catch (err) {
      st.toast(String(err), "error");
      void load();
    }
  };

  /** Drop a deleted note out of the local wall without a full re-cluster. */
  const removeLocal = useCallback((id: string) => {
    setData((d) =>
      d === null
        ? d
        : {
            ...d,
            clusters: d.clusters
              .map((c) => ({ ...c, notes: c.notes.filter((n) => n.id !== id) }))
              .filter((c) => c.notes.length > 0),
            loose: d.loose.filter((n) => n.id !== id),
          },
    );
  }, []);

  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center text-stone-600">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  const corrected = new Set(data.corrected);
  const empty = data.clusters.length === 0 && data.loose.length === 0;
  const activeNote = activeId
    ? (data.clusters.flatMap((c) => c.notes).find((n) => n.id === activeId) ??
      data.loose.find((n) => n.id === activeId) ??
      null)
    : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div className="flex-1 overflow-y-auto px-5 pb-6">
        <div className="flex items-center gap-2 pb-3">
          <button
            onClick={() => void load()}
            disabled={working}
            title="Re-cluster the board — your hand-placed notes stay where you put them"
            className="flex cursor-pointer items-center gap-1 text-[10px] font-medium text-clay-400 transition-colors hover:text-clay-300 disabled:opacity-60"
          >
            {working ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            {working ? "Tidying…" : "Tidy board"}
          </button>
          {data.pending > 0 && (
            <span className="text-[10px] text-stone-600">
              · {data.pending} note{data.pending === 1 ? "" : "s"} still indexing
            </span>
          )}
          <span className="ml-auto text-[10px] text-stone-600">
            Drag a card to another cluster to correct it, or within its cluster to reorder
          </span>
        </div>

        {empty && (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-stone-600">
            <LayoutGrid size={22} strokeWidth={1.5} />
            <p className="text-xs">
              {embedderState === "downloading" || embedderState === "loading"
                ? "The semantic engine is warming up — clusters appear once notes are indexed."
                : data.pending > 0
                  ? "Notes are still being indexed — clusters appear as themes emerge."
                  : "No notes on the board yet. Write a few and they'll cluster by theme."}
            </p>
          </div>
        )}

        {data.clusters.map((c) => (
          <ClusterSection
            key={c.anchor_id}
            containerId={CONTAINER_PREFIX + c.anchor_id}
            label={c.label}
            isLoose={false}
            notes={c.notes}
            corrected={corrected}
            onCorrectionCleared={load}
            onDeleted={removeLocal}
          />
        ))}
        {/* Keep the loose section mounted while dragging even when it's empty,
            so a card can always be pulled out of every cluster. */}
        {(data.loose.length > 0 || activeId !== null) && (
          <ClusterSection
            containerId={LOOSE_ID}
            label="Loose notes"
            isLoose
            notes={data.loose}
            corrected={corrected}
            onCorrectionCleared={load}
            onDeleted={removeLocal}
          />
        )}
      </div>
      <DragOverlay>
        {activeNote ? (
          <div className="pointer-events-none rotate-2">
            <div className="rounded-xl shadow-2xl shadow-black/60 ring-1 ring-clay-500/70">
              <BoardCard note={activeNote} corrected={corrected.has(activeNote.id)} />
            </div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function ClusterSection({
  containerId,
  label,
  isLoose,
  notes,
  corrected,
  onCorrectionCleared,
  onDeleted,
}: {
  containerId: string;
  label: string;
  /** The unclustered section — dropping here keeps a note deliberately loose. */
  isLoose: boolean;
  notes: Note[];
  corrected: Set<string>;
  onCorrectionCleared: () => Promise<void>;
  onDeleted: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: containerId });

  return (
    <section
      ref={setNodeRef}
      className={`mb-4 rounded-xl p-2 transition-colors ${
        isOver ? "bg-clay-600/10 ring-1 ring-inset ring-clay-500" : ""
      }`}
    >
      <div className="flex items-center gap-1.5 px-1 pb-1.5">
        {isLoose ? (
          <FileText size={11} className="text-stone-600" />
        ) : (
          <Sparkles size={11} className="text-sage-400" />
        )}
        <span className="text-[11px] font-semibold text-stone-300">{label}</span>
        <span className="text-[10px] text-stone-600">{notes.length}</span>
      </div>
      <SortableContext items={notes.map((n) => n.id)} strategy={rectSortingStrategy}>
        <div className="grid min-h-10 grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
          {notes.map((n) => (
            <SortableCard
              key={n.id}
              note={n}
              corrected={corrected.has(n.id)}
              onCorrectionCleared={onCorrectionCleared}
              onDeleted={onDeleted}
            />
          ))}
        </div>
      </SortableContext>
    </section>
  );
}

/** Sortable wrapper: the whole card is the drag handle; while it's in flight
 *  the DragOverlay carries the visual and this placeholder dims to mark the
 *  landing slot. Neighbours animate aside via dnd-kit's transforms.
 *  Memoized — one card's update shouldn't re-render its whole cluster
 *  (useSortable still re-renders this card during drags as needed). */
const SortableCard = memo(function SortableCard({
  note,
  corrected,
  onCorrectionCleared,
  onDeleted,
}: {
  note: Note;
  corrected: boolean;
  onCorrectionCleared?: () => Promise<void>;
  onDeleted?: (id: string) => void;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: note.id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...listeners}
      className={`cursor-grab active:cursor-grabbing ${isDragging ? "opacity-30" : ""}`}
    >
      <BoardCard
        note={note}
        corrected={corrected}
        onCorrectionCleared={onCorrectionCleared}
        onDeleted={onDeleted}
      />
    </div>
  );
});

// ------------------------------------------------------------- simple feeds

function CardGrid({ notes, showScore }: { notes: Note[]; showScore?: boolean }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
      {notes.map((n) => (
        <BoardCard key={n.id} note={n} showScore={showScore} />
      ))}
    </div>
  );
}

function EmptyFeed({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-stone-600">
      {icon}
      <p className="text-xs">{text}</p>
    </div>
  );
}

function RecentBoard() {
  // Shallow-compared slice: a worker burst replacing note #500 must not
  // re-render this feed when the first RECENT_MAX entries are untouched.
  const recent = useStore(useShallow((s) => s.notes.slice(0, RECENT_MAX)));
  return (
    <div className="flex-1 overflow-y-auto px-5 pb-6">
      <p className="pb-3 text-[10px] text-stone-600">The last {RECENT_MAX} notes you touched.</p>
      {recent.length === 0 ? (
        <EmptyFeed icon={<Clock size={22} strokeWidth={1.5} />} text="Nothing here yet — recent notes show up as you write." />
      ) : (
        <CardGrid notes={recent} />
      )}
    </div>
  );
}

function PinnedBoard() {
  const pinned = useStore(useShallow((s) => s.notes.filter((n) => n.pinned)));
  return (
    <div className="flex-1 overflow-y-auto px-5 pb-6">
      <p className="pb-3 text-[10px] text-stone-600">
        Notes you pinned — right-click any note and choose Pin to add one.
      </p>
      {pinned.length === 0 ? (
        <EmptyFeed icon={<Pin size={22} strokeWidth={1.5} />} text="No pinned notes yet." />
      ) : (
        <CardGrid notes={pinned} />
      )}
    </div>
  );
}

function StaleBoard() {
  const [notes, setNotes] = useState<Note[] | null>(null);

  useEffect(() => {
    api
      .staleIdeas()
      .then(setNotes)
      .catch((e) => {
        useStore.getState().toast(String(e), "error");
        setNotes([]);
      });
  }, []);

  if (!notes) {
    return (
      <div className="flex flex-1 items-center justify-center text-stone-600">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto px-5 pb-6">
      <p className="pb-3 text-[10px] text-stone-600">
        Untouched for a month or more, but close to what you're working on now — the
        anti-forgetting feed.
      </p>
      {notes.length === 0 ? (
        <EmptyFeed
          icon={<Hourglass size={22} strokeWidth={1.5} />}
          text="Nothing has gone stale — every note has been touched recently."
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
          {notes.map((n) => (
            <BoardCard
              key={n.id}
              note={n}
              showScore
              onDeleted={(id) => setNotes((ns) => ns?.filter((m) => m.id !== id) ?? ns)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- card

/** An interactive sticky: edit the note in place, tick its to-dos, jot a new
 *  one — the editor stays one explicit click away instead of one accidental
 *  click away. List payloads carry a content excerpt, so the card lazily
 *  fetches the full note the first time an interaction needs it. */
const BoardCard = memo(function BoardCard({
  note,
  corrected = false,
  showScore = false,
  onCorrectionCleared,
  onDeleted,
}: {
  note: Note;
  /** Hand-placed (a board_links row exists) — badged, AI never moves it. */
  corrected?: boolean;
  showScore?: boolean;
  onCorrectionCleared?: () => Promise<void>;
  onDeleted?: (id: string) => void;
}) {
  const llmReady = useStore((s) => s.settings?.llm_backend !== "none");
  const previewMode = useStore((s) => s.settings?.board_preview ?? "summary");
  const [live, setLive] = useState<Note>(note);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [newTodo, setNewTodo] = useState("");
  const [showAllTodos, setShowAllTodos] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** True once `live.content` is the whole note, not the list excerpt. */
  const fullRef = useRef(note.content.length < EXCERPT_LEN);
  const liveRef = useRef(live);
  liveRef.current = live;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adopt fresh server copies (board reloads, store updates) — but never let
  // a stale excerpt clobber a fuller copy of the same revision: take the new
  // metadata (tags, pin, summary) and keep our full content.
  useEffect(() => {
    setLive((cur) => {
      if (
        cur.id === note.id &&
        fullRef.current &&
        cur.updated_at >= note.updated_at &&
        cur.content.startsWith(note.content)
      ) {
        return { ...note, content: cur.content };
      }
      fullRef.current = note.content.length < EXCERPT_LEN;
      return note;
    });
  }, [note]);

  const adopt = (n: Note) => {
    fullRef.current = true;
    setLive(n);
    useStore.getState().applyNoteUpdate(n);
  };

  const ensureFull = async (): Promise<Note> => {
    if (fullRef.current) return liveRef.current;
    const n = await api.getNote(liveRef.current.id);
    fullRef.current = true;
    setLive(n);
    return n;
  };

  // A truncated excerpt can hide checkboxes past the cut — fetch the real
  // thing as soon as the card looks like a to-do list.
  const looksLikeTodos = /(^|\n)\s*[-*+]\s+\[( |x|X)\]/.test(live.content);
  useEffect(() => {
    if (looksLikeTodos && !fullRef.current) {
      void ensureFull().catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [looksLikeTodos]);

  const persist = async (n: Note, content: string) => {
    const updated = await api.updateNote(n.id, n.title, content);
    adopt(updated);
  };

  const flushDraft = async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const content = draftRef.current;
    if (content === liveRef.current.content) return;
    try {
      await persist(liveRef.current, content);
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
  };

  const scheduleDraftSave = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flushDraft(), 600);
  };

  // Don't lose a pending edit if the card unmounts mid-debounce.
  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        void flushDraft();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const enterEdit = async () => {
    try {
      const n = await ensureFull();
      setDraft(n.content);
      setEditing(true);
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
  };

  const exitEdit = () => {
    void flushDraft();
    setEditing(false);
  };

  const toggleTodo = async (line: number) => {
    try {
      const n = await ensureFull();
      await persist(n, toggleTodoAtLine(n.content, line));
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
  };

  const addTodo = async () => {
    const text = newTodo.trim();
    if (!text) return;
    setNewTodo("");
    try {
      const n = await ensureFull();
      await persist(n, appendTodo(n.content, text));
    } catch (e) {
      useStore.getState().toast(String(e), "error");
      setNewTodo(text);
    }
  };

  const del = () => {
    if (!confirmDel) {
      setConfirmDel(true);
      setTimeout(() => setConfirmDel(false), 4000);
      return;
    }
    const id = live.id;
    void useStore
      .getState()
      .deleteNote(id)
      .then(() => onDeleted?.(id));
  };

  const openNote = () => void useStore.getState().selectNote(live.id);

  const todos = parseTodos(live.content);
  const visibleTodos = showAllTodos ? todos : todos.slice(0, MAX_TODOS_SHOWN);
  const preview = notePreview(live, previewMode, 160);

  const headerBtn =
    "cursor-pointer rounded p-0.5 text-stone-500 transition-colors hover:bg-stone-800 hover:text-stone-200";

  return (
    <>
      <div
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        // select-none keeps a press-and-move on the card's text starting a
        // drag instead of a text selection.
        className="group flex h-full select-none flex-col rounded-xl border border-stone-800 bg-stone-900 p-3 text-left transition-colors hover:border-stone-700"
      >
        <div className="flex w-full items-center gap-1.5">
          <span className="truncate text-xs font-semibold text-stone-100">
            {noteDisplayTitle(live)}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {live.pinned && <Pin size={9} className="text-stone-600 group-hover:hidden" />}
            {corrected && (
              <span
                title="Placed by you — re-tidies won't move it"
                className="flex group-hover:hidden"
              >
                <Hand size={10} className="text-clay-400" />
              </span>
            )}
            {showScore && typeof live.score === "number" && (
              <span
                className="rounded bg-stone-800 px-1 text-[9px] text-stone-400 group-hover:hidden"
                title="How close this sits to what you've worked on lately"
              >
                {(live.score * 100).toFixed(0)}%
              </span>
            )}
            <span
              className={`items-center gap-0.5 ${confirmDel ? "flex" : "hidden group-hover:flex"}`}
            >
              <button
                // Keep the textarea focused through the press, so "done" sees
                // editing=true instead of a blur racing it back into edit mode.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => (editing ? exitEdit() : void enterEdit())}
                title={editing ? "Done editing" : "Edit here on the board"}
                className={headerBtn}
              >
                {editing ? <Check size={11} /> : <Pencil size={11} />}
              </button>
              <button onClick={openNote} title="Open the note in the editor" className={headerBtn}>
                <ExternalLink size={11} />
              </button>
              <button
                onClick={del}
                title={confirmDel ? "Click again to move to trash" : "Delete note"}
                className={
                  confirmDel
                    ? "cursor-pointer rounded bg-red-950/70 p-0.5 text-red-400"
                    : "cursor-pointer rounded p-0.5 text-stone-500 transition-colors hover:bg-stone-800 hover:text-red-400"
                }
              >
                <Trash2 size={11} />
              </button>
            </span>
          </span>
        </div>

        {editing ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              scheduleDraftSave();
            }}
            // Typing and selecting must never arm the card's drag sensor.
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={exitEdit}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            rows={Math.min(14, Math.max(4, draft.split("\n").length + 1))}
            spellCheck={false}
            placeholder="Write markdown…"
            className="mt-1.5 w-full select-text resize-none rounded-md bg-stone-950/60 p-2 font-mono text-[11px] leading-relaxed text-stone-200 outline-none ring-1 ring-stone-800 focus:ring-clay-700"
          />
        ) : todos.length > 0 ? (
          <div className="mt-1.5 flex flex-col gap-px">
            {/* Body rows are divs, not buttons — WebKit refuses to start the
                card's drag from an interactive child. */}
            {visibleTodos.map((t) => (
              <div
                key={t.line}
                onClick={() => void toggleTodo(t.line)}
                title={t.checked ? "Mark as not done" : "Mark as done"}
                className="flex w-full cursor-pointer items-start gap-1.5 rounded px-0.5 py-px text-left transition-colors hover:bg-stone-800/50"
              >
                <span
                  className={`mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center rounded border transition-colors ${
                    t.checked
                      ? "border-sage-600 bg-sage-700/60 text-white"
                      : "border-stone-600 text-transparent"
                  }`}
                >
                  <Check size={8} strokeWidth={3} />
                </span>
                <span
                  className={`min-w-0 flex-1 text-[11px] leading-relaxed ${
                    t.checked ? "text-stone-600 line-through" : "text-stone-400"
                  }`}
                >
                  {t.text || "…"}
                </span>
              </div>
            ))}
            {todos.length > MAX_TODOS_SHOWN && !showAllTodos && (
              <div
                onClick={() => setShowAllTodos(true)}
                className="cursor-pointer px-0.5 text-left text-[10px] text-stone-600 hover:text-stone-400"
              >
                +{todos.length - MAX_TODOS_SHOWN} more
              </div>
            )}
            <input
              value={newTodo}
              onChange={(e) => setNewTodo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addTodo();
              }}
              // Typing here must never arm the card's drag sensor.
              onPointerDown={(e) => e.stopPropagation()}
              placeholder="+ Add a to-do…"
              className={`mt-1 w-full select-text rounded bg-transparent px-0.5 py-px text-[11px] text-stone-300 outline-none transition-opacity placeholder:text-stone-600 focus:bg-stone-950/60 ${
                newTodo ? "" : "opacity-0 focus:opacity-100 group-hover:opacity-100"
              }`}
            />
          </div>
        ) : (
          <div
            onClick={() => void enterEdit()}
            title="Click to edit here on the board"
            className="cursor-text text-left"
          >
            {preview.text ? (
              <p className="mt-1 line-clamp-4 whitespace-pre-line text-[11px] leading-relaxed text-stone-500">
                {preview.isSummary && (
                  <span title="AI summary — open the note for the full text" className="mr-1 inline-flex align-baseline">
                    <Sparkles size={9} className="text-sage-500" />
                  </span>
                )}
                {preview.text}
              </p>
            ) : (
              <p className="mt-1 text-[11px] italic text-stone-600">Empty note — click to write</p>
            )}
          </div>
        )}

        <div className="mt-auto flex w-full items-center gap-1.5 pt-2">
          <span className="shrink-0 text-[9px] text-stone-600">{relativeTime(live.updated_at)}</span>
          <span className="no-scrollbar flex min-w-0 gap-1 overflow-x-auto">
            {live.tags.map((t) => (
              <span
                key={t.tag}
                className={`shrink-0 rounded-full px-1.5 text-[9px] ${
                  t.source === "ai"
                    ? "border border-sage-700/60 text-sage-400"
                    : "bg-stone-800 text-stone-400"
                }`}
              >
                {t.tag}
              </span>
            ))}
          </span>
        </div>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Open",
              icon: <FileText size={13} />,
              onClick: openNote,
            },
            {
              label: "Edit on the board",
              icon: <Pencil size={13} />,
              onClick: () => void enterEdit(),
            },
            {
              label: live.pinned ? "Unpin" : "Pin",
              icon: live.pinned ? <PinOff size={13} /> : <Pin size={13} />,
              onClick: async () => {
                try {
                  const updated = await api.setNotePinned(live.id, !live.pinned);
                  adopt(updated);
                } catch (e) {
                  useStore.getState().toast(String(e), "error");
                }
              },
            },
            ...(llmReady
              ? [
                  {
                    label: "Refresh summary",
                    icon: <Sparkles size={13} />,
                    onClick: async () => {
                      try {
                        adopt(await api.aiSummarizeNote(live.id));
                      } catch (e) {
                        useStore.getState().toast(String(e), "error");
                      }
                    },
                  },
                ]
              : []),
            ...(corrected
              ? [
                  {
                    label: "Let AI place it again",
                    icon: <Sparkles size={13} />,
                    onClick: async () => {
                      try {
                        await api.clearBoardLink(live.id);
                        useStore.getState().toast("Back to automatic placement");
                        await onCorrectionCleared?.();
                      } catch (e) {
                        useStore.getState().toast(String(e), "error");
                      }
                    },
                  },
                ]
              : []),
            {
              label: "Delete",
              icon: <Trash2 size={13} />,
              danger: true,
              confirm: true,
              onClick: () => {
                const id = live.id;
                void useStore
                  .getState()
                  .deleteNote(id)
                  .then(() => onDeleted?.(id));
              },
            },
          ]}
        />
      )}
    </>
  );
});
