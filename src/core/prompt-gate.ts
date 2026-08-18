import {
  PARENT_WAKE_DEDUPE_MS,
  SESSION_IDLE_SETTLE_MS,
} from "../config/constants"
import { errorInfoFromResult } from "../shared/api-result"
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
  /** Serializes dispatches: a concurrent caller queues instead of dropping. */
  dispatchChain: Promise<unknown>
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
  // session.status at 1.18 exposes "busy" (prompt processing) and "retry"
  // (waiting between attempts) — both mean the session is not idle. The map
  // only tracks non-idle sessions, so an absent entry is idle.
  if (!status) return false
  const normalized = status.toLowerCase()
  return normalized === "busy" || normalized === "retry"
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
      state = { dispatchChain: Promise.resolve() }
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

  // Wait-for-idle, dedupe, and the actual prompt dispatch. Run behind the
  // per-session chain so concurrent callers queue instead of dropping; the
  // reservation/dedupe checks are re-evaluated here at actual dispatch time.
  private async dispatchNow(args: {
    sessionID: string
    source: string
    state: SessionState
    text: string
    parts?: Array<Record<string, unknown>>
    mode: "async" | "sync"
    queueBehavior: "defer" | "enqueue"
    dedupeKey: string
    dedupeMs: number
  }): Promise<GateDispatchResult> {
    const { sessionID, source, state, text, parts, mode, queueBehavior, dedupeKey, dedupeMs } = args

    if (state.reservation) {
      return { status: "reserved", reservedBy: state.reservation.source }
    }

    if (state.recent && state.recent.dedupeKey === dedupeKey && Date.now() < state.recent.heldUntil) {
      return { status: "duplicate" }
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

      const result = await dispatch()

      // The client resolves 4xx/5xx with { error } instead of rejecting; a
      // resolved-but-rejected request must not count as dispatched.
      const resultError = errorInfoFromResult(result as unknown)
      if (resultError) {
        log(`[prism] gate: prompt dispatch failed`, { sessionID, source, error: resultError })
        return { status: "failed", error: resultError }
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

    // Serialize behind any in-flight dispatch: a second source would
    // previously be dropped ("reserved"), silently losing a wake.
    const run = state.dispatchChain
      .catch(() => undefined) // a failed dispatch must not block the queue
      .then(() =>
        this.dispatchNow({ sessionID, source, state, text, parts, mode, queueBehavior, dedupeKey, dedupeMs }),
      )
    state.dispatchChain = run.catch(() => undefined)
    return run
  }

  clear(sessionID: string): void {
    this.state.delete(sessionID)
  }

  clearAll(): void {
    this.state.clear()
  }
}
