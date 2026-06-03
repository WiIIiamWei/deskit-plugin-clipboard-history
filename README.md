# DesKit Clipboard History Plugin

A DesKit plugin that records clipboard changes and shows a searchable clipboard history from the launcher.

## What Works Now

- Records text and image clipboard entries through `activationEvents: ["clipboard:change"]`.
- De-duplicates repeated clipboard content and keeps the newest entry first.
- Shows a searchable list grouped by favorites and content type.
- Filters history by all/text/image entries.
- Stars favorite entries and keeps them pinned while trimming or clearing unstarred history.
- Pressing `Enter` on a history row copies that item back to the clipboard.
- Each history item exposes `Copy` and `Star`/`Unstar` actions.
- Self-triggered copies are ignored by the history collector so copied history items are not re-added.
- Stores history locally with `storage:plugin`.
- Syncs recent text history through DesKit settings sync (GitHub Gist) or optional WebDAV.

## Current Host Boundary

The intended user shortcut is `Win+Ctrl+C`. The current DesKit host can open plugin commands from the launcher, but it cannot reliably paste into the previously focused text field after the DesKit window opens. This plugin therefore copies the selected history item back to the clipboard and lets the user paste it manually.

This plugin keeps the command and data shape ready for future host integration:

- command id: `clipboard-history.open`
- preferred shortcut: `Win+Ctrl+C`
- primary row action: `copy`

## Sync

The plugin supports three sync modes:

- `Off`: local-only history.
- `DesKit settings sync (Gist)`: stores a small hidden plugin sync document inside DesKit settings sync.
- `WebDAV`: writes the same small sync document to a user-configured WebDAV file.

Sync intentionally includes text entries only. Image entries remain local because screenshots and image data URLs can quickly exceed the host network and settings-sync payload limits. File clipboard entries are not supported by the current DesKit SDK.

Every sync write is capped to the newest 5 text entries and a maximum JSON payload of 512 KiB. If the payload still exceeds 512 KiB, the plugin removes the largest text records until the document fits or no records remain.

### WebDAV

Enable WebDAV sync in the plugin settings, then provide:

- WebDAV root URL, for example `https://dav.example.com/remote.php/dav/files/me/`.
- WebDAV username.
- WebDAV password or app token.
- Sync file path, default `deskit/clipboard-history.json`.

The plugin creates missing WebDAV collections with `MKCOL`, merges remote and local text entries by item id, and preserves the newest favorite/star state.

WebDAV credentials are stored in DesKit plugin preferences because the current host does not yet expose a dedicated secret vault.

## Development

```bash
npm install
npm run check
npm run pack
```

The package command emits `release/com.deskit.clipboard-history-0.4.0.deskit` and a `.sha256` file.

## Manifest

The plugin requires:

- `clipboard:read` to receive clipboard-change payloads.
- `clipboard:write` to place selected content back on the clipboard.
- `storage:plugin` to persist local history and sync metadata.
- `sync:plugin` to use DesKit settings sync as a clipboard-history sync provider.
- `network:http` to read/write the optional WebDAV sync document.

The manifest declares `icon: "lucide:clipboard-list"` at both plugin and command level. Keep this aligned with the Marketplace listing so installed plugins and marketplace cards render the same icon.
