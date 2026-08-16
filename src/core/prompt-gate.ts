import {
  PARENT_WAKE_DEDUPE_MS,
  SESSION_IDLE_SETTLE_MS,
} from "../config/constants"
import { log } from "../shared/log"
import type { PrismClient } from "./client-types"

export interface PromptGateOptions {
  semanticDedupeMs?: number
  idleSettleMs?: number
  idlePollMs?: number
}

export type GateDispatchStatus = "dispatched" | "reserved" | "duplicate" | "failed"

export interface GateDispatchResult {
  status: GateDispatchStatus
  reservedBy?: string
  error?: unknown
}

interface SessionState {
  reservation?: { source: string }
  recent?: { dedupeKey: string; heldUntil: number }
  dispatchInFlight: boolean
}

function hashText(text: string): string {
  // FNV-1a; only used as a dedupe key, not for security.
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `h${(hash >>> 0).toString(36)}`
}

function isBusyStatus(status: string | undefined): boolean {
  // session.status "active"/"running"/"busy" means a prompt is being processed.
  if (!status) return false
  const normalized = status.toLowerCase()
  return normalized === "active" || normalized === "running" || normalized === "busy" || normalized === "streaming"
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// Internal message injection gate. Ported semantics from oh-my-openagent's
// prompt-async-gate: per-session reservation, semantic dedupe over a recent
// dispatch window, wait-for-idle settling, and explicit release.
// EVERY internal prompt Prism sends to a parent session goes through here.
export class PromptGate {
  private state = new Map<string, SessionState>()

  constructor(
    private client: PrismClient,
    private options: PromptGateOptions = {},
  ) {}

  private getState(sessionID: string): SessionState {
    let state = this.state.get(sessionID)
    if (!state) {
      state = { dispatchInFlight: false }
      this.state.set(sessionID, state)
    }
    return state
  }

  // Reserve the session before any status-flip/callback work that will later
  // queue a wake. Blocks other sources from dispatching meanwhile.
  reserve(sessionID: string, source: string): void {
    const state = this.getState(sessionID)
    state.reservation = { source }
  }

  release(sessionID: string): void {
    const state = this.state.get(sessionID)
    if (state) state.reservation = undefined
  }

  isReserved(sessionID: string): boolean {
    return this.state.get(sessionID)?.reservation !== undefined
  }

  // Whether a same-text dispatch happened recently and has not been consumed.
  hasRecentDispatch(sessionID: string): boolean {
    const state = this.state.get(sessionID)
    if (!state?.recent) return false
    return Date.now() < state.recent.heldUntil
  }

  async isSessionBusy(sessionID: string): Promise<boolean> {
    // session.get does not expose a status field; the batch status endpoint
    // (verified against opencode 1.18) maps sessionID -> { type }.
    try {
      const response = await this.client.session.status()
      const statusMap = response.data as Record<string, { type?: string }> | undefined
      return isBusyStatus(statusMap?.[sessionID]?.type)
    } catch {
      return false
    }
  }

  // Wait until the session is not busy (or settle timeout), so the injected
  // message lands between turns instead of colliding with an in-flight prompt.
  private async waitForIdle(sessionID: string): Promise<boolean> {
    const settleMs = this.options.idleSettleMs ?? SESSION_IDLE_SETTLE_MS
    const pollMs = this.options.idlePollMs ?? 500
    const deadline = Date.now() + settleMs
    while (Date.now() < deadline) {
      if (!(await this.isSessionBusy(sessionID))) return true
      await sleep(pollMs)
    }
    return !(await this.isSessionBusy(sessionID))
  }

  async dispatch(args: {
    sessionID: string
    source: string
    text: string
    parts?: Array<Record<string, unknown>>
    mode?: "async" | "sync"
    /** defer: wait for session idle before dispatching; enqueue: dispatch immediately */
    queueBehavior?: "defer" | "enqueue"
  }): Promise<GateDispatchResult> {
    const { sessionID, source, text, parts, mode = "async", queueBehavior = "defer" } = args
    const state = this.getState(sessionID)
    const dedupeKey = hashText(text)
    const dedupeMs = this.options.semanticDedupeMs ?? PARENT_WAKE_DEDUPE_MS

    if (state.reservation) {
      return { status: "reserved", reservedBy: state.reservation.source }
    }

    if (state.recent && state.recent.dedupeKey === dedupeKey && Date.now() < state.recent.heldUntil) {
      return { status: "duplicate" }
    }

    if (state.dispatchInFlight) {
      return { status: "reserved", reservedBy: source }
    }

    const body = parts
      ? { parts }
      : { parts: [{ type: "text", text, synthetic: true }] }

    const dispatch = (): Promise<unknown> => {
      if (mode === "sync") {
        return this.client.session.prompt({ path: { id: sessionID }, body })
      }
      return this.client.session.promptAsync({ path: { id: sessionID }, body })
    }

    try {
      if (queueBehavior === "defer") {
        const idle = await this.waitForIdle(sessionID)
        if (!idle) {
          log(`[prism] gate: session still busy after settle, dispatching anyway`, { sessionID, source })
        }
      }

      state.dispatchInFlight = true
      try {
        await dispatch()
      } finally {
        state.dispatchInFlight = false
      }

      // Recent-dispatch hold: the same notification text re-sent within the
      // dedupe window collapses into "duplicate" instead of waking the parent
      // twice for the same event.
      state.recent = { dedupeKey, heldUntil: Date.now() + dedupeMs }
      return { status: "dispatched" }
    } catch (error) {
      log(`[prism] gate: prompt dispatch failed`, { sessionID, source, error })
      return { status: "failed", error }
    }
  }

  clear(sessionID: string): void {
    this.state.delete(sessionID)
  }

  clearAll(): void {
    this.state.clear()
  }
}
