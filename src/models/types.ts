export type Variant = "off" | "low" | "medium" | "high" | "xhigh" | "max"

export interface ResolvedModel {
  providerID: string
  modelID: string
  variant?: Variant
}

export interface ModelCapabilities {
  isVisionCapable(model: string): boolean | null
}

export interface ErrorInfo {
  name?: string
  message?: string
  statusCode?: number
}
