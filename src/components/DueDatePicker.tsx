import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Clock } from "lucide-react";

/**
 * Fully themed replacement for the native datetime-local picker: month grid,
 * quick presets, and a time field, all built from the design-token ramps.
 * Positioned `fixed` against the trigger's rect so it never gets clipped by
 * the panel's scroll container; flips above when there's no room below.
 */

const PANEL_W = 256;
const PANEL_H = 348;
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 6 weeks × 7 days covering the given month, starting on Sunday. */
function calendarDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function at(d: Date, hours: number, minutes = 0): Date {
  const out = new Date(d);
  out.setHours(hours, minutes, 0, 0);
  return out;
}

export default function DueDatePicker({
  initial,
  anchor,
  onCommit,
  onClose,
}: {
  /** Current due time (ms epoch) or null. */
  initial: number | null;
  /** Bounding rect of the trigger button. */
  anchor: DOMRect;
  onCommit: (ms: number | null) => void;
  onClose: () => void;
}) {
  const init = initial !== null ? new Date(initial) : null;
  const [viewYear, setViewYear] = useState(() => (init ?? new Date()).getFullYear());
  const [viewMonth, setViewMonth] = useState(() => (init ?? new Date()).getMonth());
  const [selected, setSelected] = useState<Date | null>(init);
  const [time, setTime] = useState(() =>
    init ? `${pad(init.getHours())}:${pad(init.getMinutes())}` : "09:00",
  );

  const days = useMemo(() => calendarDays(viewYear, viewMonth), [viewYear, viewMonth]);
  const today = new Date();

  const style = useMemo(() => {
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - PANEL_W - 8));
    let top = anchor.bottom + 6;
    if (top + PANEL_H > window.innerHeight - 8) {
      top = Math.max(8, anchor.top - PANEL_H - 6);
    }
    return { left, top, width: PANEL_W };
  }, [anchor]);

  const shiftMonth = (delta: number) => {
    const d = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  };

  const commit = (d: Date | null) => {
    onCommit(d ? d.getTime() : null);
    onClose();
  };

  const apply = () => {
    if (!selected) return;
    const [h, m] = time.split(":").map(Number);
    commit(at(selected, Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0));
  };

  const presets: { label: string; date: Date }[] = [
    { label: "Today 18:00", date: at(today, 18) },
    {
      label: "Tomorrow 9:00",
      date: at(new Date(today.getTime() + 86400000), 9),
    },
    {
      label: "In a week",
      date: at(new Date(today.getTime() + 7 * 86400000), 9),
    },
  ];

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fade-in fixed z-50 rounded-xl border border-stone-800 bg-stone-900 p-3 shadow-2xl shadow-black/60"
        style={style}
      >
        {/* quick presets */}
        <div className="flex gap-1 pb-2.5">
          {presets.map((p) => (
            <button
              key={p.label}
              onClick={() => commit(p.date)}
              className="cursor-pointer rounded-full bg-stone-800/80 px-2 py-0.5 text-[10px] text-stone-300 transition-colors hover:bg-clay-600/25 hover:text-clay-300"
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* month navigation */}
        <div className="flex items-center justify-between pb-1.5">
          <button
            onClick={() => shiftMonth(-1)}
            className="cursor-pointer rounded-md p-1 text-stone-500 transition-colors hover:bg-stone-800 hover:text-stone-200"
            title="Previous month"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            onClick={() => {
              setViewYear(today.getFullYear());
              setViewMonth(today.getMonth());
            }}
            className="cursor-pointer rounded-md px-2 py-0.5 text-xs font-semibold text-stone-100 transition-colors hover:bg-stone-800"
            title="Jump to current month"
          >
            {MONTHS[viewMonth]} {viewYear}
          </button>
          <button
            onClick={() => shiftMonth(1)}
            className="cursor-pointer rounded-md p-1 text-stone-500 transition-colors hover:bg-stone-800 hover:text-stone-200"
            title="Next month"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        {/* weekday header */}
        <div className="grid grid-cols-7 pb-0.5">
          {WEEKDAYS.map((d) => (
            <span
              key={d}
              className="py-0.5 text-center text-[9px] font-semibold uppercase text-stone-600"
            >
              {d}
            </span>
          ))}
        </div>

        {/* day grid */}
        <div className="grid grid-cols-7 gap-0.5">
          {days.map((d) => {
            const inMonth = d.getMonth() === viewMonth;
            const isSelected = selected !== null && sameDay(d, selected);
            const isToday = sameDay(d, today);
            return (
              <button
                key={d.toISOString()}
                onClick={() => setSelected(d)}
                className={`cursor-pointer rounded-md py-1 text-center text-[11px] transition-colors ${
                  isSelected
                    ? "bg-clay-600 font-semibold text-white"
                    : isToday
                      ? "text-clay-300 ring-1 ring-inset ring-clay-600/60 hover:bg-stone-800"
                      : inMonth
                        ? "text-stone-300 hover:bg-stone-800"
                        : "text-stone-600 hover:bg-stone-800/60"
                }`}
              >
                {d.getDate()}
              </button>
            );
          })}
        </div>

        {/* time + actions */}
        <div className="mt-2.5 flex items-center gap-1.5">
          <Clock size={12} className="shrink-0 text-stone-500" />
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value || "09:00")}
            className="rounded-md bg-stone-950/70 px-1.5 py-0.5 text-xs text-stone-200 outline-none ring-1 ring-stone-800 focus:ring-stone-600"
          />
          <span className="ml-auto flex items-center gap-1.5">
            {initial !== null && (
              <button
                onClick={() => commit(null)}
                className="cursor-pointer rounded-md px-1.5 py-1 text-[10px] text-stone-500 transition-colors hover:text-red-400"
                title="Remove the reminder time"
              >
                Clear
              </button>
            )}
            <button
              onClick={apply}
              disabled={selected === null}
              className="cursor-pointer rounded-md bg-clay-600 px-2.5 py-1 text-[10px] font-medium text-white transition-colors hover:bg-clay-500 disabled:cursor-default disabled:opacity-50"
            >
              Set reminder
            </button>
          </span>
        </div>
      </div>
    </>
  );
}
