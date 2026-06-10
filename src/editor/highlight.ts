import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Inline decorations for term highlighting — used both by "opened a note
 * from keyword search" and the ⌘F find bar. Decorations live outside the
 * document, so they never dirty the note or the undo history.
 */

interface HighlightPluginState {
  terms: string[];
  active: number;
  decos: DecorationSet;
}

const key = new PluginKey<HighlightPluginState>("termHighlight");

export interface TermRange {
  from: number;
  to: number;
}

/** All occurrences of any term (case-insensitive), in document order. */
export function findTermRanges(doc: PMNode, terms: string[]): TermRange[] {
  const needles = [...new Set(terms.map((t) => t.toLowerCase()).filter((t) => t.length > 0))];
  if (needles.length === 0) return [];
  const out: TermRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    const text = node.text.toLowerCase();
    for (const needle of needles) {
      let idx = 0;
      while ((idx = text.indexOf(needle, idx)) !== -1) {
        out.push({ from: pos + idx, to: pos + idx + needle.length });
        idx += needle.length;
      }
    }
    return true;
  });
  return out.sort((a, b) => a.from - b.from);
}

function buildDecorations(doc: PMNode, terms: string[], active: number): DecorationSet {
  const ranges = findTermRanges(doc, terms);
  if (ranges.length === 0) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    ranges.map((r, i) =>
      Decoration.inline(r.from, r.to, {
        class: i === active ? "term-hit term-hit-active" : "term-hit",
      }),
    ),
  );
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    termHighlight: {
      /** Set highlighted terms; `active` marks one occurrence as current (-1 = none). */
      setHighlightTerms: (terms: string[], active?: number) => ReturnType;
    };
  }
}

export const TermHighlight = Extension.create({
  name: "termHighlight",

  addCommands() {
    return {
      setHighlightTerms:
        (terms: string[], active = -1) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(key, { terms, active });
            tr.setMeta("addToHistory", false);
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<HighlightPluginState>({
        key,
        state: {
          init: () => ({ terms: [], active: -1, decos: DecorationSet.empty }),
          apply(tr, value, _old, newState) {
            const meta = tr.getMeta(key) as { terms: string[]; active: number } | undefined;
            if (meta) {
              return {
                ...meta,
                decos: buildDecorations(newState.doc, meta.terms, meta.active),
              };
            }
            if (tr.docChanged && value.terms.length > 0) {
              return {
                ...value,
                decos: buildDecorations(newState.doc, value.terms, value.active),
              };
            }
            return value;
          },
        },
        props: {
          decorations(state) {
            return key.getState(state)?.decos ?? null;
          },
        },
      }),
    ];
  },
});
