import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { Download, FolderOpen, Loader2, RefreshCw, X, Zap } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { THEMES } from "../themes";
import type { AppSettings, DownloadProgress } from "../types";

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

  const save = async (): Promise<boolean> => {
    setSaving(true);
    try {
      await api.setSettings(local);
      useStore.getState().setSettings(local);
      return true;
    } catch (e) {
      useStore.getState().toast(String(e), "error");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    if (!(await save())) return;
    setTesting(true);
    try {
      const reply = await api.testLlm();
      useStore.getState().toast(`LLM replied: ${reply.slice(0, 80)}`, "success");
    } catch (e) {
      useStore.getState().toast(String(e), "error");
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
          </section>

          {/* ---------------- AI Engine (BYOM) ---------------- */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">
              AI Engine &amp; Model Selection
            </h3>
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
              <button onClick={() => void testConnection()} disabled={testing} className={btnCls + " mt-2"}>
                {testing ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                Test connection
              </button>
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

const inputCls =
  "rounded-md border border-stone-700 bg-stone-950 px-2 py-1.5 text-xs text-stone-200 outline-none focus:border-clay-600 w-full";
const btnCls =
  "flex items-center gap-1.5 rounded-md border border-stone-700 px-3 py-1.5 text-xs text-stone-300 hover:border-stone-500 hover:text-stone-100 disabled:opacity-50";

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
