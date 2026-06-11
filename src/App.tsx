import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useStore } from "./store";
import Sidebar from "./components/Sidebar";
import Editor from "./components/Editor";
import ActionPanel from "./components/ActionPanel";
import ReminderBanners from "./components/ReminderBanners";
import SettingsModal from "./components/SettingsModal";
import CommandPalette from "./components/CommandPalette";
import SimilarNotesModal from "./components/SimilarNotesModal";
import Toasts from "./components/Toasts";
import type { ActionItem, Note, QueueStatus } from "./types";

// Webview zoom (⌘+/⌘−/⌘0), persisted across launches.
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;

function currentZoom(): number {
  const z = Number(localStorage.getItem("nn.zoom"));
  return Number.isFinite(z) && z > 0 ? z : 1;
}

function setZoom(factor: number) {
  const z = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, factor)) * 10) / 10;
  localStorage.setItem("nn.zoom", String(z));
  void getCurrentWebview().setZoom(z);
}

export default function App() {
  const ready = useStore((s) => s.ready);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const actionsOpen = useStore((s) => s.actionsOpen);
  const similarOpen = useStore((s) => s.similarOpen);

  useEffect(() => {
    void useStore.getState().init();

    // The worker emits note-updated in bursts (embed batch = 8 per tick,
    // sweeps = hundreds) — tag counts only need to settle once per burst.
    let tagRefresh: ReturnType<typeof setTimeout> | null = null;
    const scheduleTagRefresh = () => {
      if (tagRefresh) clearTimeout(tagRefresh);
      tagRefresh = setTimeout(() => void useStore.getState().refreshTags(), 400);
    };

    const unsubs = [
      listen<Note>("note-updated", (e) => {
        useStore.getState().applyNoteUpdate(e.payload);
        scheduleTagRefresh();
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
      listen("action-items-changed", () => {
        void useStore.getState().refreshActions();
      }),
      listen<ActionItem>("action-due", (e) => {
        const st = useStore.getState();
        void st.refreshActions();
        if (st.settings?.notify_in_app !== false) st.pushReminder(e.payload);
      }),
      listen<{ count: number; path: string }>("backup-done", (e) => {
        useStore.getState().toast(
          `Backed up ${e.payload.count} notes to ${e.payload.path}`,
          "success",
        );
      }),
      listen<string>("note-captured", (e) => {
        const st = useStore.getState();
        void st.refreshNotes();
        st.toast("Note captured", "success", {
          label: "Open",
          run: () => void useStore.getState().selectNote(e.payload),
        });
      }),
    ];
    return () => {
      if (tagRefresh) clearTimeout(tagRefresh);
      for (const p of unsubs) void p.then((u) => u());
    };
  }, []);

  // Restore persisted webview zoom before first paint settles.
  useEffect(() => {
    const z = currentZoom();
    if (z !== 1) void getCurrentWebview().setZoom(z);
  }, []);

  // Global shortcuts: ⌘K/⌘P palette, ⌘N new note, ⌘, settings, ⌘+/−/0 zoom.
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
      } else if (key === "\\") {
        e.preventDefault();
        useStore.getState().toggleSidebar();
      } else if (key === "=" || key === "+") {
        e.preventDefault();
        setZoom(currentZoom() + ZOOM_STEP);
      } else if (key === "-" || key === "_") {
        e.preventDefault();
        setZoom(currentZoom() - ZOOM_STEP);
      } else if (key === "0") {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-stone-500">
        Loading GoldFishy…
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <Sidebar />
      <Editor />
      {actionsOpen && <ActionPanel />}
      {settingsOpen && <SettingsModal />}
      {paletteOpen && <CommandPalette />}
      {similarOpen && <SimilarNotesModal />}
      <ReminderBanners />
      <Toasts />
    </div>
  );
}
