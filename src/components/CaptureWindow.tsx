import { useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { api } from "../api";
import GoldfishLogo from "./GoldfishLogo";

/**
 * The quick-capture window (label "capture"): summoned by the global
 * shortcut, hidden on save/esc/blur. Saved text becomes an untitled note —
 * the worker titles and tags it moments later.
 */
export default function CaptureWindow() {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const win = getCurrentWebviewWindow();

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
      const note = await api.createNote(null);
      await api.updateNote(note.id, "", body);
      await emit("note-captured", note.id);
      setText("");
      void win.hide();
    } catch (e) {
      console.error("[capture] save failed:", e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-screen flex-col gap-2 bg-stone-950 p-3">
      <div data-tauri-drag-region className="flex items-center gap-2">
        <GoldfishLogo size={18} />
        <span className="text-xs font-semibold text-stone-300">Quick capture</span>
        <span className="ml-auto text-[9px] text-stone-600">
          lands in All Notes — AI titles &amp; tags it shortly
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
        placeholder="Jot it down…"
        className="flex-1 resize-none rounded-lg bg-stone-900 p-2.5 text-sm text-stone-200 outline-none ring-1 ring-stone-800 placeholder:text-stone-600 focus:ring-stone-700"
      />
      <div className="flex items-center text-[9px] text-stone-600">
        <span>↵ save · ⇧↵ newline · esc dismiss</span>
        {saving && <span className="ml-auto text-clay-400">Saving…</span>}
      </div>
    </div>
  );
}
