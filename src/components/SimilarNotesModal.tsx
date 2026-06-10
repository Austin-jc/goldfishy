import { useEffect, useState } from "react";
import { Combine, FileText, Loader2, X } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { relativeTime, stripMarkdown } from "../utils";
import type { Note } from "../types";

/**
 * Review-and-merge for clusters of highly similar notes. Merging is
 * low-stakes by design: the target gets a version checkpoint and the
 * absorbed notes sit in Trash for 30 days.
 */
export default function SimilarNotesModal() {
  const close = () => useStore.getState().setSimilarOpen(false);
  const [groups, setGroups] = useState<Note[][] | null>(null);
  const [mergingIdx, setMergingIdx] = useState<number | null>(null);

  useEffect(() => {
    void api
      .findSimilarNotes()
      .then(setGroups)
      .catch((e) => {
        useStore.getState().toast(String(e), "error");
        setGroups([]);
      });
  }, []);

  const merge = async (idx: number) => {
    const group = groups?.[idx];
    if (!group) return;
    setMergingIdx(idx);
    try {
      const merged = await api.mergeNotes(group.map((n) => n.id));
      setGroups((g) => (g ? g.filter((_, i) => i !== idx) : g));
      const st = useStore.getState();
      await st.refreshNotes();
      void st.refreshTags();
      void st.refreshTrash();
      st.toast(
        `Merged ${group.length} notes into “${merged.title || "Untitled"}”`,
        "success",
        { label: "Open", run: () => void useStore.getState().selectNote(merged.id) },
      );
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    } finally {
      setMergingIdx(null);
    }
  };

  const dismiss = (idx: number) =>
    setGroups((g) => (g ? g.filter((_, i) => i !== idx) : g));

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/50 pt-20"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="flex h-fit max-h-[72vh] w-[560px] flex-col overflow-hidden rounded-xl border border-stone-800 bg-stone-900 shadow-2xl">
        <header className="flex items-center gap-2 border-b border-stone-800 px-4 py-3">
          <Combine size={15} className="text-clay-400" />
          <h2 className="text-sm font-semibold text-stone-100">Similar notes</h2>
          <span className="text-[10px] text-stone-500">
            merge candidates · sources go to Trash, fully recoverable
          </span>
          <button
            onClick={close}
            className="ml-auto cursor-pointer rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-stone-800 hover:text-stone-200"
          >
            <X size={15} />
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-3">
          {groups === null && (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-stone-500">
              <Loader2 size={14} className="animate-spin" />
              Comparing notes…
            </div>
          )}
          {groups?.map((group, idx) => (
            <div key={group[0].id} className="rounded-xl bg-stone-950/50 p-2">
              {group.map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    close();
                    void useStore.getState().selectNote(n.id);
                  }}
                  title="Open note"
                  className="flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-stone-800/60"
                >
                  <FileText size={13} className="mt-0.5 shrink-0 text-stone-600" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-xs text-stone-200">
                        {n.title || "Untitled"}
                      </span>
                      <span className="ml-auto shrink-0 text-[9px] text-stone-600">
                        {relativeTime(n.updated_at)}
                      </span>
                    </span>
                    <span className="line-clamp-1 text-[10px] text-stone-500">
                      {stripMarkdown(n.content).slice(0, 110)}
                    </span>
                  </span>
                </button>
              ))}
              <div className="mt-1 flex items-center gap-2 px-2 pb-1">
                <button
                  onClick={() => void merge(idx)}
                  disabled={mergingIdx !== null}
                  className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-clay-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-clay-500 disabled:opacity-50"
                >
                  {mergingIdx === idx ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <Combine size={11} />
                  )}
                  {mergingIdx === idx
                    ? "Merging…"
                    : `Merge ${group.length} into the oldest`}
                </button>
                <button
                  onClick={() => dismiss(idx)}
                  disabled={mergingIdx !== null}
                  className="cursor-pointer rounded-lg px-2 py-1 text-[11px] text-stone-500 transition-colors hover:bg-stone-800 hover:text-stone-300 disabled:opacity-50"
                >
                  Keep separate
                </button>
              </div>
            </div>
          ))}
          {groups !== null && groups.length === 0 && (
            <p className="px-4 py-10 text-center text-xs text-stone-500">
              No overlapping notes found — your collection is already tidy.
              <br />
              <span className="text-[10px] text-stone-600">
                (Notes need embeddings first; new notes are indexed within seconds.)
              </span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
