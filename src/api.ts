import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type {
  ActionItem,
  ActionStatus,
  AppSettings,
  BackupResult,
  CollectionSummary,
  Folder,
  Note,
  NoteVersionMeta,
  QueueStatus,
  SearchMode,
  TagCount,
} from "./types";

// Absolute path of the app data dir, set once at startup; used to resolve
// relative `images/...` markdown references for display.
let dataDir: string | null = null;
export function setDataDir(dir: string) {
  dataDir = dir;
}
export function resolveImageSrc(src: string): string {
  if (!src) return src;
  if (/^(https?|asset|data|blob):/.test(src)) return src;
  if (dataDir && !src.startsWith("/")) {
    return convertFileSrc(`${dataDir}/${src}`);
  }
  if (src.startsWith("/")) return convertFileSrc(src);
  return src;
}

export const api = {
  // notes
  listNotes: (folderId: string | null, tags: string[] | null) =>
    invoke<Note[]>("list_notes", { folderId, tags }),
  getNote: (id: string) => invoke<Note>("get_note", { id }),
  createNote: (folderId: string | null) => invoke<Note>("create_note", { folderId }),
  updateNote: (id: string, title: string, content: string) =>
    invoke<Note>("update_note", { id, title, content }),
  deleteNote: (id: string) => invoke<void>("delete_note", { id }),
  restoreNote: (id: string) => invoke<Note>("restore_note", { id }),
  purgeNote: (id: string) => invoke<void>("purge_note", { id }),
  emptyTrash: () => invoke<number>("empty_trash"),
  listTrashedNotes: () => invoke<Note[]>("list_trashed_notes"),
  moveNote: (id: string, folderId: string | null) =>
    invoke<Note>("move_note", { id, folderId }),
  setNotePinned: (id: string, pinned: boolean) =>
    invoke<Note>("set_note_pinned", { id, pinned }),
  addTag: (noteId: string, tag: string) => invoke<Note>("add_tag", { noteId, tag }),
  removeTag: (noteId: string, tag: string) => invoke<Note>("remove_tag", { noteId, tag }),
  listNoteVersions: (noteId: string) =>
    invoke<NoteVersionMeta[]>("list_note_versions", { noteId }),
  restoreNoteVersion: (versionId: string) =>
    invoke<Note>("restore_note_version", { versionId }),
  acceptFolderSuggestion: (noteId: string) =>
    invoke<Note>("accept_folder_suggestion", { noteId }),
  dismissFolderSuggestion: (noteId: string) =>
    invoke<Note>("dismiss_folder_suggestion", { noteId }),
  searchNotes: (query: string, mode: SearchMode) =>
    invoke<Note[]>("search_notes", { query, mode }),
  relatedNotes: (noteId: string) => invoke<Note[]>("related_notes", { noteId }),
  findSimilarNotes: () => invoke<Note[][]>("find_similar_notes"),
  mergeNotes: (noteIds: string[]) => invoke<Note>("merge_notes", { noteIds }),

  // folders & tags
  listFolders: () => invoke<Folder[]>("list_folders"),
  createFolder: (name: string, parentId: string | null) =>
    invoke<Folder>("create_folder", { name, parentId }),
  moveFolder: (id: string, parentId: string | null) =>
    invoke<void>("move_folder", { id, parentId }),
  renameFolder: (id: string, name: string) => invoke<void>("rename_folder", { id, name }),
  deleteFolder: (id: string) => invoke<void>("delete_folder", { id }),
  listTags: () => invoke<TagCount[]>("list_tags"),
  deleteTag: (tag: string) => invoke<void>("delete_tag", { tag }),

  // AI
  aiProcessNote: (noteId: string) => invoke<Note>("ai_process_note", { noteId }),
  aiBulletify: (noteId: string) => invoke<Note>("ai_bulletify", { noteId }),
  aiTitleUntitled: () => invoke<number>("ai_title_untitled"),
  aiSummarizeCollection: (kind: string, key: string) =>
    invoke<string>("ai_summarize_collection", { kind, key }),
  getCollectionSummary: (kind: string, key: string) =>
    invoke<CollectionSummary | null>("get_collection_summary", { kind, key }),
  testLlm: () => invoke<string>("test_llm"),
  downloadModel: (repo: string) => invoke<string>("download_model", { repo }),

  // action items & reminders
  listActionItems: () => invoke<ActionItem[]>("list_action_items"),
  extractActions: (noteId: string) =>
    invoke<ActionItem[]>("extract_actions_note", { noteId }),
  createActionItem: (
    text: string,
    category: string | null,
    dueAt: number | null,
    noteId: string | null,
  ) => invoke<ActionItem>("create_action_item", { text, category, dueAt, noteId }),
  setActionStatus: (id: string, status: ActionStatus) =>
    invoke<ActionItem>("set_action_status", { id, status }),
  setActionCategory: (id: string, category: string) =>
    invoke<ActionItem>("set_action_category", { id, category }),
  setActionDue: (id: string, dueAt: number | null) =>
    invoke<ActionItem>("set_action_due", { id, dueAt }),
  deleteActionItem: (id: string) => invoke<void>("delete_action_item", { id }),

  // settings & system
  getSettings: () => invoke<AppSettings>("get_settings"),
  setSettings: (settings: AppSettings) => invoke<void>("set_settings", { settings }),
  reindexAll: () => invoke<QueueStatus>("reindex_all"),
  queueStatus: () => invoke<QueueStatus>("queue_status"),
  listQueuedNotes: () => invoke<Note[]>("list_queued_notes"),
  notifyActivity: () => invoke<void>("notify_activity"),
  getDataDir: () => invoke<string>("get_data_dir"),
  saveImage: (srcPath: string) => invoke<string>("save_image", { srcPath }),
  saveImageBytes: (dataBase64: string, ext: string) =>
    invoke<string>("save_image_bytes", { dataBase64, ext }),
  exportNotes: (dest: string, format: "markdown" | "json") =>
    invoke<number>("export_notes", { dest, format }),
  backupNow: () => invoke<BackupResult>("backup_now"),
};
