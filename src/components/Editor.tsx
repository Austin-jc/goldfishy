import { useCallback, useEffect, useRef, useState } from "react";
import {
  BubbleMenu,
  EditorContent,
  useEditor,
  type Editor as TiptapEditor,
} from "@tiptap/react";
import { isTextSelection } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "tiptap-markdown";
import { common, createLowlight } from "lowlight";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  Bold,
  Check,
  ChevronDown,
  Code,
  FileText,
  Folder as FolderIcon,
  Heading1,
  Heading2,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  ListTodo,
  Loader2,
  Pin,
  PinOff,
  Plus,
  Quote,
  Sparkles,
  SquareCode,
  Strikethrough,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { LocalImage, toggleUnifiedCodeBlock } from "../editor/extensions";
import { findTermRanges, TermHighlight } from "../editor/highlight";
import { isImagePath, relativeTime } from "../utils";
import type { Note } from "../types";

const lowlight = createLowlight(common);

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

const PASTE_EXT: Record<string, string> = { jpeg: "jpg", "svg+xml": "svg" };

export default function Editor() {
  const noteId = useStore((s) => s.selectedNote?.id);
  if (!noteId) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 text-stone-600">
        <FileText size={32} strokeWidth={1.5} />
        <p className="text-sm">Select a note or create a new one</p>
        <button
          onClick={() => void useStore.getState().createNote()}
          className="cursor-pointer rounded-lg bg-clay-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-clay-500"
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
  const [aiWorking, setAiWorking] = useState<"" | "bullets" | "organize" | "actions">("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addingTag, setAddingTag] = useState(false);

  const titleRef = useRef(note.title);
  const contentRef = useRef(note.content);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // A brand-new note starts in the title field.
  useEffect(() => {
    if (!note.title && !note.content) titleInputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Adopt an AI-generated title (the worker auto-titles untitled notes) as
  // long as the user hasn't typed one locally — otherwise the next autosave
  // would silently wipe it back to empty.
  useEffect(() => {
    if (note.title && titleRef.current.trim() === "") {
      setTitle(note.title);
      titleRef.current = note.title;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.title]);

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
      StarterKit.configure({ codeBlock: false }),
      CodeBlockLowlight.configure({ lowlight }),
      LocalImage,
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder: "Start writing… markdown works." }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ html: false, linkify: true }),
      TermHighlight,
    ],
    content: note.content,
    editorProps: {
      // ⌘V of image data (screenshots, copied images) saves into app
      // storage and embeds, same as drag-drop.
      handlePaste: (view, event) => {
        const item = Array.from(event.clipboardData?.items ?? []).find((i) =>
          i.type.startsWith("image/"),
        );
        const file = item?.getAsFile();
        if (!item || !file) return false;
        event.preventDefault();
        void (async () => {
          try {
            const subtype = item.type.split("/")[1] || "png";
            const ext = PASTE_EXT[subtype] ?? subtype;
            const rel = await api.saveImageBytes(bufToBase64(await file.arrayBuffer()), ext);
            const node = view.state.schema.nodes.image.create({ src: rel });
            view.dispatch(view.state.tr.replaceSelectionWith(node));
          } catch (e) {
            useStore.getState().toast(String(e), "error");
          }
        })();
        return true;
      },
    },
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

  // While a keyword search is active, highlight its terms in the open note
  // and jump to the first hit — so a clicked result lands in context.
  const searchQuery = useStore((s) => s.searchQuery);
  const searchMode = useStore((s) => s.searchMode);
  const searchActive = useStore((s) => s.searchResults !== null);
  useEffect(() => {
    if (!editor) return;
    const terms =
      searchActive && searchMode === "keyword"
        ? searchQuery
            .split(/\s+/)
            .map((t) => t.replace(/^"+|"+$/g, ""))
            .filter((t) => t.length >= 2)
        : [];
    editor.commands.setHighlightTerms(terms);
    if (terms.length > 0) {
      const first = findTermRanges(editor.state.doc, terms)[0];
      // No focus() here — stealing focus from the search bar would be rude.
      if (first) editor.chain().setTextSelection(first.from).scrollIntoView().run();
    }
  }, [editor, searchQuery, searchMode, searchActive]);

  // Drag & drop local images: copy into app storage, embed as relative path.
  // The Tauri event carries the pointer position (physical px), so the image
  // lands where it was dropped — not wherever the cursor happened to be.
  useEffect(() => {
    if (!editor) return;
    const docPosAt = (position: { x: number; y: number }): number | null => {
      const scale = window.devicePixelRatio || 1;
      const found = editor.view.posAtCoords({
        left: position.x / scale,
        top: position.y / scale,
      });
      return found ? found.pos : null;
    };
    const unlisten = getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type === "over") {
        // Live caret feedback while hovering a drag over the text.
        const pos = docPosAt(event.payload.position);
        if (pos !== null) editor.chain().focus().setTextSelection(pos).run();
        return;
      }
      if (event.payload.type !== "drop") return;
      const images = event.payload.paths.filter(isImagePath);
      if (images.length === 0) return;
      const pos = docPosAt(event.payload.position);
      if (pos !== null) editor.chain().focus().setTextSelection(pos).run();
      for (const p of images) {
        try {
          const rel = await api.saveImage(p);
          editor.chain().focus().setImage({ src: rel }).run();
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

  const runActions = async () => {
    await saveNow();
    setAiWorking("actions");
    try {
      const found = await api.extractActions(noteId);
      await useStore.getState().refreshActions();
      useStore.getState().setActionsOpen(true);
      useStore.getState().toast(
        found.length
          ? `${found.length} action item${found.length === 1 ? "" : "s"} proposed`
          : "No open action items found",
        "success",
      );
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    } finally {
      setAiWorking("");
    }
  };

  const ghostBtn =
    "flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] text-stone-400 transition-colors hover:bg-stone-900 hover:text-stone-200 disabled:opacity-50";

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      {/* header — borderless, recedes behind the canvas */}
      <header className="flex items-center gap-2 px-5 pb-1 pt-3">
        <FolderPicker noteId={noteId} folderId={note.folder_id} />

        <span className="text-[10px] text-stone-600">edited {relativeTime(note.updated_at)}</span>

        <span className="ml-auto flex items-center gap-0.5">
          {llmReady && (
            <>
              <button
                onClick={() => void runBulletify()}
                disabled={aiWorking !== ""}
                title="Auto-bullet: restructure into concise bullet points"
                className={ghostBtn + " hover:text-clay-300"}
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
                className={ghostBtn + " hover:text-clay-300"}
              >
                {aiWorking === "organize" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Tags size={12} />
                )}
                Organize
              </button>
              <button
                onClick={() => void runActions()}
                disabled={aiWorking !== ""}
                title="Extract action items & follow-ups from this note"
                className={ghostBtn + " hover:text-clay-300"}
              >
                {aiWorking === "actions" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <ListChecks size={12} />
                )}
                Actions
              </button>
            </>
          )}
          <button
            onClick={async () => {
              try {
                const updated = await api.setNotePinned(noteId, !note.pinned);
                useStore.getState().applyNoteUpdate(updated);
              } catch (e) {
                useStore.getState().toast(String(e), "error");
              }
            }}
            title={note.pinned ? "Unpin note" : "Pin note to the top of the sidebar"}
            className={ghostBtn + (note.pinned ? " text-clay-400" : "")}
          >
            {note.pinned ? <PinOff size={12} /> : <Pin size={12} />}
          </button>
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
            className={
              confirmDelete
                ? "flex cursor-pointer items-center rounded-lg bg-red-950/80 px-2.5 py-1.5 text-[11px] text-red-300"
                : ghostBtn + " hover:text-red-400"
            }
          >
            <Trash2 size={12} />
          </button>
        </span>
      </header>

      {/* AI folder routing suggestion — fades in, never a modal */}
      {suggestedFolder && (
        <div className="fade-in mx-5 mb-1 flex items-center gap-2 rounded-lg bg-sage-900/40 px-3 py-1.5 text-xs text-stone-300">
          <Sparkles size={12} className="text-sage-300" />
          <span>
            AI suggests filing this in <b className="text-sage-200">{suggestedFolder.name}</b>
          </span>
          <button
            onClick={async () => {
              const updated = await api.acceptFolderSuggestion(noteId);
              useStore.getState().applyNoteUpdate(updated);
              void useStore.getState().refreshNotes();
            }}
            className="ml-2 cursor-pointer rounded-md bg-sage-700 px-2 py-0.5 text-[10px] font-medium text-white transition-colors hover:bg-sage-500"
          >
            Move
          </button>
          <button
            onClick={async () => {
              const updated = await api.dismissFolderSuggestion(noteId);
              useStore.getState().applyNoteUpdate(updated);
            }}
            className="cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-stone-500 hover:text-stone-300"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* canvas — a single centered column; whitespace does the dividing */}
      <div
        className="flex-1 overflow-y-auto"
        onClick={(e) => {
          if (e.target === e.currentTarget) editor?.chain().focus().run();
        }}
      >
        <div className="mx-auto w-full max-w-3xl px-10 pt-8">
          <input
            ref={titleInputRef}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              titleRef.current = e.target.value;
              scheduleSave();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || (e.key === "ArrowDown" && !e.shiftKey)) {
                e.preventDefault();
                editor?.chain().focus("start").run();
              }
            }}
            placeholder="Untitled"
            className="w-full bg-transparent pb-2 text-[1.7rem] font-bold tracking-tight text-stone-100 outline-none placeholder:text-stone-700"
          />

          {/* tags */}
          <div className="flex flex-wrap items-center gap-1.5 pb-7">
            {note.tags.map((t) => (
              <span
                key={t.tag}
                className={`fade-in group flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${
                  t.source === "ai"
                    ? "border border-sage-700/70 text-sage-300"
                    : "bg-stone-800/80 text-stone-300"
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
                  className="hidden cursor-pointer text-stone-500 hover:text-red-400 group-hover:inline"
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
                className="w-24 rounded-full bg-stone-900 px-2.5 py-0.5 text-[10px] text-stone-200 outline-none ring-1 ring-stone-700"
              />
            ) : (
              <button
                onClick={() => setAddingTag(true)}
                className="flex cursor-pointer items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] text-stone-600 transition-colors hover:bg-stone-900 hover:text-stone-300"
              >
                <Plus size={9} /> tag
              </button>
            )}
          </div>

          <EditorContent editor={editor} />
          <RelatedNotes noteId={noteId} />
          {/* generous click target below the text to keep writing */}
          <div
            className="h-40"
            onClick={() => editor?.chain().focus("end").run()}
          />
        </div>
      </div>

      {editor && <SelectionMenu editor={editor} />}
    </main>
  );
}

/** The most similar notes (by embedding), surfaced quietly under the text. */
function RelatedNotes({ noteId }: { noteId: string }) {
  const embStatus = useStore((s) => s.selectedNote?.embedding_status);
  const [related, setRelated] = useState<Note[]>([]);

  // Re-query when the note re-embeds, so the list tracks content changes.
  useEffect(() => {
    let cancelled = false;
    void api
      .relatedNotes(noteId)
      .then((r) => {
        if (!cancelled) setRelated(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [noteId, embStatus]);

  if (related.length === 0) return null;
  return (
    <div className="fade-in mt-12">
      <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-stone-600">
        <Sparkles size={10} className="text-sage-500" />
        Related notes
      </p>
      <div className="mt-1 space-y-0.5">
        {related.map((n) => (
          <button
            key={n.id}
            onClick={() => void useStore.getState().selectNote(n.id)}
            className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-stone-900"
          >
            <FileText size={12} className="shrink-0 text-stone-600" />
            <span className="truncate text-xs text-stone-300">
              {n.title || "Untitled"}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {typeof n.score === "number" && (
                <span className="rounded bg-stone-900 px-1 text-[9px] text-stone-500">
                  {(n.score * 100).toFixed(0)}%
                </span>
              )}
              <span className="text-[9px] text-stone-600">
                {relativeTime(n.updated_at)}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Shows where the note is filed; click to move it to another folder. */
function FolderPicker({ noteId, folderId }: { noteId: string; folderId: string | null }) {
  const folders = useStore((s) => s.folders);
  const [open, setOpen] = useState(false);
  const current = folderId ? folders.find((f) => f.id === folderId) : null;

  const move = async (target: string | null) => {
    setOpen(false);
    if (target === folderId) return;
    try {
      const updated = await api.moveNote(noteId, target);
      useStore.getState().applyNoteUpdate(updated);
      void useStore.getState().refreshNotes();
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        title="Where this note is filed — click to move it"
        className="flex max-w-52 cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-stone-400 transition-colors hover:bg-stone-900 hover:text-stone-200"
      >
        <FolderIcon size={12} className={current ? "text-clay-400" : "text-stone-500"} />
        <span className="truncate">{current ? current.name : "No folder"}</span>
        <ChevronDown size={11} className="shrink-0 text-stone-600" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-56 overflow-y-auto rounded-xl border border-stone-800 bg-stone-900 p-1 shadow-2xl shadow-black/40">
            <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-stone-500">
              Move note to
            </p>
            <FolderMenuItem active={!current} onClick={() => void move(null)}>
              No folder
            </FolderMenuItem>
            {folderOptions(folders).map((o) => (
              <FolderMenuItem
                key={o.id}
                active={folderId === o.id}
                onClick={() => void move(o.id)}
              >
                {o.label}
              </FolderMenuItem>
            ))}
            {folders.length === 0 && (
              <p className="px-2.5 py-2 text-[11px] text-stone-600">
                No folders yet — create one in the sidebar.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function FolderMenuItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-1.5 whitespace-pre rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
        active ? "bg-clay-600/15 text-clay-300" : "text-stone-300 hover:bg-stone-800/70"
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {active && <Check size={11} className="shrink-0" />}
    </button>
  );
}

function folderOptions(folders: { id: string; name: string; parent_id: string | null }[]) {
  const out: { id: string; label: string }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.filter((x) => x.parent_id === parent)) {
      out.push({ id: f.id, label: `${"  ".repeat(depth)}${f.name}` });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Floating contextual toolbar — appears over the current text selection. */
function SelectionMenu({ editor }: { editor: TiptapEditor }) {
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
      className={`cursor-pointer rounded-md p-1.5 transition-colors ${
        active
          ? "bg-clay-600/25 text-clay-300"
          : "text-stone-400 hover:bg-stone-800 hover:text-stone-100"
      }`}
    >
      {children}
    </button>
  );

  return (
    <BubbleMenu
      editor={editor}
      tippyOptions={{ duration: 120, maxWidth: "none" }}
      shouldShow={({ editor, state, from, to }) => {
        if (!editor.isEditable || state.selection.empty) return false;
        if (!isTextSelection(state.selection)) return false;
        return state.doc.textBetween(from, to).trim().length > 0;
      }}
    >
      <div className="flex items-center gap-0.5 rounded-xl border border-stone-800 bg-stone-900 p-1 shadow-2xl shadow-black/60">
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
        <Btn
          title="Inline code"
          active={editor.isActive("code")}
          onClick={() => editor.chain().focus().toggleCode().run()}
        >
          <Code size={13} />
        </Btn>
        <span className="mx-1 h-4 w-px bg-stone-800" />
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
        <span className="mx-1 h-4 w-px bg-stone-800" />
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
          title="Task list (checkboxes)"
          active={editor.isActive("taskList")}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
        >
          <ListTodo size={13} />
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
          onClick={() => toggleUnifiedCodeBlock(editor)}
        >
          <SquareCode size={13} />
        </Btn>
      </div>
    </BubbleMenu>
  );
}
