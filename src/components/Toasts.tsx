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
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`fade-in rounded-lg border px-3 py-2 text-left text-xs shadow-lg ${colors[t.kind]}`}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}
