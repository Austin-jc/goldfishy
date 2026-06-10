import { useEffect, useRef, useState } from "react";
import { Loader2, Search, Sparkles, X } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { relativeTime, snippetHtml, stripMarkdown } from "../utils";
import type { Note } from "../types";

export function SearchBar() {
  const mode = useStore((s) => s.searchMode);
  const searching = useStore((s) => s.searching);
  const [q, setQ] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    <div>
      <div className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 focus-within:border-indigo-600">
        {searching ? (
          <Loader2 size={13} className="animate-spin text-indigo-400" />
        ) : (
          <Search size={13} className="text-zinc-500" />
        )}
        <input
          value={q}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run(q);
          }}
          placeholder={mode === "keyword" ? "Search notes…" : "Search by meaning… (Enter)"}
          className="min-w-0 flex-1 bg-transparent text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
        />
        {q ? (
          <button
            onClick={() => {
              setQ("");
              useStore.getState().setSearchResults(null);
              useStore.getState().setSearchQuery("");
            }}
            className="text-zinc-500 hover:text-zinc-200"
          >
            <X size={12} />
          </button>
        ) : (
          <kbd
            className="cursor-pointer rounded border border-zinc-700 px-1 text-[9px] text-zinc-500"
            onClick={() => useStore.getState().setPaletteOpen(true)}
            title="Open command palette"
          >
            ⌘K
          </kbd>
        )}
      </div>
      <div className="mt-1.5 flex gap-1">
        <ModeButton active={mode === "keyword"} onClick={() => switchMode("keyword")}>
          <Search size={11} /> Keyword
        </ModeButton>
        <ModeButton active={mode === "semantic"} onClick={() => switchMode("semantic")}>
          <Sparkles size={11} /> Semantic
        </ModeButton>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium ${
        active
          ? "bg-indigo-600/30 text-indigo-300"
          : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}

export function SummaryBar() {
  const view = useStore((s) => s.view);
  const settings = useStore((s) => s.settings);
  const [summary, setSummary] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  const [open, setOpen] = useState(false);

  const kind = view.kind;
  const key = view.key ?? "";

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
          className="flex items-center gap-1 text-[10px] font-medium text-indigo-400 hover:text-indigo-300 disabled:opacity-60"
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
            className="text-[10px] text-zinc-600 hover:text-zinc-400"
          >
            regenerate
          </button>
        )}
      </div>
      {open && summary && (
        <div className="fade-in mt-1.5 rounded-md border border-indigo-900/50 bg-indigo-950/30 p-2 text-[11px] leading-relaxed text-zinc-300">
          {summary}
          {updatedAt && (
            <div className="mt-1 text-[9px] text-zinc-600">
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
      className={`block w-full border-b border-zinc-800/60 px-4 py-2.5 text-left ${
        selected ? "bg-indigo-600/15" : "hover:bg-zinc-800/40"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-[13px] font-medium text-zinc-100">
          {note.title || "Untitled"}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {note.embedding_status === "PENDING" && (
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-sky-400" title="Indexing…" />
          )}
          {note.llm_status === "PENDING" && (
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-purple-400" title="AI organizing…" />
          )}
          {typeof note.score === "number" && note.score <= 1 && note.score > 0 && (
            <span className="rounded bg-zinc-800 px-1 text-[9px] text-zinc-400">
              {(note.score * 100).toFixed(0)}%
            </span>
          )}
        </span>
      </div>
      {note.snippet ? (
        <p
          className="mt-0.5 line-clamp-2 text-[11px] text-zinc-500"
          dangerouslySetInnerHTML={{ __html: snippetHtml(note.snippet) }}
        />
      ) : (
        preview && <p className="mt-0.5 line-clamp-2 text-[11px] text-zinc-500">{preview}</p>
      )}
      <div className="mt-1 flex items-center gap-1.5">
        <span className="text-[10px] text-zinc-600">{relativeTime(note.updated_at)}</span>
        <span className="flex min-w-0 gap-1 overflow-hidden">
          {note.tags.slice(0, 3).map((t) => (
            <span
              key={t.tag}
              className={`fade-in shrink-0 rounded-full px-1.5 text-[9px] ${
                t.source === "ai"
                  ? "border border-purple-800/60 text-purple-400"
                  : "bg-zinc-800 text-zinc-400"
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
