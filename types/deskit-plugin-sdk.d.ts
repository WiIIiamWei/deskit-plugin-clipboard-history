// Vendored type surface for @deskit/plugin-sdk.
//
// The DesKit SDK is types-only (no runtime) and is not published to npm,
// so this template ships the public contract as an ambient module
// declaration. `import type { PluginModule } from "@deskit/plugin-sdk"`
// resolves here; the build erases the import entirely (CJS output has no
// reference to the SDK). Keep this in sync with the DesKit SDK version
// pinned in your deskit.json `engines.deskit`.

declare module "@deskit/plugin-sdk" {
  export type LocalizedString = string | { [locale: string]: string }

  export interface ClipboardTextContent {
    type: "text"
    text: string
  }
  export interface ClipboardImageContent {
    type: "image"
    dataUrl: string
    mimeType: "image/png" | "image/jpeg" | "image/webp" | string
    width?: number
    height?: number
    name?: string
  }
  export interface ClipboardFileContent {
    type: "file"
    paths: string[]
  }
  export type ClipboardContent =
    | ClipboardTextContent
    | ClipboardImageContent
    | ClipboardFileContent
  export type ClipboardActionValue = string | ClipboardContent

  export interface CopyAction {
    type: "copy"
    label?: LocalizedString
    value: ClipboardActionValue
    shortcut?: string
  }
  export interface PasteAction {
    type: "paste"
    label?: LocalizedString
    value: ClipboardActionValue
    shortcut?: string
  }
  export interface OpenUrlAction {
    type: "open-url"
    label?: LocalizedString
    url: string
    shortcut?: string
  }
  export interface OpenPathAction {
    type: "open-path"
    label?: LocalizedString
    path: string
    shortcut?: string
  }
  export interface RunCommandAction {
    type: "run-command"
    label?: LocalizedString
    commandId: string
    args?: unknown
  }
  export interface SubmitAction {
    type: "submit"
    label?: LocalizedString
  }
  export interface CloseAction {
    type: "close"
    label?: LocalizedString
  }
  export interface CustomAction {
    type: "custom"
    label: LocalizedString
    id: string
    payload?: unknown
  }
  export type Action =
    | CopyAction
    | PasteAction
    | OpenUrlAction
    | OpenPathAction
    | RunCommandAction
    | SubmitAction
    | CloseAction
    | CustomAction

  export interface ListItem {
    id: string
    title: LocalizedString
    subtitle?: LocalizedString
    accessory?: string
    icon?: string
    actions: Action[]
  }
  export interface ListView {
    type: "list"
    searchPlaceholder?: string
    isLoading?: boolean
    emptyText?: LocalizedString
    sections?: Array<{ title?: LocalizedString; items: ListItem[] }>
    items?: ListItem[]
  }
  export interface DetailView {
    type: "detail"
    markdown: string
    metadata?: Array<{ label: LocalizedString; value: string }>
    actions: Action[]
  }
  interface FormFieldBase {
    id: string
    label: LocalizedString
    required?: boolean
    description?: LocalizedString
  }
  export interface TextField extends FormFieldBase {
    type: "text"
    placeholder?: LocalizedString
    default?: string
  }
  export interface TextAreaField extends FormFieldBase {
    type: "textarea"
    placeholder?: LocalizedString
    default?: string
    rows?: number
  }
  export interface NumberField extends FormFieldBase {
    type: "number"
    default?: number
    min?: number
    max?: number
    step?: number
  }
  export interface CheckboxField extends FormFieldBase {
    type: "checkbox"
    default?: boolean
  }
  export interface SelectField extends FormFieldBase {
    type: "select"
    default?: string
    options: Array<{ value: string; label: LocalizedString }>
  }
  export type FormField =
    | TextField
    | TextAreaField
    | NumberField
    | CheckboxField
    | SelectField
  export interface FormView {
    type: "form"
    fields: FormField[]
    submitLabel?: LocalizedString
    actions: Action[]
  }
  export interface ToastOnly {
    type: "toast"
    level: "info" | "success" | "warning" | "error"
    message: LocalizedString
  }
  export type View = ListView | DetailView | FormView | ToastOnly

  export interface StorageAPI {
    get: <T = unknown>(key: string) => Promise<T | undefined>
    set: <T = unknown>(key: string, value: T) => Promise<void>
    delete: (key: string) => Promise<void>
    list: () => Promise<string[]>
  }
  export interface ClipboardAPI {
    read: () => Promise<ClipboardContent | undefined>
    write: (content: ClipboardContent) => Promise<void>
    watch: (listener: (content: ClipboardContent) => void) => () => void
    readText: () => Promise<string>
    writeText: (text: string) => Promise<void>
  }
  export interface NotificationAPI {
    show: (options: { title: string; body?: string; silent?: boolean }) => Promise<void>
  }
  export interface SystemAPI {
    openUrl: (url: string) => Promise<void>
    openPath: (path: string) => Promise<void>
    captureScreen: (options?: { name?: string }) => Promise<{ path: string }>
  }
  export interface PluginContext {
    pluginId: string
    locale: string
    theme: { mode: "light" | "dark"; accent: string }
    preferences: Record<string, unknown>
    storage: StorageAPI
    clipboard: ClipboardAPI
    notifications: NotificationAPI
    system: SystemAPI
    log: (...args: unknown[]) => void
  }

  export interface CommandInvocation {
    commandId: string
    initialQuery?: string
  }
  export interface ClipboardChangeEvent {
    content: ClipboardContent
  }
  export interface PluginEvents {
    onClipboardChange?: (event: ClipboardChangeEvent, ctx: PluginContext) => Promise<void> | void
  }
  export interface CommandHandler {
    run: (input: CommandInvocation, ctx: PluginContext) => Promise<View> | View
    onSearchChange?: (text: string, ctx: PluginContext) => Promise<View> | View
    onAction?: (
      actionId: string,
      payload: unknown,
      ctx: PluginContext
    ) => Promise<View | void> | View | void
    dispose?: (ctx: PluginContext) => void
  }
  export interface PluginModule {
    commands: Record<string, CommandHandler>
    events?: PluginEvents
  }
}
