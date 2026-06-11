import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FolderOpen,
  Loader2,
  RefreshCw,
  X,
  Zap,
} from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { THEMES } from "../themes";
import type { AppSettings, DownloadProgress, PromptOverrides } from "../types";

export default function SettingsModal() {
  const settings = useStore((s) => s.settings)!;
  const queue = useStore((s) => s.queue);
  const [local, setLocal] = useState<AppSettings>({ ...settings });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [download, setDownload] = useState<DownloadProgress | null>(null);
  const [downloading, setDownloading] = useState(false);

  const close = () => useStore.getState().setSettingsOpen(false);

  useEffect(() => {
    const un = listen<DownloadProgress>("model-download-progress", (e) => {
      setDownload(e.payload);
      if (e.payload.done) {
        setDownloading(false);
        void api.getSettings().then((s) => {
          useStore.getState().setSettings(s);
          setLocal((prev) => ({ ...prev, model_path: s.model_path, hf_repo: s.hf_repo }));
        });
      }
    });
    return () => {
      void un.then((u) => u());
    };
  }, []);

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setLocal((prev) => ({ ...prev, [key]: value }));

  const setThreshold = (
    key: "semantic_search_threshold" | "related_notes_threshold" | "similar_merge_threshold",
    raw: string,
  ) => set(key, Math.min(1, Math.max(0, Number(raw) || 0)));

  // Pending prompt edits from the Prompts section; null = untouched.
  const promptOverridesRef = useRef<PromptOverrides | null>(null);

  const save = async (): Promise<boolean> => {
    setSaving(true);
    try {
      await api.setSettings(local);
      useStore.getState().setSettings(local);
      if (promptOverridesRef.current !== null) {
        // Backend validates (placeholders kept, known fields) — a clear error
        // comes back as the toast and the modal stays open.
        await api.setPromptOverrides(promptOverridesRef.current);
      }
      return true;
    } catch (e) {
      useStore.getState().toast(String(e), "error");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const [llmStatus, setLlmStatus] = useState<{ ok: boolean; detail: string } | null>(null);

  const connectionLabel = (s: AppSettings) =>
    s.llm_backend === "external"
      ? `${s.external_model.trim() || "default"} @ ${s.external_url.trim() || "?"}`
      : s.llm_backend === "sidecar"
        ? `${s.model_path.split("/").pop() || "local model"} via llama-server`
        : "disabled";

  const testConnection = async () => {
    if (!(await save())) return;
    setTesting(true);
    setLlmStatus(null);
    try {
      await api.testLlm();
      setLlmStatus({ ok: true, detail: `Connected · ${connectionLabel(local)}` });
    } catch (e) {
      setLlmStatus({ ok: false, detail: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const startDownload = async () => {
    if (!local.hf_repo.trim()) {
      useStore.getState().toast("Enter a HuggingFace repo id first", "error");
      return;
    }
    if (!(await save())) return;
    setDownloading(true);
    setDownload(null);
    try {
      const path = await api.downloadModel(local.hf_repo);
      useStore.getState().toast(`Model downloaded: ${path}`, "success");
    } catch (e) {
      useStore.getState().toast(String(e), "error");
      setDownloading(false);
    }
  };

  const pickFile = async (key: "sidecar_binary" | "model_path", ggufOnly: boolean) => {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: ggufOnly ? [{ name: "GGUF model", extensions: ["gguf"] }] : undefined,
    });
    if (typeof picked === "string") set(key, picked);
  };

  const exportAll = async (format: "markdown" | "json") => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    try {
      const count = await api.exportNotes(dir, format);
      useStore.getState().toast(`Exported ${count} notes as ${format}`, "success");
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
  };

  const reindex = async () => {
    if (!(await save())) return;
    try {
      const status = await api.reindexAll();
      useStore.getState().setQueue(status);
      useStore.getState().toast(
        `Sweeping database — ${status.embed_stale + status.embed_pending} to embed, ${status.llm_stale + status.llm_pending} for the LLM`,
      );
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
  };

  const pct =
    download && download.total > 0
      ? Math.min(100, Math.round((download.downloaded / download.total) * 100))
      : null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6">
      <div className="flex max-h-full w-[620px] flex-col rounded-xl border border-stone-800 bg-stone-900 shadow-2xl">
        <header className="flex items-center justify-between border-b border-stone-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-stone-100">Settings</h2>
          <button onClick={close} className="text-stone-500 hover:text-stone-200">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
          {/* ---------------- Appearance ---------------- */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">
              Appearance
            </h3>
            <ThemePicker />
            <div className="mt-3">
              <LineNumbersToggle />
            </div>
          </section>

          {/* ---------------- AI Engine (BYOM) ---------------- */}
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-stone-500">
              AI Engine &amp; Model Selection
            </h3>
            <p className="mb-2 text-[10px] text-stone-500">
              Active:{" "}
              <span className={settings.llm_backend === "none" ? "" : "text-sage-400"}>
                {settings.llm_backend === "none" ? "AI disabled" : connectionLabel(settings)}
              </span>
            </p>
            <div className="flex gap-2">
              {(
                [
                  ["none", "Disabled"],
                  ["sidecar", "Local model (llama.cpp)"],
                  ["external", "External server"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => set("llm_backend", value)}
                  className={`rounded-md border px-3 py-1.5 text-xs ${
                    local.llm_backend === value
                      ? "border-clay-600 bg-clay-600/20 text-clay-300"
                      : "border-stone-700 text-stone-400 hover:border-stone-500"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {local.llm_backend === "external" && (
              <div className="mt-3 space-y-2 rounded-lg border border-stone-800 p-3">
                <Field label="Server URL (OpenAI-compatible, e.g. Ollama / LM Studio)">
                  <input
                    value={local.external_url}
                    onChange={(e) => set("external_url", e.target.value)}
                    placeholder="http://localhost:11434"
                    className={inputCls}
                  />
                </Field>
                <div className="flex gap-2">
                  <Field label="Model name" className="flex-1">
                    <input
                      value={local.external_model}
                      onChange={(e) => set("external_model", e.target.value)}
                      placeholder="llama3.2"
                      className={inputCls}
                    />
                  </Field>
                  <Field label="API key (optional)" className="flex-1">
                    <input
                      value={local.external_api_key}
                      onChange={(e) => set("external_api_key", e.target.value)}
                      type="password"
                      placeholder="—"
                      className={inputCls}
                    />
                  </Field>
                </div>
              </div>
            )}

            {local.llm_backend === "sidecar" && (
              <div className="mt-3 space-y-2 rounded-lg border border-stone-800 p-3">
                <Field label="llama-server binary (from llama.cpp)">
                  <div className="flex gap-2">
                    <input
                      value={local.sidecar_binary}
                      onChange={(e) => set("sidecar_binary", e.target.value)}
                      placeholder="/opt/homebrew/bin/llama-server"
                      className={inputCls + " flex-1"}
                    />
                    <button onClick={() => void pickFile("sidecar_binary", false)} className={btnCls}>
                      <FolderOpen size={12} /> Browse
                    </button>
                  </div>
                </Field>
                <Field label="GGUF model file">
                  <div className="flex gap-2">
                    <input
                      value={local.model_path}
                      onChange={(e) => set("model_path", e.target.value)}
                      placeholder="/path/to/model.gguf"
                      className={inputCls + " flex-1"}
                    />
                    <button onClick={() => void pickFile("model_path", true)} className={btnCls}>
                      <FolderOpen size={12} /> Browse
                    </button>
                  </div>
                </Field>
                <Field label="…or download from HuggingFace (repo id)">
                  <div className="flex gap-2">
                    <input
                      value={local.hf_repo}
                      onChange={(e) => set("hf_repo", e.target.value)}
                      placeholder="bartowski/Llama-3.2-3B-Instruct-GGUF"
                      className={inputCls + " flex-1"}
                    />
                    <button onClick={() => void startDownload()} disabled={downloading} className={btnCls}>
                      {downloading ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Download size={12} />
                      )}
                      Download
                    </button>
                  </div>
                </Field>
                {(downloading || download) && (
                  <div className="text-[10px] text-stone-500">
                    {download ? (
                      <>
                        {download.file} — {(download.downloaded / 1048576).toFixed(0)} MB
                        {download.total > 0 && <> / {(download.total / 1048576).toFixed(0)} MB</>}
                        {download.done && " ✓"}
                      </>
                    ) : (
                      "Contacting HuggingFace…"
                    )}
                    {pct !== null && !download?.done && (
                      <div className="mt-1 h-1 w-full overflow-hidden rounded bg-stone-800">
                        <div className="h-full bg-clay-500" style={{ width: `${pct}%` }} />
                      </div>
                    )}
                  </div>
                )}
                <Field label="Sidecar port">
                  <input
                    type="number"
                    value={local.sidecar_port}
                    onChange={(e) => set("sidecar_port", Number(e.target.value) || 8757)}
                    className={inputCls + " w-28"}
                  />
                </Field>
              </div>
            )}

            {local.llm_backend !== "none" && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button onClick={() => void testConnection()} disabled={testing} className={btnCls}>
                  {testing ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                  Test connection
                </button>
                {llmStatus && (
                  <span
                    className={`fade-in flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] ${
                      llmStatus.ok
                        ? "bg-sage-900 text-sage-300"
                        : "bg-red-950 text-red-300"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        llmStatus.ok ? "bg-sage-400" : "bg-red-400"
                      }`}
                    />
                    <span className="max-w-80 truncate">{llmStatus.detail}</span>
                  </span>
                )}
              </div>
            )}
          </section>

          {/* ---------------- Processing ---------------- */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">
              Processing Mode &amp; Timers
            </h3>
            <div className="space-y-3 rounded-lg border border-stone-800 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-stone-200">Automation mode</p>
                  <p className="text-[10px] text-stone-500">
                    Full Auto runs the background queues; Manual Only waits for the AI buttons.
                  </p>
                </div>
                <div className="flex overflow-hidden rounded-md border border-stone-700">
                  {(
                    [
                      ["auto", "Full Auto"],
                      ["manual", "Manual Only"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() => set("automation_mode", value)}
                      className={`px-3 py-1 text-xs ${
                        local.automation_mode === value
                          ? "bg-clay-600 text-white"
                          : "text-stone-400 hover:bg-stone-800"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-stone-200">Auto-tag granularity</p>
                  <p className="text-[10px] text-stone-500">
                    How many tags the AI may add per note. Fewer keeps tags meaningful.
                  </p>
                </div>
                <div className="flex overflow-hidden rounded-md border border-stone-700">
                  {(
                    [
                      [0, "Off"],
                      [1, "Minimal"],
                      [2, "Balanced"],
                      [4, "Detailed"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() => set("auto_tag_max", value)}
                      className={`cursor-pointer px-3 py-1 text-xs transition-colors ${
                        local.auto_tag_max === value
                          ? "bg-clay-600 text-white"
                          : "text-stone-400 hover:bg-stone-800"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <ToggleRow
                label="Auto-title untitled notes"
                desc="Generate a title when a note is left untitled (also applies to the Organize button)."
                value={local.auto_title}
                onChange={(v) => set("auto_title", v)}
              />
              <ToggleRow
                label="Suggest destination folders"
                desc="Let the AI propose where to file a note while organizing; you always confirm."
                value={local.suggest_folders}
                onChange={(v) => set("suggest_folders", v)}
              />
              <div className="flex gap-4">
                <Field label="Embedding debounce (seconds)" className="flex-1">
                  <input
                    type="number"
                    min={0}
                    value={local.embed_debounce_secs}
                    onChange={(e) => set("embed_debounce_secs", Math.max(0, Number(e.target.value) || 0))}
                    className={inputCls}
                  />
                </Field>
                <Field label="LLM debounce (seconds)" className="flex-1">
                  <input
                    type="number"
                    min={0}
                    value={local.llm_debounce_secs}
                    onChange={(e) => set("llm_debounce_secs", Math.max(0, Number(e.target.value) || 0))}
                    className={inputCls}
                  />
                </Field>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-stone-200">Sync / Re-index</p>
                  <p className="text-[10px] text-stone-500">
                    Sweep the database and process notes skipped while in Manual Mode.
                  </p>
                </div>
                <button onClick={() => void reindex()} disabled={queue?.sweep_active} className={btnCls}>
                  {queue?.sweep_active ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <RefreshCw size={12} />
                  )}
                  {queue?.sweep_active ? "Sweeping…" : "Re-index now"}
                </button>
              </div>
            </div>
          </section>

          {/* ---------------- Search & similarity ---------------- */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">
              Search &amp; Similarity
            </h3>
            <div className="space-y-3 rounded-lg border border-stone-800 p-3">
              <p className="text-[10px] text-stone-500">
                Cosine-similarity floors (0–1). Lower lets broader, looser matches
                through; higher keeps only near-misses. Defaults in parentheses.
              </p>
              <div className="flex gap-4">
                <Field label="Semantic search (0.25)" className="flex-1">
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={local.semantic_search_threshold}
                    onChange={(e) => setThreshold("semantic_search_threshold", e.target.value)}
                    className={inputCls}
                    title="Floor for semantic results — also the smart mode's by-meaning matches"
                  />
                </Field>
                <Field label="Related notes (0.35)" className="flex-1">
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={local.related_notes_threshold}
                    onChange={(e) => setThreshold("related_notes_threshold", e.target.value)}
                    className={inputCls}
                    title="Floor for the Related-notes panel under the editor"
                  />
                </Field>
                <Field label="Tidy-up merge (0.80)" className="flex-1">
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={local.similar_merge_threshold}
                    onChange={(e) => setThreshold("similar_merge_threshold", e.target.value)}
                    className={inputCls}
                    title="How similar two notes must be before Tidy up proposes merging them"
                  />
                </Field>
              </div>
            </div>
          </section>

          {/* ---------------- Reminders & action items ---------------- */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">
              Reminders &amp; Action Items
            </h3>
            <div className="space-y-3 rounded-lg border border-stone-800 p-3">
              <ToggleRow
                label="Extract action items automatically"
                desc="The AI proposes tasks and follow-ups as it reads your notes (needs an AI engine)."
                value={local.extract_actions}
                onChange={(v) => set("extract_actions", v)}
              />
              <ToggleRow
                label="In-app reminder banners"
                desc="Show a banner inside the app when a scheduled item comes due."
                value={local.notify_in_app}
                onChange={(v) => set("notify_in_app", v)}
              />
              <ToggleRow
                label="System notifications"
                desc="Also fire a native desktop notification, so reminders reach you outside the app."
                value={local.notify_system}
                onChange={(v) => set("notify_system", v)}
              />
            </div>
          </section>

          {/* ---------------- Prompts ---------------- */}
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-stone-500">
              Prompts (advanced)
            </h3>
            <p className="mb-2 text-[10px] leading-relaxed text-stone-600">
              The exact instructions each AI feature sends to your model. Edit
              freely — keep the {"{placeholders}"}, they're filled in at run
              time (Save checks this). Edits live in your database; the
              benchmark (<code>npm run bench</code>) always measures the
              defaults.
            </p>
            <PromptsSection
              onChange={(ov) => {
                promptOverridesRef.current = ov;
              }}
            />
          </section>

          {/* ---------------- Data ---------------- */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">
              Data &amp; Export
            </h3>
            <div className="flex gap-2">
              <button onClick={() => void exportAll("markdown")} className={btnCls}>
                Export all as Markdown
              </button>
              <button onClick={() => void exportAll("json")} className={btnCls}>
                Export all as JSON
              </button>
            </div>
            <div className="mt-3 space-y-2 rounded-lg border border-stone-800 p-3">
              <Field label="Automatic backup folder (markdown snapshots; leave empty to disable)">
                <div className="flex gap-2">
                  <input
                    value={local.backup_dir}
                    onChange={(e) => set("backup_dir", e.target.value)}
                    placeholder="/path/to/backups"
                    className={inputCls + " flex-1"}
                  />
                  <button
                    onClick={async () => {
                      const dir = await open({ directory: true, multiple: false });
                      if (typeof dir === "string") set("backup_dir", dir);
                    }}
                    className={btnCls}
                  >
                    <FolderOpen size={12} /> Browse
                  </button>
                </div>
              </Field>
              <div className="flex items-end gap-3">
                <Field label="Backup every (days)">
                  <input
                    type="number"
                    min={1}
                    value={local.backup_interval_days}
                    onChange={(e) =>
                      set("backup_interval_days", Math.max(1, Number(e.target.value) || 7))
                    }
                    className={inputCls + " w-24"}
                  />
                </Field>
                <button
                  onClick={async () => {
                    if (!(await save())) return;
                    try {
                      const res = await api.backupNow();
                      useStore.getState().toast(
                        `Backed up ${res.count} notes to ${res.path}`,
                        "success",
                      );
                    } catch (e) {
                      useStore.getState().toast(String(e), "error");
                    }
                  }}
                  className={btnCls}
                >
                  Back up now
                </button>
              </div>
            </div>
          </section>
        </div>

        <footer className="flex justify-end gap-2 border-t border-stone-800 px-5 py-3">
          <button onClick={close} className={btnCls}>
            Cancel
          </button>
          <button
            onClick={async () => {
              if (await save()) {
                useStore.getState().toast("Settings saved", "success");
                close();
              }
            }}
            disabled={saving}
            className="flex items-center gap-1 rounded-md bg-clay-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-clay-500 disabled:opacity-60"
          >
            {saving && <Loader2 size={12} className="animate-spin" />}
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}

function ThemePicker() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  return (
    <div>
      <div className="grid grid-cols-3 gap-2">
        {THEMES.map((t) => (
          <button
            key={t.id}
            onClick={() => setTheme(t.id)}
            className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-xs ring-1 transition-colors ${
              theme === t.id
                ? "bg-stone-800/70 text-stone-100 ring-clay-500"
                : "text-stone-400 ring-stone-800 hover:text-stone-200 hover:ring-stone-600"
            }`}
          >
            <span className="flex shrink-0 -space-x-1">
              {t.preview.map((c) => (
                <span
                  key={c}
                  className="h-3.5 w-3.5 rounded-full ring-1 ring-black/30"
                  style={{ background: c }}
                />
              ))}
            </span>
            <span className="truncate">{t.name}</span>
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[10px] text-stone-500">
        Applies immediately — no save needed.
      </p>
    </div>
  );
}

/** Display-only preference — applies instantly, persisted to localStorage. */
function LineNumbersToggle() {
  const lineNumbers = useStore((s) => s.lineNumbers);
  const setLineNumbers = useStore((s) => s.setLineNumbers);
  return (
    <ToggleRow
      label="Line numbers in the editor"
      desc="Number each block (paragraph, heading, list) in a gutter — applies immediately"
      value={lineNumbers}
      onChange={setLineNumbers}
    />
  );
}

const inputCls =
  "rounded-md border border-stone-700 bg-stone-950 px-2 py-1.5 text-xs text-stone-200 outline-none focus:border-clay-600 w-full";
const btnCls =
  "flex items-center gap-1.5 rounded-md border border-stone-700 px-3 py-1.5 text-xs text-stone-300 hover:border-stone-500 hover:text-stone-100 disabled:opacity-50";

function ToggleRow({
  label,
  desc,
  value,
  onChange,
}: {
  label: string;
  desc: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-xs text-stone-200">{label}</p>
        <p className="text-[10px] text-stone-500">{desc}</p>
      </div>
      <button
        onClick={() => onChange(!value)}
        role="switch"
        aria-checked={value}
        className={`h-5 w-9 shrink-0 cursor-pointer rounded-full p-0.5 transition-colors ${
          value ? "bg-clay-600" : "bg-stone-700"
        }`}
      >
        <span
          className={`block h-4 w-4 rounded-full bg-white transition-transform ${
            value ? "translate-x-4" : ""
          }`}
        />
      </button>
    </div>
  );
}

/** Friendly names for prompt tasks; falls back to the raw key. */
const PROMPT_TASK_LABELS: Record<string, string> = {
  title: "Auto-title",
  tag_route: "Tags & folder routing (manual Organize)",
  organize: "Background organize (single pass)",
  actions: "Action-item extraction",
  arrange: "Auto-arrange unfiled notes",
  bulletify: "Auto-bullet",
  merge: "Merge similar notes",
  summary: "Collection summary",
};

/**
 * Accordion of every prompt task with its editable text fields and reply cap.
 * Edits are kept as a sparse override object ({task: {field: value}}); a field
 * set back to its default drops out of the overrides. Persisted on the modal's
 * Save via `set_prompt_overrides` (which validates placeholders server-side).
 */
function PromptsSection({ onChange }: { onChange: (ov: PromptOverrides) => void }) {
  const [defaults, setDefaults] = useState<Record<string, unknown> | null>(null);
  const [overrides, setOverrides] = useState<PromptOverrides>({});
  const [openTask, setOpenTask] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([api.getPromptDefaults(), api.getPromptOverrides()])
      .then(([d, o]) => {
        setDefaults(d);
        setOverrides((o ?? {}) as PromptOverrides);
      })
      .catch((e) => useStore.getState().toast(String(e), "error"));
  }, []);

  if (!defaults) return null;

  const tasks = Object.entries(defaults).filter(
    (e): e is [string, Record<string, unknown>] =>
      typeof e[1] === "object" && e[1] !== null,
  );

  const update = (next: PromptOverrides) => {
    setOverrides(next);
    onChange(next);
  };

  const setField = (
    task: string,
    field: string,
    value: string | number,
    def: string | number,
  ) => {
    const next: PromptOverrides = { ...overrides, [task]: { ...(overrides[task] ?? {}) } };
    if (value === def) {
      delete next[task][field];
      if (Object.keys(next[task]).length === 0) delete next[task];
    } else {
      next[task][field] = value;
    }
    update(next);
  };

  const resetTask = (task: string) => {
    const next = { ...overrides };
    delete next[task];
    update(next);
  };

  return (
    <div className="space-y-1.5">
      {tasks.map(([key, def]) => {
        const fields = Object.entries(def).filter(
          (e): e is [string, string] => typeof e[1] === "string" && e[0] !== "schema_name",
        );
        const modified = key in overrides;
        const expanded = openTask === key;
        return (
          <div key={key} className="rounded-lg border border-stone-800">
            <button
              onClick={() => setOpenTask(expanded ? null : key)}
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs text-stone-300 transition-colors hover:text-stone-100"
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {PROMPT_TASK_LABELS[key] ?? key}
              {modified && (
                <span className="rounded-full bg-clay-950 px-1.5 py-px text-[9px] font-medium text-clay-300">
                  customized
                </span>
              )}
              {modified && (
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    resetTask(key);
                  }}
                  className="ml-auto text-[10px] text-stone-500 hover:text-stone-300"
                >
                  reset to defaults
                </span>
              )}
            </button>
            {expanded && (
              <div className="space-y-2 px-3 pb-3">
                {fields.map(([field, defVal]) => {
                  const cur = (overrides[key]?.[field] as string | undefined) ?? defVal;
                  return (
                    <Field key={field} label={field.replace(/_/g, " ")}>
                      <textarea
                        value={cur}
                        rows={Math.min(8, Math.max(2, Math.ceil(defVal.length / 90)))}
                        onChange={(e) => setField(key, field, e.target.value, defVal)}
                        spellCheck={false}
                        className={inputCls + " w-full resize-y font-mono text-[11px] leading-relaxed"}
                      />
                    </Field>
                  );
                })}
                {typeof def.max_tokens === "number" && (
                  <Field label="max tokens (reply length cap)">
                    <input
                      type="number"
                      min={16}
                      max={8192}
                      value={
                        (overrides[key]?.max_tokens as number | undefined) ??
                        (def.max_tokens as number)
                      }
                      onChange={(e) =>
                        setField(
                          key,
                          "max_tokens",
                          Math.min(8192, Math.max(16, Number(e.target.value) || 16)),
                          def.max_tokens as number,
                        )
                      }
                      className={inputCls + " w-28"}
                    />
                  </Field>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-[10px] font-medium text-stone-500">{label}</span>
      {children}
    </label>
  );
}
