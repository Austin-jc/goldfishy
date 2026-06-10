import Image from "@tiptap/extension-image";
import { mergeAttributes, type Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { resolveImageSrc } from "../api";

/**
 * Markdown stores portable relative paths (`images/<uuid>.png`); only the
 * rendered DOM resolves them through Tauri's asset protocol for display.
 */
export const LocalImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    const attrs = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes);
    return ["img", { ...attrs, src: resolveImageSrc(String(attrs.src ?? "")) }];
  },
});

/**
 * Toggle a code block, but unlike Tiptap's default (which converts every
 * selected paragraph into its own code block), a multi-block selection is
 * merged into a single code block, one line per former block.
 */
export function toggleUnifiedCodeBlock(editor: Editor) {
  if (editor.isActive("codeBlock")) {
    editor.chain().focus().toggleCodeBlock().run();
    return;
  }

  const { state } = editor;
  const { from, to } = state.selection;
  const blocks: { pos: number; node: PMNode }[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) {
      blocks.push({ pos, node });
      return false;
    }
    return true;
  });

  if (blocks.length <= 1) {
    editor.chain().focus().toggleCodeBlock().run();
    return;
  }

  const start = blocks[0].pos;
  const last = blocks[blocks.length - 1];
  const end = last.pos + last.node.nodeSize;
  const text = blocks.map((b) => b.node.textContent).join("\n");

  try {
    editor
      .chain()
      .focus()
      .insertContentAt(
        { from: start, to: end },
        { type: "codeBlock", content: text ? [{ type: "text", text }] : undefined },
      )
      .run();
  } catch {
    // Selections that cross exotic structures (e.g. partial lists) can make
    // the single-block replace invalid — fall back to the default behavior.
    editor.chain().focus().toggleCodeBlock().run();
  }
}
