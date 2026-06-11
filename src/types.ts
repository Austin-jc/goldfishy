export type PipelineStatus = "CLEAN" | "PENDING" | "STALE";

export interface NoteTag {
  tag: string;
  source: "manual" | "ai";
}

export interface Note {
  id: string;
  title: string;
  /**
   * Full Markdown from `get_note`/events; list_notes rows carry only a
   * ~240-char excerpt — enough for previews, never edit/copy from it.
   */
  content: string;
  folder_id: string | null;
  created_at: number;
  updated_at: number;
  tags: NoteTag[];
  embedding_status: PipelineStatus;
  llm_status: PipelineStatus;
  suggested_folder_id: string | null;
  has_embedding: boolean;
  pinned: boolean;
  /** ms epoch when soft-deleted (in Trash); null for live notes. */
  deleted_at: number | null;
  score?: number;
  snippet?: string;
  /** Smart-search provenance: which engine(s) surfaced this result. */
  matched_by?: "keyword" | "semantic" | "both";
}

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

/** One folder's worth of an auto-arrange plan (folder_id null = new folder). */
export interface ArrangeGroup {
  folder_id: string | null;
  folder_name: string;
  is_new: boolean;
  notes: Note[];
}

/** One accepted move from the auto-arrange review modal. */
export interface ArrangeMove {
  note_id: string;
  folder_id: string | null;
  folder_name: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  ignored: number;
}

/**
 * Sparse user overrides over prompts/prompts.json: {task: {field: value}}.
 * Only string fields and max_tokens are tunable; schemas/limits are code-owned.
 */
export type PromptOverrides = Record<string, Record<string, string | number>>;

export interface QueueStatus {
  embed_stale: number;
  embed_pending: number;
  llm_stale: number;
  llm_pending: number;
  sweep_active: boolean;
  embedder_ready: boolean;
  embedder_state: "cold" | "downloading" | "loading" | "ready" | "error";
  /** Live label of what the AI worker is doing right now, null when idle. */
  current_activity: string | null;
  /** Note the live activity targets, when it's a single note. */
  current_note_id: string | null;
}

export interface AppSettings {
  automation_mode: "auto" | "manual";
  embed_debounce_secs: number;
  llm_debounce_secs: number;
  llm_backend: "none" | "external" | "sidecar";
  external_url: string;
  external_model: string;
  external_api_key: string;
  sidecar_binary: string;
  model_path: string;
  sidecar_port: number;
  hf_repo: string;
  auto_tag_max: number;
  auto_title: boolean;
  suggest_folders: boolean;
  extract_actions: boolean;
  notify_in_app: boolean;
  notify_system: boolean;
  /** Folder for periodic markdown backups; empty = backups off. */
  backup_dir: string;
  backup_interval_days: number;
  /** Cosine floor for semantic search hits (incl. smart mode's semantic leg). */
  semantic_search_threshold: number;
  /** Cosine floor for the editor's Related-notes panel. */
  related_notes_threshold: number;
  /** Cosine floor for "Tidy up" merge candidates. */
  similar_merge_threshold: number;
}

export interface BackupResult {
  count: number;
  path: string;
}

export type ActionStatus = "proposed" | "scheduled" | "done" | "dismissed";

/** Action-panel ordering: soonest reminder first, or newest created first. */
export type ActionSort = "due" | "created";

export interface ActionItem {
  id: string;
  note_id: string | null;
  note_title: string;
  text: string;
  category: string;
  status: ActionStatus;
  due_at: number | null;
  notified_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface NoteVersionMeta {
  id: string;
  note_id: string;
  title: string;
  preview: string;
  chars: number;
  created_at: number;
}

export interface CollectionSummary {
  summary: string;
  updated_at: number;
}

/** "smart" fuses keyword + semantic rankings (RRF) and is the default. */
export type SearchMode = "smart" | "keyword" | "semantic";

export interface View {
  kind: "all" | "folder";
  /** Folder id when kind === "folder". */
  key: string | null;
}

export interface DownloadProgress {
  file: string;
  downloaded: number;
  total: number;
  done: boolean;
}
