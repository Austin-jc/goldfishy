import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Combine,
  FilePlus,
  FileText,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  Copy,
  Inbox,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Tag,
  Trash2,
  Undo2,
} from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { relativeTime, stripMarkdown } from "../utils";
import ContextMenu from "./ContextMenu";
import GoldfishLogo from "./GoldfishLogo";
import { NoteItem, SearchBar, SummaryBar } from "./NoteList";
import type { Folder, Note } from "../types";

const MIN_WIDTH = 240;
const MAX_WIDTH = 480;
const EXPANDED_KEY = "nn.expandedFolders";
const NOTE_MIME = "application/x-goldfishy-note";
const FOLDER_MIME = "application/x-goldfishy-folder";

function hasTreePayload(e: React.DragEvent) {
  return e.dataTransfer.types.includes(NOTE_MIME) || e.dataTransfer.types.includes(FOLDER_MIME);
}

/** Move whatever was dragged (note or folder) into the target folder. */
async function handleTreeDrop(e: React.DragEvent, targetFolderId: string | null) {
  const noteId = e.dataTransfer.getData(NOTE_MIME);
  const folderId = e.dataTransfer.getData(FOLDER_MIME);
  const st = useStore.getState();
  try {
    if (noteId) {
      await api.moveNote(noteId, targetFolderId);
      await st.refreshNotes();
      if (st.selectedNote?.id === noteId) void st.selectNote(noteId);
    } else if (folderId && folderId !== targetFolderId) {
      await api.moveFolder(folderId, targetFolderId);
      await st.refreshFolders();
    }
  } catch (err) {
    st.toast(String(err), "error");
  }
}

function loadExpanded(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "{}");
  } catch {
    return {};
  }
}

/** Everything the recursive tree rows need, bundled to avoid prop drift. */
interface TreeCtx {
  notesByFolder: Map<string | null, Note[]>;
  childrenOf: Map<string | null, Folder[]>;
  subtreeCounts: Map<string, number>;
  filterActive: boolean;
  isExpanded: (id: string) => boolean;
  setExpanded: (id: string, open: boolean) => void;
}

export default function Sidebar() {
  const folders = useStore((s) => s.folders);
  const tags = useStore((s) => s.tags);
  const view = useStore((s) => s.view);
  const queue = useStore((s) => s.queue);
  const notes = useStore((s) => s.notes);
  const tagFilter = useStore((s) => s.tagFilter);
  const searchResults = useStore((s) => s.searchResults);
  const selectView = useStore((s) => s.selectView);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const selectedNoteId = useStore((s) => s.selectedNote?.id ?? null);
  const settings = useStore((s) => s.settings);
  const [addingRoot, setAddingRoot] = useState(false);
  const [titlingAll, setTitlingAll] = useState(false);
  const [retagging, setRetagging] = useState(false);
  const [confirmRetag, setConfirmRetag] = useState(false);
  const [rootDropHover, setRootDropHover] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(
    () => localStorage.getItem("nn.tagsOpen") !== "0",
  );

  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem("nn.sidebarWidth"));
    return Number.isFinite(v) && v > 0 ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, v)) : 320;
  });
  const widthRef = useRef(width);
  widthRef.current = width;

  // User-toggled expansion, persisted. Default is expanded.
  const [expanded, setExpandedState] = useState<Record<string, boolean>>(loadExpanded);
  // Transient expansion while a tag filter is active — folders with matches
  // open up so the filtered notes are actually visible.
  const [autoOpen, setAutoOpen] = useState<Set<string>>(new Set());

  const setExpanded = (id: string, open: boolean) => {
    setExpandedState((prev) => {
      const next = { ...prev, [id]: open };
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(next));
      return next;
    });
    if (!open) {
      setAutoOpen((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  useEffect(() => {
    if (tagFilter.length === 0) {
      setAutoOpen((prev) => (prev.size > 0 ? new Set() : prev));
      return;
    }
    const byId = new Map(folders.map((f) => [f.id, f] as const));
    const ids = new Set<string>();
    for (const n of notes) {
      let cur = n.folder_id ? byId.get(n.folder_id) : undefined;
      while (cur) {
        ids.add(cur.id);
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
      }
    }
    setAutoOpen(ids);
  }, [tagFilter, notes, folders]);

  // Reveal the selected note: expand its folder chain (e.g. after opening a
  // note from search, the queue popover, or an action item).
  useEffect(() => {
    const st = useStore.getState();
    const fid = st.selectedNote?.folder_id;
    if (!fid) return;
    const byId = new Map(st.folders.map((f) => [f.id, f] as const));
    const chain: string[] = [];
    let cur = byId.get(fid);
    while (cur) {
      chain.push(cur.id);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    setExpandedState((prev) => {
      if (!chain.some((id) => prev[id] === false)) return prev;
      const next = { ...prev };
      for (const id of chain) next[id] = true;
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(next));
      return next;
    });
  }, [selectedNoteId]);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    const move = (ev: PointerEvent) =>
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem("nn.sidebarWidth", String(widthRef.current));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const ctx: TreeCtx = useMemo(() => {
    const notesByFolder = new Map<string | null, Note[]>();
    for (const n of notes) {
      const k = n.folder_id ?? null;
      const arr = notesByFolder.get(k);
      if (arr) arr.push(n);
      else notesByFolder.set(k, [n]);
    }
    const childrenOf = new Map<string | null, Folder[]>();
    for (const f of folders) {
      const k = f.parent_id ?? null;
      const arr = childrenOf.get(k);
      if (arr) arr.push(f);
      else childrenOf.set(k, [f]);
    }
    const subtreeCounts = new Map<string, number>();
    const walk = (f: Folder): number => {
      let c = notesByFolder.get(f.id)?.length ?? 0;
      for (const ch of childrenOf.get(f.id) ?? []) c += walk(ch);
      subtreeCounts.set(f.id, c);
      return c;
    };
    for (const root of childrenOf.get(null) ?? []) walk(root);
    return {
      notesByFolder,
      childrenOf,
      subtreeCounts,
      filterActive: tagFilter.length > 0,
      isExpanded: (id: string) => autoOpen.has(id) || expanded[id] !== false,
      setExpanded,
    };
  }, [notes, folders, tagFilter, expanded, autoOpen]);

  const roots = ctx.childrenOf.get(null) ?? [];
  const unfiled = ctx.notesByFolder.get(null) ?? [];
  const pinnedNotes = useMemo(() => notes.filter((n) => n.pinned), [notes]);

  const busy =
    (queue?.embed_pending ?? 0) + (queue?.llm_pending ?? 0) > 0 || queue?.sweep_active;

  const untitledCount = useMemo(
    () => notes.filter((n) => !n.title.trim() && n.content.trim()).length,
    [notes],
  );

  const titleAll = async () => {
    setTitlingAll(true);
    try {
      const n = await api.aiTitleUntitled();
      useStore.getState().toast(
        n > 0 ? `Auto-titled ${n} note${n === 1 ? "" : "s"}` : "No notes needed a title",
        "success",
      );
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    } finally {
      setTitlingAll(false);
    }
  };

  // Heavy (one LLM call per note) — armed with a two-step confirm.
  const retagAll = async () => {
    if (!confirmRetag) {
      setConfirmRetag(true);
      setTimeout(() => setConfirmRetag(false), 2500);
      return;
    }
    setConfirmRetag(false);
    setRetagging(true);
    try {
      const n = await api.aiRetagAll();
      const st = useStore.getState();
      void st.refreshTags();
      void st.refreshNotes();
      st.toast(`Re-tagged ${n} note${n === 1 ? "" : "s"}`, "success");
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    } finally {
      setRetagging(false);
    }
  };

  // Click to toggle: add to the selection, click again to remove.
  const toggleTag = (tag: string) => {
    const next = tagFilter.includes(tag)
      ? tagFilter.filter((t) => t !== tag)
      : [...tagFilter, tag];
    useStore.getState().setTagFilter(next);
  };

  if (collapsed) {
    return (
      <button
        onClick={toggleSidebar}
        title="Show sidebar (⌘\)"
        className="fixed left-3 top-3 z-30 cursor-pointer rounded-lg bg-stone-900/80 p-2 text-stone-500 transition-colors hover:bg-stone-800 hover:text-stone-200"
      >
        <PanelLeftOpen size={15} />
      </button>
    );
  }

  return (
    <aside
      className="relative flex shrink-0 flex-col bg-stone-900/40"
      style={{ width }}
    >
      {/* header */}
      <div className="flex items-center gap-2 px-4 pb-3 pt-4">
        <span title="GoldFishy" className="flex items-center">
          <GoldfishLogo size={26} />
        </span>
        {busy && (
          <span
            className="pulse-dot h-2 w-2 rounded-full bg-clay-400"
            title="AI engine working in the background"
          />
        )}
        <span className="ml-auto flex items-center gap-0.5">
          <ActionsBell />
          <button
            onClick={() => setSettingsOpen(true)}
            className="cursor-pointer rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-stone-800 hover:text-stone-200"
            title="Settings (⌘,)"
          >
            <Settings size={15} />
          </button>
          <button
            onClick={toggleSidebar}
            className="cursor-pointer rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-stone-800 hover:text-stone-200"
            title="Hide sidebar (⌘\)"
          >
            <PanelLeftClose size={15} />
          </button>
          <button
            onClick={() => void useStore.getState().createNote()}
            className="ml-1 flex cursor-pointer items-center gap-1 rounded-lg bg-clay-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-clay-500"
            title="New note (⌘N)"
          >
            <Plus size={13} />
            New
          </button>
        </span>
      </div>

      {/* search */}
      <div className="px-3 pb-3">
        <SearchBar />
      </div>

      <div className="flex-1 overflow-y-auto">
        {searchResults ? (
          <div className="mt-1">
            <div className="px-4 pb-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">
                Results · {searchResults.length}
              </span>
            </div>
            <div className="space-y-0.5 px-2 pb-2">
              {searchResults.map((n) => (
                <NoteItem key={n.id} note={n} />
              ))}
            </div>
            {searchResults.length === 0 && (
              <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-stone-600">
                <FileText size={20} strokeWidth={1.5} />
                <p className="text-xs">No results</p>
              </div>
            )}
          </div>
        ) : (
          <div className="px-2 pb-2">
            {/* the explorer root — hover for a new folder, drop to unfile */}
            <div
              onDragOver={(e) => {
                if (hasTreePayload(e)) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setRootDropHover(true);
                }
              }}
              onDragLeave={() => setRootDropHover(false)}
              onDrop={(e) => {
                e.preventDefault();
                setRootDropHover(false);
                void handleTreeDrop(e, null);
              }}
              className={`group flex items-center rounded-lg transition-colors ${
                rootDropHover
                  ? "bg-clay-600/15 ring-1 ring-inset ring-clay-500"
                  : view.kind === "all"
                    ? "bg-clay-600/15"
                    : "hover:bg-stone-800/60"
              }`}
            >
              <button
                onClick={() => selectView({ kind: "all", key: null })}
                className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ${
                  view.kind === "all" ? "text-clay-300" : "text-stone-300"
                }`}
              >
                <Inbox size={15} />
                All Notes
              </button>
              <span className="mr-2 text-[10px] text-stone-600 group-hover:hidden">
                {notes.length}
              </span>
              <button
                onClick={() => setAddingRoot(true)}
                className="mr-1.5 hidden shrink-0 cursor-pointer rounded p-0.5 text-stone-500 hover:text-stone-200 group-hover:block"
                title="New folder"
              >
                <FolderPlus size={13} />
              </button>
            </div>
            {addingRoot && (
              <FolderNameInput
                onDone={async (name) => {
                  setAddingRoot(false);
                  if (name) {
                    await api.createFolder(name, null);
                    await useStore.getState().refreshFolders();
                  }
                }}
              />
            )}

            <div className="-mx-2">
              <SummaryBar />
            </div>

            {/* one-click cleanup whenever untitled notes pile up */}
            {settings?.llm_backend !== "none" &&
              tagFilter.length === 0 &&
              untitledCount > 0 && (
                <button
                  onClick={() => void titleAll()}
                  disabled={titlingAll}
                  title="Generate a title for every untitled note"
                  className="flex cursor-pointer items-center gap-1 px-2.5 pb-1 pt-0.5 text-[10px] font-medium text-clay-400 transition-colors hover:text-clay-300 disabled:opacity-60"
                >
                  {titlingAll ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <Sparkles size={11} />
                  )}
                  {titlingAll
                    ? "Titling…"
                    : `Auto-title ${untitledCount} untitled note${untitledCount === 1 ? "" : "s"}`}
                </button>
              )}

            {tagFilter.length === 0 && notes.length >= 4 && (
              <button
                onClick={() => useStore.getState().setSimilarOpen(true)}
                title="Find clusters of overlapping notes and merge them"
                className="flex cursor-pointer items-center gap-1 px-2.5 pb-1 pt-0.5 text-[10px] font-medium text-stone-500 transition-colors hover:text-clay-300"
              >
                <Combine size={11} />
                Tidy up similar notes
              </button>
            )}

            {/* pinned shortcuts — notes also stay in their tree position */}
            {pinnedNotes.length > 0 && (
              <>
                <p className="mt-2 flex items-center gap-1 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-stone-500">
                  <Pin size={10} />
                  Pinned
                </p>
                <div className="mt-0.5">
                  {pinnedNotes.map((n) => (
                    <TreeNoteRow key={`pin-${n.id}`} note={n} depth={0} />
                  ))}
                </div>
              </>
            )}

            {/* file explorer — folders with their notes nested inside */}
            <div className="mt-1">
              {roots.map((f) => (
                <FolderNode key={f.id} folder={f} depth={0} ctx={ctx} />
              ))}
              {unfiled.map((n) => (
                <TreeNoteRow key={n.id} note={n} depth={0} />
              ))}
              {roots.length === 0 && unfiled.length === 0 && !addingRoot && (
                <div className="flex flex-col items-center gap-2 px-6 py-8 text-center text-stone-600">
                  <FileText size={20} strokeWidth={1.5} />
                  <p className="text-xs">
                    {ctx.filterActive
                      ? "No notes carry all the selected tags"
                      : "No notes here yet. Create one!"}
                  </p>
                </div>
              )}
            </div>

            {/* tags — a filter over the explorer, not a destination */}
            <div className="mt-4 flex items-center justify-between px-2.5">
              <button
                onClick={() => {
                  setTagsOpen(!tagsOpen);
                  localStorage.setItem("nn.tagsOpen", tagsOpen ? "0" : "1");
                }}
                title="Filter the notes above by tag"
                className="flex cursor-pointer items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-stone-500 transition-colors hover:text-stone-300"
              >
                {tagsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                Tags
                {tagFilter.length > 0 && (
                  <span className="ml-0.5 rounded-full bg-clay-600/25 px-1.5 py-px text-[9px] font-semibold normal-case tracking-normal text-clay-300">
                    {tagFilter.length} selected
                  </span>
                )}
              </button>
              <span className="flex items-center gap-2">
                {settings?.llm_backend !== "none" && notes.length > 0 && (
                  <button
                    onClick={() => void retagAll()}
                    disabled={retagging}
                    className={`flex cursor-pointer items-center gap-1 text-[10px] transition-colors ${
                      confirmRetag
                        ? "text-clay-300"
                        : "text-stone-500 hover:text-clay-300"
                    } disabled:opacity-60`}
                    title="Regenerate AI tags for every note (manual tags are never touched)"
                  >
                    {retagging ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      <RefreshCw size={10} />
                    )}
                    {retagging
                      ? "re-tagging…"
                      : confirmRetag
                        ? `re-tag ${notes.length}?`
                        : "regenerate"}
                  </button>
                )}
                {tagFilter.length > 0 && (
                  <button
                    onClick={() => useStore.getState().setTagFilter([])}
                    className="cursor-pointer text-[10px] text-stone-500 transition-colors hover:text-clay-300"
                    title="Clear the tag filter"
                  >
                    clear
                  </button>
                )}
              </span>
            </div>
            {tagsOpen && (
              <div className="mt-0.5">
                {tags.map((t) => (
                  <TagRow
                    key={t.tag}
                    tag={t.tag}
                    count={t.count}
                    active={tagFilter.includes(t.tag)}
                    onToggle={() => toggleTag(t.tag)}
                  />
                ))}
                {tags.length === 0 && (
                  <p className="py-1 pl-[21px] text-xs text-stone-600">No tags yet</p>
                )}
              </div>
            )}

            <TrashSection />
          </div>
        )}
      </div>

      {/* status footer + queue popover */}
      <QueueFooter />

      {/* resize handle */}
      <div
        onPointerDown={startResize}
        className="absolute inset-y-0 -right-0.5 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-clay-600/40 active:bg-clay-600/60"
        title="Drag to resize"
      />
    </aside>
  );
}

function TagRow({
  tag,
  count,
  active,
  onToggle,
}: {
  tag: string;
  count: number;
  active: boolean;
  onToggle: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const remove = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 2500);
      return;
    }
    try {
      await api.deleteTag(tag);
      const st = useStore.getState();
      if (st.tagFilter.includes(tag)) {
        st.setTagFilter(st.tagFilter.filter((t) => t !== tag));
      } else {
        void st.refreshNotes();
      }
      void st.refreshTags();
      if (st.selectedNote) void st.selectNote(st.selectedNote.id);
      st.toast(`Tag “${tag}” removed from all notes`, "success");
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
  };

  return (
    <div
      className={`group flex items-center rounded-lg transition-colors ${
        active ? "bg-clay-600/15" : "hover:bg-stone-800/60"
      }`}
    >
      <button
        onClick={onToggle}
        title={active ? "Remove from filter" : "Add to filter (combines with other selected tags)"}
        className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg py-1 pl-[21px] pr-2.5 text-sm ${
          active ? "text-clay-300" : "text-stone-400"
        }`}
      >
        <Tag size={13} className="shrink-0" />
        <span className="truncate">{tag}</span>
        {active && <Check size={12} className="shrink-0" />}
        <span className="ml-auto text-[10px] text-stone-600">{count}</span>
      </button>
      <button
        onClick={() => void remove()}
        className={`mr-1.5 shrink-0 cursor-pointer rounded p-0.5 ${
          confirmDelete
            ? "text-red-400"
            : "hidden text-stone-500 hover:text-red-400 group-hover:block"
        }`}
        title={confirmDelete ? "Click again to delete this tag everywhere" : "Delete tag from all notes"}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

/** Soft-deleted notes: restore or delete forever; auto-purged after 30 days. */
function TrashSection() {
  const trash = useStore((s) => s.trash);
  const [open, setOpen] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  if (trash.length === 0) return null;

  const restore = async (id: string) => {
    try {
      await api.restoreNote(id);
      const st = useStore.getState();
      await st.refreshNotes();
      await st.refreshTrash();
      void st.refreshTags();
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
  };

  const emptyAll = async () => {
    if (!confirmEmpty) {
      setConfirmEmpty(true);
      setTimeout(() => setConfirmEmpty(false), 2500);
      return;
    }
    try {
      const n = await api.emptyTrash();
      await useStore.getState().refreshTrash();
      useStore.getState().toast(`Deleted ${n} note${n === 1 ? "" : "s"} forever`, "info");
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
  };

  return (
    <>
      <div className="mt-4 flex items-center justify-between px-2.5">
        <button
          onClick={() => setOpen(!open)}
          className="flex cursor-pointer items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-stone-500 transition-colors hover:text-stone-300"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          Trash · {trash.length}
        </button>
        {open && (
          <button
            onClick={() => void emptyAll()}
            className={`cursor-pointer text-[10px] transition-colors ${
              confirmEmpty ? "text-red-400" : "text-stone-500 hover:text-red-400"
            }`}
            title="Permanently delete everything in the trash"
          >
            {confirmEmpty ? "click to confirm" : "empty"}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-0.5">
          {trash.map((n) => (
            <TrashRow key={n.id} note={n} onRestore={() => void restore(n.id)} />
          ))}
          <p className="px-[21px] py-1 text-[9px] text-stone-600">
            Items are deleted forever after 30 days.
          </p>
        </div>
      )}
    </>
  );
}

function TrashRow({ note, onRestore }: { note: Note; onRestore: () => void }) {
  const [confirmPurge, setConfirmPurge] = useState(false);
  return (
    <div className="group flex items-center gap-1.5 rounded-lg py-1 pl-[21px] pr-2 text-[12.5px] text-stone-500 transition-colors hover:bg-stone-800/40">
      <FileText size={12} className="shrink-0 text-stone-700" />
      <span className="truncate" title={note.title || "Untitled"}>
        {note.title || "Untitled"}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <span className="text-[9px] text-stone-600 group-hover:hidden">
          {note.deleted_at ? relativeTime(note.deleted_at) : ""}
        </span>
        <span className="hidden items-center gap-1 group-hover:flex">
          <button
            onClick={onRestore}
            className="cursor-pointer rounded p-0.5 text-stone-500 hover:text-sage-300"
            title="Restore note"
          >
            <Undo2 size={12} />
          </button>
          <button
            onClick={async () => {
              if (!confirmPurge) {
                setConfirmPurge(true);
                setTimeout(() => setConfirmPurge(false), 2500);
                return;
              }
              try {
                await api.purgeNote(note.id);
                await useStore.getState().refreshTrash();
              } catch (e) {
                useStore.getState().toast(String(e), "error");
              }
            }}
            className={`cursor-pointer rounded p-0.5 ${
              confirmPurge ? "text-red-400" : "text-stone-500 hover:text-red-400"
            }`}
            title={confirmPurge ? "Click again to delete forever" : "Delete forever"}
          >
            <Trash2 size={12} />
          </button>
        </span>
      </span>
    </div>
  );
}

function ActionsBell() {
  const actionsOpen = useStore((s) => s.actionsOpen);
  const setActionsOpen = useStore((s) => s.setActionsOpen);
  const items = useStore((s) => s.actionItems);
  // Attention = proposals awaiting review + overdue scheduled reminders.
  const now = Date.now();
  const badge = items.filter(
    (i) =>
      i.status === "proposed" ||
      (i.status === "scheduled" && i.due_at !== null && i.due_at <= now),
  ).length;

  return (
    <button
      onClick={() => setActionsOpen(!actionsOpen)}
      className={`relative cursor-pointer rounded-lg p-1.5 transition-colors ${
        actionsOpen
          ? "bg-clay-600/20 text-clay-300"
          : "text-stone-500 hover:bg-stone-800 hover:text-stone-200"
      }`}
      title="Action items & reminders"
    >
      <Bell size={15} />
      {badge > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-clay-600 px-0.5 text-[8px] font-semibold text-white">
          {badge > 9 ? "9+" : badge}
        </span>
      )}
    </button>
  );
}

function QueueFooter() {
  const queue = useStore((s) => s.queue);
  const [open, setOpen] = useState(false);
  const [queued, setQueued] = useState<Note[]>([]);

  const total = queue
    ? queue.embed_stale + queue.embed_pending + queue.llm_stale + queue.llm_pending
    : 0;
  // Counts can hit zero while the worker is still busy (e.g. action
  // extraction runs after the note is already CLEAN) — the live activity
  // keeps the footer clickable through that window.
  const busy = total > 0 || Boolean(queue?.current_activity);

  // Refresh the list while open so rows disappear as the worker drains them.
  useEffect(() => {
    if (!open) return;
    void api
      .listQueuedNotes()
      .then(setQueued)
      .catch(() => setQueued([]));
  }, [open, queue]);

  useEffect(() => {
    if (!busy) setOpen(false);
  }, [busy]);

  if (!queue) return null;

  const pending = queue.embed_pending + queue.llm_pending;
  const statusText =
    queue.embedder_state === "downloading"
      ? "Downloading semantic model… (first run)"
      : queue.embedder_state === "loading"
        ? "Loading semantic model…"
        : queue.embedder_state === "error"
          ? "Semantic engine error — keyword search still works"
          : queue.current_activity
            ? queue.current_activity
            : queue.sweep_active
              ? "Re-indexing…"
              : pending > 0
                ? "AI engine working…"
                : total > 0
                  ? `${total} note${total === 1 ? "" : "s"} queued`
                  : "All notes up to date";

  return (
    <div className="relative px-3 pb-2 pt-1">
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-3 right-3 z-30 mb-1 overflow-hidden rounded-xl border border-stone-800 bg-stone-900 shadow-2xl shadow-black/60">
            <div className="px-3 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-stone-500">
              Processing queue{total > 0 ? ` · ${total}` : ""}
            </div>
            {queue.current_activity && (
              <button
                onClick={() => {
                  const nid = queue.current_note_id;
                  if (!nid) return;
                  setOpen(false);
                  void useStore.getState().selectNote(nid);
                }}
                title={queue.current_note_id ? "Open the note being processed" : undefined}
                className={`flex w-full items-center gap-1.5 px-3 pb-1 text-left ${
                  queue.current_note_id ? "cursor-pointer hover:text-sage-200" : "cursor-default"
                }`}
              >
                <span className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-sage-400" />
                <span className="truncate text-[10px] text-sage-300">
                  {queue.current_activity}
                </span>
              </button>
            )}
            <div className="max-h-64 overflow-y-auto p-1">
              {queued.map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    setOpen(false);
                    void useStore.getState().selectNote(n.id);
                  }}
                  title="Open this note"
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-stone-800/70"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-stone-200">
                    {n.title || "Untitled"}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {n.embedding_status !== "CLEAN" && (
                      <span
                        className={`rounded-full px-1.5 py-px text-[9px] ${
                          n.embedding_status === "PENDING"
                            ? "bg-clay-600/25 text-clay-300"
                            : "bg-stone-800 text-stone-500"
                        }`}
                      >
                        {n.embedding_status === "PENDING" ? "indexing…" : "index queued"}
                      </span>
                    )}
                    {n.llm_status !== "CLEAN" && (
                      <span
                        className={`rounded-full px-1.5 py-px text-[9px] ${
                          n.llm_status === "PENDING"
                            ? "bg-sage-900/80 text-sage-300"
                            : "bg-stone-800 text-stone-500"
                        }`}
                      >
                        {n.llm_status === "PENDING" ? "AI working…" : "AI queued"}
                      </span>
                    )}
                  </span>
                </button>
              ))}
              {queued.length === 0 && (
                <p className="px-3 py-3 text-center text-[11px] text-stone-600">
                  Queue is empty
                </p>
              )}
            </div>
          </div>
        </>
      )}
      <button
        onClick={() => {
          if (busy) setOpen(!open);
        }}
        className={`flex w-full items-center gap-1 rounded-lg px-1.5 py-1 text-left text-[10px] text-stone-600 ${
          busy
            ? "cursor-pointer transition-colors hover:bg-stone-800/60 hover:text-stone-400"
            : "cursor-default"
        }`}
        title={busy ? "Show queued notes" : undefined}
      >
        <span className="truncate">{statusText}</span>
        {busy && (
          <ChevronUp
            size={11}
            className={`ml-auto shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        )}
      </button>
    </div>
  );
}

function FolderNameInput({
  initial = "",
  onDone,
}: {
  initial?: string;
  onDone: (name: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(value.trim() || null);
        if (e.key === "Escape") onDone(null);
      }}
      placeholder="Folder name"
      className="mx-2 mt-1 w-[calc(100%-1rem)] rounded-lg bg-stone-900 px-2.5 py-1 text-xs text-stone-200 outline-none ring-1 ring-clay-700"
    />
  );
}

const PREVIEW_DELAY_MS = 450;
const PREVIEW_W = 264;

/** Copy a note (same folder, same content) and open the copy. */
async function duplicateNote(note: Note) {
  const st = useStore.getState();
  try {
    // Tree rows only carry a content excerpt — fetch the full note to copy.
    const full = await api.getNote(note.id);
    const copy = await api.createNote(full.folder_id);
    await api.updateNote(
      copy.id,
      full.title ? `${full.title} (copy)` : "",
      full.content,
    );
    await st.refreshNotes();
    await st.selectNote(copy.id);
  } catch (e) {
    st.toast(String(e), "error");
  }
}

/** A note leaf inside the explorer tree: status icons + hover preview card. */
function TreeNoteRow({ note, depth }: { note: Note; depth: number }) {
  const active = useStore((s) => s.selectedNote?.id === note.id);
  // Live worker target — covers bulk titling/re-tagging/merging, which run
  // outside the status-flag pipeline.
  const aiActive = useStore((s) => s.queue?.current_note_id === note.id);
  const [preview, setPreview] = useState<{ left: number; top: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const working =
    aiActive || note.llm_status === "PENDING" || note.embedding_status === "PENDING";
  const queued =
    !working && (note.llm_status === "STALE" || note.embedding_status === "STALE");

  const startPreview = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      setPreview({
        left: Math.min(rect.right + 10, window.innerWidth - PREVIEW_W - 8),
        top: Math.max(8, Math.min(rect.top, window.innerHeight - 240)),
      });
    }, PREVIEW_DELAY_MS);
  };
  const stopPreview = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setPreview(null);
  };
  useEffect(() => stopPreview, []);

  const snippet = stripMarkdown(note.content).slice(0, 220);

  return (
    <>
      <button
        onClick={() => {
          stopPreview();
          void useStore.getState().selectNote(note.id);
        }}
        onMouseEnter={startPreview}
        onMouseLeave={stopPreview}
        onContextMenu={(e) => {
          e.preventDefault();
          stopPreview();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        draggable
        onDragStart={(e) => {
          stopPreview();
          e.dataTransfer.setData(NOTE_MIME, note.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        className={`flex w-full cursor-pointer items-center gap-1.5 rounded-lg py-1 pr-2 text-left text-[12.5px] transition-colors ${
          active
            ? "bg-stone-800/80 text-stone-100"
            : "text-stone-400 hover:bg-stone-800/40 hover:text-stone-200"
        }`}
        style={{ paddingLeft: 21 + depth * 14 }}
      >
        <FileText size={12} className="shrink-0 text-stone-600" />
        <span className="truncate">{note.title || "Untitled"}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {note.pinned && <Pin size={9} className="text-stone-600" />}
          {aiActive || note.llm_status === "PENDING" ? (
            <span title="AI working on this note…" className="flex">
              <Loader2 size={11} className="animate-spin text-sage-400" />
            </span>
          ) : note.embedding_status === "PENDING" ? (
            <span title="Indexing…" className="flex">
              <Loader2 size={11} className="animate-spin text-clay-400" />
            </span>
          ) : queued ? (
            <span title="Queued for AI processing" className="flex">
              <Clock size={10} className="text-stone-600" />
            </span>
          ) : null}
        </span>
      </button>
      {preview && (
        <div
          className="fade-in pointer-events-none fixed z-50 rounded-xl border border-stone-800 bg-stone-900 p-3 shadow-2xl shadow-black/60"
          style={{ ...preview, width: PREVIEW_W }}
        >
          <p className="truncate text-xs font-semibold text-stone-100">
            {note.title || "Untitled"}
          </p>
          <p className="mt-0.5 text-[9px] text-stone-600">
            edited {relativeTime(note.updated_at)}
            {working && " · AI working…"}
            {queued && " · queued for AI"}
          </p>
          {snippet ? (
            <p className="mt-1.5 line-clamp-5 text-[11px] leading-relaxed text-stone-400">
              {snippet}
            </p>
          ) : (
            <p className="mt-1.5 text-[11px] italic text-stone-600">Empty note</p>
          )}
          {note.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {note.tags.map((t) => (
                <span
                  key={t.tag}
                  className={`rounded-full px-1.5 py-px text-[9px] ${
                    t.source === "ai"
                      ? "border border-sage-700/60 text-sage-400"
                      : "bg-stone-800 text-stone-400"
                  }`}
                >
                  {t.tag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
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
            {
              label: "Duplicate",
              icon: <Copy size={13} />,
              onClick: () => void duplicateNote(note),
            },
            {
              label: "Delete",
              icon: <Trash2 size={13} />,
              danger: true,
              confirm: true,
              onClick: () => void useStore.getState().deleteNote(note.id),
            },
          ]}
        />
      )}
    </>
  );
}

function FolderNode({
  folder,
  depth,
  ctx,
}: {
  folder: Folder;
  depth: number;
  ctx: TreeCtx;
}) {
  const view = useStore((s) => s.view);
  const selectView = useStore((s) => s.selectView);
  const [renaming, setRenaming] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const deleteFolder = async () => {
    await api.deleteFolder(folder.id);
    await useStore.getState().refreshFolders();
    await useStore.getState().refreshNotes();
    if (active) selectView({ kind: "all", key: null });
  };

  const children = ctx.childrenOf.get(folder.id) ?? [];
  const folderNotes = ctx.notesByFolder.get(folder.id) ?? [];
  const count = ctx.subtreeCounts.get(folder.id) ?? 0;
  const hasContents = children.length > 0 || folderNotes.length > 0;
  const expanded = ctx.isExpanded(folder.id);
  const active = view.kind === "folder" && view.key === folder.id;
  // With a tag filter on, folders with no matches anywhere below recede.
  const dimmed = ctx.filterActive && count === 0;

  if (renaming) {
    return (
      <FolderNameInput
        initial={folder.name}
        onDone={async (name) => {
          setRenaming(false);
          if (name && name !== folder.name) {
            await api.renameFolder(folder.id, name);
            await useStore.getState().refreshFolders();
          }
        }}
      />
    );
  }

  return (
    <div>
      <div
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.setData(FOLDER_MIME, folder.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (hasTreePayload(e)) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            setDropHover(true);
          }
        }}
        onDragLeave={() => setDropHover(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDropHover(false);
          ctx.setExpanded(folder.id, true);
          void handleTreeDrop(e, folder.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        className={`group flex items-center gap-1 rounded-lg px-1 py-1 text-sm transition-colors ${
          dropHover
            ? "bg-clay-600/15 text-clay-300 ring-1 ring-inset ring-clay-500"
            : active
              ? "bg-clay-600/15 text-clay-300"
              : "text-stone-300 hover:bg-stone-800/60"
        } ${dimmed ? "opacity-50" : ""}`}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        <button
          onClick={() => ctx.setExpanded(folder.id, !expanded)}
          className="cursor-pointer text-stone-600 hover:text-stone-300"
          tabIndex={-1}
        >
          {hasContents ? (
            expanded ? (
              <ChevronDown size={13} />
            ) : (
              <ChevronRight size={13} />
            )
          ) : (
            <span className="inline-block w-[13px]" />
          )}
        </button>
        <button
          onClick={() => {
            selectView({ kind: "folder", key: folder.id });
            if (!expanded) ctx.setExpanded(folder.id, true);
          }}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
        >
          {expanded && hasContents ? (
            <FolderOpen size={13} className="shrink-0 text-stone-500" />
          ) : (
            <FolderIcon size={13} className="shrink-0 text-stone-500" />
          )}
          <span className="truncate">{folder.name}</span>
        </button>
        <span className="shrink-0 text-[10px] text-stone-600 group-hover:hidden">
          {count > 0 ? count : ""}
        </span>
        <span className="hidden shrink-0 items-center gap-1 group-hover:flex">
          <button
            onClick={() => {
              ctx.setExpanded(folder.id, true);
              void useStore.getState().createNote(folder.id);
            }}
            className="cursor-pointer text-stone-500 hover:text-stone-200"
            title="New note in this folder"
          >
            <FilePlus size={12} />
          </button>
          <button
            onClick={() => setAddingChild(true)}
            className="cursor-pointer text-stone-500 hover:text-stone-200"
            title="New subfolder"
          >
            <FolderPlus size={12} />
          </button>
          <button
            onClick={() => setRenaming(true)}
            className="cursor-pointer text-stone-500 hover:text-stone-200"
            title="Rename"
          >
            <Pencil size={12} />
          </button>
          <button
            onClick={async () => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                setTimeout(() => setConfirmDelete(false), 2500);
                return;
              }
              await deleteFolder();
            }}
            className={
              confirmDelete
                ? "cursor-pointer text-red-400"
                : "cursor-pointer text-stone-500 hover:text-red-400"
            }
            title={confirmDelete ? "Click again to delete" : "Delete folder (notes move to root)"}
          >
            <Trash2 size={12} />
          </button>
        </span>
      </div>
      {addingChild && (
        <div style={{ paddingLeft: depth * 14 }}>
          <FolderNameInput
            onDone={async (name) => {
              setAddingChild(false);
              if (name) {
                await api.createFolder(name, folder.id);
                await useStore.getState().refreshFolders();
                ctx.setExpanded(folder.id, true);
              }
            }}
          />
        </div>
      )}
      {expanded && (
        <>
          {children.map((c) => (
            <FolderNode key={c.id} folder={c} depth={depth + 1} ctx={ctx} />
          ))}
          {folderNotes.map((n) => (
            <TreeNoteRow key={n.id} note={n} depth={depth + 1} />
          ))}
        </>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "New note here",
              icon: <FilePlus size={13} />,
              onClick: () => {
                ctx.setExpanded(folder.id, true);
                void useStore.getState().createNote(folder.id);
              },
            },
            {
              label: "New subfolder",
              icon: <FolderPlus size={13} />,
              onClick: () => setAddingChild(true),
            },
            {
              label: "Rename",
              icon: <Pencil size={13} />,
              onClick: () => setRenaming(true),
            },
            {
              label: "Delete folder",
              icon: <Trash2 size={13} />,
              danger: true,
              confirm: true,
              onClick: () => void deleteFolder(),
            },
          ]}
        />
      )}
    </div>
  );
}
