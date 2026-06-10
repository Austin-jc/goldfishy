import { AlarmClock, X } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { ActionItem } from "../types";

/** In-app banners for due reminders — persistent until acted on. */
export default function ReminderBanners() {
  const reminders = useStore((s) => s.reminders);
  if (reminders.length === 0) return null;
  return (
    <div className="fixed left-1/2 top-4 z-50 flex w-[440px] -translate-x-1/2 flex-col gap-2">
      {reminders.map((r) => (
        <Banner key={r.id} item={r} />
      ))}
    </div>
  );
}

function tomorrowMorning(): number {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

function Banner({ item }: { item: ActionItem }) {
  const dismiss = () => useStore.getState().dismissReminder(item.id);

  const run = async (fn: () => Promise<unknown>) => {
    dismiss();
    try {
      await fn();
      await useStore.getState().refreshActions();
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
  };

  const snooze = (until: number, label: string) =>
    run(async () => {
      await api.setActionDue(item.id, until);
      useStore.getState().toast(`Snoozed until ${label}`, "info");
    });

  return (
    <div className="fade-in flex items-start gap-2.5 rounded-xl border border-clay-700/50 bg-stone-900 px-3.5 py-3 shadow-2xl shadow-black/60">
      <AlarmClock size={15} className="mt-0.5 shrink-0 text-clay-400" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-stone-100">{item.text}</p>
        {item.note_title && (
          <p className="mt-0.5 truncate text-[10px] text-stone-500">
            from “{item.note_title}”
          </p>
        )}
        <div className="mt-2 flex items-center gap-1.5">
          <button
            onClick={() => void run(() => api.setActionStatus(item.id, "done"))}
            className="cursor-pointer rounded-md bg-clay-600 px-2.5 py-1 text-[10px] font-medium text-white transition-colors hover:bg-clay-500"
          >
            Done
          </button>
          <span className="flex items-center gap-0.5 rounded-md bg-stone-800/60 px-1 py-0.5">
            <span className="px-1 text-[9px] uppercase tracking-wide text-stone-500">
              Snooze
            </span>
            <button
              onClick={() => void snooze(Date.now() + 15 * 60_000, "in 15 minutes")}
              className="cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-stone-300 transition-colors hover:bg-stone-700 hover:text-stone-100"
            >
              15m
            </button>
            <button
              onClick={() => void snooze(Date.now() + 3600_000, "in 1 hour")}
              className="cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-stone-300 transition-colors hover:bg-stone-700 hover:text-stone-100"
            >
              1h
            </button>
            <button
              onClick={() => void snooze(tomorrowMorning(), "tomorrow 9:00")}
              className="cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-stone-300 transition-colors hover:bg-stone-700 hover:text-stone-100"
            >
              Tomorrow
            </button>
          </span>
          {item.note_id && (
            <button
              onClick={() => {
                dismiss();
                void useStore.getState().selectNote(item.note_id);
              }}
              className="cursor-pointer rounded-md px-2 py-1 text-[10px] text-stone-400 transition-colors hover:bg-stone-800 hover:text-stone-200"
            >
              Open note
            </button>
          )}
        </div>
      </div>
      <button
        onClick={dismiss}
        title="Dismiss banner"
        className="cursor-pointer rounded-md p-1 text-stone-500 transition-colors hover:bg-stone-800 hover:text-stone-200"
      >
        <X size={13} />
      </button>
    </div>
  );
}
