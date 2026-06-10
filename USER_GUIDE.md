# GoldFishy — User Guide

Welcome to GoldFishy! This guide explains everything in plain language — no technical knowledge needed.

---

## What is GoldFishy?

GoldFishy is a note-taking app that **organizes your notes for you**. You just write; the app can suggest labels, file notes into the right folder, tidy up messy text, and find notes even when you don't remember the exact words you used.

The most important thing to know: **everything stays on your computer.** Your notes are never sent to the internet or any company's servers. The "AI" lives entirely on your own machine.

---

## 1. The basics

### The two panels

When you open GoldFishy you'll see two areas:

1. **Left panel** — everything for finding notes: the search box, your folders, your tags, and the list of notes. The Settings gear and the **+ New** button live at the top.
2. **Editor** (the rest of the window) — the note you're currently writing.

### Writing your first note

1. Click the **+ New** button at the top of the left panel (or press **⌘N**).
2. Type a title at the top, then click below it and start writing.
3. That's it — **notes save themselves automatically** as you type. There is no Save button because you'll never need one.

### Making text look nice

Select some text and a small floating toolbar appears right above it (bold, headings, lists, quotes, code…). Selecting several lines and clicking the code-block button turns the whole selection into a single highlighted code block. You can also use these typing shortcuts — they transform as you type:

| Type this… | …and you get |
|---|---|
| `# ` then text | A big heading |
| `## ` then text | A smaller heading |
| `- ` then text | A bulleted list |
| `1. ` then text | A numbered list |
| `**word**` | **Bold** |
| `*word*` | *Italic* |

### Adding pictures

Drag any image file from your desktop or a folder straight into a note. The app stores its own copy, so you can move or delete the original later.

### Deleting a note

Click the trash can at the top right of the note. It asks you to **click twice** — that's deliberate, so you can't delete by accident.

---

## 2. Organizing with folders and tags

- **Folders** work like folders anywhere else. Hover over **Folders** in the sidebar and click **+** to make one. Hover over a folder's name for buttons to rename it, delete it, or add a folder inside it.
- To **move a note** into a folder, open the note and use the folder dropdown at the top left of the editor.
- **Tags** are little labels (like `recipes` or `work`). Under the note's title, click **+ tag** to add one. Click a tag in the sidebar to see every note with that label.

You can use folders, tags, both, or neither — the search is good enough that many people barely organize at all.

---

## 3. Finding things

### Quick search from anywhere (⌘K)

Press **⌘K** at any time to open the quick search window (like Spotlight). Start typing to see matching notes instantly, use the ↑↓ arrow keys to pick one, and press Enter to open it. Two more tricks:

- Press **Tab** to switch between word-matching and "search by meaning".
- Type **>** as the first character to see commands instead — new note, settings, re-index, export — and run them with Enter.

### The search box

You can also type in the search box at the top of the left panel. There are two search styles — switch with the tiny toggle inside the right edge of the box (🔍 / ✦):

- **Keyword** — finds notes containing the words you type. Instant, updates as you type.
- **Semantic** — finds notes *about* what you type, even if the words don't match. Searching "flight stuff" will find your airline booking note even if it never says "flight stuff". Type your search, then press **Enter**.

> The first time you ever open the app it downloads a small "understanding" file (about 80 MB) in the background — the sidebar shows "Downloading semantic model…" while it happens, and you can keep writing the whole time. After that it works fully offline, forever.

---

## 4. The AI features — what they do

Once AI is enabled (next section), GoldFishy can:

- 🏷 **Auto-tag** — a few seconds after you stop typing, the app quietly adds three suggested tags to your note. AI tags look green with a ✨; your own tags look neutral. Don't like one? Hover over it and click the ×.
- 📁 **Suggest a folder** — if a note seems to belong somewhere, a small banner appears: *"AI suggests filing this in …"* with **Move** and **Dismiss** buttons. Nothing moves unless you click Move.
- • **Auto-bullet** — wrote a messy brain-dump? Click **Auto-bullet** at the top of the note and it gets reorganized into tidy bullet points.
- 📝 **Summarize a collection** — viewing a folder or tag, click **Summarize collection** under the search box to get a one-paragraph summary of everything in it.
- ✅ **Action items & reminders** — the AI also spots tasks and follow-ups in your notes ("call the dentist", "send the report by Friday") and proposes them in the **Actions panel** (the bell at the top of the left panel). Nothing is scheduled until you accept it.

### The Actions panel (the bell 🔔)

Click the bell to open the panel. It has three groups:

- **Proposed** — items the AI found, waiting for your review. Accept (✓) to schedule them, or dismiss (✗) — dismissed items are never re-proposed.
- **Scheduled** — your active list. Click the little calendar chip to set or change a reminder time; when it comes due you get a banner inside the app and (optionally) a normal desktop notification with **Done / Snooze 1h / Open note** at hand.
- **Completed** — what you've finished, collapsed out of the way.

Every item has a **category** chip (work, errands, health…) — the AI suggests one, and you can click the chip to change it. Use the category chips at the top of the panel to filter. You can also type into "Add an action item…" to add one yourself — no AI needed.

All of it is configurable in **Settings → Reminders & Action Items**: automatic extraction, in-app banners, and system notifications each have their own switch.

The app is careful about your battery and your typing: AI work only happens in the background **after you stop typing**, and it never interrupts you with pop-ups.

---

## 5. Enabling the AI features

The AI needs a "brain" — a language model running on your computer. The easiest way to get one is a free app called **Ollama**. Five minutes, one time:

### Step 1 — Install Ollama

1. Go to **ollama.com** in your web browser.
2. Click **Download**, then open the downloaded file and follow the installer (just like installing any app).

### Step 2 — Get a model

1. Open the **Terminal** app (press `Cmd + Space`, type "Terminal", press Enter).
2. Type this and press Enter:
   ```
   ollama pull llama3.2
   ```
3. Wait for the download to finish (about 2 GB — a few minutes on decent Wi-Fi). You can close Terminal afterwards.

### Step 3 — Connect GoldFishy to it

1. In GoldFishy, click the **Settings** gear (top of the left panel).
2. Under **AI Engine & Model Selection**, click **External server**.
3. Make sure the Server URL says `http://localhost:11434` (it's filled in for you).
4. In **Model name**, type: `llama3.2`
5. Click **Test connection** — you should see a little message saying the LLM replied.
6. Click **Save**.

Done! Auto-tagging starts working in the background, and the Auto-bullet / Summarize buttons appear.

> **"Localhost"? "Server"?** Don't worry — despite the words, this is all happening inside your own computer. Nothing goes online.

### Alternative: let GoldFishy download a model itself

If you'd rather not install Ollama, GoldFishy can run models directly, but this path needs one technical ingredient (a helper program called `llama-server`) that usually requires a tool called Homebrew to install. If the steps below sound foreign, ask a techy friend — or just use the Ollama method above, it's genuinely easier.

1. Install the helper: in Terminal, run `brew install llama.cpp`
2. In GoldFishy: **Settings → AI Engine → Local model (llama.cpp)**
3. Next to the binary box, click **Browse** and pick `llama-server` (usually in `/opt/homebrew/bin/`)
4. In the HuggingFace box, paste a model name like `bartowski/Llama-3.2-3B-Instruct-GGUF` and click **Download**
5. When the download finishes, click **Test connection**, then **Save**

---

## 6. Settings explained

**Settings → Processing Mode & Timers**

- **Automation mode**
  - *Full Auto* (recommended) — tags and suggestions happen by themselves in the background.
  - *Manual Only* — the AI only runs when you click the **Organize** or **Auto-bullet** buttons. Choose this if you're on battery a lot or just prefer to be in control.
- **Embedding debounce** — how many seconds after you stop typing before the app updates its search index for that note. Leave it at 2 unless you have a reason.
- **LLM debounce** — how many seconds of quiet before the heavier AI (tagging) kicks in. Leave at 5.
- **Sync / Re-index** — if you spent a while in Manual mode and want the AI to catch up on everything it skipped, click **Re-index now** and let it churn through the backlog.

**Reading the little signals**

- A pulsing **tan dot** on a note = it's being indexed for search (takes a second).
- A pulsing **green dot** = the AI is reading it to suggest tags.
- The line at the bottom of the sidebar tells you what the background engine is doing ("All notes up to date", "3 notes queued", etc.). When notes are queued, **click that line** to see exactly which notes are waiting and jump to any of them.
- The left panel itself is adjustable: drag its right edge to resize it, or hide it entirely with the panel button at the top (or **⌘\**).

---

## 7. Backing up / taking your notes elsewhere

Your notes are never locked in. In **Settings → Data & Export**:

- **Export all as Markdown** — creates ordinary text files, one per note, arranged in folders matching yours, plus your images. These open in any text editor, on any computer, forever.
- **Export all as JSON** — one structured file with everything; useful for importing into other software.

Pick any destination folder (a USB stick, a cloud-synced folder, anywhere).

---

## 8. Questions & troubleshooting

**Do I need the internet?**
Only twice, ever: once when the search "understanding" file downloads (~80 MB), and once when you download an AI model. Everything else — writing, searching, tagging, summarizing — is fully offline.

**The AI buttons don't appear.**
AI is disabled. Follow section 5 to enable it.

**"No LLM backend configured" or "LLM request failed".**
GoldFishy can't reach the AI. If you used Ollama, make sure Ollama is running (its icon in the menu bar; open the Ollama app if not), then try **Test connection** in Settings again.

**Tagging seems slow.**
That's by design — the heavy AI waits politely until you've been idle for a few seconds and processes notes one at a time so your computer stays fast. Results fade in when ready.

**Semantic search says the model isn't ready.**
The understanding file downloads automatically the first time the app opens. If the sidebar says "Downloading semantic model…", just give it a minute; if it says "Semantic engine error", check that you're online and restart the app — once the download finishes, it's permanent.

**A tag or folder suggestion is wrong.**
Remove the tag with its × or click **Dismiss** on the suggestion. Your manual choices always win — the AI never overrides a tag you added or moves a note without your click.

**Where exactly do my notes live?**
In a database file on your Mac at `~/Library/Application Support/com.nexusnote.app/`. Back up that folder (or use Export) and you have everything.
