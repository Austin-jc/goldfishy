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
  /** AI-generated per-note summary (style per settings); null until generated. */
  summary: string | null;
  score?: number;
  snippet?: string;
  /** Smart-search provenance: which engine(s) surfaced this result. */
  matched_by?: "keyword" | "semantic" | "both";
}

/** The hand-chosen sticky colors (the palette the swatch picker offers).
 *  `blue` is the default for linked stickies (a pointer, not a thought). */
export type StickyColor =
  | "yellow"
  | "green"
  | "blue"
  | "pink"
  | "orange"
  | "purple"
  | "gray";

/** A sticky on the Wall. A text sticky owns `text`; a linked sticky has
 *  `note_id` set and shows the note's `note_title`/`note_preview`. */
export interface Sticky {
  id: string;
  text: string;
  color: StickyColor;
  x: number;
  y: number;
  z: number;
  /** false = sitting in the Inbox, not yet hand-placed on the Wall. */
  placed: boolean;
  note_id: string | null;
  /** Live note title/preview for a linked sticky; null on text stickies. */
  note_title: string | null;
  note_preview: string | null;
  created_at: number;
  updated_at: number;
  /** Search-result extras — unset outside search. */
  score?: number;
  snippet?: string;
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
  /** Post-error pause deadlines (ms epoch; 0 / past = not paused). */
  embed_cooldown_until: number;
  llm_cooldown_until: number;
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
  /** Cosine floor for Board clusters (topical groups, not duplicates). */
  board_cluster_threshold: number;
  /** Keep an AI summary of every note up to date (LLM pipeline). */
  summarize_notes: boolean;
  /** Shape of note summaries. */
  note_summary_style: "blurb" | "bullets" | "todos";
  /** What Board sticky cards show (summary falls back to the excerpt). */
  board_preview: "summary" | "excerpt";
  /** What the explorer hover preview shows. */
  hover_preview: "summary" | "excerpt";
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

/** Full stored text of one version (fetched on demand for the diff view). */
export interface NoteVersionContent {
  title: string;
  content: string;
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

/** Which curated feed the Board is showing. */
export type BoardMode = "wall" | "clusters" | "recent" | "stale" | "pinned";

/** One semantic cluster on the Board; corrections attach to `anchor_id`. */
export interface BoardCluster {
  anchor_id: string;
  label: string;
  /** Set when the label is a real tag — dropping a note here also tags it. */
  label_tag: string | null;
  notes: Note[];
}

export interface BoardData {
  clusters: BoardCluster[];
  /** Embedded notes that didn't cluster with anything. */
  loose: Note[];
  /** Note ids placed by hand — badged, and re-tidies never move them. */
  corrected: string[];
  /** Live notes still waiting for an embedding (not on the board yet). */
  pending: number;
}

export interface DownloadProgress {
  file: string;
  downloaded: number;
  total: number;
  done: boolean;
}
