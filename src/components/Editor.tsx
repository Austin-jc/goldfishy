import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  BubbleMenu,
  EditorContent,
  useEditor,
  useEditorState,
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
  ChevronUp,
  Code,
  FileText,
  Folder as FolderIcon,
  Heading1,
  Heading2,
  History,
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
  Search,
  Sparkles,
  SquareCode,
  StickyNote,
  Strikethrough,
  Tags,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { LocalImage, toggleUnifiedCodeBlock } from "../editor/extensions";
import { findTermRanges, TermHighlight } from "../editor/highlight";
import { SlashCommands } from "../editor/slash";
import {
  absoluteTime,
  collapseDiffContext,
  diffLines,
  isImagePath,
  noteDisplayTitle,
  relativeTime,
} from "../utils";
import type { DiffLine } from "../utils";
import ContextMenu from "./ContextMenu";
import { Copy } from "lucide-react";
import type { Note, NoteVersionMeta } from "../types";

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

/**
 * Live width of an element, so the header can shed labels before it overflows
 * under the action panel. A CSS container query can't do this here: inline-size
 * containment would re-anchor the `fixed inset-0` click-away backdrops of the
 * folder/history popovers to the header instead of the viewport.
 */
function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(Number.MAX_SAFE_INTEGER);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Header width below which the AI buttons go icon-only / the timestamp hides. */
const HEADER_LABELS_MIN = 700;
const HEADER_EDITED_MIN = 520;

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
  const [findOpen, setFindOpen] = useState(false);
  /** Proposed AI rewrite awaiting keep/discard; nothing is saved until Keep. */
  const [rewriteProposal, setRewriteProposal] = useState<string | null>(null);
  /** Right-click menu over a text selection (turn it into an action item). */
  const [selMenu, setSelMenu] = useState<{ x: number; y: number; text: string } | null>(null);

  const titleRef = useRef(note.title);
  const contentRef = useRef(note.content);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<TiptapEditor | null>(null);

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
    // Markdown is serialized once per save, not per keystroke (typing latency
    // grows with note size otherwise). Tiptap only destroys the editor a tick
    // after unmount, so the unmount flush still sees a live instance.
    const ed = editorRef.current;
    if (ed && !ed.isDestroyed) {
      contentRef.current = ed.storage.markdown.getMarkdown();
    }
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
      Placeholder.configure({
        placeholder: "Start writing… markdown works, “/” inserts blocks.",
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ html: false, linkify: true }),
      TermHighlight,
      SlashCommands,
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
    onUpdate: () => scheduleSave(),
    // Don't re-render the whole editor pane per keystroke; the few spots
    // that need live transaction state subscribe via useEditorState.
    shouldRerenderOnTransaction: false,
  });
  editorRef.current = editor;

  // Flush pending edits when the note (or app view) changes.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      void saveNow();
    };
  }, [saveNow]);

  // While a keyword search is active, highlight its terms in the open note
  // and jump to the first hit — so a clicked result lands in context.
  // The find bar owns the highlights while it's open.
  const searchQuery = useStore((s) => s.searchQuery);
  const searchMode = useStore((s) => s.searchMode);
  const searchActive = useStore((s) => s.searchResults !== null);
  useEffect(() => {
    if (!editor || findOpen) return;
    // Smart mode highlights like keyword — semantic-only matches simply have
    // no term hits to mark.
    const terms =
      searchActive && searchMode !== "semantic"
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
  }, [editor, searchQuery, searchMode, searchActive, findOpen]);

  // ⌘F opens the in-note find bar (⌘⇧F is focus mode, handled app-wide).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

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

  // Right-click on a text selection → custom menu (action item, copy).
  // Caret right-clicks and clicks outside the editor keep the native menu.
  const onEditorContextMenu = (e: React.MouseEvent) => {
    if (!editor || !editor.view.dom.contains(e.target as Node)) return;
    const { from, to, empty } = editor.state.selection;
    if (empty) return;
    const text = editor.state.doc.textBetween(from, to, " ").trim();
    if (!text) return;
    e.preventDefault();
    setSelMenu({ x: e.clientX, y: e.clientY, text });
  };

  // A selection → a text sticky in the Inbox (the note is untouched).
  const stickSelection = async (text: string) => {
    const sticky = await useStore.getState().createSticky("", "yellow", 0, 0, false);
    if (!sticky) return;
    await useStore.getState().saveSticky(sticky.id, { text });
    useStore.getState().toast("Stuck to the wall — it's in the Inbox", "success", {
      label: "Open wall",
      run: () => {
        const st = useStore.getState();
        st.setBoardMode("wall");
        st.setBoardOpen(true);
      },
    });
  };

  const addSelectionAction = async (text: string) => {
    // Same cap the AI extraction applies to action texts.
    const chars = Array.from(text);
    const capped = chars.length > 200 ? chars.slice(0, 200).join("") + "…" : text;
    try {
      await api.createActionItem(capped, null, null, noteId);
      useStore.getState().toast("Action item added", "success", {
        label: "View",
        run: () => useStore.getState().setActionsOpen(true),
      });
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
  };

  const runBulletify = async () => {
    await saveNow();
    setAiWorking("bullets");
    try {
      // Preview only — the note is untouched until the user clicks Keep.
      setRewriteProposal(await api.aiBulletifyPreview(noteId));
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    } finally {
      setAiWorking("");
    }
  };

  const keepRewrite = async () => {
    if (rewriteProposal === null) return;
    try {
      const updated = await api.applyNoteRewrite(noteId, rewriteProposal);
      contentRef.current = updated.content;
      editor?.commands.setContent(updated.content);
      useStore.getState().applyNoteUpdate(updated);
      useStore.getState().toast(
        "Restructured into bullets — the previous version is in History",
        "success",
      );
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    } finally {
      setRewriteProposal(null);
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

  const [headerRef, headerWidth] = useElementWidth<HTMLElement>();
  const showLabels = headerWidth >= HEADER_LABELS_MIN;
  const showEdited = headerWidth >= HEADER_EDITED_MIN;

  const ghostBtn =
    "flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[11px] text-stone-400 transition-colors hover:bg-stone-900 hover:text-stone-200 disabled:opacity-50";
  // AI actions get real button affordances (resting tint, hover fill, pressed
  // state) in the sage "AI" accent, inside a ringed cluster — see header below.
  const aiBtn =
    "flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md py-1 text-[11px] text-stone-300 transition-colors hover:bg-sage-900/40 hover:text-sage-200 active:bg-sage-900/60 disabled:opacity-50 " +
    (showLabels ? "px-2" : "px-1.5");

  return (
    <main className="relative flex min-w-0 flex-1 flex-col">
      {findOpen && editor && (
        <FindBar editor={editor} onClose={() => setFindOpen(false)} />
      )}
      {/* header — borderless, recedes behind the canvas */}
      <header ref={headerRef} className="flex items-center gap-2 px-5 pb-1 pt-3">
        <FolderPicker noteId={noteId} folderId={note.folder_id} />

        {showEdited && (
          <span
            className="whitespace-nowrap text-[10px] text-stone-600"
            title={`Created ${absoluteTime(note.created_at)} · edited ${absoluteTime(note.updated_at)}`}
          >
            edited {relativeTime(note.updated_at)}
          </span>
        )}

        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {llmReady && (
            <span className="mr-1 flex items-center rounded-lg p-0.5 ring-1 ring-stone-800">
              <Sparkles size={11} className="mx-1 shrink-0 text-sage-400" />
              <button
                onClick={() => void runBulletify()}
                disabled={aiWorking !== ""}
                title="Auto-bullet: restructure into concise bullet points"
                className={aiBtn}
              >
                {aiWorking === "bullets" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <List size={12} />
                )}
                {showLabels && "Auto-bullet"}
              </button>
              <button
                onClick={() => void runOrganize()}
                disabled={aiWorking !== ""}
                title="Organize: suggest tags and a destination folder"
                className={aiBtn}
              >
                {aiWorking === "organize" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Tags size={12} />
                )}
                {showLabels && "Organize"}
              </button>
              <button
                onClick={() => void runActions()}
                disabled={aiWorking !== ""}
                title="Extract action items & follow-ups from this note"
                className={aiBtn}
              >
                {aiWorking === "actions" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <ListChecks size={12} />
                )}
                {showLabels && "Extract actions"}
              </button>
            </span>
          )}
          <HistoryPopover
            noteId={noteId}
            onRestored={(updated) => {
              titleRef.current = updated.title;
              contentRef.current = updated.content;
              setTitle(updated.title);
              editor?.commands.setContent(updated.content);
              useStore.getState().applyNoteUpdate(updated);
            }}
          />
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
                setTimeout(() => setConfirmDelete(false), 4000);
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
        onContextMenu={onEditorContextMenu}
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
      {editor && <EditorStats editor={editor} />}

      {selMenu && (
        <ContextMenu
          x={selMenu.x}
          y={selMenu.y}
          onClose={() => setSelMenu(null)}
          items={[
            {
              label: "Add as action item",
              icon: <ListChecks size={13} />,
              onClick: () => void addSelectionAction(selMenu.text),
            },
            {
              label: "Stick to wall",
              icon: <StickyNote size={13} />,
              onClick: () => void stickSelection(selMenu.text),
            },
            {
              label: "Copy",
              icon: <Copy size={13} />,
              onClick: () => void navigator.clipboard.writeText(selMenu.text),
            },
          ]}
        />
      )}

      {rewriteProposal !== null && (
        <RewritePreview
          proposal={rewriteProposal}
          onKeep={() => void keepRewrite()}
          onDiscard={() => setRewriteProposal(null)}
        />
      )}
    </main>
  );
}

/** Review panel for an AI rewrite — sage-framed (AI-derived), nothing is
 *  written until Keep. Esc discards. */
function RewritePreview({
  proposal,
  onKeep,
  onDiscard,
}: {
  proposal: string;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDiscard();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onDiscard]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDiscard();
      }}
    >
      <div className="flex max-h-[80vh] w-[640px] flex-col overflow-hidden rounded-xl border border-sage-700/60 bg-stone-900 shadow-2xl shadow-black/60">
        <div className="flex items-center gap-2 px-4 pb-2 pt-3">
          <Sparkles size={14} className="text-sage-300" />
          <span className="text-sm font-semibold text-stone-100">Auto-bullet preview</span>
          <span className="ml-auto text-[10px] text-stone-500">
            Keep replaces the note body — the current version is checkpointed first
          </span>
        </div>
        <div className="mx-3 flex-1 overflow-y-auto rounded-lg bg-sage-900/20 px-4 py-3">
          <pre className="whitespace-pre-wrap font-[inherit] text-[13px] leading-relaxed text-stone-200">
            {proposal}
          </pre>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3">
          <button
            onClick={onDiscard}
            className="cursor-pointer rounded-lg px-3 py-1.5 text-xs text-stone-400 transition-colors hover:bg-stone-800 hover:text-stone-200"
          >
            Discard (esc)
          </button>
          <button
            onClick={onKeep}
            className="cursor-pointer rounded-lg bg-sage-700 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sage-500"
          >
            Keep
          </button>
        </div>
      </div>
    </div>
  );
}

/** Version history popover — checkpoints accrue as you edit; click to restore. */
function HistoryPopover({
  noteId,
  onRestored,
}: {
  noteId: string;
  onRestored: (note: Note) => void;
}) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<NoteVersionMeta[]>([]);
  /** Version whose diff against the current note is expanded inline. */
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffLine[] | null>(null);
  const createdAt = useStore((s) => s.selectedNote?.created_at);

  useEffect(() => {
    if (!open) return;
    setDiffFor(null);
    setDiff(null);
    void api
      .listNoteVersions(noteId)
      .then(setVersions)
      .catch(() => setVersions([]));
  }, [open, noteId]);

  // Reviewing the change is the confirmation step: a row click shows what
  // restoring would do; only the button inside the diff actually restores.
  const showDiff = async (versionId: string) => {
    if (diffFor === versionId) {
      setDiffFor(null);
      setDiff(null);
      return;
    }
    try {
      const full = await api.getNoteVersion(versionId);
      const current = useStore.getState().selectedNote?.content ?? "";
      setDiff(diffLines(current, full.content));
      setDiffFor(versionId);
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
  };

  const restore = async (versionId: string) => {
    try {
      const updated = await api.restoreNoteVersion(versionId);
      setOpen(false);
      onRestored(updated);
      useStore.getState().toast("Version restored — the previous state was checkpointed", "success");
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        title="Version history"
        className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] transition-colors hover:bg-stone-900 ${
          open ? "bg-stone-900 text-stone-200" : "text-stone-400 hover:text-stone-200"
        }`}
      >
        <History size={12} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            className={`absolute right-0 top-full z-30 mt-1 max-h-96 overflow-y-auto rounded-xl border border-stone-800 bg-stone-900 p-1 shadow-2xl shadow-black/40 ${
              diffFor ? "w-[26rem]" : "w-72"
            }`}
          >
            <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-stone-500">
              Version history
            </p>
            {versions.map((v) => (
              <div key={v.id}>
                <button
                  onClick={() => void showDiff(v.id)}
                  className={`block w-full cursor-pointer rounded-lg px-2.5 py-2 text-left transition-colors ${
                    diffFor === v.id ? "bg-stone-800/70" : "hover:bg-stone-800/70"
                  }`}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-xs text-stone-200">
                      {v.title || "Untitled"}
                    </span>
                    <span className="ml-auto shrink-0 text-[9px] text-stone-600">
                      {relativeTime(v.created_at)}
                    </span>
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-[10px] text-stone-500">
                    {diffFor === v.id
                      ? "What restoring this version would change:"
                      : v.preview || "(empty)"}
                  </span>
                </button>
                {diffFor === v.id && diff && (
                  <div className="mx-1 mb-1 rounded-lg bg-stone-950/60 p-1.5">
                    {diff.every((l) => l.kind === "same") ? (
                      <p className="px-1 py-1 text-[10px] italic text-stone-600">
                        Identical to the current note
                      </p>
                    ) : (
                      <div className="max-h-48 overflow-y-auto font-mono text-[10px] leading-relaxed">
                        {collapseDiffContext(diff).map((l, i) =>
                          l.kind === "skip" ? (
                            <p key={i} className="px-1.5 py-0.5 text-center text-stone-700">
                              ⋯ {l.count} unchanged line{l.count === 1 ? "" : "s"} ⋯
                            </p>
                          ) : (
                            <p
                              key={i}
                              className={`whitespace-pre-wrap break-words rounded px-1.5 ${
                                l.kind === "del"
                                  ? "bg-red-950/40 text-red-300"
                                  : l.kind === "add"
                                    ? "bg-sage-900/40 text-sage-300"
                                    : "text-stone-500"
                              }`}
                            >
                              {l.kind === "del" ? "− " : l.kind === "add" ? "+ " : "  "}
                              {l.text || " "}
                            </p>
                          ),
                        )}
                      </div>
                    )}
                    <button
                      onClick={() => void restore(v.id)}
                      className="mt-1.5 flex w-full cursor-pointer items-center justify-center gap-1 rounded-lg bg-clay-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-clay-500"
                    >
                      <Undo2 size={11} />
                      Restore this version
                    </button>
                  </div>
                )}
              </div>
            ))}
            {versions.length === 0 && (
              <p className="px-2.5 py-3 text-center text-[11px] text-stone-600">
                No checkpoints yet — they accumulate as you edit.
              </p>
            )}
            {createdAt != null && (
              <p className="mt-1 border-t border-stone-800/70 px-2.5 pb-1.5 pt-2 text-[10px] text-stone-600">
                Note created {absoluteTime(createdAt)}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Floating ⌘F find bar — highlights matches, Enter / Shift-Enter cycles. */
function FindBar({ editor, onClose }: { editor: TiptapEditor; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Subscribed, not read at render: the pane no longer re-renders per
  // transaction, and edits while the bar is open must keep the count honest.
  const count =
    useEditorState({
      editor,
      selector: ({ editor: e }) =>
        query ? findTermRanges(e.state.doc, [query]).length : 0,
    }) ?? 0;

  const apply = (q: string, idx: number) => {
    editor.commands.setHighlightTerms(q ? [q] : [], idx);
    const range = q ? findTermRanges(editor.state.doc, [q])[idx] : undefined;
    if (range) editor.chain().setTextSelection(range.from).scrollIntoView().run();
  };

  const onChange = (q: string) => {
    setQuery(q);
    setActive(0);
    apply(q, 0);
  };

  const step = (dir: 1 | -1) => {
    if (count === 0) return;
    const idx = (active + dir + count) % count;
    setActive(idx);
    apply(query, idx);
  };

  return (
    <div className="absolute right-6 top-2 z-30 flex items-center gap-1 rounded-xl border border-stone-800 bg-stone-900 px-2 py-1.5 shadow-2xl shadow-black/50">
      <Search size={12} className="shrink-0 text-stone-500" />
      <input
        autoFocus
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
          if (e.key === "Escape") onClose();
        }}
        placeholder="Find in note…"
        className="w-40 bg-transparent text-xs text-stone-200 outline-none placeholder:text-stone-600"
      />
      <span className="min-w-10 text-right text-[10px] tabular-nums text-stone-500">
        {query ? (count > 0 ? `${active + 1}/${count}` : "0/0") : ""}
      </span>
      <button
        onClick={() => step(-1)}
        title="Previous match (⇧↵)"
        className="cursor-pointer rounded p-1 text-stone-500 hover:bg-stone-800 hover:text-stone-200"
      >
        <ChevronUp size={12} />
      </button>
      <button
        onClick={() => step(1)}
        title="Next match (↵)"
        className="cursor-pointer rounded p-1 text-stone-500 hover:bg-stone-800 hover:text-stone-200"
      >
        <ChevronDown size={12} />
      </button>
      <button
        onClick={onClose}
        title="Close (esc)"
        className="cursor-pointer rounded p-1 text-stone-500 hover:bg-stone-800 hover:text-stone-200"
      >
        <X size={12} />
      </button>
    </div>
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
              {noteDisplayTitle(n)}
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
    // min-w-0 lets the picker shrink (and truncate) before the header overflows.
    <div className="relative min-w-0 max-w-52">
      <button
        onClick={() => setOpen(!open)}
        title="Where this note is filed — click to move it"
        className="flex max-w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-stone-400 transition-colors hover:bg-stone-900 hover:text-stone-200"
      >
        <FolderIcon
          size={12}
          className={"shrink-0 " + (current ? "text-clay-400" : "text-stone-500")}
        />
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

/** Quiet word-count / read-time stat in the editor pane's bottom corner.
 *  Read time appears once a note is long enough for it to mean anything. */
function EditorStats({ editor }: { editor: TiptapEditor }) {
  const words =
    useEditorState({
      editor,
      selector: ({ editor: e }) =>
        e.state.doc
          .textBetween(0, e.state.doc.content.size, " ")
          .split(/\s+/)
          .filter(Boolean).length,
    }) ?? 0;
  if (words === 0) return null;
  const minutes = Math.max(1, Math.round(words / 200));
  return (
    <span className="pointer-events-none absolute bottom-2 right-4 z-10 rounded-md bg-stone-900/80 px-1.5 py-0.5 text-[10px] tabular-nums text-stone-600">
      {words.toLocaleString()} word{words === 1 ? "" : "s"}
      {words >= 200 ? ` · ${minutes} min read` : ""}
    </span>
  );
}

/** Floating contextual toolbar — appears over the current text selection. */
function SelectionMenu({ editor }: { editor: TiptapEditor }) {
  // The editor pane no longer re-renders per transaction
  // (shouldRerenderOnTransaction: false) — subscribe to just the active
  // states this menu shows; deep-equal means no-op transactions don't render.
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      taskList: e.isActive("taskList"),
      blockquote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
    }),
  });

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
          active={on.bold}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold size={13} />
        </Btn>
        <Btn
          title="Italic"
          active={on.italic}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic size={13} />
        </Btn>
        <Btn
          title="Strikethrough"
          active={on.strike}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <Strikethrough size={13} />
        </Btn>
        <Btn
          title="Inline code"
          active={on.code}
          onClick={() => editor.chain().focus().toggleCode().run()}
        >
          <Code size={13} />
        </Btn>
        <span className="mx-1 h-4 w-px bg-stone-800" />
        <Btn
          title="Heading 1"
          active={on.h1}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        >
          <Heading1 size={13} />
        </Btn>
        <Btn
          title="Heading 2"
          active={on.h2}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 size={13} />
        </Btn>
        <span className="mx-1 h-4 w-px bg-stone-800" />
        <Btn
          title="Bullet list"
          active={on.bulletList}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List size={13} />
        </Btn>
        <Btn
          title="Numbered list"
          active={on.orderedList}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered size={13} />
        </Btn>
        <Btn
          title="Task list (checkboxes)"
          active={on.taskList}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
        >
          <ListTodo size={13} />
        </Btn>
        <Btn
          title="Quote"
          active={on.blockquote}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          <Quote size={13} />
        </Btn>
        <Btn
          title="Code block"
          active={on.codeBlock}
          onClick={() => toggleUnifiedCodeBlock(editor)}
        >
          <SquareCode size={13} />
        </Btn>
      </div>
    </BubbleMenu>
  );
}
