import { create } from "zustand";
import { api, setDataDir } from "./api";
import { applyTheme, DEFAULT_THEME } from "./themes";
import type {
  ActionItem,
  AppSettings,
  Folder,
  Note,
  QueueStatus,
  SearchMode,
  TagCount,
  View,
} from "./types";

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
}

let toastSeq = 1;

interface Store {
  ready: boolean;
  notes: Note[];
  selectedNote: Note | null;
  folders: Folder[];
  tags: TagCount[];
  settings: AppSettings | null;
  queue: QueueStatus | null;
  view: View;
  searchQuery: string;
  searchMode: SearchMode;
  searchResults: Note[] | null;
  searching: boolean;
  settingsOpen: boolean;
  paletteOpen: boolean;
  sidebarCollapsed: boolean;
  theme: string;
  toasts: Toast[];
  actionsOpen: boolean;
  actionItems: ActionItem[];
  /** Due reminders currently shown as in-app banners. */
  reminders: ActionItem[];

  init: () => Promise<void>;
  refreshNotes: () => Promise<void>;
  refreshFolders: () => Promise<void>;
  refreshTags: () => Promise<void>;
  selectView: (view: View) => void;
  selectNote: (id: string | null) => Promise<void>;
  createNote: () => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
  applyNoteUpdate: (note: Note) => void;
  removeNoteLocal: (id: string) => void;
  setSettings: (s: AppSettings) => void;
  setQueue: (q: QueueStatus) => void;
  setSearchQuery: (q: string) => void;
  setSearchMode: (m: SearchMode) => void;
  setSearchResults: (r: Note[] | null) => void;
  setSearching: (b: boolean) => void;
  setSettingsOpen: (b: boolean) => void;
  setPaletteOpen: (b: boolean) => void;
  toggleSidebar: () => void;
  setTheme: (theme: string) => void;
  setActionsOpen: (b: boolean) => void;
  refreshActions: () => Promise<void>;
  pushReminder: (item: ActionItem) => void;
  dismissReminder: (id: string) => void;
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: number) => void;
}

export const useStore = create<Store>((set, get) => ({
  ready: false,
  notes: [],
  selectedNote: null,
  folders: [],
  tags: [],
  settings: null,
  queue: null,
  view: { kind: "all", key: null },
  searchQuery: "",
  searchMode: "keyword",
  searchResults: null,
  searching: false,
  settingsOpen: false,
  paletteOpen: false,
  sidebarCollapsed: localStorage.getItem("nn.sidebarCollapsed") === "1",
  theme: localStorage.getItem("nn.theme") ?? DEFAULT_THEME,
  toasts: [],
  actionsOpen: false,
  actionItems: [],
  reminders: [],

  init: async () => {
    const [dir, settings, folders, tags, queue] = await Promise.all([
      api.getDataDir(),
      api.getSettings(),
      api.listFolders(),
      api.listTags(),
      api.queueStatus(),
    ]);
    setDataDir(dir);
    set({ settings, folders, tags, queue });
    await get().refreshNotes();
    set({ ready: true });
    void get().refreshActions();
  },

  refreshNotes: async () => {
    const { view } = get();
    const notes = await api.listNotes(
      view.kind === "folder" ? view.key : null,
      view.kind === "tag" ? view.key : null,
    );
    set({ notes });
  },

  refreshFolders: async () => set({ folders: await api.listFolders() }),
  refreshTags: async () => set({ tags: await api.listTags() }),

  selectView: (view) => {
    set({ view, searchQuery: "", searchResults: null });
    void get().refreshNotes();
  },

  selectNote: async (id) => {
    if (!id) {
      set({ selectedNote: null });
      return;
    }
    try {
      const note = await api.getNote(id);
      set({ selectedNote: note });
    } catch (e) {
      get().toast(String(e), "error");
    }
  },

  createNote: async () => {
    const { view } = get();
    try {
      const note = await api.createNote(view.kind === "folder" ? view.key : null);
      set((s) => ({ notes: [note, ...s.notes], selectedNote: note }));
    } catch (e) {
      get().toast(String(e), "error");
    }
  },

  deleteNote: async (id) => {
    try {
      await api.deleteNote(id);
      get().removeNoteLocal(id);
      void get().refreshTags();
    } catch (e) {
      get().toast(String(e), "error");
    }
  },

  applyNoteUpdate: (note) => {
    set((s) => {
      const replace = (arr: Note[]) => {
        const i = arr.findIndex((n) => n.id === note.id);
        if (i === -1) return arr;
        const copy = arr.slice();
        copy[i] = note;
        return copy;
      };
      return {
        notes: replace(s.notes),
        searchResults: s.searchResults ? replace(s.searchResults) : s.searchResults,
        selectedNote: s.selectedNote?.id === note.id ? note : s.selectedNote,
      };
    });
  },

  removeNoteLocal: (id) => {
    set((s) => ({
      notes: s.notes.filter((n) => n.id !== id),
      searchResults: s.searchResults?.filter((n) => n.id !== id) ?? null,
      selectedNote: s.selectedNote?.id === id ? null : s.selectedNote,
    }));
  },

  setSettings: (settings) => set({ settings }),
  setQueue: (queue) => set({ queue }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSearchMode: (searchMode) => set({ searchMode }),
  setSearchResults: (searchResults) => set({ searchResults }),
  setSearching: (searching) => set({ searching }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  toggleSidebar: () =>
    set((s) => {
      const sidebarCollapsed = !s.sidebarCollapsed;
      localStorage.setItem("nn.sidebarCollapsed", sidebarCollapsed ? "1" : "0");
      return { sidebarCollapsed };
    }),

  setTheme: (theme) => {
    localStorage.setItem("nn.theme", theme);
    applyTheme(theme);
    set({ theme });
  },

  setActionsOpen: (actionsOpen) => set({ actionsOpen }),

  refreshActions: async () => {
    try {
      set({ actionItems: await api.listActionItems() });
    } catch {
      // Backend may not be ready during startup; the next event refreshes.
    }
  },

  pushReminder: (item) =>
    set((s) =>
      s.reminders.some((r) => r.id === item.id)
        ? s
        : { reminders: [...s.reminders, item] },
    ),
  dismissReminder: (id) =>
    set((s) => ({ reminders: s.reminders.filter((r) => r.id !== id) })),

  toast: (text, kind = "info") => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), 5000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
