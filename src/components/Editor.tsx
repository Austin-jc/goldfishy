import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor as TiptapEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  Bold,
  Code,
  FileText,
  Heading1,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Loader2,
  Plus,
  Quote,
  Sparkles,
  Strikethrough,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { LocalImage } from "../editor/extensions";
import { isImagePath, relativeTime } from "../utils";

export default function Editor() {
  const noteId = useStore((s) => s.selectedNote?.id);
  if (!noteId) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 text-zinc-600">
        <FileText size={32} />
        <p className="text-sm">Select a note or create a new one</p>
        <button
          onClick={() => void useStore.getState().createNote()}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
        >
          New note
        </button>
      </main>
    );
  }
  return <EditorInner key={noteId} noteId={noteId} />;
}

function EditorInner({ noteId }: { noteId: string }) {
  const note = useStore((s) => s.selectedNote)!;
  const folders = useStore((s) => s.folders);
  const settings = useStore((s) => s.settings);
  const [title, setTitle] = useState(note.title);
  const [aiWorking, setAiWorking] = useState<"" | "bullets" | "organize">("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addingTag, setAddingTag] = useState(false);

  const titleRef = useRef(note.title);
  const contentRef = useRef(note.content);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveNow = useCallback(async () => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    try {
      const updated = await api.updateNote(noteId, titleRef.current, contentRef.current);
      useStore.getState().applyNoteUpdate(updated);
    } catch (e) {
      useStore.getState().toast(`Save failed: ${e}`, "error");
    }
  }, [noteId]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveNow(), 600);
  }, [saveNow]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      LocalImage,
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder: "Start writing… markdown works." }),
      Markdown.configure({ html: false, linkify: true }),
    ],
    content: note.content,
    onUpdate: ({ editor }) => {
      contentRef.current = editor.storage.markdown.getMarkdown();
      scheduleSave();
    },
  });

  // Flush pending edits when the note (or app view) changes.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      void saveNow();
    };
  }, [saveNow]);

  // Drag & drop local images: copy into app storage, embed as relative path.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type !== "drop") return;
      const images = event.payload.paths.filter(isImagePath);
      for (const p of images) {
        try {
          const rel = await api.saveImage(p);
          editor?.chain().focus().setImage({ src: rel }).run();
        } catch (e) {
          useStore.getState().toast(String(e), "error");
        }
      }
    });
    return () => {
      void unlisten.then((u) => u());
    };
  }, [editor]);

  const llmReady = settings?.llm_backend !== "none";
  const suggestedFolder = note.suggested_folder_id
    ? folders.find((f) => f.id === note.suggested_folder_id)
    : null;

  const runBulletify = async () => {
    await saveNow();
    setAiWorking("bullets");
    try {
      const updated = await api.aiBulletify(noteId);
      contentRef.current = updated.content;
      editor?.commands.setContent(updated.content);
      useStore.getState().applyNoteUpdate(updated);
      useStore.getState().toast("Restructured into bullets", "success");
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    } finally {
      setAiWorking("");
    }
  };

  const runOrganize = async () => {
    await saveNow();
    setAiWorking("organize");
    try {
      const updated = await api.aiProcessNote(noteId);
      useStore.getState().applyNoteUpdate(updated);
      void useStore.getState().refreshTags();
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    } finally {
      setAiWorking("");
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      {/* header */}
      <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2">
        <select
          value={note.folder_id ?? ""}
          onChange={async (e) => {
            const updated = await api.moveNote(noteId, e.target.value || null);
            useStore.getState().applyNoteUpdate(updated);
            void useStore.getState().refreshNotes();
          }}
          className="max-w-44 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 outline-none"
        >
          <option value="">No folder</option>
          {folderOptions(folders).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>

        <span className="text-[10px] text-zinc-600">edited {relativeTime(note.updated_at)}</span>

        <span className="ml-auto flex items-center gap-1">
          {llmReady && (
            <>
              <button
                onClick={() => void runBulletify()}
                disabled={aiWorking !== ""}
                title="Auto-bullet: restructure into concise bullet points"
                className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-indigo-700 hover:text-indigo-300 disabled:opacity-50"
              >
                {aiWorking === "bullets" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <List size={12} />
                )}
                Auto-bullet
              </button>
              <button
                onClick={() => void runOrganize()}
                disabled={aiWorking !== ""}
                title="Suggest tags and a destination folder"
                className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-indigo-700 hover:text-indigo-300 disabled:opacity-50"
              >
                {aiWorking === "organize" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Tags size={12} />
                )}
                Organize
              </button>
            </>
          )}
          <button
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                setTimeout(() => setConfirmDelete(false), 2500);
                return;
              }
              dirtyRef.current = false;
              void useStore.getState().deleteNote(noteId);
            }}
            title={confirmDelete ? "Click again to delete" : "Delete note"}
            className={`rounded-md border px-2 py-1 text-[11px] ${
              confirmDelete
                ? "border-red-800 bg-red-950 text-red-300"
                : "border-zinc-700 text-zinc-400 hover:border-red-800 hover:text-red-400"
            }`}
          >
            <Trash2 size={12} />
          </button>
        </span>
      </header>

      {/* AI folder routing suggestion — fades in, never a modal */}
      {suggestedFolder && (
        <div className="fade-in flex items-center gap-2 border-b border-indigo-900/40 bg-indigo-950/30 px-4 py-1.5 text-xs text-zinc-300">
          <Sparkles size={12} className="text-indigo-400" />
          <span>
            AI suggests filing this in <b className="text-indigo-300">{suggestedFolder.name}</b>
          </span>
          <button
            onClick={async () => {
              const updated = await api.acceptFolderSuggestion(noteId);
              useStore.getState().applyNoteUpdate(updated);
              void useStore.getState().refreshNotes();
            }}
            className="ml-2 rounded bg-indigo-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-indigo-500"
          >
            Move
          </button>
          <button
            onClick={async () => {
              const updated = await api.dismissFolderSuggestion(noteId);
              useStore.getState().applyNoteUpdate(updated);
            }}
            className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* title */}
      <input
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          titleRef.current = e.target.value;
          scheduleSave();
        }}
        placeholder="Untitled"
        className="bg-transparent px-6 pb-1 pt-4 text-2xl font-bold text-zinc-100 outline-none placeholder:text-zinc-700"
      />

      {/* tags */}
      <div className="flex flex-wrap items-center gap-1.5 px-6 pb-2">
        {note.tags.map((t) => (
          <span
            key={t.tag}
            className={`fade-in group flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${
              t.source === "ai"
                ? "border border-purple-800/70 text-purple-300"
                : "bg-zinc-800 text-zinc-300"
            }`}
            title={t.source === "ai" ? "Suggested by AI" : "Manual tag"}
          >
            {t.source === "ai" && <Sparkles size={9} />}
            {t.tag}
            <button
              onClick={async () => {
                const updated = await api.removeTag(noteId, t.tag);
                useStore.getState().applyNoteUpdate(updated);
                void useStore.getState().refreshTags();
              }}
              className="hidden text-zinc-500 hover:text-red-400 group-hover:inline"
            >
              <X size={9} />
            </button>
          </span>
        ))}
        {addingTag ? (
          <input
            autoFocus
            onBlur={() => setAddingTag(false)}
            onKeyDown={async (e) => {
              if (e.key === "Escape") setAddingTag(false);
              if (e.key === "Enter") {
                const v = (e.target as HTMLInputElement).value.trim();
                if (v) {
                  const updated = await api.addTag(noteId, v);
                  useStore.getState().applyNoteUpdate(updated);
                  void useStore.getState().refreshTags();
                }
                setAddingTag(false);
              }
            }}
            placeholder="tag name"
            className="w-24 rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-200 outline-none"
          />
        ) : (
          <button
            onClick={() => setAddingTag(true)}
            className="flex items-center gap-0.5 rounded-full border border-dashed border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
          >
            <Plus size={9} /> tag
          </button>
        )}
      </div>

      {/* toolbar */}
      {editor && <Toolbar editor={editor} />}

      {/* content */}
      <div
        className="flex-1 overflow-y-auto px-6 py-3"
        onClick={() => editor?.chain().focus().run()}
      >
        <EditorContent editor={editor} className="h-full" />
      </div>
    </main>
  );
}

function folderOptions(folders: { id: string; name: string; parent_id: string | null }[]) {
  const out: { id: string; label: string }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.filter((x) => x.parent_id === parent)) {
      out.push({ id: f.id, label: `${"  ".repeat(depth)}${f.name}` });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function Toolbar({ editor }: { editor: TiptapEditor }) {
  const Btn = ({
    active,
    onClick,
    title,
    children,
  }: {
    active?: boolean;
    onClick: () => void;
    title: string;
    children: React.ReactNode;
  }) => (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      className={`rounded p-1.5 ${
        active ? "bg-indigo-600/30 text-indigo-300" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );

  return (
    <div className="flex items-center gap-0.5 border-y border-zinc-800/70 px-5 py-0.5">
      <Btn
        title="Bold"
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold size={13} />
      </Btn>
      <Btn
        title="Italic"
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic size={13} />
      </Btn>
      <Btn
        title="Strikethrough"
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough size={13} />
      </Btn>
      <span className="mx-1 h-4 w-px bg-zinc-800" />
      <Btn
        title="Heading 1"
        active={editor.isActive("heading", { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        <Heading1 size={13} />
      </Btn>
      <Btn
        title="Heading 2"
        active={editor.isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 size={13} />
      </Btn>
      <span className="mx-1 h-4 w-px bg-zinc-800" />
      <Btn
        title="Bullet list"
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List size={13} />
      </Btn>
      <Btn
        title="Numbered list"
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered size={13} />
      </Btn>
      <Btn
        title="Quote"
        active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote size={13} />
      </Btn>
      <Btn
        title="Code block"
        active={editor.isActive("codeBlock")}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      >
        <Code size={13} />
      </Btn>
      <span className="ml-auto text-[10px] text-zinc-700">
        drag &amp; drop images · markdown syntax supported
      </span>
    </div>
  );
}
