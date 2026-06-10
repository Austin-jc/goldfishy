import { useStore } from "../store";

const colors: Record<string, string> = {
  info: "border-zinc-700 bg-zinc-900",
  success: "border-emerald-800 bg-emerald-950",
  error: "border-red-900 bg-red-950",
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
          className={`fade-in rounded-lg border px-3 py-2 text-left text-xs text-zinc-200 shadow-lg ${colors[t.kind]}`}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}
