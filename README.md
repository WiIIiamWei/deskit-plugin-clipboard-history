# DesKit Clipboard History Plugin

A DesKit plugin that records clipboard changes and shows a searchable clipboard history from the launcher.

## What Works Now

- Records text, image, and file clipboard entries through `activationEvents: ["clipboard:change"]`.
- De-duplicates repeated clipboard content and keeps the newest entry first.
- Shows a searchable list in DesKit.
- Pressing `Enter` on a history row copies that item back to the clipboard.
- Each history item exposes a single `Copy` action.
- Self-triggered copies are ignored by the history collector so copied history items are not re-added.
- Stores history locally with `storage:plugin`.

## Current Host Boundary

The intended user shortcut is `Win+Ctrl+C`. The current DesKit host can open plugin commands from the launcher, but it cannot reliably paste into the previously focused text field after the DesKit window opens. This plugin therefore copies the selected history item back to the clipboard and lets the user paste it manually.

This plugin keeps the command and data shape ready for future host integration:

- command id: `clipboard-history.open`
- preferred shortcut: `Win+Ctrl+C`
- primary row action: `copy`

## Future Sync Interface

Multi-device sync is intentionally not implemented yet. The stored state reserves a `sync` object:

```ts
interface ClipboardSyncState {
  provider: string
  enabled: boolean
  cursor?: string
  lastSyncedAt?: number
}
```

Possible future providers can map to this shape without migrating local history.

## Development

```bash
npm install
npm run check
npm run pack
```

The package command emits `release/com.deskit.clipboard-history-0.3.1.deskit` and a `.sha256` file.

## Manifest

The plugin requires:

- `clipboard:read` to receive clipboard-change payloads.
- `clipboard:write` to place selected content back on the clipboard.
- `storage:plugin` to persist local history and sync metadata.

The manifest declares `icon: "lucide:clipboard-list"` at both plugin and
command level. Keep this aligned with the Marketplace listing so installed
plugins and marketplace cards render the same icon.
