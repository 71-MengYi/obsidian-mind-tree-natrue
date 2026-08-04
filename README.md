# Mind Tree Nature

Mind Tree Nature is an offline-first Obsidian plugin for organizing notes, attachments, and web links as an ordered mind tree.

## Use

1. Run **Mind Tree Nature: Create new mind tree** from the command palette.
2. Add and edit nodes from the centered toolbar or a node's context menu. The vertical menu at the view's top-left contains per-tree settings and shortcut help.
3. Drag from empty canvas space with the left mouse button to select nodes. Drag empty space with the right mouse button to pan.
4. Drag a node before, after, or inside another node to reorganize the tree.
5. Use `Enter`, `Shift+Enter`, `Tab`, `Shift+Tab`, and `Ctrl/Cmd+E` for fast node and note creation.

`.mtn.md` files open in the Mind Tree view automatically. The plugin intentionally does not add an action for opening their Markdown source.

## Development

```bash
npm install
npm run check
npm test
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/mind-tree-nature/` to test the plugin.

## Data and privacy

- Mind trees use top-level YAML `documentId`, `schemaVersion`, `layoutMode`, `recursiveScan`, `collectionMode`, `theme`, and `nodeShape` properties followed by a Markdown outline. Lossless gzip-compressed JSON is stored after the outline and an explicit instruction telling AI tools to ignore it; settings are not duplicated in that payload.
- The plugin does not send telemetry or upload vault content.
- Web links are stored but never fetched in the background.

See [the design document](docs/requirements.md) for the product and technical baseline.

Theme palettes and parts of the layout/connection behavior are adapted from the
MIT-licensed [Light Mindmap](https://github.com/ninglg/light-mindmap). See
[third-party notices](THIRD_PARTY_NOTICES.md).
