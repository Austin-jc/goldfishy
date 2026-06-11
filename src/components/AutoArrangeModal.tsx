import { useEffect, useState } from "react";
import { Check, Folder, FolderPlus, Loader2, Wand2, X } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { noteDisplayTitle, stripMarkdown } from "../utils";
import type { ArrangeGroup } from "../types";

/**
 * Review-and-apply for the auto-arrange plan: the LLM proposes where each
 * unfiled note should be filed (existing folders preferred, new ones only
 * for multi-note topics). Nothing moves until the user applies — and only
 * the rows they left selected.
 */
export default function AutoArrangeModal() {
  const close = () => useStore.getState().setArrangeOpen(false);
  const unfiledCount = useStore(
    (s) => s.notes.filter((n) => !n.folder_id && !n.deleted_at).length,
  );
  const [groups, setGroups] = useState<ArrangeGroup[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    void api
      .planAutoArrange()
      .then((gs) => {
        setGroups(gs);
        setSelected(new Set(gs.flatMap((g) => g.notes.map((n) => n.id))));
      })
      .catch((e) => {
        useStore.getState().toast(String(e), "error");
        setGroups([]);
      });
  }, []);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const toggleGroup = (g: ArrangeGroup) =>
    setSelected((s) => {
      const next = new Set(s);
      const allOn = g.notes.every((n) => next.has(n.id));
      for (const n of g.notes) {
        if (allOn) {
          next.delete(n.id);
        } else {
          next.add(n.id);
        }
      }
      return next;
    });

  const count = groups
    ? groups.flatMap((g) => g.notes).filter((n) => selected.has(n.id)).length
    : 0;

  const apply = async () => {
    if (!groups || count === 0) return;
    setApplying(true);
    try {
      const moves = groups.flatMap((g) =>
        g.notes
          .filter((n) => selected.has(n.id))
          .map((n) => ({
            note_id: n.id,
            folder_id: g.folder_id,
            folder_name: g.folder_name,
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
            review the plan — nothing moves until you apply
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
              Planning homes for {unfiledCount} unfiled note
              {unfiledCount === 1 ? "" : "s"}…
            </div>
          )}
          {groups?.map((g) => {
            const allOn = g.notes.every((n) => selected.has(n.id));
            return (
              <div
                key={(g.folder_id ?? "new") + g.folder_name}
                className="rounded-xl bg-stone-950/50 p-2"
              >
                <button
                  onClick={() => toggleGroup(g)}
                  title={allOn ? "Deselect this folder" : "Select this folder"}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-stone-800/60"
                >
                  {g.is_new ? (
                    <FolderPlus size={13} className="shrink-0 text-sage-400" />
                  ) : (
                    <Folder size={13} className="shrink-0 text-clay-400" />
                  )}
                  <span className="truncate text-xs font-medium text-stone-200">
                    {g.folder_name}
                  </span>
                  {g.is_new && (
                    <span className="shrink-0 rounded-full bg-sage-900 px-1.5 py-px text-[9px] font-medium text-sage-300">
                      new folder
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-[10px] text-stone-600">
                    {allOn ? "deselect all" : "select all"}
                  </span>
                </button>
                {g.notes.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => toggle(n.id)}
                    className="flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-stone-800/60"
                  >
                    <span
                      className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors ${
                        selected.has(n.id)
                          ? "border-clay-500 bg-clay-600 text-white"
                          : "border-stone-600 text-transparent"
                      }`}
                    >
                      <Check size={10} strokeWidth={3} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-stone-200">
                        {noteDisplayTitle(n)}
                      </span>
                      <span className="line-clamp-1 text-[10px] text-stone-500">
                        {stripMarkdown(n.content).slice(0, 110)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
          {groups !== null && groups.length === 0 && (
            <p className="px-4 py-10 text-center text-xs text-stone-500">
              {unfiledCount === 0
                ? "No unfiled notes — everything already has a home."
                : "The model couldn't find confident homes for these notes, so they stay put."}
            </p>
          )}
        </div>

        {groups !== null && groups.length > 0 && (
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
    </div>
  );
}
