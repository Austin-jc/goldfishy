import { useMemo, useRef, useState } from "react";
import {
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  ListChecks,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { relativeTime } from "../utils";
import DueDatePicker from "./DueDatePicker";
import type { ActionItem } from "../types";

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function dueLabel(ms: number): { text: string; overdue: boolean } {
  const now = Date.now();
  if (ms <= now) return { text: `overdue · ${relativeTime(ms)}`, overdue: true };
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, today)) return { text: `today ${hm}`, overdue: false };
  if (sameDay(d, tomorrow)) return { text: `tomorrow ${hm}`, overdue: false };
  return { text: `${d.toLocaleDateString()} ${hm}`, overdue: false };
}

export default function ActionPanel() {
  const items = useStore((s) => s.actionItems);
  const setActionsOpen = useStore((s) => s.setActionsOpen);
  const refreshActions = useStore((s) => s.refreshActions);
  const selectedNoteId = useStore((s) => s.selectedNote?.id);
  const settings = useStore((s) => s.settings);
  const [filter, setFilter] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [newText, setNewText] = useState("");
  const [scanning, setScanning] = useState(false);

  const categories = useMemo(
    () => [...new Set(items.map((i) => i.category))].sort(),
    [items],
  );
  const visible = filter ? items.filter((i) => i.category === filter) : items;
  const proposed = visible.filter((i) => i.status === "proposed");
  const scheduled = visible.filter((i) => i.status === "scheduled");
  const done = visible.filter((i) => i.status === "done");

  const addItem = async () => {
    const text = newText.trim();
    if (!text) return;
    setNewText("");
    try {
      await api.createActionItem(text, filter, null, selectedNoteId ?? null);
      await refreshActions();
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
  };

  const scanCurrent = async () => {
    if (!selectedNoteId) return;
    setScanning(true);
    try {
      const found = await api.extractActions(selectedNoteId);
      useStore.getState().toast(
        found.length
          ? `${found.length} action item${found.length === 1 ? "" : "s"} proposed`
          : "No open action items found in this note",
        "success",
      );
      await refreshActions();
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    } finally {
      setScanning(false);
    }
  };

  return (
    <aside className="flex w-[360px] shrink-0 flex-col bg-stone-900/40">
      {/* header */}
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <ListChecks size={16} className="text-clay-400" />
        <span className="text-sm font-semibold text-stone-100">Action items</span>
        <span className="ml-auto flex items-center gap-0.5">
          {settings?.llm_backend !== "none" && selectedNoteId && (
            <button
              onClick={() => void scanCurrent()}
              disabled={scanning}
              title="Scan the open note for action items"
              className="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] text-stone-400 transition-colors hover:bg-stone-800 hover:text-clay-300 disabled:opacity-50"
            >
              {scanning ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Sparkles size={12} />
              )}
              Scan note
            </button>
          )}
          <button
            onClick={() => setActionsOpen(false)}
            className="cursor-pointer rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-stone-800 hover:text-stone-200"
            title="Close panel"
          >
            <X size={15} />
          </button>
        </span>
      </div>

      {/* quick add */}
      <div className="px-3 pb-2">
        <div className="flex items-center gap-1.5 rounded-lg bg-stone-900 px-2.5 py-1.5 ring-1 ring-stone-800/70 focus-within:ring-stone-700">
          <Plus size={13} className="text-stone-500" />
          <input
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addItem();
            }}
            placeholder="Add an action item…"
            className="min-w-0 flex-1 bg-transparent text-xs text-stone-200 outline-none placeholder:text-stone-600"
          />
        </div>
      </div>

      {/* category filter */}
      {categories.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-2">
          <FilterChip active={filter === null} onClick={() => setFilter(null)}>
            all
          </FilterChip>
          {categories.map((c) => (
            <FilterChip key={c} active={filter === c} onClick={() => setFilter(filter === c ? null : c)}>
              {c}
            </FilterChip>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto pb-4">
        {proposed.length > 0 && (
          <Section title={`Proposed · ${proposed.length}`}>
            {proposed.map((i) => (
              <ActionRow key={i.id} item={i} />
            ))}
          </Section>
        )}

        <Section title={`Scheduled · ${scheduled.length}`}>
          {scheduled.map((i) => (
            <ActionRow key={i.id} item={i} />
          ))}
          {scheduled.length === 0 && (
            <p className="px-4 py-2 text-[11px] text-stone-600">
              Nothing scheduled. Accept a proposal or add one above.
            </p>
          )}
        </Section>

        {done.length > 0 && (
          <div className="mt-3 px-4">
            <button
              onClick={() => setDoneOpen(!doneOpen)}
              className="flex cursor-pointer items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-stone-500 transition-colors hover:text-stone-300"
            >
              {doneOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Completed · {done.length}
            </button>
            {doneOpen && (
              <div className="mt-1 space-y-0.5 pb-2">
                {done.map((i) => (
                  <ActionRow key={i.id} item={i} />
                ))}
              </div>
            )}
          </div>
        )}

        {items.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-stone-600">
            <ListChecks size={20} strokeWidth={1.5} />
            <p className="text-xs">
              {settings?.llm_backend === "none"
                ? "Add items above, or enable an AI engine in Settings to extract them from your notes automatically."
                : "No action items yet. They appear here as the AI reads your notes, or add one above."}
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}

function FilterChip({
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
      className={`cursor-pointer rounded-full px-2 py-0.5 text-[10px] transition-colors ${
        active
          ? "bg-clay-600/25 text-clay-300"
          : "bg-stone-800/70 text-stone-400 hover:text-stone-200"
      }`}
    >
      {children}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <p className="px-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-stone-500">
        {title}
      </p>
      <div className="space-y-0.5 px-2">{children}</div>
    </div>
  );
}

function ActionRow({ item }: { item: ActionItem }) {
  const refreshActions = useStore((s) => s.refreshActions);
  const [editingCategory, setEditingCategory] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);
  const dueBtnRef = useRef<HTMLButtonElement>(null);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refreshActions();
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
  };

  const due = item.due_at ? dueLabel(item.due_at) : null;
  const isDone = item.status === "done";

  return (
    <div className="group rounded-lg px-2.5 py-2 transition-colors hover:bg-stone-800/40">
      <div className="flex items-start gap-2">
        <p
          className={`min-w-0 flex-1 text-xs leading-snug ${
            isDone ? "text-stone-500 line-through" : "text-stone-200"
          }`}
        >
          {item.text}
        </p>
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {item.status === "proposed" && (
            <>
              <button
                onClick={() => void run(() => api.setActionStatus(item.id, "scheduled"))}
                title="Accept & schedule"
                className="cursor-pointer rounded-md p-1 text-sage-400 transition-colors hover:bg-stone-800 hover:text-sage-300"
              >
                <Check size={13} />
              </button>
              <button
                onClick={() => void run(() => api.setActionStatus(item.id, "dismissed"))}
                title="Dismiss"
                className="cursor-pointer rounded-md p-1 text-stone-500 transition-colors hover:bg-stone-800 hover:text-red-400"
              >
                <X size={13} />
              </button>
            </>
          )}
          {item.status === "scheduled" && (
            <button
              onClick={() => void run(() => api.setActionStatus(item.id, "done"))}
              title="Mark done"
              className="cursor-pointer rounded-md p-1 text-stone-500 transition-colors hover:bg-stone-800 hover:text-sage-300"
            >
              <CircleCheck size={13} />
            </button>
          )}
          <button
            onClick={() => void run(() => api.deleteActionItem(item.id))}
            title="Delete"
            className="cursor-pointer rounded-md p-1 text-stone-600 transition-colors hover:bg-stone-800 hover:text-red-400"
          >
            <Trash2 size={12} />
          </button>
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {/* category chip — click to edit */}
        {editingCategory ? (
          <input
            autoFocus
            defaultValue={item.category}
            onBlur={() => setEditingCategory(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditingCategory(false);
              if (e.key === "Enter") {
                const v = (e.target as HTMLInputElement).value.trim();
                setEditingCategory(false);
                if (v && v !== item.category)
                  void run(() => api.setActionCategory(item.id, v));
              }
            }}
            className="w-24 rounded-full bg-stone-900 px-2 py-0.5 text-[10px] text-stone-200 outline-none ring-1 ring-stone-700"
          />
        ) : (
          <button
            onClick={() => setEditingCategory(true)}
            title="Edit category"
            className="cursor-pointer rounded-full bg-stone-800/80 px-2 py-0.5 text-[10px] text-stone-400 transition-colors hover:text-clay-300"
          >
            {item.category}
          </button>
        )}

        {/* due — click opens the themed picker */}
        <button
          ref={dueBtnRef}
          onClick={() =>
            setPickerAnchor(dueBtnRef.current?.getBoundingClientRect() ?? null)
          }
          title={item.due_at ? "Change reminder time" : "Set a reminder time"}
          className={`flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-[10px] transition-colors ${
            due?.overdue && !isDone
              ? "bg-red-950/70 text-red-300"
              : due
                ? "bg-stone-800/80 text-stone-300 hover:text-clay-300"
                : "text-stone-600 hover:text-stone-300"
          }`}
        >
          <CalendarClock size={10} />
          {due ? due.text : "remind me"}
        </button>
        {pickerAnchor && (
          <DueDatePicker
            initial={item.due_at}
            anchor={pickerAnchor}
            onClose={() => setPickerAnchor(null)}
            onCommit={(ms) => {
              if (ms !== item.due_at) void run(() => api.setActionDue(item.id, ms));
            }}
          />
        )}

        {item.note_id && (
          <button
            onClick={() => void useStore.getState().selectNote(item.note_id)}
            title="Open source note"
            className="max-w-[140px] cursor-pointer truncate text-[10px] text-stone-600 transition-colors hover:text-clay-300"
          >
            ↗ {item.note_title || "Untitled"}
          </button>
        )}
      </div>
    </div>
  );
}
