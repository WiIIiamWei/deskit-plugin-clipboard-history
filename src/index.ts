import type {
  ClipboardContent,
  ListItem,
  ListView,
  PluginContext,
  PluginModule,
  ToastOnly,
} from "@deskit/plugin-sdk"

declare function setInterval(handler: () => void, timeout: number): unknown
declare function clearInterval(handle: unknown): void

const COMMAND_ID = "clipboard-history.open"
const HISTORY_STORAGE_KEY = "clipboard-history.state"
const DEFAULT_MAX_ITEMS = 50
const DEFAULT_SEARCH_LIMIT = 20
const DEFAULT_LOCALE: Locale = "en"
const DEFAULT_FILTER: ClipboardHistoryFilter = "all"
const DEFAULT_SYNC_PROVIDER = "off"
const GIST_SYNC_PROVIDER = "gist"
const WEBDAV_SYNC_PROVIDER = "webdav"
const SYNC_STORAGE_KEY = "clipboardHistoryText"
const DEFAULT_WEBDAV_PATH = "deskit/clipboard-history.json"
const WEBDAV_TIMEOUT_MS = 4_000
const MAX_PREVIEW_LENGTH = 140
const SELF_WRITE_IGNORE_MS = 3_000
const MAX_SYNC_ITEMS = 5
const MAX_SYNC_BYTES = 512 * 1024
const MAX_TEXT_BYTES = 512 * 1024
const MAX_CLIPBOARD_ITEM_BYTES = 4 * 1024 * 1024
const MAX_IMAGE_CACHE_BYTES = 128 * 1024 * 1024
const IMAGE_CACHE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000
const IMAGE_BLOB_PREFIX = "clipboard-images"

let captureQueue: Promise<void> = Promise.resolve()
let captureInFlight = false
let pendingCapture: { content: ClipboardContent; ctx: PluginContext } | undefined
let maintenanceTimer: unknown | undefined
let maintenanceQueue: Promise<void> = Promise.resolve()
let syncQueue: Promise<void> = Promise.resolve()
const ignoredClipboardFingerprints = new Map<string, number>()

interface ClipboardChangeEvent {
  content: ClipboardContent
}

type ClipboardHistoryFilter = "all" | ClipboardContent["type"]
type SyncProvider = "off" | "gist" | "webdav"

interface ClipboardTextStoredContent {
  type: "text"
  text: string
}

interface ClipboardImageStoredContent {
  type: "image"
  blobKey: string
  mimeType: string
  byteLength: number
  width?: number
  height?: number
  name?: string
}

type ClipboardStoredContent = ClipboardTextStoredContent | ClipboardImageStoredContent

interface ClipboardHistoryItem {
  id: string
  content: ClipboardStoredContent
  preview: string
  kind: ClipboardStoredContent["type"]
  kindLabel: string
  updatedAt: number
  favorite: boolean
  favoriteUpdatedAt?: number
  source: "local" | "sync"
}

interface ClipboardHistoryState {
  items: ClipboardHistoryItem[]
  sync: ClipboardSyncState
  filter: ClipboardHistoryFilter
}

interface ClipboardSyncState {
  provider: SyncProvider
  enabled: boolean
  cursor?: string
  lastSyncedAt?: number
  lastError?: string
}

interface ClipboardHistoryPreferenceSet {
  maxItems: number
  captureImages: boolean
  syncProvider: SyncProvider
  webdavUrl: string
  webdavUsername: string
  webdavPassword: string
  webdavPath: string
}

interface ClipboardTextSyncItem {
  id: string
  text: string
  preview: string
  updatedAt: number
  favorite: boolean
  favoriteUpdatedAt?: number
}

interface ClipboardSyncDocument {
  version: 1
  pluginId: string
  updatedAt: number
  items: ClipboardTextSyncItem[]
}

interface WebDavResponse {
  status: number
  statusText: string
  ok: boolean
  body: string
}

interface StateReadResult {
  state: ClipboardHistoryState
  migrated: boolean
}

interface NormalizationState {
  migrated: boolean
}

type ListSection = { title?: string; items: ListItem[] }

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
        if (actionId === "copy-item") return handleCopyItem(payload, ctx)
        if (actionId === "toggle-favorite") return handleToggleFavorite(payload, ctx)
        if (actionId === "set-filter") return handleSetFilter(payload, ctx)
        if (actionId === "sync-now") return handleSyncNow(ctx)
        if (actionId === "clear-history") return handleClearHistory(ctx)
        return undefined
      },
      async dispose(ctx) {
        if (maintenanceTimer) {
          clearInterval(maintenanceTimer)
          maintenanceTimer = undefined
        }
        await captureQueue
        await maintenanceQueue
        const state = await readState(ctx)
        state.items = await cleanupImageBlobs(ctx, state.items)
        await writeState(ctx, state)
      },
    },
  },
  events: {
    onClipboardChange(event: ClipboardChangeEvent, ctx: PluginContext) {
      queueClipboardCapture(event.content, ctx)
    },
  },
}

function queueClipboardCapture(content: ClipboardContent, ctx: PluginContext): void {
  ensureMaintenance(ctx)
  pendingCapture = { content, ctx }
  if (captureInFlight) return

  captureInFlight = true
  captureQueue = (async () => {
    try {
      while (pendingCapture) {
        const next = pendingCapture
        pendingCapture = undefined
        try {
          await captureClipboardContent(next.content, next.ctx)
        } catch (err) {
          next.ctx.log("failed to capture clipboard history", err)
        }
      }
    } finally {
      captureInFlight = false
      if (pendingCapture) queueClipboardCapture(pendingCapture.content, pendingCapture.ctx)
    }
  })()
}

async function captureClipboardContent(content: ClipboardContent, ctx: PluginContext): Promise<void> {
  const preferences = readPreferences(ctx)
  if (!shouldCapture(content, preferences)) return
  const prepared = await prepareStoredContent(content, ctx)
  if (!prepared) return

  const fingerprint = fingerprintStoredContent(prepared.content)
  if (shouldIgnoreClipboardFingerprint(fingerprint)) return

  const state = await readState(ctx)
  const existing = state.items.find((item) => item.id === fingerprint)
  const now = Date.now()
  const nextItem: ClipboardHistoryItem = {
    id: fingerprint,
    content: prepared.content,
    preview: prepared.preview,
    kind: prepared.content.type,
    kindLabel: kindLabel(prepared.content),
    updatedAt: now,
    favorite: existing?.favorite ?? false,
    favoriteUpdatedAt: existing?.favoriteUpdatedAt,
    source: "local",
  }

  const previousItems = state.items
  state.items = await limitStoredItems(
    [nextItem, ...state.items.filter((item) => item.id !== fingerprint)],
    preferences.maxItems,
    ctx
  )
  await writeState(ctx, state)
  state.items = await cleanupUnreferencedImageBlobs(ctx, state.items, previousItems)
  await writeState(ctx, state)
  queueSync(ctx)
}

async function makeView(rawInput: string, ctx: PluginContext): Promise<ListView> {
  ensureMaintenance(ctx)
  const locale = normalizeLocale(ctx.locale)
  const preferences = readPreferences(ctx)
  const { state, migrated } = await readStateWithMigration(ctx)
  if (migrated) await writeState(ctx, state)
  const filtered = filterItems(state.items, rawInput, state.filter)
  const sections = historySections(filtered, state.filter, locale, rawInput)

  return {
    type: "list",
    searchPlaceholder: t(locale, "Search clipboard history…", "搜索剪贴板历史…"),
    emptyText: t(locale, "No clipboard history yet", "还没有剪贴板历史"),
    sections: [
      ...sections,
      {
        title: t(locale, "Controls", "控制"),
        items: controlItems(state, preferences, locale),
      },
    ],
  }
}

function ensureMaintenance(ctx: PluginContext): void {
  if (maintenanceTimer) return
  maintenanceTimer = setInterval(
    () => queueImageCacheMaintenance(ctx),
    IMAGE_CACHE_CLEANUP_INTERVAL_MS
  )
}

function queueImageCacheMaintenance(ctx: PluginContext): void {
  maintenanceQueue = maintenanceQueue
    .then(async () => {
      await captureQueue
      const { state, migrated } = await readStateWithMigration(ctx)
      const items = await cleanupImageBlobs(ctx, state.items)
      if (migrated || !sameHistoryItems(items, state.items)) {
        state.items = items
        await writeState(ctx, state)
      }
    })
    .catch((err) => ctx.log("failed to clean clipboard image cache", err))
}

async function handleCopyItem(payload: unknown, ctx: PluginContext): Promise<ToastOnly | ListView> {
  const itemId = extractStringField(payload, "itemId")
  if (!itemId) return makeView("", ctx)

  const state = await readState(ctx)
  const item = state.items.find((candidate) => candidate.id === itemId)
  if (!item) return makeView("", ctx)

  const content = await itemToClipboardContent(item, ctx)
  if (!content) {
    state.items = state.items.filter((candidate) => candidate.id !== item.id)
    await writeState(ctx, state)
    state.items = await cleanupImageBlobs(ctx, state.items)
    await writeState(ctx, state)
    return {
      type: "toast",
      level: "warning",
      message: t(
        normalizeLocale(ctx.locale),
        "Clipboard image is no longer available",
        "剪贴板图片缓存已不存在"
      ),
    }
  }

  const fingerprint = fingerprintStoredContent(item.content)
  markSelfWrittenClipboardFingerprint(fingerprint)
  try {
    await ctx.clipboard.write(content)
  } catch (err) {
    ignoredClipboardFingerprints.delete(fingerprint)
    throw err
  }

  return {
    type: "toast",
    level: "success",
    message: t(normalizeLocale(ctx.locale), `Copied: ${item.preview}`, `已复制：${item.preview}`),
  }
}

async function handleToggleFavorite(payload: unknown, ctx: PluginContext): Promise<ListView> {
  const itemId = extractStringField(payload, "itemId")
  const state = await readState(ctx)
  const item = state.items.find((candidate) => candidate.id === itemId)
  if (!item) return makeView("", ctx)

  item.favorite = !item.favorite
  item.favoriteUpdatedAt = Date.now()
  state.items = await limitStoredItems(state.items, readPreferences(ctx).maxItems, ctx)
  await writeState(ctx, state)
  state.items = await cleanupImageBlobs(ctx, state.items)
  await writeState(ctx, state)
  queueSync(ctx)
  return makeView("", ctx)
}

async function handleSetFilter(payload: unknown, ctx: PluginContext): Promise<ListView> {
  const filter = normalizeFilter(extractStringField(payload, "filter"))
  const state = await readState(ctx)
  state.filter = filter
  await writeState(ctx, state)
  return makeView("", ctx)
}

async function handleSyncNow(ctx: PluginContext): Promise<ToastOnly> {
  const locale = normalizeLocale(ctx.locale)
  const preferences = readPreferences(ctx)
  if (preferences.syncProvider === "off") {
    return {
      type: "toast",
      level: "info",
      message: t(locale, "Clipboard history sync is disabled", "剪贴板历史同步未启用"),
    }
  }
  if (!(await isSyncReady(ctx, preferences))) {
    return {
      type: "toast",
      level: "warning",
      message: syncNotReadyMessage(locale, preferences.syncProvider),
    }
  }

  try {
    const state = await syncState(ctx)
    const syncedCount = createSyncDocument(ctx.pluginId, state.items, Date.now()).items.length
    return {
      type: "toast",
      level: "success",
      message: t(
        locale,
        `Synced ${syncedCount} text clipboard item(s)`,
        `已同步 ${syncedCount} 条文本剪贴板记录`
      ),
    }
  } catch (err) {
    const providerLabel = syncProviderLabel(preferences.syncProvider)
    return {
      type: "toast",
      level: "error",
      message: t(
        locale,
        `${providerLabel} sync failed: ${errorMessage(err)}`,
        `${providerLabel} 同步失败：${errorMessage(err)}`
      ),
    }
  }
}

async function handleClearHistory(ctx: PluginContext): Promise<ToastOnly> {
  const state = await readState(ctx)
  const favoriteItems = state.items.filter((item) => item.favorite)
  const removedCount = state.items.length - favoriteItems.length
  state.items = favoriteItems
  state.items = await limitStoredItems(state.items, readPreferences(ctx).maxItems, ctx)
  await writeState(ctx, state)
  state.items = await cleanupImageBlobs(ctx, state.items)
  await writeState(ctx, state)
  queueSync(ctx)
  return {
    type: "toast",
    level: "success",
    message: t(
      normalizeLocale(ctx.locale),
      `Cleared ${removedCount} unstarred item(s); favorites were kept`,
      `已清空 ${removedCount} 条未收藏记录，收藏项已保留`
    ),
  }
}

async function readState(ctx: PluginContext): Promise<ClipboardHistoryState> {
  return (await readStateWithMigration(ctx)).state
}

async function readStateWithMigration(ctx: PluginContext): Promise<StateReadResult> {
  const raw = await ctx.storage.get(HISTORY_STORAGE_KEY)
  const migration: NormalizationState = { migrated: false }
  const state = await normalizeState(raw, ctx, migration)
  const limitedItems = await limitStoredItems(state.items, readPreferences(ctx).maxItems, ctx)
  if (!sameHistoryItems(limitedItems, state.items)) {
    state.items = limitedItems
    migration.migrated = true
  }
  return { state, migrated: migration.migrated }
}

async function writeState(ctx: PluginContext, state: ClipboardHistoryState): Promise<void> {
  await ctx.storage.set(HISTORY_STORAGE_KEY, await normalizeState(state, ctx, { migrated: false }))
}

function queueSync(ctx: PluginContext): void {
  if (readPreferences(ctx).syncProvider === "off") return
  syncQueue = syncQueue
    .then(async () => {
      if (await isSyncReady(ctx, readPreferences(ctx))) await syncState(ctx)
    })
    .catch((err) => ctx.log("failed to sync clipboard history", err))
}

async function syncState(ctx: PluginContext): Promise<ClipboardHistoryState> {
  const preferences = readPreferences(ctx)
  if (!(await isSyncReady(ctx, preferences))) {
    throw new Error(`${syncProviderLabel(preferences.syncProvider)} sync is not configured`)
  }

  try {
    const remoteItems = await readRemoteSyncItems(ctx, preferences)
    const current = await readState(ctx)
    const now = Date.now()
    const nextState: ClipboardHistoryState = {
      ...current,
      items: await limitStoredItems(
        mergeClipboardItems(current.items, remoteItems),
        preferences.maxItems,
        ctx
      ),
      sync: {
        provider: preferences.syncProvider,
        enabled: true,
        lastSyncedAt: now,
      },
    }
    await writeState(ctx, nextState)
    nextState.items = await cleanupImageBlobs(ctx, nextState.items)
    await writeState(ctx, nextState)
    await writeRemoteSyncItems(ctx, preferences, nextState.items, now)
    return nextState
  } catch (err) {
    await recordSyncError(ctx, preferences.syncProvider, err)
    throw err
  }
}

async function readRemoteSyncItems(
  ctx: PluginContext,
  preferences: ClipboardHistoryPreferenceSet
): Promise<ClipboardHistoryItem[]> {
  if (preferences.syncProvider === GIST_SYNC_PROVIDER) {
    return syncDocumentToHistoryItems(await ctx.sync.get<ClipboardSyncDocument>(SYNC_STORAGE_KEY))
  }
  return readWebDavItems(ctx, preferences)
}

async function writeRemoteSyncItems(
  ctx: PluginContext,
  preferences: ClipboardHistoryPreferenceSet,
  items: ClipboardHistoryItem[],
  updatedAt: number
): Promise<void> {
  const document = createSyncDocument(ctx.pluginId, items, updatedAt)
  if (preferences.syncProvider === GIST_SYNC_PROVIDER) {
    await ctx.sync.set(SYNC_STORAGE_KEY, document)
    return
  }
  await ensureWebDavCollections(ctx, preferences)
  await writeWebDavDocument(ctx, preferences, document)
}

async function readWebDavItems(
  ctx: PluginContext,
  preferences: ClipboardHistoryPreferenceSet
): Promise<ClipboardHistoryItem[]> {
  const response = await webDavRequest(ctx, preferences, webDavFileUrl(preferences), "GET")
  if (response.status === 404) return []
  if (!response.ok) throw new Error(`GET ${response.status} ${response.statusText}`)
  if (!response.body.trim()) return []

  const parsed = JSON.parse(response.body) as unknown
  return syncDocumentToHistoryItems(parsed)
}

async function writeWebDavDocument(
  ctx: PluginContext,
  preferences: ClipboardHistoryPreferenceSet,
  document: ClipboardSyncDocument
): Promise<void> {
  const response = await webDavRequest(
    ctx,
    preferences,
    webDavFileUrl(preferences),
    "PUT",
    `${JSON.stringify(document, null, 2)}\n`
  )
  if (!response.ok) throw new Error(`PUT ${response.status} ${response.statusText}`)
}

function createSyncDocument(
  pluginId: string,
  items: ClipboardHistoryItem[],
  updatedAt: number
): ClipboardSyncDocument {
  return fitSyncDocument({
    version: 1,
    pluginId,
    updatedAt,
    items: sortItemsForSync(items)
      .filter((item) => item.content.type === "text")
      .slice(0, MAX_SYNC_ITEMS)
      .map(historyItemToSyncItem),
  })
}

function fitSyncDocument(document: ClipboardSyncDocument): ClipboardSyncDocument {
  const next: ClipboardSyncDocument = { ...document, items: [...document.items] }
  while (jsonByteLength(next) > MAX_SYNC_BYTES && next.items.length > 0) {
    let largestIndex = 0
    let largestSize = -1
    for (const [index, item] of next.items.entries()) {
      const size = jsonByteLength(item)
      if (size > largestSize) {
        largestSize = size
        largestIndex = index
      }
    }
    next.items.splice(largestIndex, 1)
  }
  return next
}

function sortItemsForSync(items: ClipboardHistoryItem[]): ClipboardHistoryItem[] {
  return [...items].sort((left, right) => {
    return right.updatedAt - left.updatedAt || right.id.localeCompare(left.id)
  })
}

function jsonByteLength(value: unknown): number {
  return utf8Bytes(JSON.stringify(value)).length
}

function historyItemToSyncItem(item: ClipboardHistoryItem): ClipboardTextSyncItem {
  const next: ClipboardTextSyncItem = {
    id: item.id,
    text: item.content.type === "text" ? item.content.text : "",
    preview: item.preview,
    updatedAt: item.updatedAt,
    favorite: item.favorite,
  }
  if (typeof item.favoriteUpdatedAt === "number") {
    next.favoriteUpdatedAt = item.favoriteUpdatedAt
  }
  return next
}

function syncDocumentToHistoryItems(value: unknown): ClipboardHistoryItem[] {
  if (!value || typeof value !== "object") return []
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.items)) return []
  return record.items
    .map(normalizeSyncItem)
    .filter(isClipboardHistoryItem)
    .map((item) => ({ ...item, source: "sync" }))
}

function normalizeSyncItem(value: unknown): ClipboardHistoryItem | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const oldContent = normalizeClipboardContent(record.content)
  const text =
    typeof record.text === "string"
      ? record.text
      : oldContent?.type === "text"
        ? oldContent.text
        : undefined
  if (typeof text !== "string" || typeof record.updatedAt !== "number") return null
  const content: ClipboardTextStoredContent = {
    type: "text",
    text: truncateUtf8(text, MAX_TEXT_BYTES),
  }
  const id =
    typeof record.id === "string" && record.id ? record.id : fingerprintStoredContent(content)
  const preview =
    typeof record.preview === "string" && record.preview
      ? truncateWhitespace(record.preview, MAX_PREVIEW_LENGTH)
      : previewContent(content)
  return {
    id,
    content,
    preview,
    kind: "text",
    kindLabel: "Text",
    updatedAt: record.updatedAt,
    favorite: record.favorite === true,
    favoriteUpdatedAt:
      typeof record.favoriteUpdatedAt === "number" ? record.favoriteUpdatedAt : undefined,
    source: "sync",
  }
}

async function ensureWebDavCollections(
  ctx: PluginContext,
  preferences: ClipboardHistoryPreferenceSet
): Promise<void> {
  const segments = webDavPathSegments(preferences.webdavPath).slice(0, -1)
  let currentPath = ""
  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment
    const response = await webDavRequest(
      ctx,
      preferences,
      buildWebDavUrl(preferences.webdavUrl, currentPath, true),
      "MKCOL"
    )
    if (![200, 201, 405].includes(response.status)) {
      throw new Error(`MKCOL ${response.status} ${response.statusText}`)
    }
  }
}

async function webDavRequest(
  ctx: PluginContext,
  preferences: ClipboardHistoryPreferenceSet,
  url: string,
  method: string,
  body?: string
): Promise<WebDavResponse> {
  if (!ctx.network) throw new Error("DesKit network API is not available")
  return ctx.network.request(url, {
    method,
    headers: webDavHeaders(preferences, body !== undefined),
    ...(body !== undefined ? { body } : {}),
    timeoutMs: WEBDAV_TIMEOUT_MS,
  })
}

async function recordSyncError(
  ctx: PluginContext,
  provider: SyncProvider,
  err: unknown
): Promise<void> {
  const state = await readState(ctx)
  state.sync = {
    provider,
    enabled: true,
    lastSyncedAt: state.sync.lastSyncedAt,
    lastError: truncateWhitespace(errorMessage(err), 120),
  }
  await writeState(ctx, state)
}

function webDavHeaders(
  preferences: ClipboardHistoryPreferenceSet,
  hasBody: boolean
): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Basic ${base64Encode(`${preferences.webdavUsername}:${preferences.webdavPassword}`)}`,
    ...(hasBody ? { "Content-Type": "application/json; charset=utf-8" } : {}),
  }
}

function webDavFileUrl(preferences: ClipboardHistoryPreferenceSet): string {
  return buildWebDavUrl(preferences.webdavUrl, preferences.webdavPath, false)
}

function buildWebDavUrl(baseUrl: string, remotePath: string, trailingSlash: boolean): string {
  const root = baseUrl.trim().replace(/\/+$/, "")
  const encodedPath = webDavPathSegments(remotePath).map(encodeURIComponent).join("/")
  return `${root}/${encodedPath}${trailingSlash ? "/" : ""}`
}

function webDavPathSegments(remotePath: string): string[] {
  const segments = remotePath
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
  return segments.length > 0 ? segments : DEFAULT_WEBDAV_PATH.split("/")
}

function isWebDavSyncReady(preferences: ClipboardHistoryPreferenceSet): boolean {
  return (
    preferences.syncProvider === WEBDAV_SYNC_PROVIDER &&
    preferences.webdavUrl.length > 0 &&
    preferences.webdavUsername.length > 0 &&
    preferences.webdavPassword.length > 0
  )
}

async function isSyncReady(
  ctx: PluginContext,
  preferences: ClipboardHistoryPreferenceSet
): Promise<boolean> {
  if (preferences.syncProvider === GIST_SYNC_PROVIDER) {
    return (await ctx.sync.status()).available
  }
  if (preferences.syncProvider === WEBDAV_SYNC_PROVIDER) return isWebDavSyncReady(preferences)
  return false
}

function mergeClipboardItems(
  localItems: ClipboardHistoryItem[],
  remoteItems: ClipboardHistoryItem[]
): ClipboardHistoryItem[] {
  const merged = new Map<string, ClipboardHistoryItem>()
  for (const item of localItems) merged.set(item.id, { ...item, source: "local" })
  for (const remoteItem of remoteItems) {
    const existing = merged.get(remoteItem.id)
    merged.set(remoteItem.id, existing ? mergeClipboardItem(existing, remoteItem) : remoteItem)
  }
  return sortItems([...merged.values()])
}

function mergeClipboardItem(
  localItem: ClipboardHistoryItem,
  remoteItem: ClipboardHistoryItem
): ClipboardHistoryItem {
  const contentItem = remoteItem.updatedAt > localItem.updatedAt ? remoteItem : localItem
  const localFavoriteAt = localItem.favoriteUpdatedAt ?? localItem.updatedAt
  const remoteFavoriteAt = remoteItem.favoriteUpdatedAt ?? remoteItem.updatedAt
  if (remoteFavoriteAt > localFavoriteAt) {
    return {
      ...contentItem,
      favorite: remoteItem.favorite,
      favoriteUpdatedAt: remoteItem.favoriteUpdatedAt,
      source: contentItem === remoteItem ? "sync" : localItem.source,
    }
  }
  if (localFavoriteAt > remoteFavoriteAt) {
    return {
      ...contentItem,
      favorite: localItem.favorite,
      favoriteUpdatedAt: localItem.favoriteUpdatedAt,
      source: contentItem === remoteItem ? "sync" : localItem.source,
    }
  }
  return {
    ...contentItem,
    favorite: localItem.favorite || remoteItem.favorite,
    favoriteUpdatedAt: localItem.favoriteUpdatedAt ?? remoteItem.favoriteUpdatedAt,
    source: contentItem === remoteItem ? "sync" : localItem.source,
  }
}

function markSelfWrittenClipboardFingerprint(fingerprint: string): void {
  pruneIgnoredClipboardFingerprints()
  ignoredClipboardFingerprints.set(fingerprint, Date.now() + SELF_WRITE_IGNORE_MS)
}

function shouldIgnoreClipboardFingerprint(fingerprint: string): boolean {
  pruneIgnoredClipboardFingerprints()
  const expiresAt = ignoredClipboardFingerprints.get(fingerprint)
  if (!expiresAt) return false
  ignoredClipboardFingerprints.delete(fingerprint)
  return expiresAt > Date.now()
}

function pruneIgnoredClipboardFingerprints(now = Date.now()): void {
  for (const [fingerprint, expiresAt] of ignoredClipboardFingerprints) {
    if (expiresAt <= now) ignoredClipboardFingerprints.delete(fingerprint)
  }
}

function readPreferences(ctx: PluginContext): ClipboardHistoryPreferenceSet {
  const maxItems = Number(ctx.preferences.maxItems)
  return {
    maxItems: Number.isFinite(maxItems) && maxItems > 0 ? maxItems : DEFAULT_MAX_ITEMS,
    captureImages: ctx.preferences.captureImages !== false,
    syncProvider: readSyncProvider(ctx),
    webdavUrl: readStringPreference(ctx, "webdavUrl"),
    webdavUsername: readStringPreference(ctx, "webdavUsername"),
    webdavPassword: readStringPreference(ctx, "webdavPassword", false),
    webdavPath: readStringPreference(ctx, "webdavPath") || DEFAULT_WEBDAV_PATH,
  }
}

function readStringPreference(ctx: PluginContext, key: string, trim = true): string {
  const value = ctx.preferences[key]
  if (typeof value !== "string") return ""
  return trim ? value.trim() : value
}

function readSyncProvider(ctx: PluginContext): SyncProvider {
  const provider = ctx.preferences.syncProvider
  if (provider === GIST_SYNC_PROVIDER || provider === WEBDAV_SYNC_PROVIDER) return provider
  return DEFAULT_SYNC_PROVIDER
}

function normalizeSyncProvider(value: unknown): SyncProvider {
  return value === GIST_SYNC_PROVIDER || value === WEBDAV_SYNC_PROVIDER
    ? value
    : DEFAULT_SYNC_PROVIDER
}

function syncProviderLabel(provider: SyncProvider): string {
  if (provider === GIST_SYNC_PROVIDER) return "DesKit settings sync"
  if (provider === WEBDAV_SYNC_PROVIDER) return "WebDAV"
  return "Clipboard history"
}

function syncNotReadyMessage(locale: Locale, provider: SyncProvider): string {
  if (provider === GIST_SYNC_PROVIDER) {
    return t(
      locale,
      "DesKit settings sync is not enabled or GitHub is not connected",
      "DesKit 设置同步未启用，或尚未连接 GitHub"
    )
  }
  if (provider === WEBDAV_SYNC_PROVIDER) {
    return t(locale, "WebDAV URL or credentials are incomplete", "WebDAV URL 或凭据不完整")
  }
  return t(locale, "Clipboard history sync is disabled", "剪贴板历史同步未启用")
}

function shouldCapture(
  content: ClipboardContent,
  preferences: ClipboardHistoryPreferenceSet
): boolean {
  if (content.type === "text") return content.text.trim().length > 0
  const decoded = splitDataUrl(content.dataUrl)
  if (!decoded || decoded.byteLength > MAX_CLIPBOARD_ITEM_BYTES) return false
  return preferences.captureImages
}

function filterItems(
  items: ClipboardHistoryItem[],
  query: string,
  filter: ClipboardHistoryFilter
): ClipboardHistoryItem[] {
  const trimmed = query.trim().toLowerCase()
  const scoped = filter === "all" ? items : items.filter((item) => item.kind === filter)
  if (!trimmed) return sortItems(scoped)
  return sortItems(
    scoped.filter((item) => {
      const haystack =
        `${item.preview} ${item.kindLabel} ${item.kind} ${item.source}`.toLowerCase()
      return haystack.includes(trimmed)
    })
  )
}

function historySections(
  items: ClipboardHistoryItem[],
  filter: ClipboardHistoryFilter,
  locale: Locale,
  rawInput: string
): ListSection[] {
  const favorites = items.filter((item) => item.favorite)
  const regularItems = items.filter((item) => !item.favorite)
  const sections: ListSection[] = []

  if (favorites.length > 0) {
    sections.push({
      title: t(locale, "Favorites", "收藏"),
      items: favorites.slice(0, DEFAULT_SEARCH_LIMIT).map((item) => toListItem(item, locale)),
    })
  }

  if (filter === "all") {
    for (const kind of ["text", "image"] as const) {
      const group = regularItems.filter((item) => item.kind === kind)
      if (group.length > 0) {
        sections.push({
          title: groupTitle(kind, locale),
          items: group.slice(0, DEFAULT_SEARCH_LIMIT).map((item) => toListItem(item, locale)),
        })
      }
    }
  } else if (regularItems.length > 0) {
    sections.push({
      title: t(locale, "History", "历史记录"),
      items: regularItems.slice(0, DEFAULT_SEARCH_LIMIT).map((item) => toListItem(item, locale)),
    })
  }

  if (sections.length === 0) {
    sections.push({
      title: t(locale, "History", "历史记录"),
      items: [emptyItem(locale, rawInput)],
    })
  }

  return sections
}

function toListItem(item: ClipboardHistoryItem, locale: Locale): ListItem {
  return {
    id: item.id,
    title: item.preview,
    subtitle: `${item.kindLabel} · ${sourceLabel(item.source, locale)}`,
    accessory: formatRelativeAge(item.updatedAt, locale),
    icon: iconForContent(item.content),
    actions: [
      {
        type: "custom",
        id: "copy-item",
        label: t(locale, "Copy", "复制"),
        icon: "lucide:copy",
        payload: { itemId: item.id },
      },
      {
        type: "custom",
        id: "toggle-favorite",
        label: item.favorite ? t(locale, "Unstar", "取消收藏") : t(locale, "Star", "收藏"),
        icon: "lucide:star",
        active: item.favorite,
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
      "Copy text or images to start collecting history.",
      "复制文本或图片后即可开始记录历史。"
    ),
    icon: "lucide:clipboard-list",
    actions: [],
  }
}

function controlItems(
  state: ClipboardHistoryState,
  preferences: ClipboardHistoryPreferenceSet,
  locale: Locale
): ListItem[] {
  const unstarredCount = state.items.filter((item) => !item.favorite).length
  return [
    ...filterControlItems(state.filter, locale),
    {
      id: "control:sync",
      title: t(locale, "Clipboard sync", "剪贴板同步"),
      subtitle: syncSubtitle(state.sync, preferences, locale),
      icon: syncIcon(state.sync, preferences),
      actions: [
        {
          type: "custom",
          id: "sync-now",
          label: t(locale, "Sync now", "立即同步"),
        },
      ],
    },
    {
      id: "control:clear",
      title: t(locale, "Clear unstarred history", "清空未收藏历史"),
      subtitle: t(
        locale,
        `${unstarredCount} unstarred item(s); favorites stay pinned`,
        `${unstarredCount} 条未收藏记录；收藏项会保留置顶`
      ),
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

function filterControlItems(filter: ClipboardHistoryFilter, locale: Locale): ListItem[] {
  const options: Array<{
    filter: ClipboardHistoryFilter
    title: string
    subtitle: string
    icon: string
  }> = [
    {
      filter: "all",
      title: t(locale, "All types", "全部类型"),
      subtitle: t(locale, "Show text and images", "显示文本和图片"),
      icon: "lucide:list-filter",
    },
    {
      filter: "text",
      title: t(locale, "Text only", "仅文本"),
      subtitle: t(locale, "Show text clipboard entries", "仅显示文本剪贴板记录"),
      icon: "lucide:clipboard",
    },
    {
      filter: "image",
      title: t(locale, "Images only", "仅图片"),
      subtitle: t(locale, "Show image clipboard entries", "仅显示图片剪贴板记录"),
      icon: "lucide:image",
    },
  ]

  return options.map((option) => ({
    id: `filter:${option.filter}`,
    title: option.title,
    subtitle: option.subtitle,
    accessoryIcon: option.filter === filter ? "lucide:check" : undefined,
    accessoryIconActive: option.filter === filter,
    icon: option.icon,
    actions: [
      {
        type: "custom",
        id: "set-filter",
        label: t(locale, "Select", "选择"),
        payload: { filter: option.filter },
      },
    ],
  }))
}

function syncSubtitle(
  sync: ClipboardSyncState,
  preferences: ClipboardHistoryPreferenceSet,
  locale: Locale
): string {
  if (preferences.syncProvider === "off") return t(locale, "Disabled", "未启用")
  if (preferences.syncProvider === GIST_SYNC_PROVIDER) {
    return sync.lastError
      ? t(locale, `Last error: ${sync.lastError}`, `最近错误：${sync.lastError}`)
      : t(
          locale,
          "Uses DesKit settings sync; only recent text items are synced",
          "使用 DesKit 设置同步；仅同步最近的文本记录"
        )
  }
  if (!isWebDavSyncReady(preferences)) {
    return t(locale, "Enabled, but URL or credentials are incomplete", "已启用，但 URL 或凭据不完整")
  }
  if (sync.lastError) return t(locale, `Last error: ${sync.lastError}`, `最近错误：${sync.lastError}`)
  if (sync.lastSyncedAt) {
    return t(
      locale,
      `Last synced ${formatRelativeAge(sync.lastSyncedAt, locale)}`,
      `上次同步于${formatRelativeAge(sync.lastSyncedAt, locale)}`
    )
  }
  return t(locale, "Ready to sync", "可以同步")
}

function syncIcon(sync: ClipboardSyncState, preferences: ClipboardHistoryPreferenceSet): string {
  if (preferences.syncProvider === "off") return "lucide:cloud-off"
  if (preferences.syncProvider === GIST_SYNC_PROVIDER) {
    return sync.lastError ? "lucide:cloud-alert" : "lucide:cloud-check"
  }
  if (!isWebDavSyncReady(preferences) || sync.lastError) return "lucide:cloud-alert"
  return "lucide:cloud-check"
}

async function prepareStoredContent(
  content: ClipboardContent,
  ctx: PluginContext
): Promise<{ content: ClipboardStoredContent; preview: string } | null> {
  if (content.type === "text") {
    const text = truncateUtf8(content.text, MAX_TEXT_BYTES)
    if (!text.trim()) return null
    const storedContent: ClipboardTextStoredContent = { type: "text", text }
    return { content: storedContent, preview: previewContent(storedContent) }
  }

  const decoded = splitDataUrl(content.dataUrl)
  if (!decoded) return null
  if (decoded.byteLength > MAX_CLIPBOARD_ITEM_BYTES) return null
  const mimeType = content.mimeType || decoded.mimeType
  const blobKey = imageBlobKey(content.dataUrl, mimeType)
  await ctx.storage.writeBlob(blobKey, decoded.base64, { encoding: "base64" })
  const storedContent: ClipboardImageStoredContent = {
    type: "image",
    blobKey,
    mimeType,
    byteLength: decoded.byteLength,
    width: content.width,
    height: content.height,
    name: content.name,
  }
  return { content: storedContent, preview: previewContent(storedContent) }
}

async function itemToClipboardContent(
  item: ClipboardHistoryItem,
  ctx: PluginContext
): Promise<ClipboardContent | null> {
  if (item.content.type === "text") return { type: "text", text: item.content.text }
  const base64 = await ctx.storage.readBlob(item.content.blobKey, { encoding: "base64" })
  if (!base64) return null
  return {
    type: "image",
    dataUrl: `data:${item.content.mimeType};base64,${base64}`,
    mimeType: item.content.mimeType,
    width: item.content.width,
    height: item.content.height,
    name: item.content.name,
  }
}

async function normalizeState(
  value: unknown,
  ctx: PluginContext,
  migration: NormalizationState
): Promise<ClipboardHistoryState> {
  if (!value || typeof value !== "object") return defaultState()
  const record = value as Record<string, unknown>
  const items: ClipboardHistoryItem[] = []
  if (Array.isArray(record.items)) {
    for (const item of record.items) {
      const normalized = await normalizeItem(item, ctx, migration)
      if (normalized) {
        items.push(normalized)
      } else {
        migration.migrated = true
      }
    }
  }
  const sync = normalizeSync(record.sync)
  const filter = normalizeFilter(record.filter)
  return { items: sortItems(items), sync, filter }
}

async function normalizeItem(
  value: unknown,
  ctx: PluginContext,
  migration: NormalizationState
): Promise<ClipboardHistoryItem | null> {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const content = await normalizeStoredContent(record.content, ctx, migration)
  if (!content) return null
  if (typeof record.id !== "string") return null
  if (typeof record.updatedAt !== "number") return null
  const originalPreview = typeof record.preview === "string" ? record.preview : undefined
  const preview =
    originalPreview !== undefined
      ? truncateWhitespace(originalPreview, MAX_PREVIEW_LENGTH)
      : previewContent(content)
  const nextPreview = content.type === "text" ? previewContent(content) : preview
  if (nextPreview !== originalPreview) migration.migrated = true
  return {
    id: record.id,
    content,
    preview: nextPreview,
    kind: content.type,
    kindLabel: typeof record.kindLabel === "string" ? record.kindLabel : kindLabel(content),
    updatedAt: record.updatedAt,
    favorite: record.favorite === true,
    favoriteUpdatedAt:
      typeof record.favoriteUpdatedAt === "number" ? record.favoriteUpdatedAt : undefined,
    source: record.source === "sync" ? "sync" : "local",
  }
}

function normalizeSync(value: unknown): ClipboardSyncState {
  if (!value || typeof value !== "object") return defaultState().sync
  const record = value as Record<string, unknown>
  return {
    provider: normalizeSyncProvider(record.provider),
    enabled: record.enabled === true,
    cursor: typeof record.cursor === "string" ? record.cursor : undefined,
    lastSyncedAt: typeof record.lastSyncedAt === "number" ? record.lastSyncedAt : undefined,
    lastError: typeof record.lastError === "string" ? record.lastError : undefined,
  }
}

async function normalizeStoredContent(
  value: unknown,
  ctx: PluginContext,
  migration: NormalizationState
): Promise<ClipboardStoredContent | null> {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (record.type === "text" && typeof record.text === "string") {
    const text = truncateUtf8(record.text, MAX_TEXT_BYTES)
    if (text !== record.text) migration.migrated = true
    return text.trim() ? { type: "text", text } : null
  }
  if (
    record.type === "image" &&
    typeof record.blobKey === "string" &&
    typeof record.mimeType === "string"
  ) {
    const byteLength = typeof record.byteLength === "number" ? record.byteLength : 0
    if (byteLength > MAX_CLIPBOARD_ITEM_BYTES) {
      migration.migrated = true
      return null
    }
    return {
      type: "image",
      blobKey: record.blobKey,
      mimeType: record.mimeType,
      byteLength,
      width: typeof record.width === "number" ? record.width : undefined,
      height: typeof record.height === "number" ? record.height : undefined,
      name: typeof record.name === "string" ? record.name : undefined,
    }
  }
  if (
    record.type === "image" &&
    typeof record.dataUrl === "string" &&
    typeof record.mimeType === "string"
  ) {
    const prepared = await prepareStoredContent(
      {
        type: "image",
        dataUrl: record.dataUrl,
        mimeType: record.mimeType,
        width: typeof record.width === "number" ? record.width : undefined,
        height: typeof record.height === "number" ? record.height : undefined,
        name: typeof record.name === "string" ? record.name : undefined,
      },
      ctx
    )
    migration.migrated = true
    return prepared?.content ?? null
  }
  return null
}

function normalizeClipboardContent(value: unknown): ClipboardContent | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (record.type === "text" && typeof record.text === "string") {
    return { type: "text", text: truncateUtf8(record.text, MAX_TEXT_BYTES) }
  }
  if (
    record.type === "image" &&
    typeof record.dataUrl === "string" &&
    typeof record.mimeType === "string"
  ) {
    return {
      type: "image",
      dataUrl: record.dataUrl,
      mimeType: record.mimeType,
      width: typeof record.width === "number" ? record.width : undefined,
      height: typeof record.height === "number" ? record.height : undefined,
      name: typeof record.name === "string" ? record.name : undefined,
    }
  }
  return null
}

function normalizeFilter(value: unknown): ClipboardHistoryFilter {
  return value === "text" || value === "image" ? value : DEFAULT_FILTER
}

function defaultState(): ClipboardHistoryState {
  return {
    items: [],
    sync: {
      provider: DEFAULT_SYNC_PROVIDER,
      enabled: false,
    },
    filter: DEFAULT_FILTER,
  }
}

function isClipboardHistoryItem(item: ClipboardHistoryItem | null): item is ClipboardHistoryItem {
  return item !== null
}

function sameHistoryItems(left: ClipboardHistoryItem[], right: ClipboardHistoryItem[]): boolean {
  if (left.length !== right.length) return false
  return left.every((item, index) => {
    const other = right[index]
    if (!other || item.id !== other.id || item.kind !== other.kind) return false
    if (item.content.type !== other.content.type) return false
    if (item.content.type === "text" && other.content.type === "text") {
      return item.content.text === other.content.text
    }
    if (item.content.type === "image" && other.content.type === "image") {
      return (
        item.content.blobKey === other.content.blobKey &&
        item.content.byteLength === other.content.byteLength
      )
    }
    return false
  })
}

async function limitStoredItems(
  items: ClipboardHistoryItem[],
  maxRegularItems: number,
  ctx: PluginContext
): Promise<ClipboardHistoryItem[]> {
  const sorted = sortItems(items)
  const favorites = sorted.filter((item) => item.favorite)
  const regularItems = sorted.filter((item) => !item.favorite).slice(0, maxRegularItems)
  return limitImageCacheItems([...favorites, ...regularItems], await ctx.storage.listBlobs())
}

function limitImageCacheItems(
  items: ClipboardHistoryItem[],
  blobs: Array<{ key: string; size: number; updatedAt: number }>
): ClipboardHistoryItem[] {
  const blobSizes = new Map(blobs.map((blob) => [blob.key, blob.size]))
  const selected: ClipboardHistoryItem[] = []
  let imageBytes = 0

  for (const item of sortItems(items)) {
    if (item.content.type !== "image") {
      selected.push(item)
      continue
    }
    const size = blobSizes.get(item.content.blobKey)
    if (size === undefined) continue
    if (size > MAX_CLIPBOARD_ITEM_BYTES) continue
    if (imageBytes + size > MAX_IMAGE_CACHE_BYTES) continue
    selected.push({ ...item, content: { ...item.content, byteLength: size } })
    imageBytes += size
  }

  return sortItems(selected)
}

async function cleanupUnreferencedImageBlobs(
  ctx: PluginContext,
  nextItems: ClipboardHistoryItem[],
  previousItems: ClipboardHistoryItem[]
): Promise<ClipboardHistoryItem[]> {
  const nextKeys = imageBlobKeys(nextItems)
  await Promise.all(
    [...imageBlobKeys(previousItems)]
      .filter((key) => !nextKeys.has(key))
      .map((key) => ctx.storage.deleteBlob(key))
  )
  return cleanupImageBlobs(ctx, nextItems)
}

async function cleanupImageBlobs(
  ctx: PluginContext,
  items: ClipboardHistoryItem[]
): Promise<ClipboardHistoryItem[]> {
  const keepKeys = imageBlobKeys(items)
  const blobs = await ctx.storage.listBlobs()
  const imageBlobs = blobs
    .filter((blob) => blob.key.startsWith(`${IMAGE_BLOB_PREFIX}/`))
    .sort((left, right) => {
      const leftItem = imageItemForBlob(items, left.key)
      const rightItem = imageItemForBlob(items, right.key)
      if (leftItem?.favorite !== rightItem?.favorite) return leftItem?.favorite ? 1 : -1
      return (leftItem?.updatedAt ?? left.updatedAt) - (rightItem?.updatedAt ?? right.updatedAt)
    })

  let total = 0
  const deleteKeys = new Set<string>()
  for (const blob of imageBlobs) {
    if (!keepKeys.has(blob.key)) {
      deleteKeys.add(blob.key)
      continue
    }
    total += blob.size
  }

  for (const blob of imageBlobs) {
    if (total <= MAX_IMAGE_CACHE_BYTES) break
    if (deleteKeys.has(blob.key)) continue
    deleteKeys.add(blob.key)
    total -= blob.size
  }

  await Promise.all([...deleteKeys].map((key) => ctx.storage.deleteBlob(key)))
  if (deleteKeys.size === 0) return items
  return items.filter(
    (item) => item.content.type !== "image" || !deleteKeys.has(item.content.blobKey)
  )
}

function imageBlobKeys(items: ClipboardHistoryItem[]): Set<string> {
  return new Set(
    items.flatMap((item) => (item.content.type === "image" ? [item.content.blobKey] : []))
  )
}

function imageItemForBlob(
  items: ClipboardHistoryItem[],
  key: string
): ClipboardHistoryItem | undefined {
  return items.find((item) => item.content.type === "image" && item.content.blobKey === key)
}

function sortItems(items: ClipboardHistoryItem[]): ClipboardHistoryItem[] {
  return [...items].sort((left, right) => {
    if (left.favorite !== right.favorite) return right.favorite ? 1 : -1
    const leftSortAt = left.favorite ? left.favoriteUpdatedAt ?? left.updatedAt : left.updatedAt
    const rightSortAt = right.favorite ? right.favoriteUpdatedAt ?? right.updatedAt : right.updatedAt
    return rightSortAt - leftSortAt || right.updatedAt - left.updatedAt
  })
}

function fingerprintStoredContent(content: ClipboardStoredContent): string {
  if (content.type === "text") return `clip:${hashString(content.text)}`
  return `clip:${hashString(content.blobKey)}`
}

function hashString(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function previewContent(content: ClipboardStoredContent): string {
  if (content.type === "text") return truncateWhitespace(content.text, MAX_PREVIEW_LENGTH)
  const size = content.width && content.height ? ` · ${content.width}×${content.height}` : ""
  return content.name ? `${content.name}${size}` : `Image${size}`
}

function kindLabel(content: ClipboardStoredContent): string {
  return content.type === "text" ? "Text" : content.mimeType || "Image"
}

function iconForContent(content: ClipboardStoredContent): string {
  return content.type === "text" ? "lucide:clipboard" : "lucide:image"
}

function groupTitle(kind: ClipboardStoredContent["type"], locale: Locale): string {
  return kind === "text" ? t(locale, "Text", "文本") : t(locale, "Images", "图片")
}

function splitDataUrl(
  dataUrl: string
): { mimeType: string; base64: string; byteLength: number } | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!match) return null
  const base64 = match[2]
  return { mimeType: match[1], base64, byteLength: base64ByteLength(base64) }
}

function imageBlobKey(dataUrl: string, mimeType: string): string {
  const extension = imageExtension(mimeType)
  return `${IMAGE_BLOB_PREFIX}/${hashString(dataUrl)}.${extension}`
}

function imageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg"
  if (mimeType === "image/webp") return "webp"
  return "png"
}

function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding)
}

function sourceLabel(source: ClipboardHistoryItem["source"], locale: Locale): string {
  return source === "sync" ? t(locale, "Synced", "已同步") : t(locale, "Local", "本地")
}

function truncateWhitespace(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}…`
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0
  let end = 0
  for (const char of value) {
    const charBytes = utf8Bytes(char).length
    if (bytes + charBytes > maxBytes) break
    bytes += charBytes
    end += char.length
  }
  return value.slice(0, end)
}

function formatRelativeAge(timestamp: number, locale: Locale): string {
  const diff = Date.now() - timestamp
  if (diff < 10_000) return t(locale, "just now", "刚刚")
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

function base64Encode(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  const bytes = utf8Bytes(value)
  let result = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    result += alphabet[first >> 2]
    result += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)]
    result += second === undefined ? "=" : alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)]
    result += third === undefined ? "=" : alphabet[third & 63]
  }
  return result
}

function utf8Bytes(value: string): number[] {
  const bytes: number[] = []
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint <= 0x7f) {
      bytes.push(codePoint)
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f))
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      )
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      )
    }
  }
  return bytes
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function normalizeLocale(locale: string): Locale {
  return locale.toLowerCase().startsWith("zh") ? "zh-CN" : DEFAULT_LOCALE
}

function t(locale: Locale, en: string, zhCN: string): string {
  return locale === "zh-CN" ? zhCN : en
}

type Locale = "en" | "zh-CN"

export = plugin
