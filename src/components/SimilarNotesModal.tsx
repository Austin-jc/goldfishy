import { Combine, FileText, Loader2, X } from "lucide-react";
import { useStore } from "../store";
import { noteDisplayTitle, relativeTime, stripMarkdown } from "../utils";

/**
 * Review-and-merge for clusters of highly similar notes. The scan and the
 * merges run in the store (background), so closing the modal mid-merge loses
 * nothing. Merging is low-stakes by design: the target gets a version
 * checkpoint and the absorbed notes sit in Trash for 30 days.
 */
export default function SimilarNotesModal() {
  const groups = useStore((s) => s.similarGroups);
  const finding = useStore((s) => s.similarFinding);
  const merging = useStore((s) => s.mergingSimilar);

  const close = () => {
    const st = useStore.getState();
    st.setSimilarOpen(false);
    // Everything reviewed — drop the "ready for review" state in the sidebar.
    if (st.similarGroups !== null && st.similarGroups.length === 0) st.clearSimilarGroups();
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
          {groups === null && finding && (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-stone-500">
              <Loader2 size={14} className="animate-spin" />
              Comparing notes…
            </div>
          )}
          {groups?.map((group) => {
            const key = group[0].id;
            const busy = merging.includes(key);
            return (
              <div key={key} className="rounded-xl bg-stone-950/50 p-2">
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
                          {noteDisplayTitle(n)}
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
                    onClick={() => void useStore.getState().mergeSimilarGroup(key)}
                    disabled={busy}
                    className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-clay-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-clay-500 disabled:opacity-50"
                  >
                    {busy ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <Combine size={11} />
                    )}
                    {busy ? "Merging…" : `Merge ${group.length} into the oldest`}
                  </button>
                  <button
                    onClick={() => useStore.getState().dismissSimilarGroup(key)}
                    disabled={busy}
                    className="cursor-pointer rounded-lg px-2 py-1 text-[11px] text-stone-500 transition-colors hover:bg-stone-800 hover:text-stone-300 disabled:opacity-50"
                  >
                    Keep separate
                  </button>
                </div>
              </div>
            );
          })}
          {groups !== null && groups.length === 0 && (
            <p className="px-4 py-10 text-center text-xs text-stone-500">
              No overlapping notes found — your collection is already tidy.
              <br />
              <span className="text-[10px] text-stone-600">
                (Notes need embeddings first; new notes are indexed within seconds.)
              </span>
            </p>
          )}
          {groups === null && !finding && (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <p className="text-xs text-stone-500">No scan results yet.</p>
              <button
                onClick={() => void useStore.getState().startFindSimilar()}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-clay-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-clay-500"
              >
                <Combine size={11} />
                Scan for similar notes
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
