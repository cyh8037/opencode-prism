// Narrow client surface Prism needs from the OpenCode SDK. Typed locally so
// every core module is testable against plain mocks; the real PluginInput
// client satisfies this structurally.
export interface PrismSession {
  get(params: { path: { id: string }; query?: { directory?: string } }): Promise<{
    data?: {
      id?: string
      directory?: string
      status?: string
      model?: { id?: string; modelID?: string; providerID?: string }
    }
    error?: unknown
  }>
  create(params: {
    body: Record<string, unknown>
    query?: { directory?: string }
  }): Promise<{ data?: { id: string }; error?: unknown }>
  abort(params: { path: { id: string } }): Promise<unknown>
  prompt(params: {
    path: { id: string }
    body: Record<string, unknown>
    query?: { directory?: string }
  }): Promise<unknown>
  promptAsync(params: {
    path: { id: string }
    body: Record<string, unknown>
    query?: { directory?: string }
  }): Promise<unknown>
  messages(params: {
    path: { id: string }
    query?: { directory?: string }
  }): Promise<{ data?: unknown; error?: unknown }>
  status(params?: { query?: { directory?: string } }): Promise<{ data?: unknown; error?: unknown }>
}

export type ToastVariant = "info" | "success" | "warning" | "error"

export interface PrismTui {
  showToast(params: { body: { title: string; message: string; variant: ToastVariant; duration: number } }): Promise<unknown>
}

export interface PrismClient {
  session: PrismSession
  tui: PrismTui
}

// 运行时探测 TUI 环境：host 只在 TUI 会话里挂载 tui RPC 面（web/headless
// 下为空或缺失）。子会话导航指引等 TUI 专属文案据此门控。注意这是运行时
// 鸭子探测（非版本化 API），web 端行为需在真实 web 会话中人工验证。
export function isTuiClient(client: PrismClient | undefined | null): boolean {
  return typeof (client as { tui?: { showToast?: unknown } } | undefined)?.tui?.showToast === "function"
}
