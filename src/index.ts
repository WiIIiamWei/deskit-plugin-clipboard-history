import type {
  ClipboardContent,
  ListItem,
  ListView,
  PluginContext,
  PluginModule,
  ToastOnly,
  View,
} from "@deskit/plugin-sdk"

const COMMAND_ID = "clipboard-history.open"
const HISTORY_STORAGE_KEY = "clipboard-history.state"
const DEFAULT_MAX_ITEMS = 50
const DEFAULT_SEARCH_LIMIT = 20
const DEFAULT_LOCALE: Locale = "en"
const DEFAULT_SYNC_PROVIDER = "local"
const MAX_PREVIEW_LENGTH = 140

let captureQueue: Promise<void> = Promise.resolve()

interface ClipboardChangeEvent {
  content: ClipboardContent
}

interface ClipboardHistoryItem {
  id: string
  content: ClipboardContent
  preview: string
  kind: ClipboardContent["type"]
  kindLabel: string
  updatedAt: number
  source: "local" | "sync"
}

interface ClipboardHistoryState {
  items: ClipboardHistoryItem[]
  lastSelectedId?: string
  sync: ClipboardSyncState
}

interface ClipboardSyncState {
  provider: string
  enabled: boolean
  cursor?: string
  lastSyncedAt?: number
}

interface ClipboardHistoryPreferenceSet {
  maxItems: number
  captureImages: boolean
  captureFiles: boolean
}

const plugin: PluginModule = {
  commands: {
    [COMMAND_ID]: {
      async run({ initialQuery }, ctx) {
        return makeView(initialQuery ?? "", ctx)
      },
      async onSearchChange(text, ctx) {
        return makeView(text, ctx)
      },
      async onAction(actionId, payload, ctx) {
        if (actionId === "select-item") return handleSelectItem(payload, ctx)
        if (actionId === "clear-history") return handleClearHistory(ctx)
        if (actionId === "mark-sync-ready") return handleMarkSyncReady(payload, ctx)
        return undefined
      },
    },
  },
  events: {
    async onClipboardChange(event: ClipboardChangeEvent, ctx: PluginContext) {
      captureQueue = captureQueue
        .then(() => captureClipboardContent(event.content, ctx))
        .catch((err) => ctx.log("failed to capture clipboard history", err))
      await captureQueue
    },
  },
}

async function captureClipboardContent(content: ClipboardContent, ctx: PluginContext): Promise<void> {
  const preferences = readPreferences(ctx)
  if (!shouldCapture(content, preferences)) return

  const state = await readState(ctx)
  const now = Date.now()
  const fingerprint = fingerprintContent(content)
  const nextItem: ClipboardHistoryItem = {
    id: fingerprint,
    content,
    preview: previewContent(content),
    kind: content.type,
    kindLabel: kindLabel(content),
    updatedAt: now,
    source: "local",
  }

  state.items = [nextItem, ...state.items.filter((item) => item.id !== fingerprint)].slice(
    0,
    preferences.maxItems
  )
  state.lastSelectedId ??= nextItem.id
  await writeState(ctx, state)
}

async function makeView(rawInput: string, ctx: PluginContext): Promise<ListView> {
  const locale = normalizeLocale(ctx.locale)
  const preferences = readPreferences(ctx)
  const state = await readState(ctx)
  const filtered = filterItems(state.items, rawInput, preferences.maxItems)
  const selectedId = state.lastSelectedId ?? filtered[0]?.id
  const historyItems = filtered
    .slice(0, DEFAULT_SEARCH_LIMIT)
    .map((item) => toListItem(item, locale, item.id === selectedId))

  return {
    type: "list",
    searchPlaceholder: t(locale, "Search clipboard history…", "搜索剪贴板历史…"),
    emptyText: t(locale, "No clipboard history yet", "还没有剪贴板历史"),
    sections: [
      {
        title: t(locale, "History", "历史记录"),
        items: historyItems.length > 0 ? historyItems : [emptyItem(locale, rawInput)],
      },
      {
        title: t(locale, "Controls", "控制"),
        items: controlItems(state, locale),
      },
      {
        title: t(locale, "Future sync", "后续同步"),
        items: syncItems(state.sync, locale),
      },
    ],
  }
}

async function handleSelectItem(payload: unknown, ctx: PluginContext): Promise<ToastOnly | ListView> {
  const itemId = extractStringField(payload, "itemId")
  if (!itemId) return makeView("", ctx)

  const state = await readState(ctx)
  const item = state.items.find((candidate) => candidate.id === itemId)
  if (!item) return makeView("", ctx)

  state.lastSelectedId = item.id
  await writeState(ctx, state)
  await ctx.clipboard.write(item.content)

  return {
    type: "toast",
    level: "success",
    message: t(
      normalizeLocale(ctx.locale),
      `Copied for paste: ${item.preview}`,
      `已复制，准备粘贴：${item.preview}`
    ),
  }
}

async function handleClearHistory(ctx: PluginContext): Promise<ToastOnly> {
  const state = await readState(ctx)
  state.items = []
  state.lastSelectedId = undefined
  await writeState(ctx, state)
  return {
    type: "toast",
    level: "success",
    message: t(normalizeLocale(ctx.locale), "Clipboard history cleared", "已清空剪贴板历史"),
  }
}

async function handleMarkSyncReady(payload: unknown, ctx: PluginContext): Promise<View> {
  const provider = extractStringField(payload, "provider") ?? DEFAULT_SYNC_PROVIDER
  const state = await readState(ctx)
  state.sync = {
    ...state.sync,
    provider,
    enabled: false,
    lastSyncedAt: Date.now(),
  }
  await writeState(ctx, state)
  return {
    type: "toast",
    level: "info",
    message: t(
      normalizeLocale(ctx.locale),
      `Sync placeholder saved for ${provider}`,
      `已为 ${provider} 保存同步预留状态`
    ),
  }
}

async function readState(ctx: PluginContext): Promise<ClipboardHistoryState> {
  return normalizeState(await ctx.storage.get(HISTORY_STORAGE_KEY))
}

async function writeState(ctx: PluginContext, state: ClipboardHistoryState): Promise<void> {
  await ctx.storage.set(HISTORY_STORAGE_KEY, normalizeState(state))
}

function readPreferences(ctx: PluginContext): ClipboardHistoryPreferenceSet {
  const maxItems = Number(ctx.preferences.maxItems)
  return {
    maxItems: Number.isFinite(maxItems) && maxItems > 0 ? maxItems : DEFAULT_MAX_ITEMS,
    captureImages: ctx.preferences.captureImages !== false,
    captureFiles: ctx.preferences.captureFiles !== false,
  }
}

function shouldCapture(content: ClipboardContent, preferences: ClipboardHistoryPreferenceSet): boolean {
  if (content.type === "text") return content.text.trim().length > 0
  if (content.type === "image") return preferences.captureImages
  return preferences.captureFiles && content.paths.length > 0
}

function filterItems(items: ClipboardHistoryItem[], query: string, maxItems: number): ClipboardHistoryItem[] {
  const trimmed = query.trim().toLowerCase()
  const scoped = items.slice(0, maxItems)
  if (!trimmed) return scoped
  return scoped.filter((item) => {
    const haystack = `${item.preview} ${item.kindLabel} ${item.kind} ${item.source}`.toLowerCase()
    return haystack.includes(trimmed)
  })
}

function toListItem(item: ClipboardHistoryItem, locale: Locale, selected: boolean): ListItem {
  return {
    id: item.id,
    title: item.preview,
    subtitle: t(locale, item.kindLabel, item.kindLabel),
    accessory: selected ? t(locale, "Selected", "已选中") : formatRelativeAge(item.updatedAt, locale),
    icon: iconForContent(item.content),
    actions: [
      {
        type: "paste",
        label: t(locale, "Paste", "粘贴"),
        value: item.content,
      },
      {
        type: "copy",
        label: t(locale, "Copy", "复制"),
        value: item.content,
      },
      {
        type: "custom",
        id: "select-item",
        label: t(locale, "Select", "选中"),
        payload: { itemId: item.id },
      },
    ],
  }
}

function emptyItem(locale: Locale, query: string): ListItem {
  return {
    id: `empty:${query || "root"}`,
    title: t(locale, "No matching clipboard items", "没有匹配的剪贴板内容"),
    subtitle: t(
      locale,
      "Install and enable the plugin, then copy something to start collecting history.",
      "安装并启用插件后，复制内容即可开始记录历史。"
    ),
    icon: "lucide:clipboard-list",
    actions: [],
  }
}

function controlItems(state: ClipboardHistoryState, locale: Locale): ListItem[] {
  return [
    {
      id: "control:shortcut",
      title: t(locale, "Preferred shortcut: Win+Ctrl+C", "建议快捷键：Win+Ctrl+C"),
      subtitle: t(
        locale,
        "Change this shortcut from the plugin settings page.",
        "可在插件设置页修改这个快捷键。"
      ),
      icon: "lucide:keyboard",
      actions: [],
    },
    {
      id: "control:clear",
      title: t(locale, "Clear history", "清空历史"),
      subtitle: t(locale, `${state.items.length} item(s) stored`, `已保存 ${state.items.length} 项`),
      icon: "lucide:trash-2",
      actions: [
        {
          type: "custom",
          id: "clear-history",
          label: t(locale, "Clear", "清空"),
        },
      ],
    },
  ]
}

function syncItems(sync: ClipboardSyncState, locale: Locale): ListItem[] {
  return [
    {
      id: "sync:placeholder",
      title: t(locale, "Sync adapter placeholder", "同步适配器预留"),
      subtitle: t(
        locale,
        `${sync.provider} · ${sync.enabled ? "enabled" : "disabled"} · local-only build`,
        `${sync.provider} · ${sync.enabled ? "已启用" : "未启用"} · 当前仅本地`
      ),
      icon: "lucide:cloud",
      actions: [
        {
          type: "custom",
          id: "mark-sync-ready",
          label: t(locale, "Keep local", "保持本地"),
          payload: { provider: sync.provider },
        },
      ],
    },
  ]
}

function normalizeState(value: unknown): ClipboardHistoryState {
  if (!value || typeof value !== "object") return defaultState()
  const record = value as Record<string, unknown>
  const items = Array.isArray(record.items)
    ? (record.items.map(normalizeItem).filter(Boolean) as ClipboardHistoryItem[])
    : []
  const lastSelectedId = typeof record.lastSelectedId === "string" ? record.lastSelectedId : undefined
  const sync = normalizeSync(record.sync)
  return { items, lastSelectedId, sync }
}

function normalizeItem(value: unknown): ClipboardHistoryItem | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const content = normalizeClipboardContent(record.content)
  if (!content) return null
  if (typeof record.id !== "string" || typeof record.preview !== "string") return null
  if (typeof record.updatedAt !== "number") return null
  return {
    id: record.id,
    content,
    preview: record.preview,
    kind: content.type,
    kindLabel: typeof record.kindLabel === "string" ? record.kindLabel : kindLabel(content),
    updatedAt: record.updatedAt,
    source: record.source === "sync" ? "sync" : "local",
  }
}

function normalizeSync(value: unknown): ClipboardSyncState {
  if (!value || typeof value !== "object") return defaultState().sync
  const record = value as Record<string, unknown>
  return {
    provider: typeof record.provider === "string" ? record.provider : DEFAULT_SYNC_PROVIDER,
    enabled: record.enabled === true,
    cursor: typeof record.cursor === "string" ? record.cursor : undefined,
    lastSyncedAt: typeof record.lastSyncedAt === "number" ? record.lastSyncedAt : undefined,
  }
}

function normalizeClipboardContent(value: unknown): ClipboardContent | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (record.type === "text" && typeof record.text === "string") return { type: "text", text: record.text }
  if (record.type === "image" && typeof record.dataUrl === "string" && typeof record.mimeType === "string") {
    return {
      type: "image",
      dataUrl: record.dataUrl,
      mimeType: record.mimeType,
      width: typeof record.width === "number" ? record.width : undefined,
      height: typeof record.height === "number" ? record.height : undefined,
      name: typeof record.name === "string" ? record.name : undefined,
    }
  }
  if (record.type === "file" && Array.isArray(record.paths)) {
    const paths = record.paths.filter((item): item is string => typeof item === "string")
    return paths.length > 0 ? { type: "file", paths } : null
  }
  return null
}

function defaultState(): ClipboardHistoryState {
  return {
    items: [],
    sync: {
      provider: DEFAULT_SYNC_PROVIDER,
      enabled: false,
    },
  }
}

function fingerprintContent(content: ClipboardContent): string {
  return `clip:${hashString(JSON.stringify(content))}`
}

function hashString(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function previewContent(content: ClipboardContent): string {
  if (content.type === "text") return truncateWhitespace(content.text, MAX_PREVIEW_LENGTH)
  if (content.type === "image") {
    const size = content.width && content.height ? ` · ${content.width}×${content.height}` : ""
    return content.name ? `${content.name}${size}` : `Image${size}`
  }
  return truncateWhitespace(content.paths.join("\n"), MAX_PREVIEW_LENGTH)
}

function kindLabel(content: ClipboardContent): string {
  if (content.type === "text") return "Text"
  if (content.type === "image") return content.mimeType || "Image"
  return `${content.paths.length} file(s)`
}

function iconForContent(content: ClipboardContent): string {
  if (content.type === "text") return "lucide:clipboard"
  if (content.type === "image") return "lucide:image"
  return "lucide:files"
}

function truncateWhitespace(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}…`
}

function formatRelativeAge(timestamp: number, locale: Locale): string {
  const diff = Date.now() - timestamp
  if (diff < 10_000) return t(locale, "Just now", "刚刚")
  if (diff < 60_000) {
    const seconds = Math.floor(diff / 1000)
    return t(locale, `${seconds}s ago`, `${seconds} 秒前`)
  }
  if (diff < 3_600_000) {
    const minutes = Math.floor(diff / 60_000)
    return t(locale, `${minutes}m ago`, `${minutes} 分钟前`)
  }
  const hours = Math.floor(diff / 3_600_000)
  return t(locale, `${hours}h ago`, `${hours} 小时前`)
}

function extractStringField(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === "string" ? value : undefined
}

function normalizeLocale(locale: string): Locale {
  return locale.toLowerCase().startsWith("zh") ? "zh-CN" : DEFAULT_LOCALE
}

function t(locale: Locale, en: string, zhCN: string): string {
  return locale === "zh-CN" ? zhCN : en
}

type Locale = "en" | "zh-CN"

export = plugin
