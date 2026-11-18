![Mind Tree Nature](assets/mind-tree-nature-header.png)

[中文](README.md) | [English](README.en.md)

# Mind Tree Nature

> Let your notes take shape the way thoughts do.

Mind Tree Nature is an **offline-first** mind map plugin for Obsidian. It uses `.mtn.md` files to organize notes, text, images, attachments, and web links in a custom view — while always keeping a plain Markdown outline that any editor or AI tool can read directly.

- **Five layouts**: balanced, right, left, tree, radial
- **Ten themes**: light/dark adaptive, with twelve branch colors cycling in order
- **Desktop and mobile**, with full touch gesture support
- **Bilingual UI**: Simplified Chinese / English, following your Obsidian language
- **Local version history** (sync-excludable), **note backlinks** as reference dots, and **PNG / Markdown / Canvas** whole-tree export

## Design philosophy

**The map owns structure; files own content.** The plugin does not try to replace Markdown — it adds a visual organization layer on top of your existing vault. The map handles hierarchy and order; your `.md` files still hold the content itself. Disable the plugin tomorrow and your notes remain fully readable.

**One file, three readers.** The human-readable part of a `.mtn.md` is a standard unordered-list outline. An AI tool hits an explicit instruction and stops before the compressed block. The plugin itself treats the gzip + Base64 payload at the end of the file as the authoritative source. On save, the outline is regenerated from machine data, so the two can never drift apart.

**References should be stable, not fragile.** Linked files are tracked by stable resource IDs rather than brittle path strings, so references survive renames and moves. Node titles and file names stay in sync both ways by default — renaming a node renames the file.

**Offline first, your data stays yours.** No telemetry, no vault uploads, no third-party service. Web links store only a title, an address, and an optional icon; page content is never fetched in the background.

**Do one thing well: ordered trees.** The first release deliberately omits free-form canvases, flowcharts, and arbitrary graph structures (an ordered tree can only be *exported* to `.canvas`) — and leaves collaboration and server-side sync to whatever solution you already use.

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

A **minimap** sits in the bottom-right corner of the view: it renders the whole tree scaled down and marks the currently visible part of the canvas with an indicator window — the bigger the tree, the smaller that window; and once the tree is larger than the view, zooming in shrinks it further. Click or drag inside the minimap to jump the canvas to that position without changing zoom; its colors follow the current theme. The minimap is on by default and can be turned off under **Settings → Mind Tree Nature → Basic settings → Minimap**; maps that are already open update immediately when you toggle it.

Next to Save in the bottom-left status bar is **Version history**: after each real write from the normal save pipeline, the source text that was written is also saved under the vault-root `.mind-tree-nature-data/snapshots/` folder (not part of the note file, not in `.obsidian`, and not in the plugin's `data.json`). Identical content is deduplicated, each tree keeps the latest 30 versions, and one version is capped at 8 MiB. The dialog lists time, node count and size on the left, shows a read-only preview on the right, and **Restore this version** replaces the whole tree as a single undoable action — press `Ctrl/Cmd + Z` to undo it. We recommend excluding `.mind-tree-nature-data/` in your sync tool so version history does not travel with your notes.

### 3. Attach notes to the tree

- `Ctrl/Cmd + E`: create a Markdown note for an unlinked node and link it automatically. New notes can open in a right split, a new tab, the current tab, or a new window — your choice in settings.
- Node context menu → **Create TaskNote** (below **Add note**): create a task note for an unlinked node through the [TaskNotes](https://github.com/callumalpass/tasknotes) runtime API, then **move it into the mind tree's own folder** before linking it (the vault root when the tree sits there). TaskNotes owns the file name and task fields; this plugin supplies the node title, places the note with `tasks.move` and links it. If the move fails (for example a same-named file already exists in the tree folder), the note stays where TaskNotes created it and is still linked, with a notice showing the real path. When TaskNotes is not installed/enabled or lacks `tasks.move`, clicking only shows the install/update address and creates nothing; enabling or updating TaskNotes later needs no reload of this plugin.
- Node context menu → **Link existing file**: search every file in the vault except the current mind tree itself.
- Node context menu → **Link web page**: enter the address (only `http` / `https`) and a title; the title defaults to the node's current text and falls back to the host name when left empty.
- **File collection**: the *File collection* option in the view's top-left menu decides what happens to unlinked files sitting next to a mind tree — *off / ask every time / add to end of first level / add to Collection*. The scan button in the bottom-left status bar re-scans the current folder for new files at any time.
- **Theme preview**: open *Theme* in the view's top-left menu and hover an option — a small preview panel appears next to it and renders that theme's colors and connections on a sample tree in real time. Moving to another option switches instantly; moving away hides it.
- You can also **drag files** in from the vault or the system, including images from the clipboard.

Once linked, node titles and file names stay in sync both ways. If you don't want that, turn off **name sync** in the first item of the context menu. Only after fully removing the link (not just name sync) do the create/link entries reappear.

### 4. Import and export

The toolbar's **Node markers and Copy** buttons are disabled when no node is selected and become available as soon as you select a node. **Export does not require a selection**: with nothing selected, PNG, Markdown and Canvas all export the whole tree from the root.

- **Node markers**: the toolbar button and the node's context menu open the same marker panel with the built-in Progress / Priority / Highlight groups (one value per group; each group's delete button clears only itself). The panel also shows the custom **Emoji** and **Text tags** groups you add under **Settings → Mind Tree Nature → Manage markers**: click an unselected item to select it and replace that group's value, and click it again to clear the group. Nodes show trailing items in the order custom emoji → text tags / file badges, and text tags use the same label style as file-type badges.
- **Node links** (directly under Markers in the node context menu): point a node at another node in the same tree as a **one-way** reference. Links are created by copying and pasting: choose **Copy as… → Copy branch reference** on the target node, select where the link node should go, and press `Ctrl/Cmd + V` — the paste position receives a new node titled after the target and carrying a clickable link mark. Clicking that mark expands any collapsed ancestors, selects the target and centers it. A link never copies, moves or syncs anything: the pasted node is only a pointer, and the target's children stay where they are. The toolbar no longer has a link button and there is no node picker. **A node link and a file resource are mutually exclusive**: the pasted node has no resource, so it is always eligible; a node-linked node no longer shows the open button or offers Add note / Link existing file — the link mark owns the single trailing association slot. A link only exists inside one tree: pasting a reference into another tree (or into a tree with a different identity) only shows a notice and inserts nothing. For a node that takes part in a link, the context menu shows **Unlink node**, which removes every link that node belongs to without touching children. Linked nodes carry a block id at the end of their outline line, and the outline lists each one-way relation as `sourceId->targetId`.
- **Import text** in the toolbar: paste list/indented text to rebuild hierarchy, or switch to the *multi-level headings* rule for nested lists. Both recognize Wiki links, Markdown note/attachment links, and HTTP/HTTPS URLs — a single link per line keeps its alias, and multiple links become separate sibling nodes in order.
- **Export** in the toolbar or in the node context menu (an *Export* fly-out with **Export PNG**, **Export Markdown** and **Export as Canvas**): write the selected branch to a PNG image, a Markdown unordered-list file, or an Obsidian `<title>.canvas` file next to the source `.mtn.md` (name collisions use `-2` / `-3` and the notice reports the real path). File names default to the node title; with no node selected, all three export the whole tree from the root, so the toolbar's Export button is always available. Both surfaces show the same three commands.
- **Copy as Mermaid code** (inside the *Copy as…* fly-out, next to **Copy branch reference** and **Copy as outline**): copies a ` ```mermaid ` code block whose body is a `mindmap` outline — one row per node, indentation for depth, node text taken from the plain title. Paste it into any Markdown note to render the branch as a diagram. Resource links, node markers and node ids have no Mermaid equivalent and are left out. When the app cannot render nested menus, the same commands appear as flat rows instead.
- **Copy branch reference** (first row of *Copy as…*, which is the same menu in the node context menu and in the toolbar's copy dropdown): copies a `mind-tree-ref` code block. Paste it into any Markdown note (reading view or live preview) and it embeds a **read-only** mind-tree view of that node and all of its descendants — same branch scope, depth-based text sizes and branch colors it has in the original tree. Inside the view you can pan, zoom and fold temporarily (folding only affects this display and is never written back); nodes with a linked resource keep the gray open button in their tail to open the note, and the floating button in the top-right corner (shown on mouse hover or keyboard focus, always visible on touch devices) opens the original mind tree view. Nothing else is interactive: no selection, context menu or export entries appear. Paste the same reference back into the mind tree it came from and you get a linked node pointing at that branch instead (see **Node links** above).

A reference is bound to a *tree identity plus node id*, not to a path: moving nodes inside the tree, or renaming/moving the `.mtn.md` file, never invalidates it. The first time you copy a reference from a tree that has no identity yet, the plugin writes one `documentId` (the same mechanism used when a tree is first linked by another tree). If the referenced node is deleted or cut into another mind tree, or the tree file is missing, duplicated in identity or damaged, the note replaces the view with an explanatory message and stops rendering; while the original tree file still exists, the open button stays available next to that message. Pasting a reference back into its own mind tree inserts a linked node; pasting it into another tree only shows a notice.

References also show up in reverse on the canvas: when a `mind-tree-ref` block in an ordinary Markdown note points at a node of this tree, the node shows gray **reference dots** underneath (up to 5, with `+N` for the rest). Hover the node or focus it with the keyboard and the dots expand, left-aligned under the node, into pill buttons listing the paths of the notes that reference it; click a pill to open that note with the cursor on the reference line, or tap the dots on a touch device. The dots are an overlay only: they take no layout space, never change node size or connections, and are hidden while editing a title or dragging. They appear only in the editable map (not in read-only previews), are never written back to the note, and make no network requests.

### 5. Manage custom markers

**Settings → Mind Tree Nature → Manage markers** only manages the markers you add yourself; the built-in Progress / Priority / Highlight groups are product rules and are not affected:

- **Emoji**: added emoji are laid out as a grid of square icons. Below them is a **search box plus an emoji list**: the search field has a magnifier icon on its left, and the list scrolls vertically; with an empty box it lists the **whole** built-in catalogue (about 1300 emoji, nothing truncated — scroll to reach any of them), and it filters live as you type (by English name or by Chinese/English keywords such as `smile`, `中国`, `flag china` — you can also paste an emoji to find that emoji). Click an entry to add it; already-added entries are dimmed. Every entry is therefore **a single emoji** (a combined sequence such as 👨‍👩‍👧‍👦, a skin tone, a flag or a keycap all count as one), and there is no way to type arbitrary text here — use text tags for words. Hover an added icon (or focus it with the keyboard) to reveal a small delete button in its top-right corner, and drag an icon to reorder it — the drop position and everything after it shift back. With no emoji added, the grid takes no UI space. Up to 64 emoji, all bundled offline so search never needs the network.
- **Text tags**: managed exactly like emoji, but displayed as word labels such as “Drawing” or “Mind tree”. Up to 64 tags, 24 characters each. Text tags appear after the node title with that same label style.
- With the keyboard, `Alt + ←/→` moves the focused item one place left or right. Deleting a marker stops it from being displayed immediately, while nodes keep the reference — add the same marker again to restore it.
- These settings only affect display: open mind trees refresh at once, no `.mtn.md` file is modified, and no undo entry is created.
- Like the built-in markers, the custom markers a node actually uses are mirrored into the Markdown outline as a readable suffix, for example `- Node title 〔emoji:🔥〕 〔tag:Drawing〕`, so the outline always states which markers a node carries.

### 6. Let AI read and write mind trees over MCP

On desktop the plugin exposes **one local MCP server**, named `mind-tree-nature`, so MCP clients such as Claude Desktop and Cursor can read and write your mind trees by node id.

**Why one server**: the plugin does not intercept any tool call — whether to approve, and how, is decided in your client. An MCP client attaches its "does this tool need my approval?" policy to a *server*, not to an individual tool. With reading and editing on the same server, **the client can only apply one policy to both** — either the whole server runs unattended (so writes execute too) or every call needs confirmation. The split that let reading run unattended while writes required confirmation is gone.

1. Open **Settings → Mind Tree Nature → AI** (this page opens on desktop and mobile; the MCP section itself is unavailable on mobile).
2. Turn on the **Enable MCP server** master switch (off by default). The server listens on this computer only (`127.0.0.1`); if its port is busy it tries nearby ports and the status line shows the address actually in use.
3. Click **Copy configuration JSON** and paste it into your client's MCP configuration file (Claude Desktop's `claude_desktop_config.json`, or Cursor's `mcp.json`). The snippet already contains the server address and access token under the entry name `mind-tree-nature` — no fields to fill in by hand.
4. Give that single entry its approval policy in your client. It is the only entry, and reading and writing share it — there is no "confirm writes only" option.

| | `mind-tree-nature` |
| --- | --- |
| Default port | `27321` |
| Default state | **Off**; starts only after you turn on the master switch in settings |
| Tools | All 18: 9 read-only tools plus 9 tools that change something. The read side lists mind trees, reads a whole tree (nested or flat, paged by node count), finds nodes by title, and reads a node with its parent, children (optionally the whole subtree), title path, linked files and node reference, plus node/file/depth counts; the edit side moves a node, adds a child node, renames a node, deletes a single node (children move up), links or unlinks a file, creates or removes a same-document node reference, and **creates a whole new mind tree** |
| Can it change a file? | Yes; reading and editing live on the same server |

A few deliberate rules:

- Every edit is an ordinary **single-step undoable** change, exactly as if you had made it in the UI, and it is saved to the file right away.
- **Reading and writing share one client approval policy**: that is the direct consequence of merging the two servers, and the trade-off this round asks for. The plugin does not add a second, per-tool distinction on the server side.
- After upgrading, the settings page has **a single server**, and copying the configuration again yields one `mind-tree-nature` entry. The upgrade keeps the port and access token from the old **read-only server** record, so an existing client configuration with that address and token still works — but it now carries the write tools as well.
- **Unlinking only removes the reference on the node — it never deletes your file.** Linking only accepts files that already exist in the vault, and MCP never creates, imports or moves a file (a non-Markdown file that has no resource identity yet gains its identity suffix in the same folder, exactly as when you link it in the UI).
- MCP cannot delete a whole branch and cannot delete a file.
- If a tree has unresolved external changes, or the file is changed by another program while an operation runs, the write is refused with a reason and **nothing is overwritten**.
- Creating a mind tree through MCP never steals the view you are currently looking at.
- Mobile can open the AI page, but the MCP section shows a red notice that the server is desktop-only and never starts; even if you sync a desktop configuration with MCP enabled to your phone, the phone still will not start it.

The access token lives in the plugin's `data.json` and syncs with the rest of the plugin data, so every device uses the **same fixed string** and a synced configuration does not stop working on another device; the bound port is still recorded per device. Treat it like a password: anyone who can read it can both read and write your mind trees.

### 7. Configure external model providers

After the MCP server section, **Settings → Mind Tree Nature → AI** adds a **Model providers** section that stores how to reach external model services. The AI page opens on desktop and mobile: the MCP section is unavailable on mobile and says so in red, while model providers remain editable; OAuth sign-in buttons are disabled on mobile but pasting a manual token still works. **This version has no chat or inference surface yet**: these settings are the configuration layer for later work, and the plugin never calls a model, fetches a model list or sends note content on its own.

- **Add a provider**: click **Add provider** to open a picker filtered by **All / Main / China / Gateways / Cloud / Local** or by search. Built-in choices include OpenAI, ChatGPT OAuth, Anthropic, Claude OAuth, Gemini, Gemini OAuth, GitHub Copilot, OpenRouter, Sidrune AI, xAI, Mistral, Perplexity, Groq, Cerebras, SambaNova, Together AI, Morph, DeepSeek, Moonshot, Zhipu, Doubao, SiliconFlow, StepFun, MiniMax, Hunyuan, Xiaomi MiMo, Azure OpenAI, Amazon Bedrock, Ollama, LM Studio, plus a **custom provider** for any OpenAI-compatible endpoint. After choosing a preset, fill in the form; leaving Base URL empty uses the preset's default endpoint.
- **Provider cards**: each card shows the preset name, ID, API type, the Base URL actually in use (with a default-endpoint hint) and its connection status. Expand a card to edit or delete it. Deleting requires a **second click inside the same card** (valid for about five seconds; otherwise the button resets) and also removes the provider's chat/embedding models and its device-local OAuth credential.
- **Form**: ID (unique; starts with a letter or digit, may contain dots, dashes and underscores), preset, API type, API key, Base URL and a request-URL preview; preset-specific fields cover request transport (browser / Obsidian / desktop direct), response streaming mode, prompt caching, No stainless headers, Google OAuth client ID and secret (required for Gemini OAuth; use your own Google Cloud OAuth client — the plugin embeds no client credentials), project, deployment, API version, region and custom headers. Azure OpenAI requires a Base URL, deployment name and API version; Amazon Bedrock requires a region; the custom provider requires a Base URL; Gemini OAuth requires a Google OAuth client ID and secret and refuses to save without them. Missing required fields, invalid formats, duplicate IDs and out-of-range numbers are reported inline and the form does not save.
- **Models**: an expanded card holds **Chat models** and **Embedding models** tables. A chat model stores model ID, display name, enabled flag, reasoning type, temperature, topP, context/output tokens, input modalities (text / images / PDF), built-in tool family and custom parameters; an embedding model stores model ID, display name and dimensions. Presets without embedding support say so instead of offering the table. Changing a provider ID moves its models with it.
- **Fetch model catalog**: the chat-model area has a **Fetch model catalog** button. Only a click queries the provider's model list (OpenAI-compatible / Responses via `/models`, Anthropic via `/v1/models`, Gemini via `/v1beta/models`; ChatGPT / Gemini / GitHub Copilot OAuth sessions use their login token, Claude uses a built-in fallback list and any failed read falls back as well; Azure OpenAI and Amazon Bedrock are not supported). The dialog fetches on open and supports search, select-all and batch adding. A model already configured under the same provider is marked **Already added** and skipped; config ID collisions get `-2` / `-3` suffixes. When the remote catalog is unavailable, a built-in fallback list is shown with a clear notice; batch failures are listed inline while successful rows are still saved.
- **Connectivity test**: every model row has a **Test** button. Only a click sends **one** minimal model request, then the row reports success with latency or the failure reason. Azure OpenAI and Amazon Bedrock report "not supported" instead of looking like an authentication failure. Opening the AI page, saving settings and starting the plugin never fetch a model or send note content on their own; a connected OAuth token may renew once when its status is read (login-session maintenance only: no note content and no model call); connectivity tests and OAuth sign-ins happen only when you click.
- **OAuth sign-in**: provider cards expose a sign-in panel for ChatGPT (device code), Gemini (browser PKCE), GitHub Copilot (device code) and Claude (paste an access token manually). It shows disconnected, waiting for authorization (with the device code and a verification-page link), connected (with the account) or an error, with cancel and disconnect actions. Browser redirects and local callbacks exist on desktop only; mobile can open the AI page and edit providers/models, but the OAuth connect / cancel / disconnect buttons are disabled there with a hint to paste a manual token instead, and the manual token field stays available. Gemini uses the Google OAuth client ID and secret from the provider form; the plugin and its release bundles embed no client credentials, and connecting without them opens no browser and only asks you to fill them in first. API keys and model definitions live in the plugin's `data.json`; OAuth tokens live in **device-local storage** (`${manifest.id}:ai-oauth:<providerId>`), never in `data.json`, and are not synced to other devices. API keys and tokens are passwords: the UI only reports "configured / not connected" and never renders the secret again.

## File format and privacy

- Mind trees use top-level YAML `documentId`, `schemaVersion`, `layoutMode`, `recursiveScan`, `collectionMode`, `theme`, and `nodeShape` properties followed by a Markdown outline. Lossless gzip-compressed JSON is stored after the outline and an explicit instruction telling AI tools to ignore it; settings are not duplicated in that payload. A new mind tree writes no setting property: absent settings use the global defaults from Settings → Mind map at runtime, and a property is written into that file only after you choose it in the tree's own settings menu.
- Version history lives in the vault-root dot folder `.mind-tree-nature-data/snapshots/`: it is not part of `.mtn.md`, never enters `.obsidian` or `data.json`, and changes no file format, `schemaVersion` or YAML. Each tree keeps up to 30 versions and one version is capped at 8 MiB; we recommend excluding that folder in your sync tool so history does not travel with your notes. Reverse references only read ordinary Markdown notes, are never written back to any file, and make no network requests.
- The plugin sends no telemetry and uploads no vault content. Network requests happen only on your explicit action: the local MCP server is off by default, desktop-only and bound to `127.0.0.1`; clicking **Test** on a model sends one minimal request to that provider's configured endpoint; clicking **Fetch model catalog** queries that provider's model-list endpoint once; clicking OAuth **Connect** contacts the matching sign-in endpoint. Beyond that, the plugin contacts GitHub only when you explicitly ask it to check for updates.
- Model-provider **API keys and model definitions** are stored in the plugin's `data.json` (in plain text, alongside the rest of the plugin data); **OAuth tokens** live in device-local storage and never enter `data.json`. Treat `data.json` and any key inside it as sensitive: do not commit it to a public repository or share it with others.
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
