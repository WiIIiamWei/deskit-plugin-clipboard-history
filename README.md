# DesKit Clipboard History Plugin

A DesKit plugin that records clipboard changes and shows a searchable clipboard history from the launcher.

## What Works Now

- Records text, image, and file clipboard entries through `activationEvents: ["clipboard:change"]`.
- De-duplicates repeated clipboard content and keeps the newest entry first.
- Shows a searchable list grouped by favorites and content type.
- Filters history by all/text/image/file entries.
- Stars favorite entries and keeps them pinned while trimming or clearing unstarred history.
- Pressing `Enter` on a history row copies that item back to the clipboard.
- Each history item exposes `Copy` and `Star`/`Unstar` actions.
- Self-triggered copies are ignored by the history collector so copied history items are not re-added.
- Stores history locally with `storage:plugin`.
- Syncs history through user-configured WebDAV credentials when enabled.

## Current Host Boundary

The intended user shortcut is `Win+Ctrl+C`. The current DesKit host can open plugin commands from the launcher, but it cannot reliably paste into the previously focused text field after the DesKit window opens. This plugin therefore copies the selected history item back to the clipboard and lets the user paste it manually.

This plugin keeps the command and data shape ready for future host integration:

- command id: `clipboard-history.open`
- preferred shortcut: `Win+Ctrl+C`
- primary row action: `copy`

## WebDAV Sync

Enable WebDAV sync in the plugin settings, then provide:

- WebDAV root URL, for example `https://dav.example.com/remote.php/dav/files/me/`.
- WebDAV username.
- WebDAV password or app token.
- Sync file path, default `deskit/clipboard-history.json`.

The plugin creates missing WebDAV collections with `MKCOL`, merges remote and
local entries by item id, and preserves the newest favorite/star state. Image
entries are synced as data URLs. File entries sync their local file paths as
metadata; those paths may not exist on another device.

Credentials are stored in DesKit plugin preferences because the current host
does not yet expose a dedicated secret vault.

## Development

```bash
npm install
npm run check
npm run pack
```

The package command emits `release/com.deskit.clipboard-history-0.3.2.deskit` and a `.sha256` file.

## Manifest

The plugin requires:

- `clipboard:read` to receive clipboard-change payloads.
- `clipboard:write` to place selected content back on the clipboard.
- `storage:plugin` to persist local history and sync metadata.
- `network:http` to read/write the WebDAV sync document.

The manifest declares `icon: "lucide:clipboard-list"` at both plugin and
command level. Keep this aligned with the Marketplace listing so installed
plugins and marketplace cards render the same icon.
