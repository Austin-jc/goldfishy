import { create } from "zustand";
import { api, setDataDir } from "./api";
import { applyLineNumbers, applyTheme, DEFAULT_THEME } from "./themes";
import { noteDisplayTitle } from "./utils";
import type {
  ActionItem,
  ActionSort,
  AppSettings,
  ArrangeGroup,
  BoardMode,
  CollectionSummary,
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

/** The collection-summary scope implied by the current view + tag filter. */
export function summaryScopeKey(view: View, tagFilter: string[]): string {
  const kind = view.kind === "folder" ? "folder" : tagFilter.length === 1 ? "tag" : "all";
  const key = kind === "folder" ? (view.key ?? "") : kind === "tag" ? tagFilter[0] : "";
  return `${kind}:${key}`;
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
  /** "Auto-arrange unfiled notes" review modal. */
  arrangeOpen: boolean;
  /** Background auto-arrange: a finished plan waiting for review. */
  arrangePlan: ArrangeGroup[] | null;
  arrangePlanning: boolean;
  /** Background tidy-up: merge candidates waiting for review. */
  similarGroups: Note[][] | null;
  similarFinding: boolean;
  /** First-note ids of similar groups with a merge in flight. */
  mergingSimilar: string[];
  /** Collection summaries: in-flight scopes and per-scope results. */
  summaryWorking: Record<string, boolean>;
  summaryCache: Record<string, CollectionSummary>;
  /** The Board replaces the editor pane while open. */
  boardOpen: boolean;
  /** Which curated feed the Board shows (persisted to localStorage). */
  boardMode: BoardMode;
  sidebarCollapsed: boolean;
  theme: string;
  /** Editor line-number gutter (display-only, persisted to localStorage). */
  lineNumbers: boolean;
  toasts: Toast[];
  actionsOpen: boolean;
  actionItems: ActionItem[];
  /** Action-panel sort order (persisted to localStorage). */
  actionSort: ActionSort;
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
  /** Open (or create) today's date-titled note in the Journal folder. */
  openTodayNote: () => Promise<void>;
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
  setArrangeOpen: (b: boolean) => void;
  /** Plan auto-arrange in the background; toasts "ready for review" when done. */
  startAutoArrange: () => Promise<void>;
  clearArrangePlan: () => void;
  /** Scan for similar-note clusters in the background; toasts when done. */
  startFindSimilar: () => Promise<void>;
  /** Merge one reviewed group (keyed by its first note's id), off the UI path. */
  mergeSimilarGroup: (groupKey: string) => Promise<void>;
  dismissSimilarGroup: (groupKey: string) => void;
  clearSimilarGroups: () => void;
  /** Load a cached collection summary into the store (no LLM call). */
  loadCollectionSummary: (kind: string, key: string) => Promise<void>;
  /** Regenerate a collection summary in the background. */
  generateCollectionSummary: (kind: string, key: string) => Promise<void>;
  setBoardOpen: (b: boolean) => void;
  setBoardMode: (m: BoardMode) => void;
  /** Import .md/.txt files (or folders of them) and toast the outcome. */
  importNotePaths: (paths: string[]) => Promise<void>;
  toggleSidebar: () => void;
  setTheme: (theme: string) => void;
  setLineNumbers: (on: boolean) => void;
  setActionsOpen: (b: boolean) => void;
  setActionSort: (sort: ActionSort) => void;
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
  arrangeOpen: false,
  arrangePlan: null,
  arrangePlanning: false,
  similarGroups: null,
  similarFinding: false,
  mergingSimilar: [],
  summaryWorking: {},
  summaryCache: {},
  boardOpen: false,
  boardMode: (["clusters", "recent", "stale", "pinned"] as const).find(
    (m) => m === localStorage.getItem("nn.boardMode"),
  ) ?? "clusters",
  sidebarCollapsed: localStorage.getItem("nn.sidebarCollapsed") === "1",
  theme: localStorage.getItem("nn.theme") ?? DEFAULT_THEME,
  lineNumbers: localStorage.getItem("nn.lineNumbers") === "1",
  toasts: [],
  actionsOpen: false,
  actionItems: [],
  actionSort: localStorage.getItem("nn.actionSort") === "created" ? "created" : "due",
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
      // Opening a note always lands in the editor — the Board steps aside.
      set({ selectedNote: note, boardOpen: false });
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
      set((s) => ({ notes: [note, ...s.notes], selectedNote: note, boardOpen: false }));
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
      set((s) => ({ notes: [updated, ...s.notes], selectedNote: updated, boardOpen: false }));
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

  openTodayNote: async () => {
    // Local date, not toISOString (UTC would roll the title over mid-evening).
    const now = new Date();
    const title = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
    try {
      // Match by title anywhere — a journal note the user re-filed still counts.
      const all = await api.listNotes(null, null);
      const existing = all.find((n) => n.title.trim() === title);
      if (existing) {
        await get().selectNote(existing.id);
        return;
      }
      let journal = get().folders.find((f) => f.name.toLowerCase() === "journal");
      if (!journal) {
        journal = await api.createFolder("Journal", null);
        await get().refreshFolders();
      }
      const note = await api.createNote(journal.id);
      const updated = await api.updateNote(note.id, title, "");
      set((s) => ({
        notes: [updated, ...s.notes],
        selectedNote: updated,
        boardOpen: false,
      }));
      recordRecent(updated.id);
    } catch (e) {
      get().toast(String(e), "error");
    }
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
  setArrangeOpen: (arrangeOpen) => set({ arrangeOpen }),

  startAutoArrange: async () => {
    if (get().arrangePlanning) return;
    set({ arrangePlanning: true });
    try {
      const plan = await api.planAutoArrange();
      set({ arrangePlan: plan, arrangePlanning: false });
      if (get().arrangeOpen) return; // already reviewing — the modal seeds itself
      const n = plan.reduce((acc, g) => acc + g.notes.length, 0);
      get().toast(
        n > 0
          ? `Auto-arrange plan ready — homes proposed for ${n} note${n === 1 ? "" : "s"}`
          : "Auto-arrange found no confident homes — you can still file notes by hand",
        n > 0 ? "success" : "info",
        { label: "Review", run: () => get().setArrangeOpen(true) },
      );
    } catch (e) {
      set({ arrangePlanning: false });
      get().toast(String(e), "error");
    }
  },

  clearArrangePlan: () => set({ arrangePlan: null }),

  startFindSimilar: async () => {
    if (get().similarFinding) return;
    set({ similarFinding: true });
    try {
      const groups = await api.findSimilarNotes();
      if (groups.length === 0) {
        set({ similarFinding: false, similarGroups: null });
        get().toast("No overlapping notes found — your collection is already tidy", "info");
        return;
      }
      set({ similarGroups: groups, similarFinding: false });
      if (get().similarOpen) return;
      get().toast(
        `Found ${groups.length} group${groups.length === 1 ? "" : "s"} of overlapping notes`,
        "success",
        { label: "Review", run: () => get().setSimilarOpen(true) },
      );
    } catch (e) {
      set({ similarFinding: false });
      get().toast(String(e), "error");
    }
  },

  mergeSimilarGroup: async (groupKey) => {
    const group = get().similarGroups?.find((g) => g[0]?.id === groupKey);
    if (!group || get().mergingSimilar.includes(groupKey)) return;
    set((s) => ({ mergingSimilar: [...s.mergingSimilar, groupKey] }));
    try {
      const merged = await api.mergeNotes(group.map((n) => n.id));
      set((s) => ({
        similarGroups: s.similarGroups?.filter((g) => g[0]?.id !== groupKey) ?? null,
      }));
      await get().refreshNotes();
      void get().refreshTags();
      void get().refreshTrash();
      get().toast(
        `Merged ${group.length} notes into “${noteDisplayTitle(merged)}”`,
        "success",
        { label: "Open", run: () => void get().selectNote(merged.id) },
      );
    } catch (e) {
      get().toast(String(e), "error");
    } finally {
      set((s) => ({ mergingSimilar: s.mergingSimilar.filter((k) => k !== groupKey) }));
    }
  },

  dismissSimilarGroup: (groupKey) =>
    set((s) => ({
      similarGroups: s.similarGroups?.filter((g) => g[0]?.id !== groupKey) ?? null,
    })),

  clearSimilarGroups: () => set({ similarGroups: null }),

  loadCollectionSummary: async (kind, key) => {
    const k = `${kind}:${key}`;
    if (get().summaryCache[k]) return;
    try {
      const s = await api.getCollectionSummary(kind, key);
      if (s) set((st) => ({ summaryCache: { ...st.summaryCache, [k]: s } }));
    } catch {
      // Non-critical; the bar just offers to generate.
    }
  },

  generateCollectionSummary: async (kind, key) => {
    const k = `${kind}:${key}`;
    if (get().summaryWorking[k]) return;
    set((s) => ({ summaryWorking: { ...s.summaryWorking, [k]: true } }));
    try {
      const summary = await api.aiSummarizeCollection(kind, key);
      set((s) => ({
        summaryCache: { ...s.summaryCache, [k]: { summary, updated_at: Date.now() } },
      }));
      // The bar opens itself when its scope is on screen; toast only when the
      // user has navigated elsewhere in the meantime.
      const st = get();
      if (summaryScopeKey(st.view, st.tagFilter) !== k || st.searchResults !== null) {
        st.toast("Collection summary ready", "success");
      }
    } catch (e) {
      get().toast(String(e), "error");
    } finally {
      set((s) => {
        const summaryWorking = { ...s.summaryWorking };
        delete summaryWorking[k];
        return { summaryWorking };
      });
    }
  },
  setBoardOpen: (boardOpen) => set({ boardOpen }),
  setBoardMode: (boardMode) => {
    localStorage.setItem("nn.boardMode", boardMode);
    set({ boardMode });
  },

  importNotePaths: async (paths) => {
    const { toast } = get();
    try {
      const res = await api.importNotes(paths);
      if (res.imported > 0) {
        await get().refreshNotes();
        void get().refreshTags();
        const skipped =
          res.skipped > 0
            ? ` (${res.skipped} duplicate${res.skipped === 1 ? "" : "s"} skipped)`
            : "";
        const canArrange = get().settings?.llm_backend !== "none";
        toast(
          `Imported ${res.imported} note${res.imported === 1 ? "" : "s"}${skipped}`,
          "success",
          canArrange
            ? { label: "Auto-arrange", run: () => void get().startAutoArrange() }
            : undefined,
        );
      } else if (res.skipped > 0) {
        toast("Those notes are already in GoldFishy", "info");
      } else {
        toast("No importable notes found (.md / .txt files)", "info");
      }
    } catch (e) {
      toast(String(e), "error");
    }
  },

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

  setActionSort: (actionSort) => {
    localStorage.setItem("nn.actionSort", actionSort);
    set({ actionSort });
  },

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
