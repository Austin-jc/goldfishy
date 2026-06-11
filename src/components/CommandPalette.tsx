import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ChevronRight,
  Download,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Wand2,
} from "lucide-react";
import { api } from "../api";
import { recentNoteIds, useStore } from "../store";
import { relativeTime, snippetHtml, stripMarkdown } from "../utils";
import type { Note, SearchMode } from "../types";

interface Command {
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void | Promise<void>;
}

function buildCommands(close: () => void): Command[] {
  const llmReady = useStore.getState().settings?.llm_backend !== "none";
  return [
    {
      label: "New note",
      hint: "⌘N",
      icon: <Plus size={14} />,
      run: () => {
        close();
        void useStore.getState().createNote();
      },
    },
    {
      label: "Tidy up: find & merge similar notes",
      icon: <Sparkles size={14} />,
      run: () => {
        close();
        useStore.getState().setSimilarOpen(true);
      },
    },
    ...(llmReady
      ? [
          {
            label: "Auto-title untitled notes",
            icon: <Sparkles size={14} />,
            run: async () => {
              close();
              try {
                const n = await api.aiTitleUntitled();
                useStore.getState().toast(
                  n > 0
                    ? `Auto-titled ${n} note${n === 1 ? "" : "s"}`
                    : "No notes needed a title",
                  "success",
                );
              } catch (e) {
                useStore.getState().toast(String(e), "error");
              }
            },
          } satisfies Command,
          {
            label: "Regenerate AI tags for all notes",
            icon: <RefreshCw size={14} />,
            run: async () => {
              close();
              try {
                const n = await api.aiRetagAll();
                const st = useStore.getState();
                void st.refreshTags();
                void st.refreshNotes();
                st.toast(`Re-tagged ${n} note${n === 1 ? "" : "s"}`, "success");
              } catch (e) {
                useStore.getState().toast(String(e), "error");
              }
            },
          } satisfies Command,
        ]
      : []),
    {
      label: "Open settings",
      hint: "⌘,",
      icon: <Settings size={14} />,
      run: () => {
        close();
        useStore.getState().setSettingsOpen(true);
      },
    },
    {
      label: "Sync / re-index database",
      icon: <RefreshCw size={14} />,
      run: async () => {
        close();
        try {
          const status = await api.reindexAll();
          useStore.getState().setQueue(status);
          useStore.getState().toast("Re-index started");
        } catch (e) {
          useStore.getState().toast(String(e), "error");
        }
      },
    },
    {
      label: "Export all notes as Markdown",
      icon: <Download size={14} />,
      run: async () => {
        close();
        const dir = await openDialog({ directory: true, multiple: false });
        if (typeof dir !== "string") return;
        try {
          const n = await api.exportNotes(dir, "markdown");
          useStore.getState().toast(`Exported ${n} notes as Markdown`, "success");
        } catch (e) {
          useStore.getState().toast(String(e), "error");
        }
      },
    },
    {
      label: "Export all notes as JSON",
      icon: <Download size={14} />,
      run: async () => {
        close();
        const dir = await openDialog({ directory: true, multiple: false });
        if (typeof dir !== "string") return;
        try {
          const n = await api.exportNotes(dir, "json");
          useStore.getState().toast(`Exported ${n} notes as JSON`, "success");
        } catch (e) {
          useStore.getState().toast(String(e), "error");
        }
      },
    },
  ];
}

const MODE_CYCLE: SearchMode[] = ["smart", "keyword", "semantic"];

export default function CommandPalette() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("smart");
  const [results, setResults] = useState<Note[]>([]);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = () => useStore.getState().setPaletteOpen(false);
  const isCommandMode = query.startsWith(">");
  const commands = buildCommands(close);
  const filteredCommands = isCommandMode
    ? commands.filter((c) =>
        c.label.toLowerCase().includes(query.slice(1).trim().toLowerCase()),
      )
    : [];

  // Live note search; semantic gets a slightly longer debounce.
  useEffect(() => {
    if (isCommandMode) return;
    let cancelled = false;
    if (!query.trim()) {
      // Empty query = recents: most retrieval is "the thing I touched
      // recently". MRU-opened notes first, then by updated_at (list order).
      void api.listNotes(null, null).then((notes) => {
        if (cancelled) return;
        const rank = new Map(recentNoteIds().map((id, i) => [id, i]));
        const sorted = [...notes].sort(
          (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
        );
        setResults(sorted.slice(0, 12));
      });
      return () => {
        cancelled = true;
      };
    }
    const t = setTimeout(
      async () => {
        setBusy(true);
        try {
          const r = await api.searchNotes(query, mode);
          if (!cancelled) setResults(r);
        } catch (e) {
          if (!cancelled) useStore.getState().toast(String(e), "error");
        } finally {
          if (!cancelled) setBusy(false);
        }
      },
      // Keyword is sub-50ms FTS; smart additionally embeds the query;
      // pure semantic gets the longest leash.
      mode === "keyword" ? 120 : mode === "smart" ? 200 : 450,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, mode, isCommandMode]);

  // Search-or-create: any non-empty query grows a trailing "Create" row, so a
  // failed search is one keypress away from becoming the note.
  const showCreate = !isCommandMode && query.trim().length > 0;
  const itemCount = isCommandMode
    ? filteredCommands.length
    : results.length + (showCreate ? 1 : 0);
  useEffect(() => setSel(0), [query, mode]);

  const openNote = (id: string) => {
    close();
    void useStore.getState().selectNote(id);
  };

  const createFromQuery = () => {
    const title = query.trim();
    if (!title) return;
    close();
    void useStore.getState().createNoteWithTitle(title);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, Math.max(itemCount - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Tab" && !isCommandMode) {
      e.preventDefault();
      setMode((m) => MODE_CYCLE[(MODE_CYCLE.indexOf(m) + 1) % MODE_CYCLE.length]);
    } else if (e.key === "Enter" && e.shiftKey && showCreate) {
      e.preventDefault();
      createFromQuery();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (isCommandMode) {
        void filteredCommands[sel]?.run();
      } else if (results[sel]) {
        openNote(results[sel].id);
      } else if (showCreate) {
        // Zero results (or the Create row is selected) — capture the query.
        createFromQuery();
      }
    }
  };

  // Keep the selected row visible while arrowing.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${sel}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/50 pt-24"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="flex h-fit max-h-[60vh] w-[560px] flex-col overflow-hidden rounded-xl border border-stone-800 bg-stone-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-stone-800 px-3 py-2.5">
          {busy ? (
            <Loader2 size={15} className="animate-spin text-clay-400" />
          ) : isCommandMode ? (
            <ChevronRight size={15} className="text-clay-400" />
          ) : mode === "semantic" ? (
            <Sparkles size={15} className="text-clay-400" />
          ) : mode === "smart" ? (
            <Wand2 size={15} className="text-stone-500" />
          ) : (
            <Search size={15} className="text-stone-500" />
          )}
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              isCommandMode
                ? "Type a command…"
                : mode === "semantic"
                  ? "Search by meaning…"
                  : "Search notes, or type > for commands…"
            }
            className="min-w-0 flex-1 bg-transparent text-sm text-stone-100 outline-none placeholder:text-stone-600"
          />
          {!isCommandMode && (
            <span
              className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${
                mode !== "smart"
                  ? "bg-clay-600/30 text-clay-300"
                  : "bg-stone-800 text-stone-500"
              }`}
            >
              {mode}
            </span>
          )}
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto">
          {isCommandMode ? (
            <>
              {filteredCommands.map((c, i) => (
                <button
                  key={c.label}
                  data-idx={i}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => void c.run()}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm ${
                    sel === i ? "bg-clay-600/20 text-clay-200" : "text-stone-300"
                  }`}
                >
                  <span className="text-stone-500">{c.icon}</span>
                  {c.label}
                  {c.hint && (
                    <kbd className="ml-auto rounded border border-stone-700 px-1 text-[9px] text-stone-500">
                      {c.hint}
                    </kbd>
                  )}
                </button>
              ))}
              {filteredCommands.length === 0 && (
                <p className="px-4 py-6 text-center text-xs text-stone-600">No matching command</p>
              )}
            </>
          ) : (
            <>
              {!query.trim() && results.length > 0 && (
                <p className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-stone-500">
                  Recent
                </p>
              )}
              {results.map((n, i) => (
                <button
                  key={n.id}
                  data-idx={i}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => openNote(n.id)}
                  className={`flex w-full items-start gap-2.5 px-3 py-2 text-left ${
                    sel === i ? "bg-clay-600/20" : ""
                  }`}
                >
                  <FileText size={14} className="mt-0.5 shrink-0 text-stone-500" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-sm text-stone-100">
                        {n.title || "Untitled"}
                      </span>
                      {n.matched_by === "semantic" && (
                        <span
                          className="flex shrink-0 items-center gap-0.5 self-center rounded-full border border-sage-700/60 px-1.5 text-[8px] text-sage-400"
                          title="No term match — found by meaning (semantic search)"
                        >
                          <Sparkles size={8} />
                          meaning
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-[9px] text-stone-600">
                        {typeof n.score === "number" && n.score <= 1 && n.score > 0
                          ? `${(n.score * 100).toFixed(0)}%`
                          : relativeTime(n.updated_at)}
                      </span>
                    </span>
                    {n.snippet ? (
                      <span
                        className="line-clamp-1 text-[11px] text-stone-500"
                        dangerouslySetInnerHTML={{ __html: snippetHtml(n.snippet) }}
                      />
                    ) : (
                      <span className="line-clamp-1 text-[11px] text-stone-500">
                        {stripMarkdown(n.content).slice(0, 100)}
                      </span>
                    )}
                  </span>
                </button>
              ))}
              {showCreate && (
                <button
                  data-idx={results.length}
                  onMouseEnter={() => setSel(results.length)}
                  onClick={createFromQuery}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm ${
                    sel === results.length ? "bg-clay-600/20 text-clay-200" : "text-stone-300"
                  }`}
                >
                  <Plus size={14} className="shrink-0 text-clay-400" />
                  <span className="min-w-0 truncate">
                    Create note “{query.trim()}”
                  </span>
                  <kbd className="ml-auto rounded border border-stone-700 px-1 text-[9px] text-stone-500">
                    ⇧↵
                  </kbd>
                </button>
              )}
              {results.length === 0 && !busy && !showCreate && (
                <p className="px-4 py-6 text-center text-xs text-stone-600">No notes yet</p>
              )}
            </>
          )}
        </div>

        <div className="flex gap-3 border-t border-stone-800 px-3 py-1.5 text-[9px] text-stone-600">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          {showCreate && <span>⇧↵ create note</span>}
          {!isCommandMode && (
            <span>
              tab {MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length]} search
            </span>
          )}
          <span>&gt; commands</span>
          <span className="ml-auto">esc close</span>
        </div>
      </div>
    </div>
  );
}
