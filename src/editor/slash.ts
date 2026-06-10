import { Extension, type Editor, type Range } from "@tiptap/core";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";

/**
 * "/" block-insert menu. The dropdown is plain DOM (no React) managed by the
 * suggestion plugin's render hooks — same visual language as the popovers.
 */

interface SlashItem {
  title: string;
  /** The markdown shortcut shown on the right, as a learning aid. */
  hint: string;
  run: (editor: Editor, range: Range) => void;
}

const SLASH_ITEMS: SlashItem[] = [
  {
    title: "Heading 1",
    hint: "#",
    run: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 1 }).run(),
  },
  {
    title: "Heading 2",
    hint: "##",
    run: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 2 }).run(),
  },
  {
    title: "Heading 3",
    hint: "###",
    run: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 3 }).run(),
  },
  {
    title: "Bullet list",
    hint: "-",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    title: "Numbered list",
    hint: "1.",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    title: "Task list",
    hint: "- [ ]",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    title: "Quote",
    hint: ">",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    title: "Code block",
    hint: "```",
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    title: "Divider",
    hint: "---",
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
];

function createMenu() {
  let el: HTMLDivElement | null = null;
  let items: SlashItem[] = [];
  let selected = 0;
  let props: SuggestionProps<SlashItem> | null = null;

  const pick = (item: SlashItem | undefined) => {
    if (item && props) item.run(props.editor, props.range);
  };

  const paint = () => {
    if (!el) return;
    el.innerHTML = "";
    items.forEach((item, i) => {
      const btn = document.createElement("button");
      btn.className = `flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs ${
        i === selected ? "bg-clay-600/20 text-clay-200" : "text-stone-300"
      }`;
      const title = document.createElement("span");
      title.textContent = item.title;
      const hint = document.createElement("span");
      hint.className = "ml-auto text-[9px] text-stone-500";
      hint.textContent = item.hint;
      btn.append(title, hint);
      btn.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        pick(item);
      });
      btn.addEventListener("mouseenter", () => {
        selected = i;
        paint();
      });
      el!.append(btn);
    });
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "px-2.5 py-1.5 text-xs text-stone-600";
      empty.textContent = "No matching block";
      el.append(empty);
    }
  };

  const position = () => {
    if (!el || !props?.clientRect) return;
    const rect = props.clientRect();
    if (!rect) return;
    const height = el.offsetHeight || items.length * 30 + 8;
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    el.style.left = `${Math.min(rect.left, window.innerWidth - 240)}px`;
    el.style.top = `${top}px`;
  };

  return {
    onStart: (p: SuggestionProps<SlashItem>) => {
      props = p;
      items = p.items;
      selected = 0;
      el = document.createElement("div");
      el.className =
        "fixed z-50 w-56 rounded-xl border border-stone-800 bg-stone-900 p-1 shadow-2xl shadow-black/60";
      document.body.append(el);
      paint();
      position();
    },
    onUpdate: (p: SuggestionProps<SlashItem>) => {
      props = p;
      items = p.items;
      selected = Math.min(selected, Math.max(items.length - 1, 0));
      paint();
      position();
    },
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (!el || el.style.display === "none") return false;
      if (event.key === "ArrowDown") {
        selected = (selected + 1) % Math.max(items.length, 1);
        paint();
        return true;
      }
      if (event.key === "ArrowUp") {
        selected = (selected - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1);
        paint();
        return true;
      }
      if (event.key === "Enter") {
        pick(items[selected]);
        return true;
      }
      if (event.key === "Escape") {
        el.style.display = "none";
        return true;
      }
      return false;
    },
    onExit: () => {
      el?.remove();
      el = null;
      props = null;
    },
  };
}

export const SlashCommands = Extension.create({
  name: "slashCommands",

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: "/",
        startOfLine: false,
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          return $from.parent.type.name !== "codeBlock";
        },
        items: ({ query }) =>
          SLASH_ITEMS.filter((i) =>
            i.title.toLowerCase().includes(query.toLowerCase()),
          ),
        command: ({ props }) => {
          // The item's run() already received editor+range via pick().
          void props;
        },
        render: createMenu,
      }),
    ];
  },
});
