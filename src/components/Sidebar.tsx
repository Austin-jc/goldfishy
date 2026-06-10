import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder as FolderIcon,
  FolderPlus,
  Inbox,
  Pencil,
  Plus,
  Settings,
  Tag,
  Trash2,
} from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { NoteItem, SearchBar, SummaryBar } from "./NoteList";
import type { Folder } from "../types";

export default function Sidebar() {
  const folders = useStore((s) => s.folders);
  const tags = useStore((s) => s.tags);
  const view = useStore((s) => s.view);
  const queue = useStore((s) => s.queue);
  const notes = useStore((s) => s.notes);
  const searchResults = useStore((s) => s.searchResults);
  const selectView = useStore((s) => s.selectView);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const [addingRoot, setAddingRoot] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(true);
  const [tagsOpen, setTagsOpen] = useState(true);

  const roots = useMemo(() => folders.filter((f) => !f.parent_id), [folders]);

  const busy =
    (queue?.embed_pending ?? 0) + (queue?.llm_pending ?? 0) > 0 || queue?.sweep_active;
  const backlog = (queue?.embed_stale ?? 0) + (queue?.llm_stale ?? 0);

  const shown = searchResults ?? notes;
  const viewName =
    view.kind === "all"
      ? "All Notes"
      : view.kind === "tag"
        ? `#${view.key}`
        : (folders.find((f) => f.id === view.key)?.name ?? "Folder");

  return (
    <aside className="flex w-80 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40">
      {/* header */}
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-600 text-xs font-bold text-white">
          N
        </div>
        <span className="text-sm font-semibold tracking-wide text-zinc-100">NexusNote</span>
        {busy && (
          <span
            className="pulse-dot h-2 w-2 rounded-full bg-indigo-400"
            title="AI engine working in the background"
          />
        )}
        <span className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            title="Settings (⌘,)"
          >
            <Settings size={15} />
          </button>
          <button
            onClick={() => void useStore.getState().createNote()}
            className="flex items-center gap-1 rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500"
            title="New note (⌘N)"
          >
            <Plus size={13} />
            New
          </button>
        </span>
      </div>

      {/* search */}
      <div className="px-3 pb-2">
        <SearchBar />
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* navigation */}
        <div className="px-2">
          <button
            onClick={() => selectView({ kind: "all", key: null })}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
              view.kind === "all"
                ? "bg-indigo-600/20 text-indigo-300"
                : "text-zinc-300 hover:bg-zinc-800"
            }`}
          >
            <Inbox size={15} />
            All Notes
          </button>

          <div className="mt-2 flex items-center justify-between px-2">
            <button
              onClick={() => setFoldersOpen(!foldersOpen)}
              className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
            >
              {foldersOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Folders
            </button>
            <button
              onClick={() => {
                setFoldersOpen(true);
                setAddingRoot(true);
              }}
              className="text-zinc-500 hover:text-zinc-200"
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
                <p className="px-2 py-1 text-xs text-zinc-600">No folders yet</p>
              )}
            </div>
          )}

          <div className="mt-2 px-2">
            <button
              onClick={() => setTagsOpen(!tagsOpen)}
              className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
            >
              {tagsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Tags
            </button>
          </div>
          {tagsOpen && (
            <div className="mt-0.5">
              {tags.map((t) => (
                <button
                  key={t.tag}
                  onClick={() => selectView({ kind: "tag", key: t.tag })}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm ${
                    view.kind === "tag" && view.key === t.tag
                      ? "bg-indigo-600/20 text-indigo-300"
                      : "text-zinc-400 hover:bg-zinc-800"
                  }`}
                >
                  <Tag size={13} className="shrink-0" />
                  <span className="truncate">{t.tag}</span>
                  <span className="ml-auto text-[10px] text-zinc-600">{t.count}</span>
                </button>
              ))}
              {tags.length === 0 && (
                <p className="px-2 py-1 text-xs text-zinc-600">No tags yet</p>
              )}
            </div>
          )}
        </div>

        {/* notes in the current view / search results */}
        <div className="mt-3 border-t border-zinc-800 pt-2">
          <div className="flex items-center justify-between px-4 pb-1">
            <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              {searchResults ? `Results · ${shown.length}` : `${viewName} · ${shown.length}`}
            </span>
          </div>
          {!searchResults && <SummaryBar />}
          {shown.map((n) => (
            <NoteItem key={n.id} note={n} />
          ))}
          {shown.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-zinc-600">
              <FileText size={20} />
              <p className="text-xs">
                {searchResults ? "No results" : "No notes here yet. Create one!"}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* status footer */}
      {queue && (
        <div className="border-t border-zinc-800 px-4 py-1.5 text-[10px] text-zinc-600">
          {queue.sweep_active
            ? "Re-indexing…"
            : busy
              ? "AI engine working…"
              : backlog > 0
                ? `${backlog} note${backlog === 1 ? "" : "s"} queued`
                : "All notes up to date"}
          {!queue.embedder_ready && " · embedder cold"}
        </div>
      )}
    </aside>
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
      className="mx-2 mt-1 w-[calc(100%-1rem)] rounded border border-indigo-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none"
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
        className={`group flex items-center gap-1 rounded-md px-1 py-1 text-sm ${
          active ? "bg-indigo-600/20 text-indigo-300" : "text-zinc-300 hover:bg-zinc-800"
        }`}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-zinc-600 hover:text-zinc-300"
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
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <FolderIcon size={13} className="shrink-0 text-zinc-500" />
          <span className="truncate">{folder.name}</span>
        </button>
        <span className="hidden shrink-0 items-center gap-1 group-hover:flex">
          <button
            onClick={() => setAddingChild(true)}
            className="text-zinc-500 hover:text-zinc-200"
            title="New subfolder"
          >
            <FolderPlus size={12} />
          </button>
          <button
            onClick={() => setRenaming(true)}
            className="text-zinc-500 hover:text-zinc-200"
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
            className={confirmDelete ? "text-red-400" : "text-zinc-500 hover:text-red-400"}
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
