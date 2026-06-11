import { useEffect, useRef, useState } from "react";
import { Loader2, Search, Sparkles, X } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { relativeTime, snippetHtml, stripMarkdown } from "../utils";
import type { Note } from "../types";

export function SearchBar() {
  const mode = useStore((s) => s.searchMode);
  const searching = useStore((s) => s.searching);
  const searchActive = useStore((s) => s.searchResults !== null);
  const [q, setQ] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // When the search is cleared from outside (zero-results "Create" button,
  // view switch, tag filter), the input follows suit.
  useEffect(() => {
    if (!searchActive && useStore.getState().searchQuery === "") setQ("");
  }, [searchActive]);

  const run = async (query: string, m = mode) => {
    const st = useStore.getState();
    if (!query.trim()) {
      st.setSearchResults(null);
      st.setSearchQuery("");
      return;
    }
    st.setSearching(true);
    try {
      const results = await api.searchNotes(query, m);
      st.setSearchResults(results);
      st.setSearchQuery(query);
    } catch (e) {
      st.toast(String(e), "error");
    } finally {
      st.setSearching(false);
    }
  };

  // Keyword search is instant (FTS5, sub-50ms); semantic runs on Enter.
  const onChange = (value: string) => {
    setQ(value);
    if (timer.current) clearTimeout(timer.current);
    if (mode === "keyword") {
      timer.current = setTimeout(() => void run(value), 120);
    } else if (!value.trim()) {
      useStore.getState().setSearchResults(null);
    }
  };

  const switchMode = (m: "keyword" | "semantic") => {
    useStore.getState().setSearchMode(m);
    if (q.trim()) void run(q, m);
  };

  return (
    <div className="flex items-center gap-1.5 rounded-lg bg-stone-900 px-2.5 py-1.5 ring-1 ring-stone-800/70 transition-shadow focus-within:ring-stone-700">
      {searching ? (
        <Loader2 size={13} className="animate-spin text-clay-400" />
      ) : mode === "semantic" ? (
        <Sparkles size={13} className="text-stone-500" />
      ) : (
        <Search size={13} className="text-stone-500" />
      )}
      <input
        value={q}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          // Search-or-create: Enter on an already-run search with zero
          // results turns the query into a new note's title.
          const st = useStore.getState();
          if (
            st.searchResults?.length === 0 &&
            q.trim() !== "" &&
            q.trim() === st.searchQuery.trim()
          ) {
            void st.createNoteFromSearch();
          } else {
            void run(q);
          }
        }}
        placeholder={mode === "keyword" ? "Search notes…" : "Search by meaning… (Enter)"}
        className="min-w-0 flex-1 bg-transparent text-xs text-stone-200 outline-none placeholder:text-stone-600"
      />
      {q && (
        <button
          onClick={() => {
            setQ("");
            useStore.getState().setSearchResults(null);
            useStore.getState().setSearchQuery("");
          }}
          className="cursor-pointer text-stone-500 hover:text-stone-200"
        >
          <X size={12} />
        </button>
      )}
      {/* segmented mode toggle, embedded in the bar */}
      <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-stone-950/70 p-0.5">
        <ModeButton
          active={mode === "keyword"}
          onClick={() => switchMode("keyword")}
          title="Keyword search"
        >
          <Search size={11} />
        </ModeButton>
        <ModeButton
          active={mode === "semantic"}
          onClick={() => switchMode("semantic")}
          title="Semantic search (by meaning)"
        >
          <Sparkles size={11} />
        </ModeButton>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`cursor-pointer rounded p-1 transition-colors ${
        active
          ? "bg-stone-700/80 text-clay-300"
          : "text-stone-600 hover:text-stone-300"
      }`}
    >
      {children}
    </button>
  );
}

export function SummaryBar() {
  const view = useStore((s) => s.view);
  const tagFilter = useStore((s) => s.tagFilter);
  const settings = useStore((s) => s.settings);
  const [summary, setSummary] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  const [open, setOpen] = useState(false);

  // Scope: selected folder beats tag filter beats everything.
  const kind =
    view.kind === "folder" ? "folder" : tagFilter.length === 1 ? "tag" : "all";
  const key = kind === "folder" ? (view.key ?? "") : kind === "tag" ? tagFilter[0] : "";

  useEffect(() => {
    setSummary(null);
    setUpdatedAt(null);
    setOpen(false);
    void api.getCollectionSummary(kind, key).then((s) => {
      if (s) {
        setSummary(s.summary);
        setUpdatedAt(s.updated_at);
      }
    });
  }, [kind, key]);

  if (settings?.llm_backend === "none") return null;
  // A summary of a multi-tag intersection would be misleading — single scopes only.
  if (view.kind !== "folder" && tagFilter.length > 1) return null;

  const generate = async () => {
    setWorking(true);
    try {
      const s = await api.aiSummarizeCollection(kind, key);
      setSummary(s);
      setUpdatedAt(Date.now());
      setOpen(true);
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="px-4 pb-1">
      <div className="flex items-center gap-2">
        <button
          onClick={() => (summary ? setOpen(!open) : void generate())}
          disabled={working}
          className="flex cursor-pointer items-center gap-1 text-[10px] font-medium text-clay-400 transition-colors hover:text-clay-300 disabled:opacity-60"
        >
          {working ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Sparkles size={11} />
          )}
          {working ? "Summarizing…" : summary ? (open ? "Hide summary" : "Show summary") : "Summarize collection"}
        </button>
        {summary && !working && (
          <button
            onClick={() => void generate()}
            className="cursor-pointer text-[10px] text-stone-600 transition-colors hover:text-stone-400"
          >
            regenerate
          </button>
        )}
      </div>
      {open && summary && (
        <div className="fade-in mt-1.5 rounded-lg bg-stone-900 p-2.5 text-[11px] leading-relaxed text-stone-300">
          {summary}
          {updatedAt && (
            <div className="mt-1 text-[9px] text-stone-600">
              Generated {relativeTime(updatedAt)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function NoteItem({ note }: { note: Note }) {
  const selected = useStore((s) => s.selectedNote?.id === note.id);
  const preview = note.snippet ? null : stripMarkdown(note.content).slice(0, 120);

  return (
    <button
      onClick={() => void useStore.getState().selectNote(note.id)}
      className={`block w-full cursor-pointer rounded-lg px-2.5 py-2 text-left transition-colors ${
        selected ? "bg-stone-800/80" : "hover:bg-stone-800/40"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-[13px] font-medium text-stone-100">
          {note.title || "Untitled"}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {note.embedding_status === "PENDING" && (
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-clay-300" title="Indexing…" />
          )}
          {note.llm_status === "PENDING" && (
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-sage-400" title="AI organizing…" />
          )}
          {typeof note.score === "number" && note.score <= 1 && note.score > 0 && (
            <span className="rounded bg-stone-800 px-1 text-[9px] text-stone-400">
              {(note.score * 100).toFixed(0)}%
            </span>
          )}
        </span>
      </div>
      {note.snippet ? (
        <p
          className="mt-0.5 line-clamp-2 text-[11px] text-stone-500"
          dangerouslySetInnerHTML={{ __html: snippetHtml(note.snippet) }}
        />
      ) : (
        preview && <p className="mt-0.5 line-clamp-2 text-[11px] text-stone-500">{preview}</p>
      )}
      <div className="mt-1 flex items-center gap-1.5">
        <span className="text-[10px] text-stone-600">{relativeTime(note.updated_at)}</span>
        <span className="no-scrollbar flex min-w-0 gap-1 overflow-x-auto">
          {note.tags.map((t) => (
            <span
              key={t.tag}
              className={`fade-in shrink-0 rounded-full px-1.5 text-[9px] ${
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
  );
}
