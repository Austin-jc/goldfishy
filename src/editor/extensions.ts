import Image from "@tiptap/extension-image";
import { mergeAttributes } from "@tiptap/react";
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
