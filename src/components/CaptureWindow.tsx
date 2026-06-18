import { useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { FileText, StickyNote } from "lucide-react";
import { api } from "../api";
import GoldfishLogo from "./GoldfishLogo";

type CaptureMode = "note" | "sticky";
const MODE_KEY = "nn.captureMode";

/**
 * The quick-capture window (label "capture"): summoned by the global
 * shortcut, hidden on save/esc/blur. A toggle routes the text to either a
 * note (the worker titles and tags it) or a sticky (lands in the Wall's
 * Inbox, untouched by the LLM).
 */
export default function CaptureWindow() {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<CaptureMode>(
    () => (localStorage.getItem(MODE_KEY) === "sticky" ? "sticky" : "note"),
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const win = getCurrentWebviewWindow();

  const pickMode = (m: CaptureMode) => {
    localStorage.setItem(MODE_KEY, m);
    setMode(m);
    inputRef.current?.focus();
  };

  useEffect(() => {
    const un = win.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        inputRef.current?.focus();
      } else {
        // Clicking elsewhere dismisses — capture should never linger.
        void win.hide();
      }
    });
    return () => {
      void un.then((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismiss = () => {
    setText("");
    void win.hide();
  };

  const save = async () => {
    const body = text.trim();
    if (!body || saving) return;
    setSaving(true);
    try {
      if (mode === "sticky") {
        // Unplaced → the Wall's Inbox; a keyboard capture isn't a placement.
        const sticky = await api.createSticky(body, "yellow", 0, 0, false);
        await emit("sticky-captured", sticky.id);
      } else {
        const note = await api.createNote(null);
        await api.updateNote(note.id, "", body);
        await emit("note-captured", note.id);
      }
      setText("");
      void win.hide();
    } catch (e) {
      console.error("[capture] save failed:", e);
    } finally {
      setSaving(false);
    }
  };

  const isSticky = mode === "sticky";

  return (
    <div className="flex h-screen flex-col gap-2 bg-stone-950 p-3">
      <div data-tauri-drag-region className="flex items-center gap-2">
        <GoldfishLogo size={18} />
        <span className="text-xs font-semibold text-stone-300">Quick capture</span>
        <span className="ml-auto flex items-center gap-0.5 rounded-lg bg-stone-900 p-0.5">
          <button
            onClick={() => pickMode("note")}
            className={`flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[10px] transition-colors ${
              !isSticky ? "bg-stone-700/80 text-clay-300" : "text-stone-500 hover:text-stone-300"
            }`}
          >
            <FileText size={11} />
            Note
          </button>
          <button
            onClick={() => pickMode("sticky")}
            className={`flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[10px] transition-colors ${
              isSticky ? "bg-stone-700/80 text-clay-300" : "text-stone-500 hover:text-stone-300"
            }`}
          >
            <StickyNote size={11} />
            Sticky
          </button>
        </span>
      </div>
      <textarea
        ref={inputRef}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void save();
          }
          if (e.key === "Escape") dismiss();
        }}
        placeholder={isSticky ? "Jot a thought…" : "Jot it down…"}
        className="flex-1 resize-none rounded-lg bg-stone-900 p-2.5 text-sm text-stone-200 outline-none ring-1 ring-stone-800 placeholder:text-stone-600 focus:ring-stone-700"
      />
      <div className="flex items-center text-[9px] text-stone-600">
        <span>
          {isSticky
            ? "↵ stick to the Inbox · ⇧↵ newline · esc dismiss"
            : "↵ save · ⇧↵ newline · esc dismiss"}
        </span>
        {saving && <span className="ml-auto text-clay-400">Saving…</span>}
      </div>
    </div>
  );
}
