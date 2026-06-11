import { create } from "zustand";
import { api, setDataDir } from "./api";
import { applyLineNumbers, applyTheme, DEFAULT_THEME } from "./themes";
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
  /** Optional inline action (e.g. Undo); dismisses the toast when run. */
  action?: { label: string; run: () => void };
}

let toastSeq = 1;

// Most-recently-opened notes (newest first) — drives the palette's empty
// state. localStorage so it survives restarts without a schema change.
const RECENTS_KEY = "nn.recentNotes";
const RECENTS_MAX = 20;

export function recentNoteIds(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function recordRecent(id: string) {
  const next = [id, ...recentNoteIds().filter((x) => x !== id)].slice(0, RECENTS_MAX);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
}

interface Store {
  ready: boolean;
  notes: Note[];
  selectedNote: Note | null;
  folders: Folder[];
  tags: TagCount[];
  settings: AppSettings | null;
  queue: QueueStatus | null;
  view: View;
  /** Tags filtering the file explorer — notes must carry all of them. */
  tagFilter: string[];
  searchQuery: string;
  searchMode: SearchMode;
  searchResults: Note[] | null;
  searching: boolean;
  settingsOpen: boolean;
  paletteOpen: boolean;
  /** "Tidy up similar notes" review modal. */
  similarOpen: boolean;
  sidebarCollapsed: boolean;
  theme: string;
  /** Editor line-number gutter (display-only, persisted to localStorage). */
  lineNumbers: boolean;
  toasts: Toast[];
  actionsOpen: boolean;
  actionItems: ActionItem[];
  /** Due reminders currently shown as in-app banners. */
  reminders: ActionItem[];
  /** Soft-deleted notes (Trash section). */
  trash: Note[];

  init: () => Promise<void>;
  refreshNotes: () => Promise<void>;
  refreshFolders: () => Promise<void>;
  refreshTags: () => Promise<void>;
  selectView: (view: View) => void;
  setTagFilter: (tags: string[]) => void;
  selectNote: (id: string | null) => Promise<void>;
  /** Create a note in `folderId`; defaults to the selected folder view. */
  createNote: (folderId?: string | null) => Promise<void>;
  /** Search-or-create: new note titled `title`, opened immediately. */
  createNoteWithTitle: (title: string) => Promise<void>;
  /** Create a note titled with the current search query and clear the search. */
  createNoteFromSearch: () => Promise<void>;
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
  setSimilarOpen: (b: boolean) => void;
  toggleSidebar: () => void;
  setTheme: (theme: string) => void;
  setLineNumbers: (on: boolean) => void;
  setActionsOpen: (b: boolean) => void;
  refreshActions: () => Promise<void>;
  refreshTrash: () => Promise<void>;
  pushReminder: (item: ActionItem) => void;
  dismissReminder: (id: string) => void;
  toast: (text: string, kind?: Toast["kind"], action?: Toast["action"]) => void;
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
  tagFilter: [],
  searchQuery: "",
  searchMode: "smart",
  searchResults: null,
  searching: false,
  settingsOpen: false,
  paletteOpen: false,
  similarOpen: false,
  sidebarCollapsed: localStorage.getItem("nn.sidebarCollapsed") === "1",
  theme: localStorage.getItem("nn.theme") ?? DEFAULT_THEME,
  lineNumbers: localStorage.getItem("nn.lineNumbers") === "1",
  toasts: [],
  actionsOpen: false,
  actionItems: [],
  reminders: [],
  trash: [],

  init: async () => {
    const [dir, settings, folders, tags, queue] = await Promise.all([
      api.getDataDir(),
      api.getSettings(),
      api.listFolders(),
      api.listTags(),
      api.queueStatus(),
    ]);
    setDataDir(dir);
    // First paint doesn't wait for the note list — the tree fills in as soon
    // as refreshNotes resolves.
    set({ settings, folders, tags, queue, ready: true });
    void get().refreshNotes();
    void get().refreshActions();
    void get().refreshTrash();
  },

  refreshNotes: async () => {
    // The explorer tree always shows every folder at once, so notes are
    // fetched across all folders; the tag filter is the only server-side cut.
    const { tagFilter } = get();
    const notes = await api.listNotes(null, tagFilter.length > 0 ? tagFilter : null);
    set({ notes });
  },

  refreshFolders: async () => set({ folders: await api.listFolders() }),
  refreshTags: async () => set({ tags: await api.listTags() }),

  selectView: (view) => {
    set({ view, searchQuery: "", searchResults: null });
    void get().refreshNotes();
  },

  setTagFilter: (tagFilter) => {
    set({ tagFilter, searchQuery: "", searchResults: null });
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
      recordRecent(id);
    } catch (e) {
      get().toast(String(e), "error");
    }
  },

  createNote: async (folderId) => {
    const { view } = get();
    const target =
      folderId !== undefined ? folderId : view.kind === "folder" ? view.key : null;
    try {
      const note = await api.createNote(target);
      set((s) => ({ notes: [note, ...s.notes], selectedNote: note }));
      recordRecent(note.id);
    } catch (e) {
      get().toast(String(e), "error");
    }
  },

  createNoteWithTitle: async (title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const note = await api.createNote(null);
      const updated = await api.updateNote(note.id, trimmed, "");
      set((s) => ({ notes: [updated, ...s.notes], selectedNote: updated }));
      recordRecent(updated.id);
    } catch (e) {
      get().toast(String(e), "error");
    }
  },

  createNoteFromSearch: async () => {
    const title = get().searchQuery.trim();
    if (!title) return;
    set({ searchQuery: "", searchResults: null });
    await get().createNoteWithTitle(title);
  },

  deleteNote: async (id) => {
    try {
      await api.deleteNote(id);
      get().removeNoteLocal(id);
      void get().refreshTags();
      void get().refreshTrash();
      get().toast("Note moved to trash", "info", {
        label: "Undo",
        run: () => {
          void api.restoreNote(id).then(async () => {
            await get().refreshNotes();
            await get().refreshTrash();
            void get().refreshTags();
            void get().selectNote(id);
          });
        },
      });
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
  setSimilarOpen: (similarOpen) => set({ similarOpen }),
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

  setLineNumbers: (lineNumbers) => {
    localStorage.setItem("nn.lineNumbers", lineNumbers ? "1" : "0");
    applyLineNumbers(lineNumbers);
    set({ lineNumbers });
  },

  setActionsOpen: (actionsOpen) => set({ actionsOpen }),

  refreshActions: async () => {
    try {
      set({ actionItems: await api.listActionItems() });
    } catch {
      // Backend may not be ready during startup; the next event refreshes.
    }
  },

  refreshTrash: async () => {
    try {
      set({ trash: await api.listTrashedNotes() });
    } catch {
      // Non-critical; the section just stays as-is.
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

  toast: (text, kind = "info", action) => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text, action }] }));
    setTimeout(() => get().dismissToast(id), action ? 8000 : 5000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
