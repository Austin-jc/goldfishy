import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  Folder,
  FolderPlus,
  Loader2,
  Wand2,
  X,
} from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { noteDisplayTitle, stripMarkdown } from "../utils";
import type { ArrangeGroup, Note } from "../types";

/** A note's planned destination; null = no suggestion / don't move. */
interface Dest {
  folderId: string | null;
  folderName: string;
  isNew: boolean;
}

const destKey = (d: Dest) => d.folderId ?? `new:${d.folderName.toLowerCase()}`;

/**
 * Review-and-apply for the auto-arrange plan: the LLM proposes where each
 * unfiled note should be filed (existing folders preferred, new ones only for
 * multi-note topics, generic buckets banned). Every destination is editable —
 * reassign a note to any folder, type a brand-new one, or file the notes the
 * model had no suggestion for. Nothing moves until Apply, and only the rows
 * left selected.
 */
export default function AutoArrangeModal() {
  const close = () => useStore.getState().setArrangeOpen(false);
  const folders = useStore((s) => s.folders);
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [assign, setAssign] = useState<Record<string, Dest | null>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [picker, setPicker] = useState<{ noteId: string; x: number; y: number } | null>(
    null,
  );
  const [newName, setNewName] = useState("");

  // Seed the working set: plan groups first (in plan order), then every other
  // unfiled note as "no suggestion" so it can be filed manually.
  const seed = (gs: ArrangeGroup[]) => {
    const st = useStore.getState();
    const ordered: Note[] = [];
    const seen = new Set<string>();
    const a: Record<string, Dest | null> = {};
    for (const g of gs) {
      const dest: Dest = { folderId: g.folder_id, folderName: g.folder_name, isNew: g.is_new };
      for (const n of g.notes) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        ordered.push(n);
        a[n.id] = dest;
      }
    }
    for (const n of st.notes) {
      if (n.folder_id || n.deleted_at || seen.has(n.id)) continue;
      seen.add(n.id);
      ordered.push(n);
      a[n.id] = null;
    }
    setNotes(ordered);
    setAssign(a);
    setSelected(new Set(Object.keys(a).filter((id) => a[id] !== null)));
  };

  useEffect(() => {
    void api
      .planAutoArrange()
      .then(seed)
      .catch((e) => {
        useStore.getState().toast(String(e), "error");
        seed([]); // manual filing still works without a plan
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string) => {
    if (!assign[id]) return; // nothing to move yet — pick a folder first
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const setDest = (noteId: string, dest: Dest | null) => {
    setAssign((a) => ({ ...a, [noteId]: dest }));
    setSelected((s) => {
      const next = new Set(s);
      if (dest) {
        next.add(noteId);
      } else {
        next.delete(noteId);
      }
      return next;
    });
    setPicker(null);
    setNewName("");
  };

  // Derived view: groups in first-seen order, unassigned notes trailing.
  const grouped: { key: string; dest: Dest; notes: Note[] }[] = [];
  const unassigned: Note[] = [];
  for (const n of notes ?? []) {
    const d = assign[n.id];
    if (!d) {
      unassigned.push(n);
      continue;
    }
    const k = destKey(d);
    const g = grouped.find((x) => x.key === k);
    if (g) {
      g.notes.push(n);
    } else {
      grouped.push({ key: k, dest: d, notes: [n] });
    }
  }
  const count = grouped.flatMap((g) => g.notes).filter((n) => selected.has(n.id)).length;

  // New-folder names already in the plan, offered as picker targets too.
  const plannedNew = grouped.filter((g) => g.dest.isNew).map((g) => g.dest);

  const chooseNewFolder = (noteId: string) => {
    const name = newName.trim();
    if (!name) return;
    // Reuse an existing folder if the typed name matches one.
    const existing = folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
    setDest(
      noteId,
      existing
        ? { folderId: existing.id, folderName: existing.name, isNew: false }
        : { folderId: null, folderName: name, isNew: true },
    );
  };

  const apply = async () => {
    if (count === 0) return;
    setApplying(true);
    try {
      const moves = grouped.flatMap((g) =>
        g.notes
          .filter((n) => selected.has(n.id))
          .map((n) => ({
            note_id: n.id,
            folder_id: g.dest.folderId,
            folder_name: g.dest.folderName,
          })),
      );
      const moved = await api.applyAutoArrange(moves);
      const st = useStore.getState();
      await st.refreshNotes();
      void st.refreshFolders();
      st.toast(`Filed ${moved} note${moved === 1 ? "" : "s"}`, "success");
      close();
    } catch (e) {
      useStore.getState().toast(String(e), "error");
      setApplying(false);
    }
  };

  const pickerNote = picker ? (notes ?? []).find((n) => n.id === picker.noteId) : null;
  const pickerDest = pickerNote ? assign[pickerNote.id] : null;

  const noteRow = (n: Note) => {
    const d = assign[n.id];
    return (
      <div
        key={n.id}
        className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-stone-800/60"
      >
        <button
          onClick={() => toggle(n.id)}
          disabled={!d}
          title={d ? "Include in the move" : "Pick a folder first"}
          className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded border transition-colors disabled:cursor-default ${
            d && selected.has(n.id)
              ? "border-clay-500 bg-clay-600 text-white"
              : "border-stone-600 text-transparent"
          } ${!d ? "opacity-40" : ""}`}
        >
          <Check size={10} strokeWidth={3} />
        </button>
        <button
          onClick={(e) =>
            d
              ? toggle(n.id)
              : setPicker({
                  noteId: n.id,
                  x: e.clientX,
                  y: e.clientY,
                })
          }
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <span className="block truncate text-xs text-stone-200">
            {noteDisplayTitle(n)}
          </span>
          <span className="line-clamp-1 text-[10px] text-stone-500">
            {stripMarkdown(n.content).slice(0, 110)}
          </span>
        </button>
        <button
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setPicker({ noteId: n.id, x: r.right, y: r.bottom });
            setNewName("");
          }}
          title="Choose a different folder"
          className="mt-0.5 flex shrink-0 cursor-pointer items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-stone-500 transition-colors hover:bg-stone-800 hover:text-stone-200"
        >
          {d ? "change" : "choose folder…"}
          <ChevronDown size={10} />
        </button>
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/50 pt-20"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="flex h-fit max-h-[72vh] w-[560px] flex-col overflow-hidden rounded-xl border border-stone-800 bg-stone-900 shadow-2xl">
        <header className="flex items-center gap-2 border-b border-stone-800 px-4 py-3">
          <Wand2 size={15} className="text-clay-400" />
          <h2 className="text-sm font-semibold text-stone-100">
            Auto-arrange unfiled notes
          </h2>
          <span className="text-[10px] text-stone-500">
            review &amp; adjust — nothing moves until you apply
          </span>
          <button
            onClick={close}
            className="ml-auto cursor-pointer rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-stone-800 hover:text-stone-200"
          >
            <X size={15} />
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-3">
          {notes === null && (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-stone-500">
              <Loader2 size={14} className="animate-spin" />
              Planning homes for your unfiled notes…
            </div>
          )}

          {grouped.map((g) => {
            const allOn = g.notes.every((n) => selected.has(n.id));
            return (
              <div key={g.key} className="rounded-xl bg-stone-950/50 p-2">
                <button
                  onClick={() =>
                    setSelected((s) => {
                      const next = new Set(s);
                      for (const n of g.notes) {
                        if (allOn) {
                          next.delete(n.id);
                        } else {
                          next.add(n.id);
                        }
                      }
                      return next;
                    })
                  }
                  title={allOn ? "Deselect this folder" : "Select this folder"}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-stone-800/60"
                >
                  {g.dest.isNew ? (
                    <FolderPlus size={13} className="shrink-0 text-sage-400" />
                  ) : (
                    <Folder size={13} className="shrink-0 text-clay-400" />
                  )}
                  <span className="truncate text-xs font-medium text-stone-200">
                    {g.dest.folderName}
                  </span>
                  {g.dest.isNew && (
                    <span className="shrink-0 rounded-full bg-sage-900 px-1.5 py-px text-[9px] font-medium text-sage-300">
                      new folder
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-[10px] text-stone-600">
                    {allOn ? "deselect all" : "select all"}
                  </span>
                </button>
                {g.notes.map(noteRow)}
              </div>
            );
          })}

          {unassigned.length > 0 && (
            <div className="rounded-xl bg-stone-950/50 p-2">
              <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-stone-500">
                No suggestion — file these yourself if you like
              </p>
              {unassigned.map(noteRow)}
            </div>
          )}

          {notes !== null && notes.length === 0 && (
            <p className="px-4 py-10 text-center text-xs text-stone-500">
              No unfiled notes — everything already has a home.
            </p>
          )}
        </div>

        {notes !== null && notes.length > 0 && (
          <footer className="flex items-center gap-2 border-t border-stone-800 px-4 py-3">
            <button
              onClick={() => void apply()}
              disabled={applying || count === 0}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-clay-600 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-clay-500 disabled:opacity-50"
            >
              {applying ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Wand2 size={11} />
              )}
              {applying ? "Filing…" : `Move ${count} note${count === 1 ? "" : "s"}`}
            </button>
            <button
              onClick={close}
              disabled={applying}
              className="cursor-pointer rounded-lg px-2 py-1 text-[11px] text-stone-500 transition-colors hover:bg-stone-800 hover:text-stone-300 disabled:opacity-50"
            >
              Cancel
            </button>
          </footer>
        )}
      </div>

      {/* Destination picker — fixed + anchor point so the scroll container
          can't clip it (same trick as DueDatePicker). */}
      {picker && pickerNote && (
        <>
          <div
            className="fixed inset-0 z-[60]"
            onMouseDown={() => {
              setPicker(null);
              setNewName("");
            }}
          />
          <div
            className="fixed z-[70] w-60 overflow-hidden rounded-xl border border-stone-800 bg-stone-900 shadow-2xl"
            style={{
              left: Math.max(8, Math.min(picker.x - 240, window.innerWidth - 248)),
              top: Math.min(picker.y + 4, window.innerHeight - 320),
            }}
          >
            <div className="max-h-56 overflow-y-auto p-1.5">
              {pickerDest && (
                <button
                  onClick={() => setDest(pickerNote.id, null)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-stone-400 transition-colors hover:bg-stone-800"
                >
                  <X size={12} className="shrink-0" />
                  Don't move this note
                </button>
              )}
              {plannedNew.map((d) => (
                <button
                  key={`new:${d.folderName.toLowerCase()}`}
                  onClick={() => setDest(pickerNote.id, d)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-stone-200 transition-colors hover:bg-stone-800"
                >
                  <FolderPlus size={12} className="shrink-0 text-sage-400" />
                  <span className="truncate">{d.folderName}</span>
                  <span className="ml-auto shrink-0 rounded-full bg-sage-900 px-1.5 py-px text-[9px] text-sage-300">
                    new
                  </span>
                  {pickerDest && destKey(pickerDest) === destKey(d) && (
                    <Check size={12} className="shrink-0 text-clay-400" />
                  )}
                </button>
              ))}
              {folders.map((f) => {
                const d: Dest = { folderId: f.id, folderName: f.name, isNew: false };
                const current = pickerDest && destKey(pickerDest) === destKey(d);
                return (
                  <button
                    key={f.id}
                    onClick={() => setDest(pickerNote.id, d)}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-stone-200 transition-colors hover:bg-stone-800"
                  >
                    <Folder size={12} className="shrink-0 text-clay-400" />
                    <span className="truncate">{f.name}</span>
                    {current && <Check size={12} className="ml-auto shrink-0 text-clay-400" />}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-1.5 border-t border-stone-800 p-1.5">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") chooseNewFolder(pickerNote.id);
                  if (e.key === "Escape") {
                    setPicker(null);
                    setNewName("");
                  }
                }}
                placeholder="New folder…"
                className="min-w-0 flex-1 rounded-lg bg-stone-950/60 px-2 py-1.5 text-xs text-stone-200 outline-none placeholder:text-stone-600"
              />
              <button
                onClick={() => chooseNewFolder(pickerNote.id)}
                disabled={!newName.trim()}
                className="shrink-0 cursor-pointer rounded-lg bg-clay-600 px-2 py-1.5 text-[10px] font-medium text-white transition-colors hover:bg-clay-500 disabled:opacity-40"
              >
                Add
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
