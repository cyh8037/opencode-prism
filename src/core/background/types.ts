import type { ResolvedModel } from "../../models"

export type BgTaskStatus = "pending" | "running" | "completed" | "error" | "cancelled"

export interface TaskProgress {
  toolCalls: number
  /** Distinct tool part ids already counted (part.updated fires repeatedly). */
  toolPartIds?: Set<string>
  lastTool?: string
  lastUpdate: Date
}

export interface BgTask {
  id: string
  parentSessionId: string
  sessionId?: string
  /** Working directory of the child session (may differ from the plugin's). */
  directory?: string
  description: string
  prompt: string
  /** Prompt parts override (e.g. vision tasks sending images). */
  parts?: Array<Record<string, unknown>>
  /** System prompt for the child session. */
  system?: string
  agent?: string
  model?: ResolvedModel
  /** Same-model retries already used (max 1). */
  retries: number
  status: BgTaskStatus
  queuedAt?: Date
  startedAt?: Date
  completedAt?: Date
  error?: string
  /** Last assistant text captured from the child session (result excerpt). */
  resultText?: string
  progress?: TaskProgress
  concurrencyKey?: string
  /** Stable key for re-acquiring a concurrency slot on resume. */
  concurrencyGroup: string
  suppressTmux?: boolean
}

export interface LaunchInput {
  description: string
  prompt: string
  /** Override the prompt parts entirely (e.g. vision tasks sending images). */
  parts?: Array<Record<string, unknown>>
  /** System prompt for the child session. */
  system?: string
  parentSessionId: string
  agent?: string
  suppressTmux?: boolean
  /** Pin the child session's model (e.g. the gate-checked vision model). Default: resolve the parent session's current model. */
  model?: ResolvedModel
}

export interface QueueItem {
  task: BgTask
  input: LaunchInput
  model: ResolvedModel
}

export interface SessionStatusMap {
  [sessionID: string]: { type?: string; message?: string }
}
