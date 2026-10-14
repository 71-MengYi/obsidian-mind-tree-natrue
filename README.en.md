![Mind Tree Nature](assets/mind-tree-nature-header.png)

[中文](README.md) | [English](README.en.md)

# Mind Tree Nature

> Let your notes take shape the way thoughts do.

Mind Tree Nature is an **offline-first** mind map plugin for Obsidian. It uses `.mtn.md` files to organize notes, text, images, attachments, and web links in a custom view — while always keeping a plain Markdown outline that any editor or AI tool can read directly.

- **Five layouts**: balanced, right, left, tree, radial
- **Ten themes**: light/dark adaptive, with twelve branch colors cycling in order
- **Desktop and mobile**, with full touch gesture support
- **Bilingual UI**: Simplified Chinese / English, following your Obsidian language

## Design philosophy

**The map owns structure; files own content.** The plugin does not try to replace Markdown — it adds a visual organization layer on top of your existing vault. The map handles hierarchy and order; your `.md` files still hold the content itself. Disable the plugin tomorrow and your notes remain fully readable.

**One file, three readers.** The human-readable part of a `.mtn.md` is a standard unordered-list outline. An AI tool hits an explicit instruction and stops before the compressed block. The plugin itself treats the gzip + Base64 payload at the end of the file as the authoritative source. On save, the outline is regenerated from machine data, so the two can never drift apart.

**References should be stable, not fragile.** Linked files are tracked by stable resource IDs rather than brittle path strings, so references survive renames and moves. Node titles and file names stay in sync both ways by default — renaming a node renames the file.

**Offline first, your data stays yours.** No telemetry, no vault uploads, no third-party service. Web links store only a title, an address, and an optional icon; page content is never fetched in the background.

**Do one thing well: ordered trees.** The first release deliberately omits free-form canvases, flowcharts, and arbitrary graph structures — and leaves collaboration and server-side sync to whatever solution you already use.

## Installation

**Requirement**: Obsidian **1.8.7** or newer.

### Manual install (recommended)

1. Open the [Releases](https://github.com/71-MengYi/obsidian-mind-tree-natrue/releases/latest) page and download three files from the latest release's **Assets**:
   - `main.js`
   - `manifest.json`
   - `styles.css`

   > Do not download `Source code (zip)` or `Source code (tar.gz)` — those are not the plugin.

2. Create the folder `<vault>/.obsidian/plugins/mind-tree-nature/` inside your vault. The folder name must match the plugin ID exactly: `mind-tree-nature`. `.obsidian` is hidden, so enable hidden files first.
3. Put all three downloaded files in that folder, side by side.
4. Restart Obsidian, or click the refresh button under **Settings → Community plugins** to reload the plugin list.
5. Turn off **Restricted mode**, then find and enable **Mind Tree Nature** in the community plugins list.

**On mobile**: place the same three files at the same path inside your vault, using a file manager or whatever sync solution you already run.

### Install via BRAT

If you use [BRAT](https://github.com/TfTHacker/obsidian42-brat), add this repository and let BRAT handle installation and future updates:

```
71-MengYi/obsidian-mind-tree-natrue
```

### Updates

A built-in updater lives under **Settings → Mind Tree Nature → Basic settings → Plugin updates**. You can check manually or opt in to a check on startup.

An update replaces only the three program files (`main.js`, `manifest.json`, `styles.css`), verifying their size and SHA-256 before anything is swapped. It **never touches your notes or `data.json`**, and if verification fails, nothing is replaced at all.

## Quick start

### 1. Create a mind tree

Run **Mind Tree Nature: Create new mind tree** from the command palette (`Ctrl/Cmd + P`) and choose a title and folder.

The file is saved with the `.mtn.md` extension, and **opening it takes you straight into the map view**. The plugin intentionally offers no action for opening its Markdown source, because the outline is only a projection of machine data.

The first view of any new or reopened map centers the root node exactly at 100% zoom and selects it — no hunting for your place.

### 2. Grow nodes

Select a node and just use the keyboard — no button hunting:

| Keys | Action |
| --- | --- |
| `Enter` | Add a sibling below |
| `Shift + Enter` | Add a sibling above |
| `Tab` | Add a child node |
| `Shift + Tab` | Insert a parent node |
| `Space` | Edit the node title |
| `↑` `↓` | Move between sibling nodes |
| `←` `→` | Move between parent and first child |
| `Delete` / `Backspace` | Delete the selected branch |
| `Ctrl/Cmd + ↑` / `↓` | Move the node up / down among its siblings |
| `Ctrl/Cmd + C` / `X` / `V` | Copy / cut / paste a branch |
| `Ctrl/Cmd + A` | Select all visible nodes |
| `Ctrl/Cmd + Z` / `Ctrl/Cmd + Shift + Z` | Undo / redo |
| `Ctrl/Cmd + E` | Create a Markdown note for this node and link it |
| `Ctrl/Cmd + S` | Save now and update the Markdown outline |
| `Ctrl/Cmd + F` | Open the search window on the right |
| `Escape` | Cancel editing or dragging |

On macOS, use `Cmd` instead of `Ctrl`. The round question-mark button at the view's top-left shows the same reference.

`Ctrl/Cmd + F` or the toolbar's **Search** button opens the search window on the right of the view: the window stays open and **does not close when it loses focus** — close it with the `×` in its top-right corner or with `Esc`. A live hit count sits to the right of the input, and cards below list matches from node names, file names and the content of **linked Markdown files** (mind-tree `.mtn.md` files are not content-searched; each search caps how many files and how much text it reads, so a few hits may be missed without ever blocking the UI). Multiple hits inside one card are separated by rules, each hit stays on one line, is ellipsized at both ends and has its keyword highlighted. Click a card title to jump to that node and center it in the view; click a content row to open the file with the cursor at that line.

### 3. Attach notes to the tree

- `Ctrl/Cmd + E`: create a Markdown note for an unlinked node and link it automatically. New notes can open in a right split, a new tab, the current tab, or a new window — your choice in settings.
- Node context menu → **Link existing file**: search every file in the vault except the current mind tree itself.
- **File collection**: the *File collection* option in the view's top-left menu decides what happens to unlinked files sitting next to a mind tree — *off / ask every time / add to end of first level / add to Collection*. The scan button in the bottom-left status bar re-scans the current folder for new files at any time.
- **Theme preview**: open *Theme* in the view's top-left menu and hover an option — a small preview panel appears next to it and renders that theme's colors and connections on a sample tree in real time. Moving to another option switches instantly; moving away hides it.
- You can also **drag files** in from the vault or the system, including images from the clipboard.

Once linked, node titles and file names stay in sync both ways. If you don't want that, turn off **name sync** in the first item of the context menu. Only after fully removing the link (not just name sync) do the create/link entries reappear.

### 4. Import and export

The toolbar's **Node markers, Link node, Copy, and Export** buttons are disabled when no node is selected and become available as soon as you select a node.

- **Node markers**: the toolbar button and the node's context menu open the same marker panel with the built-in Progress / Priority / Highlight groups (one value per group; each group's delete button clears only itself). The panel also shows the custom **Emoji** and **Text tags** groups you add under **Settings → Mind Tree Nature → Manage markers**: click an unselected item to select it and replace that group's value, and click it again to clear the group. Nodes show trailing items in the order custom emoji → text tags / file badges, and text tags use the same label style as file-type badges.
- **Link node** (right of Node markers in the toolbar, or directly under Markers in the node context menu): point the current node at another node in the same tree as a **one-way** reference. The picker searches nodes by their root → … → node path. The source node then shows a clickable link mark in its tail; clicking it expands any collapsed ancestors, selects the target and centers it. A node link never copies, moves or syncs anything — both nodes keep exactly the children they had. **A node link and a file resource are mutually exclusive**: a node that already has a note or another linked resource cannot be node-linked (“This node already has a note and cannot be linked”), and a node-linked node no longer shows the open button or offers Add note / Link existing file — the link mark owns the single trailing association slot. Once a node takes part in a link (as source or target), the menu and toolbar entry becomes **Unlink node**, which removes every link that node belongs to without touching children. Linked nodes carry a block id at the end of their outline line, and the outline lists each one-way relation as `sourceId->targetId`.
- **Import text** in the toolbar: paste list/indented text to rebuild hierarchy, or switch to the *multi-level headings* rule for nested lists. Both recognize Wiki links, Markdown note/attachment links, and HTTP/HTTPS URLs — a single link per line keeps its alias, and multiple links become separate sibling nodes in order.
- **Export** in the toolbar or in the node context menu (an *Export* fly-out with **Export PNG** and **Export Markdown**): write the selected branch to a PNG image or to a Markdown unordered-list file. Both surfaces show the same two commands.
- **Copy as Mermaid code** (inside the *Copy as…* fly-out, next to **Copy branch reference** and **Copy as outline**): copies a ` ```mermaid ` code block whose body is a `mindmap` outline — one row per node, indentation for depth, node text taken from the plain title. Paste it into any Markdown note to render the branch as a diagram. Resource links, node markers and node ids have no Mermaid equivalent and are left out. When the app cannot render nested menus, the same commands appear as flat rows instead.
- **Copy branch reference** (first row of *Copy as…*, which is the same menu in the node context menu and in the toolbar's copy dropdown): copies a `mind-tree-ref` code block. Paste it into any Markdown note (reading view or live preview) and it embeds a **read-only** mind-tree view of that node and all of its descendants — same branch scope, depth-based text sizes and branch colors it has in the original tree. Inside the view you can pan, zoom and fold temporarily (folding only affects this display and is never written back); nodes with a linked resource keep the gray open button in their tail to open the note, and the floating button in the top-right corner (shown on mouse hover or keyboard focus, always visible on touch devices) opens the original mind tree view. Nothing else is interactive: no selection, context menu or export entries appear.

A reference is bound to a *tree identity plus node id*, not to a path: moving nodes inside the tree, or renaming/moving the `.mtn.md` file, never invalidates it. The first time you copy a reference from a tree that has no identity yet, the plugin writes one `documentId` (the same mechanism used when a tree is first linked by another tree). If the referenced node is deleted or cut into another mind tree, or the tree file is missing, duplicated in identity or damaged, the note replaces the view with an explanatory message and stops rendering; while the original tree file still exists, the open button stays available next to that message. Pasting a reference into the mind-tree canvas only shows a notice and never inserts a node.

### 5. Manage custom markers

**Settings → Mind Tree Nature → Manage markers** only manages the markers you add yourself; the built-in Progress / Priority / Highlight groups are product rules and are not affected:

- **Emoji**: added emoji are laid out as a grid of square icons. Below them is a **search box plus an emoji list**: the search field has a magnifier icon on its left, and the list scrolls vertically; with an empty box it lists the **whole** built-in catalogue (about 1300 emoji, nothing truncated — scroll to reach any of them), and it filters live as you type (by English name or by Chinese/English keywords such as `smile`, `中国`, `flag china` — you can also paste an emoji to find that emoji). Click an entry to add it; already-added entries are dimmed. Every entry is therefore **a single emoji** (a combined sequence such as 👨‍👩‍👧‍👦, a skin tone, a flag or a keycap all count as one), and there is no way to type arbitrary text here — use text tags for words. Hover an added icon (or focus it with the keyboard) to reveal a small delete button in its top-right corner, and drag an icon to reorder it — the drop position and everything after it shift back. With no emoji added, the grid takes no UI space. Up to 64 emoji, all bundled offline so search never needs the network.
- **Text tags**: managed exactly like emoji, but displayed as word labels such as “Drawing” or “Mind tree”. Up to 64 tags, 24 characters each. Text tags appear after the node title with that same label style.
- With the keyboard, `Alt + ←/→` moves the focused item one place left or right. Deleting a marker stops it from being displayed immediately, while nodes keep the reference — add the same marker again to restore it.
- These settings only affect display: open mind trees refresh at once, no `.mtn.md` file is modified, and no undo entry is created.
- Like the built-in markers, the custom markers a node actually uses are mirrored into the Markdown outline as a readable suffix, for example `- Node title 〔emoji:🔥〕 〔tag:Drawing〕`, so the outline always states which markers a node carries.

### 6. Let AI read and write mind trees over MCP

On desktop the plugin exposes a local MCP server, so MCP clients such as Claude Desktop and Cursor can read and write your mind trees by node id.

1. Open **Settings → Mind Tree Nature → AI** (this page only exists on desktop).
2. Turn on **Enable MCP server**. It listens on this computer only (`127.0.0.1`), default port `27321`; if that port is busy it tries nearby ports and the status line shows the address actually in use. Switching it off stops the server immediately.
3. Click **Copy configuration JSON** and paste it into your client's MCP configuration file (Claude Desktop's `claude_desktop_config.json`, or Cursor's `mcp.json`). The snippet already contains the address and this computer's access token — no fields to fill in by hand.
4. Turn on **Allow write tools** when you want AI to change your mind trees. It is off by default and is a separate second switch.

Read-only tools (no write permission needed): list mind trees; read a whole tree (nested or flat shape, paged by node count); find nodes by title; read one node; read its parent; read its children (optionally the whole subtree); read the title path from the root to it; read its linked files and node reference; read a tree's node, file and depth counts.

Write tools (require write permission): **create a mind tree** (optionally in a specific folder, with initial child titles); move a node to become a child of another node; add a child node; rename a node; delete a single node (its children move up); link an existing vault file; unlink a file; create or remove a same-document node reference.

A few deliberate rules:

- Every write is an ordinary **single-step undoable** edit, exactly as if you had made it in the UI, and it is saved to the file right away.
- **Unlinking only removes the reference on the node — it never deletes your file.** Linking only accepts files that already exist in the vault, and MCP never creates, imports or moves a file (a non-Markdown file that has no resource identity yet gains its identity suffix in the same folder, exactly as when you link it in the UI).
- MCP cannot delete a whole branch and cannot delete a file.
- If a tree has unresolved external changes, or the file is changed by another program while an operation runs, the write is refused with a reason and **nothing is overwritten**.
- Creating a mind tree through MCP never steals the view you are currently looking at.
- Mobile shows no such page and never starts the server; even if you sync a desktop configuration with MCP enabled to your phone, the phone still will not start it.

The access token lives in **device-local storage**, not in plugin data, so it is never synced to another device. Treat it like a password: anyone who can read it can change your mind trees, so handle the copied text accordingly.

## File format and privacy

- Mind trees use top-level YAML `documentId`, `schemaVersion`, `layoutMode`, `recursiveScan`, `collectionMode`, `theme`, and `nodeShape` properties followed by a Markdown outline. Lossless gzip-compressed JSON is stored after the outline and an explicit instruction telling AI tools to ignore it; settings are not duplicated in that payload. A new mind tree writes no setting property: absent settings use the global defaults from Settings → Mind map at runtime, and a property is written into that file only after you choose it in the tree's own settings menu.
- The plugin does not send telemetry or upload vault content.
- The plugin's only network-related feature is the local MCP server: off by default, desktop-only, bound to `127.0.0.1`, token-protected, and it sends nothing to any server. Beyond that, the plugin contacts GitHub only when you explicitly ask it to check for updates.
- Web links are stored but never fetched in the background.
- All UI text ships as Simplified Chinese and English i18n resources and follows your Obsidian language.

See [the design document](docs/requirements.md) for the product and technical baseline.

## Development

```bash
npm install
npm run check   # type check
npm test        # unit tests
npm run build   # production build, emits main.js
```

Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/mind-tree-nature/` to test the plugin.

## License and credits

Released under the [MIT License](LICENSE), Copyright (c) 2026 Dayiy.

Theme palettes and parts of the layout/connection behavior are adapted from the
MIT-licensed [Light Mindmap](https://github.com/ninglg/light-mindmap). See
[third-party notices](THIRD_PARTY_NOTICES.md).
