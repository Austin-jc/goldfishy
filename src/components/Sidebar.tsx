import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileText,
  Folder as FolderIcon,
  FolderPlus,
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Settings,
  Tag,
  Trash2,
} from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import GoldfishLogo from "./GoldfishLogo";
import { NoteItem, SearchBar, SummaryBar } from "./NoteList";
import type { Folder, Note } from "../types";

const MIN_WIDTH = 240;
const MAX_WIDTH = 480;

export default function Sidebar() {
  const folders = useStore((s) => s.folders);
  const tags = useStore((s) => s.tags);
  const view = useStore((s) => s.view);
  const queue = useStore((s) => s.queue);
  const notes = useStore((s) => s.notes);
  const searchResults = useStore((s) => s.searchResults);
  const selectView = useStore((s) => s.selectView);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const [addingRoot, setAddingRoot] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(true);
  const [tagsOpen, setTagsOpen] = useState(true);

  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem("nn.sidebarWidth"));
    return Number.isFinite(v) && v > 0 ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, v)) : 320;
  });
  const widthRef = useRef(width);
  widthRef.current = width;

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

  const roots = useMemo(() => folders.filter((f) => !f.parent_id), [folders]);

  const busy =
    (queue?.embed_pending ?? 0) + (queue?.llm_pending ?? 0) > 0 || queue?.sweep_active;

  const shown = searchResults ?? notes;
  const selectedTags = view.kind === "tag" ? (view.tags ?? []) : [];
  const viewName =
    view.kind === "all"
      ? "All Notes"
      : view.kind === "tag"
        ? selectedTags.map((t) => `#${t}`).join(" ")
        : (folders.find((f) => f.id === view.key)?.name ?? "Folder");

  // Click to toggle: add to the selection, click again to remove.
  const toggleTag = (tag: string) => {
    const next = selectedTags.includes(tag)
      ? selectedTags.filter((t) => t !== tag)
      : [...selectedTags, tag];
    selectView(
      next.length > 0 ? { kind: "tag", key: null, tags: next } : { kind: "all", key: null },
    );
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
        {/* navigation */}
        <div className="px-2">
          <button
            onClick={() => selectView({ kind: "all", key: null })}
            className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
              view.kind === "all"
                ? "bg-clay-600/15 text-clay-300"
                : "text-stone-300 hover:bg-stone-800/60"
            }`}
          >
            <Inbox size={15} />
            All Notes
          </button>

          <div className="mt-3 flex items-center justify-between px-2.5">
            <button
              onClick={() => setFoldersOpen(!foldersOpen)}
              className="flex cursor-pointer items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-stone-500 transition-colors hover:text-stone-300"
            >
              {foldersOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Folders
            </button>
            <button
              onClick={() => {
                setFoldersOpen(true);
                setAddingRoot(true);
              }}
              className="cursor-pointer text-stone-500 transition-colors hover:text-stone-200"
              title="New folder"
            >
              <Plus size={14} />
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
          {foldersOpen && (
            <div className="mt-0.5">
              {roots.map((f) => (
                <FolderRow key={f.id} folder={f} depth={0} />
              ))}
              {roots.length === 0 && !addingRoot && (
                <p className="px-2.5 py-1 text-xs text-stone-600">No folders yet</p>
              )}
            </div>
          )}

          <div className="mt-3 px-2.5">
            <button
              onClick={() => setTagsOpen(!tagsOpen)}
              className="flex cursor-pointer items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-stone-500 transition-colors hover:text-stone-300"
            >
              {tagsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Tags
            </button>
          </div>
          {tagsOpen && (
            <div className="mt-0.5">
              {tags.map((t) => {
                const active = selectedTags.includes(t.tag);
                return (
                  <button
                    key={t.tag}
                    onClick={() => toggleTag(t.tag)}
                    title={active ? "Remove from filter" : "Add to filter (combines with other selected tags)"}
                    className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 text-sm transition-colors ${
                      active
                        ? "bg-clay-600/15 text-clay-300"
                        : "text-stone-400 hover:bg-stone-800/60"
                    }`}
                  >
                    <Tag size={13} className="shrink-0" />
                    <span className="truncate">{t.tag}</span>
                    {active && <Check size={12} className="shrink-0" />}
                    <span className="ml-auto text-[10px] text-stone-600">{t.count}</span>
                  </button>
                );
              })}
              {tags.length === 0 && (
                <p className="px-2.5 py-1 text-xs text-stone-600">No tags yet</p>
              )}
            </div>
          )}
        </div>

        {/* notes in the current view / search results */}
        <div className="mt-5">
          <div className="flex items-center justify-between px-4 pb-1">
            <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-stone-500">
              {searchResults ? `Results · ${shown.length}` : `${viewName} · ${shown.length}`}
            </span>
          </div>
          {!searchResults && <SummaryBar />}
          <div className="space-y-0.5 px-2 pb-2">
            {shown.map((n) => (
              <NoteItem key={n.id} note={n} />
            ))}
          </div>
          {shown.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-stone-600">
              <FileText size={20} strokeWidth={1.5} />
              <p className="text-xs">
                {searchResults ? "No results" : "No notes here yet. Create one!"}
              </p>
            </div>
          )}
        </div>
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

  // Refresh the list while open so rows disappear as the worker drains them.
  useEffect(() => {
    if (!open) return;
    void api
      .listQueuedNotes()
      .then(setQueued)
      .catch(() => setQueued([]));
  }, [open, queue]);

  useEffect(() => {
    if (total === 0) setOpen(false);
  }, [total]);

  if (!queue) return null;

  const pending = queue.embed_pending + queue.llm_pending;
  const statusText =
    queue.embedder_state === "downloading"
      ? "Downloading semantic model… (first run)"
      : queue.embedder_state === "loading"
        ? "Loading semantic model…"
        : queue.embedder_state === "error"
          ? "Semantic engine error — keyword search still works"
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
              Processing queue · {total}
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {queued.map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    setOpen(false);
                    void useStore.getState().selectNote(n.id);
                  }}
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
          if (total > 0) setOpen(!open);
        }}
        className={`flex w-full items-center gap-1 rounded-lg px-1.5 py-1 text-left text-[10px] text-stone-600 ${
          total > 0
            ? "cursor-pointer transition-colors hover:bg-stone-800/60 hover:text-stone-400"
            : "cursor-default"
        }`}
        title={total > 0 ? "Show queued notes" : undefined}
      >
        <span className="truncate">{statusText}</span>
        {total > 0 && (
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

function FolderRow({ folder, depth }: { folder: Folder; depth: number }) {
  const folders = useStore((s) => s.folders);
  const view = useStore((s) => s.view);
  const selectView = useStore((s) => s.selectView);
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const children = folders.filter((f) => f.parent_id === folder.id);
  const active = view.kind === "folder" && view.key === folder.id;

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
        className={`group flex items-center gap-1 rounded-lg px-1 py-1 text-sm transition-colors ${
          active ? "bg-clay-600/15 text-clay-300" : "text-stone-300 hover:bg-stone-800/60"
        }`}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        <button
          onClick={() => setExpanded(!expanded)}
          className="cursor-pointer text-stone-600 hover:text-stone-300"
          tabIndex={-1}
        >
          {children.length > 0 ? (
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
          onClick={() => selectView({ kind: "folder", key: folder.id })}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
        >
          <FolderIcon size={13} className="shrink-0 text-stone-500" />
          <span className="truncate">{folder.name}</span>
        </button>
        <span className="hidden shrink-0 items-center gap-1 group-hover:flex">
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
              await api.deleteFolder(folder.id);
              await useStore.getState().refreshFolders();
              if (active) selectView({ kind: "all", key: null });
            }}
            className={
              confirmDelete
                ? "cursor-pointer text-red-400"
                : "cursor-pointer text-stone-500 hover:text-red-400"
            }
            title={confirmDelete ? "Click again to delete" : "Delete folder"}
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
                setExpanded(true);
              }
            }}
          />
        </div>
      )}
      {expanded &&
        children.map((c) => <FolderRow key={c.id} folder={c} depth={depth + 1} />)}
    </div>
  );
}
