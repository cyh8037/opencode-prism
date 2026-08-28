import {
  GATE_DISPATCH_ATTEMPTS,
  GATE_DISPATCH_RETRY_DELAY_MS,
  GATE_RESERVATION_POLL_MS,
  GATE_RESERVATION_WAIT_MS,
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
  reservationWaitMs?: number
  reservationPollMs?: number
  dispatchRetryDelayMs?: number
}

export type GateDispatchStatus = "dispatched" | "duplicate" | "failed"

export interface GateDispatchResult {
  status: GateDispatchStatus
  error?: unknown
}

interface SessionState {
  reservation?: { source: string }
  recent?: { dedupeKey: string; heldUntil: number }
  /** Serializes dispatches: a concurrent caller queues instead of dropping. */
  dispatchChain: Promise<unknown>
  /** Aborted when the session is cleared: in-flight waitForIdle /
   *  waitForReservation loops and the dispatch retry chain must stop
   *  immediately instead of polling a session that no longer exists
   *  (a deleted session's requests would all be wasted). */
  abortController: AbortController
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

// Internal message injection gate: per-session reservation, semantic dedupe
// over a recent dispatch window, wait-for-idle settling, and explicit release.
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
      state = { dispatchChain: Promise.resolve(), abortController: new AbortController() }
      this.state.set(sessionID, state)
    }
    return state
  }

  // Reserve the session before any status-flip/callback work that will later
  // queue a wake. Blocks other sources from dispatching meanwhile. When two
  // holders overlap, the later reservation subsumes the earlier one (the
  // combined window stays covered), and release is scoped to the caller's own
  // source so an earlier holder's release cannot clear a later holder's
  // reservation. A sourceless release clears unconditionally.
  reserve(sessionID: string, source: string): void {
    const state = this.getState(sessionID)
    state.reservation = { source }
  }

  release(sessionID: string, source?: string): void {
    const state = this.state.get(sessionID)
    if (!state?.reservation) return
    if (source === undefined || state.reservation.source === source) {
      state.reservation = undefined
    }
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
  // Abort-aware: the session may be cleared (deleted) mid-wait — stop polling
  // immediately rather than burning status calls on a dead session.
  private async waitForIdle(state: SessionState, sessionID: string): Promise<boolean> {
    const abortSignal = state.abortController.signal
    const settleMs = this.options.idleSettleMs ?? SESSION_IDLE_SETTLE_MS
    const pollMs = this.options.idlePollMs ?? 500
    const deadline = Date.now() + settleMs
    while (Date.now() < deadline) {
      if (abortSignal.aborted) return false
      if (!(await this.isSessionBusy(sessionID))) return true
      await sleep(pollMs)
    }
    return !(await this.isSessionBusy(sessionID))
  }

  // A reservation only lives for the holder's status-flip + child-abort
  // window (bounded by ABORT_TIMEOUT_MS), so waiting it out almost always
  // succeeds; on timeout the dispatch proceeds rather than being dropped.
  private async waitForReservation(state: SessionState): Promise<boolean> {
    const abortSignal = state.abortController.signal
    const waitMs = this.options.reservationWaitMs ?? GATE_RESERVATION_WAIT_MS
    const pollMs = this.options.reservationPollMs ?? GATE_RESERVATION_POLL_MS
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      if (abortSignal.aborted) return false
      if (!state.reservation) return true
      await sleep(pollMs)
    }
    return !state.reservation
  }

  // Wait-for-idle, dedupe, and the actual prompt dispatch. Run behind the
  // per-session chain so concurrent callers queue instead of dropping; the
  // reservation/dedupe checks are re-evaluated here at actual dispatch time.
  // A racing reservation is waited out, and a server-confirmed rejection
  // (resolved { error }) is retried a bounded number of times — a completion
  // notification or split report that was dropped here would be lost forever
  // (callers do not re-enqueue). Thrown errors are NOT retried: the request
  // may have been delivered, and a duplicate wake is worse than a lost one.
  private async dispatchNow(args: {
    sessionID: string
    source: string
    state: SessionState
    text: string
    queueBehavior: "defer" | "enqueue"
    dedupeKey: string
    dedupeMs: number
  }): Promise<GateDispatchResult> {
    const { sessionID, source, state, text, queueBehavior, dedupeKey, dedupeMs } = args

    const body = { parts: [{ type: "text", text, synthetic: true }] }

    const dispatch = (): Promise<unknown> => this.client.session.promptAsync({ path: { id: sessionID }, body })

    const retryDelayMs = this.options.dispatchRetryDelayMs ?? GATE_DISPATCH_RETRY_DELAY_MS
    let lastError: unknown

    for (let attempt = 1; attempt <= GATE_DISPATCH_ATTEMPTS; attempt++) {
      // The session was cleared (deleted) while this dispatch was queued
      // behind the chain — every further status call and prompt attempt would
      // target a dead session. Stop instead of retrying.
      if (state.abortController.signal.aborted) {
        return { status: "failed", error: new Error("gate state cleared (session gone)") }
      }

      if (state.reservation) {
        const cleared = await this.waitForReservation(state)
        if (!cleared && state.reservation && !state.abortController.signal.aborted) {
          log(`[prism] gate: reservation still held after wait, dispatching anyway`, {
            sessionID,
            source,
            reservedBy: state.reservation.source,
          })
        }
      }

      // The session may have been cleared while we waited out a reservation.
      if (state.abortController.signal.aborted) {
        return { status: "failed", error: new Error("gate state cleared (session gone)") }
      }

      if (state.recent && state.recent.dedupeKey === dedupeKey && Date.now() < state.recent.heldUntil) {
        return { status: "duplicate" }
      }

      try {
        if (queueBehavior === "defer") {
          const idle = await this.waitForIdle(state, sessionID)
          if (!idle && !state.abortController.signal.aborted) {
            log(`[prism] gate: session still busy after settle, dispatching anyway`, { sessionID, source })
          }
        }

        // The session was cleared while we waited for idle — dispatching now
        // would target a deleted session.
        if (state.abortController.signal.aborted) {
          return { status: "failed", error: new Error("gate state cleared (session gone)") }
        }

        const result = await dispatch()

        // The client resolves 4xx/5xx with { error } instead of rejecting; a
        // resolved-but-rejected request must not count as dispatched. A
        // resolved rejection is also server-confirmed NOT delivered, so it is
        // the only failure class safe to retry.
        const resultError = errorInfoFromResult(result as unknown)
        if (resultError) {
          lastError = resultError
          log(`[prism] gate: prompt dispatch failed`, { sessionID, source, attempt, error: resultError })
          if (attempt < GATE_DISPATCH_ATTEMPTS) {
            await sleep(retryDelayMs)
            continue
          }
          return { status: "failed", error: resultError }
        }

        // Recent-dispatch hold: the same notification text re-sent within the
        // dedupe window collapses into "duplicate" instead of waking the parent
        // twice for the same event.
        state.recent = { dedupeKey, heldUntil: Date.now() + dedupeMs }
        return { status: "dispatched" }
      } catch (error) {
        // A thrown error means the request MAY have reached the server —
        // retrying could inject the same notification twice into the parent
        // conversation. Only server-confirmed rejections are retried above.
        lastError = error
        log(`[prism] gate: prompt dispatch failed`, { sessionID, source, attempt, error })
        return { status: "failed", error }
      }
    }

    return { status: "failed", error: lastError }
  }

  async dispatch(args: {
    sessionID: string
    source: string
    text: string
    /** defer: wait for session idle before dispatching; enqueue: dispatch immediately */
    queueBehavior?: "defer" | "enqueue"
  }): Promise<GateDispatchResult> {
    const { sessionID, source, text, queueBehavior = "defer" } = args
    const state = this.getState(sessionID)
    const dedupeKey = hashText(text)
    const dedupeMs = this.options.semanticDedupeMs ?? PARENT_WAKE_DEDUPE_MS

    // Fast-path dedupe only. A racing reservation is NOT a drop reason: it is
    // waited out inside dispatchNow at actual dispatch time.
    if (state.recent && state.recent.dedupeKey === dedupeKey && Date.now() < state.recent.heldUntil) {
      return { status: "duplicate" }
    }

    // Serialize behind any in-flight dispatch: a second source would
    // previously be dropped, silently losing a wake.
    const run = state.dispatchChain
      .catch(() => undefined) // a failed dispatch must not block the queue
      .then(() => this.dispatchNow({ sessionID, source, state, text, queueBehavior, dedupeKey, dedupeMs }))
    state.dispatchChain = run.catch(() => undefined)
    return run
  }

  clear(sessionID: string): void {
    // Abort first: in-flight waits (waitForIdle / waitForReservation) and the
    // dispatch retry chain listen on the signal and must not keep polling a
    // session that is gone. The state entry itself is then dropped; a later
    // dispatch gets a fresh state with a fresh controller.
    this.state.get(sessionID)?.abortController.abort()
    this.state.delete(sessionID)
  }

  clearAll(): void {
    for (const state of this.state.values()) {
      state.abortController.abort()
    }
    this.state.clear()
  }
}
