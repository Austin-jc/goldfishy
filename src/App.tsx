import { Suspense, lazy, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Minimize2 } from "lucide-react";
import { useStore } from "./store";
import Sidebar from "./components/Sidebar";
import ActionPanel from "./components/ActionPanel";
import ReminderBanners from "./components/ReminderBanners";
import SettingsModal from "./components/SettingsModal";
import CommandPalette from "./components/CommandPalette";
import SimilarNotesModal from "./components/SimilarNotesModal";
import AutoArrangeModal from "./components/AutoArrangeModal";
import Toasts from "./components/Toasts";
import { isImagePath } from "./utils";
import type { ActionItem, Note, QueueStatus } from "./types";

// The editor (Tiptap + lowlight grammars) and the Board are the two heavy
// chunks — split out so the shell paints first and the capture window's
// bundle stays slim.
const Editor = lazy(() => import("./components/Editor"));
const Board = lazy(() => import("./components/Board"));

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
  // WKWebView's page zoom double-scales SVG strokes; index.css multiplies
  // this inverse factor back into every icon's stroke-width to cancel it.
  document.documentElement.style.setProperty("--zoom-inv", String(1 / z));
}

export default function App() {
  const ready = useStore((s) => s.ready);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const actionsOpen = useStore((s) => s.actionsOpen);
  const similarOpen = useStore((s) => s.similarOpen);
  const arrangeOpen = useStore((s) => s.arrangeOpen);
  const boardOpen = useStore((s) => s.boardOpen);
  const focusMode = useStore((s) => s.focusMode);

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
        // The payload names the failing pipeline; add the recovery plan so
        // the toast isn't a dead end (the footer counts the pause down live).
        useStore.getState().toast(`${e.payload} — paused, retrying in 60s`, "error");
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
    if (z !== 1) setZoom(z);
  }, []);

  // OS files dropped anywhere on the window become imported notes (.md/.txt,
  // or folders of them). Image drops stay the editor's business — it inserts
  // them at the drop position — so they're filtered out here.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const files = event.payload.paths.filter((p) => !isImagePath(p));
      if (files.length === 0) return;
      void useStore.getState().importNotePaths(files);
    });
    return () => {
      void unlisten.then((u) => u());
    };
  }, []);

  // Global shortcuts: ⌘K/⌘P palette, ⌘N new note, ⌘⇧K sticky capture,
  // ⌘J today's note, ⌘⇧F focus mode, ⌘, settings, ⌘+/−/0 zoom.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      if ((key === "k" && !e.shiftKey) || key === "p") {
        e.preventDefault();
        const st = useStore.getState();
        st.setPaletteOpen(!st.paletteOpen);
      } else if (key === "b" && e.shiftKey) {
        // Plain ⌘B stays the editor's bold toggle.
        e.preventDefault();
        const st = useStore.getState();
        st.setBoardOpen(!st.boardOpen);
      } else if (key === "f" && e.shiftKey) {
        // Plain ⌘F stays the editor's find bar.
        e.preventDefault();
        useStore.getState().toggleFocusMode();
      } else if (key === "k" && e.shiftKey) {
        // ⌘⇧K — capture a sticky into the Inbox and open the Wall on it.
        e.preventDefault();
        void useStore.getState().quickCaptureSticky();
      } else if (key === "n") {
        e.preventDefault();
        void useStore.getState().createNote();
      } else if (key === "j") {
        e.preventDefault();
        void useStore.getState().openTodayNote();
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

  // Focus mode: just the editor. Modals and toasts stay reachable; the
  // sidebar, Board and action panel step aside until ⌘⇧F again.
  return (
    <div className="flex h-full">
      {!focusMode && <Sidebar />}
      <Suspense fallback={<main className="flex-1" />}>
        {boardOpen && !focusMode ? <Board /> : <Editor />}
      </Suspense>
      {focusMode && <FocusExitButton />}
      {actionsOpen && !focusMode && <ActionPanel />}
      {settingsOpen && <SettingsModal />}
      {paletteOpen && <CommandPalette />}
      {similarOpen && <SimilarNotesModal />}
      {arrangeOpen && <AutoArrangeModal />}
      <ReminderBanners />
      <Toasts />
    </div>
  );
}

/** The one piece of chrome focus mode keeps: a quiet way back out. */
function FocusExitButton() {
  return (
    <button
      onClick={() => useStore.getState().toggleFocusMode()}
      title="Exit focus mode (⌘⇧F)"
      className="fixed left-3 top-3 z-30 cursor-pointer rounded-lg bg-stone-900/80 p-2 text-stone-500 transition-colors hover:bg-stone-800 hover:text-stone-200"
    >
      <Minimize2 size={15} />
    </button>
  );
}
