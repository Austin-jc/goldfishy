import { useStore } from "../store";

// Theme-variable driven so toasts stay readable in light and dark themes.
const colors: Record<string, string> = {
  info: "border-stone-800 bg-stone-900 text-stone-200",
  success: "border-sage-700/50 bg-sage-900 text-stone-200",
  error: "border-red-900 bg-red-950 text-red-100",
};

export default function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`fade-in flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs shadow-lg ${colors[t.kind]}`}
        >
          <span className="min-w-0 flex-1">{t.text}</span>
          {t.action && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                dismiss(t.id);
                t.action!.run();
              }}
              className="shrink-0 cursor-pointer rounded-md bg-clay-600 px-2 py-0.5 text-[10px] font-medium text-white transition-colors hover:bg-clay-500"
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
