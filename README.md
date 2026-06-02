# DesKit Clipboard History Plugin

A DesKit plugin that records clipboard changes and shows a searchable clipboard history from the launcher.

## What Works Now

- Records text, image, and file clipboard entries through `activationEvents: ["clipboard:change"]`.
- De-duplicates repeated clipboard content and keeps the newest entry first.
- Shows a searchable list in DesKit.
- Pressing `Enter` on a history row uses the primary `paste` action exposed by DesKit.
- Also exposes explicit `Copy`, `Paste`, and `Select` actions on each item.
- Stores history locally with `storage:plugin`.

## Current Host Boundary

The intended user shortcut is `Win+Ctrl+C`. The current DesKit host can open plugin commands from the launcher and can execute `paste` actions by writing clipboard content and closing the launcher. A dedicated plugin-owned global shortcut and true OS-level “paste into the previous focused app” still need host support.

This plugin therefore keeps the command and data shape ready for that host integration:

- command id: `clipboard-history.open`
- preferred shortcut: `Win+Ctrl+C`
- primary row action: `paste`
- selected item state: `lastSelectedId`

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

The package command emits `release/com.deskit.clipboard-history-0.3.0.deskit` and a `.sha256` file.

## Manifest

The plugin requires:

- `clipboard:read` to receive clipboard-change payloads.
- `clipboard:write` to place selected content back on the clipboard.
- `storage:plugin` to persist local history and sync metadata.

The manifest declares `icon: "lucide:clipboard-list"` at both plugin and
command level. Keep this aligned with the Marketplace listing so installed
plugins and marketplace cards render the same icon.
