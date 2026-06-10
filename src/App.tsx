import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "./store";
import Sidebar from "./components/Sidebar";
import Editor from "./components/Editor";
import SettingsModal from "./components/SettingsModal";
import CommandPalette from "./components/CommandPalette";
import Toasts from "./components/Toasts";
import type { Note, QueueStatus } from "./types";

export default function App() {
  const ready = useStore((s) => s.ready);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const paletteOpen = useStore((s) => s.paletteOpen);

  useEffect(() => {
    void useStore.getState().init();

    const unsubs = [
      listen<Note>("note-updated", (e) => {
        useStore.getState().applyNoteUpdate(e.payload);
        void useStore.getState().refreshTags();
      }),
      listen<QueueStatus>("queue-status", (e) => {
        useStore.getState().setQueue(e.payload);
      }),
      listen<string>("worker-error", (e) => {
        useStore.getState().toast(e.payload, "error");
      }),
      listen("sweep-done", () => {
        useStore.getState().toast("Sync / re-index complete", "success");
        void useStore.getState().refreshNotes();
      }),
    ];
    return () => {
      for (const p of unsubs) void p.then((u) => u());
    };
  }, []);

  // Global shortcuts: ⌘K/⌘P palette, ⌘N new note, ⌘, settings.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      if (key === "k" || key === "p") {
        e.preventDefault();
        const st = useStore.getState();
        st.setPaletteOpen(!st.paletteOpen);
      } else if (key === "n") {
        e.preventDefault();
        void useStore.getState().createNote();
      } else if (key === ",") {
        e.preventDefault();
        useStore.getState().setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        Loading NexusNote…
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <Sidebar />
      <Editor />
      {settingsOpen && <SettingsModal />}
      {paletteOpen && <CommandPalette />}
      <Toasts />
    </div>
  );
}
