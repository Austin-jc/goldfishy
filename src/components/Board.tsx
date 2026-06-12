import { memo, useCallback, useEffect, useState } from "react";
import {
  Clock,
  FileText,
  Hand,
  Hourglass,
  LayoutGrid,
  Loader2,
  Pin,
  PinOff,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { noteDisplayTitle, relativeTime, stripMarkdown } from "../utils";
import ContextMenu from "./ContextMenu";
import type { BoardData, BoardMode, Note } from "../types";

const BOARD_MIME = "application/x-goldfishy-board-note";
const RECENT_MAX = 15;

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

  /** A drop is a correction: sticky must-link to the target cluster's anchor
   *  (or a sticky "stay loose" when anchor is null). When the cluster's label
   *  is a real tag, the note picks it up too — the correction compounds
   *  instead of rotting like a remembered pixel position would. */
  const dropOn = async (
    noteId: string,
    anchorId: string | null,
    label: string,
    labelTag: string | null,
  ) => {
    const st = useStore.getState();
    let taggedWith: string | null = null;
    try {
      await api.setBoardLink(noteId, anchorId);
      if (labelTag) {
        const note =
          data?.clusters.flatMap((c) => c.notes).find((n) => n.id === noteId) ??
          data?.loose.find((n) => n.id === noteId);
        if (note && !note.tags.some((t) => t.tag === labelTag)) {
          await api.addTag(noteId, labelTag);
          taggedWith = labelTag;
        }
      }
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
      await load();
      void st.refreshTags();
    } catch (e) {
      st.toast(String(e), "error");
    }
  };

  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center text-stone-600">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  const corrected = new Set(data.corrected);
  const empty = data.clusters.length === 0 && data.loose.length === 0;

  return (
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
          Drag a card onto another cluster to correct it — your placement always wins
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
          label={c.label}
          labelTag={c.label_tag}
          anchorId={c.anchor_id}
          notes={c.notes}
          corrected={corrected}
          onDrop={dropOn}
          onCorrectionCleared={load}
        />
      ))}
      {data.loose.length > 0 && (
        <ClusterSection
          label="Loose notes"
          labelTag={null}
          anchorId={null}
          notes={data.loose}
          corrected={corrected}
          onDrop={dropOn}
          onCorrectionCleared={load}
        />
      )}
    </div>
  );
}

function ClusterSection({
  label,
  labelTag,
  anchorId,
  notes,
  corrected,
  onDrop,
  onCorrectionCleared,
}: {
  label: string;
  labelTag: string | null;
  /** Null for the loose section — dropping here keeps a note unclustered. */
  anchorId: string | null;
  notes: Note[];
  corrected: Set<string>;
  onDrop: (
    noteId: string,
    anchorId: string | null,
    label: string,
    labelTag: string | null,
  ) => Promise<void>;
  onCorrectionCleared: () => Promise<void>;
}) {
  const [hover, setHover] = useState(false);

  return (
    <section
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(BOARD_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setHover(true);
        }
      }}
      onDragLeave={(e) => {
        // Only clear when truly leaving the section, not entering a child.
        if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setHover(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        const noteId = e.dataTransfer.getData(BOARD_MIME);
        if (!noteId || notes.some((n) => n.id === noteId)) return;
        void onDrop(noteId, anchorId, label, labelTag);
      }}
      className={`mb-4 rounded-xl p-2 transition-colors ${
        hover ? "bg-clay-600/10 ring-1 ring-inset ring-clay-500" : ""
      }`}
    >
      <div className="flex items-center gap-1.5 px-1 pb-1.5">
        {anchorId === null ? (
          <FileText size={11} className="text-stone-600" />
        ) : (
          <Sparkles size={11} className="text-sage-400" />
        )}
        <span className="text-[11px] font-semibold text-stone-300">{label}</span>
        <span className="text-[10px] text-stone-600">{notes.length}</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
        {notes.map((n) => (
          <BoardCard
            key={n.id}
            note={n}
            corrected={corrected.has(n.id)}
            draggable
            onCorrectionCleared={onCorrectionCleared}
          />
        ))}
      </div>
    </section>
  );
}

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
  const notes = useStore((s) => s.notes);
  const recent = notes.slice(0, RECENT_MAX);
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
  const notes = useStore((s) => s.notes);
  const pinned = notes.filter((n) => n.pinned);
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
        <CardGrid notes={notes} showScore />
      )}
    </div>
  );
}

// ------------------------------------------------------------------- card

const BoardCard = memo(function BoardCard({
  note,
  corrected = false,
  draggable = false,
  showScore = false,
  onCorrectionCleared,
}: {
  note: Note;
  /** Hand-placed (a board_links row exists) — badged, AI never moves it. */
  corrected?: boolean;
  draggable?: boolean;
  showScore?: boolean;
  onCorrectionCleared?: () => Promise<void>;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const preview = stripMarkdown(note.content).slice(0, 160);

  return (
    <>
      <button
        onClick={() => void useStore.getState().selectNote(note.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        draggable={draggable}
        onDragStart={(e) => {
          e.dataTransfer.setData(BOARD_MIME, note.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        className="flex cursor-pointer flex-col rounded-xl border border-stone-800 bg-stone-900 p-3 text-left transition-colors hover:border-stone-700 hover:bg-stone-800/60"
      >
        <div className="flex w-full items-center gap-1.5">
          <span className="truncate text-xs font-semibold text-stone-100">
            {noteDisplayTitle(note)}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {note.pinned && <Pin size={9} className="text-stone-600" />}
            {corrected && (
              <span title="Placed by you — re-tidies won't move it" className="flex">
                <Hand size={10} className="text-clay-400" />
              </span>
            )}
            {showScore && typeof note.score === "number" && (
              <span
                className="rounded bg-stone-800 px-1 text-[9px] text-stone-400"
                title="How close this sits to what you've worked on lately"
              >
                {(note.score * 100).toFixed(0)}%
              </span>
            )}
          </span>
        </div>
        {preview ? (
          <p className="mt-1 line-clamp-4 text-[11px] leading-relaxed text-stone-500">{preview}</p>
        ) : (
          <p className="mt-1 text-[11px] italic text-stone-600">Empty note</p>
        )}
        <div className="mt-auto flex w-full items-center gap-1.5 pt-2">
          <span className="shrink-0 text-[9px] text-stone-600">{relativeTime(note.updated_at)}</span>
          <span className="no-scrollbar flex min-w-0 gap-1 overflow-x-auto">
            {note.tags.map((t) => (
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
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Open",
              icon: <FileText size={13} />,
              onClick: () => void useStore.getState().selectNote(note.id),
            },
            {
              label: note.pinned ? "Unpin" : "Pin",
              icon: note.pinned ? <PinOff size={13} /> : <Pin size={13} />,
              onClick: async () => {
                try {
                  const updated = await api.setNotePinned(note.id, !note.pinned);
                  useStore.getState().applyNoteUpdate(updated);
                } catch (e) {
                  useStore.getState().toast(String(e), "error");
                }
              },
            },
            ...(corrected
              ? [
                  {
                    label: "Let AI place it again",
                    icon: <Sparkles size={13} />,
                    onClick: async () => {
                      try {
                        await api.clearBoardLink(note.id);
                        useStore.getState().toast("Back to automatic placement");
                        await onCorrectionCleared?.();
                      } catch (e) {
                        useStore.getState().toast(String(e), "error");
                      }
                    },
                  },
                ]
              : []),
          ]}
        />
      )}
    </>
  );
});
