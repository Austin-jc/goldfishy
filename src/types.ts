export type PipelineStatus = "CLEAN" | "PENDING" | "STALE";

export interface NoteTag {
  tag: string;
  source: "manual" | "ai";
}

export interface Note {
  id: string;
  title: string;
  content: string;
  folder_id: string | null;
  created_at: number;
  updated_at: number;
  tags: NoteTag[];
  embedding_status: PipelineStatus;
  llm_status: PipelineStatus;
  suggested_folder_id: string | null;
  has_embedding: boolean;
  score?: number;
  snippet?: string;
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

export interface QueueStatus {
  embed_stale: number;
  embed_pending: number;
  llm_stale: number;
  llm_pending: number;
  sweep_active: boolean;
  embedder_ready: boolean;
  embedder_state: "cold" | "downloading" | "loading" | "ready" | "error";
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
  extract_actions: boolean;
  notify_in_app: boolean;
  notify_system: boolean;
}

export type ActionStatus = "proposed" | "scheduled" | "done" | "dismissed";

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

export interface CollectionSummary {
  summary: string;
  updated_at: number;
}

export type SearchMode = "keyword" | "semantic";

export interface View {
  kind: "all" | "folder" | "tag";
  /** Folder id when kind === "folder". */
  key: string | null;
  /** Selected tags when kind === "tag" — notes must carry all of them. */
  tags?: string[];
}

export interface DownloadProgress {
  file: string;
  downloaded: number;
  total: number;
  done: boolean;
}
