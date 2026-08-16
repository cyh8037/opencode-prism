// Narrow client surface Prism needs from the OpenCode SDK. Typed locally so
// every core module is testable against plain mocks; the real PluginInput
// client satisfies this structurally.
export interface PrismSession {
  get(params: { path: { id: string }; query?: { directory?: string } }): Promise<{
    data?: {
      id?: string
      directory?: string
      status?: string
      model?: { id?: string; modelID?: string; providerID?: string; variant?: string }
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

export interface PrismTui {
  showToast(params: { body: { title: string; message: string; variant: string; duration: number } }): Promise<unknown>
}

export interface PrismProviderListResult {
  data?: {
    connected?: string[]
    all?: Array<{ id: string; models?: Record<string, unknown> }>
  }
}

export interface PrismClient {
  session: PrismSession
  tui: PrismTui
  provider?: {
    list?: () => Promise<PrismProviderListResult>
  }
}
