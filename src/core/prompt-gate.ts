import {
  GATE_DISPATCH_ATTEMPTS,
  GATE_DISPATCH_RETRY_DELAY_MS,
  GATE_DISPATCH_RETRY_DELAYS_MS,
  GATE_RESERVATION_POLL_MS,
  GATE_RESERVATION_WAIT_MS,
  PARENT_WAKE_DEDUPE_MS,
  SESSION_IDLE_SETTLE_MS,
} from "../config/constants"
import { errorInfoFromResult } from "../shared/api-result"
import { log } from "../shared/log"
import { sleep } from "../shared/sleep"
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

// Internal message injection gate: per-session reservation, semantic dedupe
// over a recent dispatch window, wait-for-idle settling, and explicit release.
// EVERY internal prompt Prism sends to a parent session goes through here.
export class PromptGate {
  private state = new Map<string, SessionState>()
  private clearedSessions = new Set<string>()
  private clearedAll = false

  constructor(
    private client: PrismClient,
    private options: PromptGateOptions = {},
  ) {}

  isCleared(sessionID: string): boolean {
    return this.clearedAll || this.clearedSessions.has(sessionID)
  }

  private getState(sessionID: string): SessionState {
    let state = this.state.get(sessionID)
    if (!state) {
      const abortController = new AbortController()
      if (this.isCleared(sessionID)) {
        abortController.abort()
      }
      state = { dispatchChain: Promise.resolve(), abortController }
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
      if (abortSignal.aborted || this.isCleared(sessionID)) return false
      if (!(await this.isSessionBusy(sessionID))) return true
      await sleep(pollMs, abortSignal)
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
      await sleep(pollMs, abortSignal)
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
    dedupeKey: string
    dedupeMs: number
  }): Promise<GateDispatchResult> {
    const { sessionID, source, state, text, dedupeKey, dedupeMs } = args

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
        // Wait for the session to settle between turns so the injected
        // message does not collide with an in-flight prompt. A settle
        // timeout still dispatches (logged) — a dropped notification is
        // worse than a mid-turn landing.
        const idle = await this.waitForIdle(state, sessionID)
        if (!idle && !state.abortController.signal.aborted) {
          log(`[prism] gate: session still busy after settle, dispatching anyway`, { sessionID, source })
        }

        // The session was cleared while we waited for idle — dispatching now
        // would target a deleted session.
        if (state.abortController.signal.aborted || this.isCleared(sessionID)) {
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
            if (state.abortController.signal.aborted || this.isCleared(sessionID)) {
              return { status: "failed", error: new Error("gate state cleared (session gone)") }
            }
            await sleep(retryDelayMs, state.abortController.signal)
            if (state.abortController.signal.aborted || this.isCleared(sessionID)) {
              return { status: "failed", error: new Error("gate state cleared (session gone)") }
            }
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
  }): Promise<GateDispatchResult> {
    const { sessionID, source, text } = args
    if (this.isCleared(sessionID)) {
      return { status: "failed", error: new Error("gate state cleared (session gone)") }
    }
    const state = this.getState(sessionID)
    if (state.abortController.signal.aborted) {
      return { status: "failed", error: new Error("gate state cleared (session gone)") }
    }
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
      .then(() => this.dispatchNow({ sessionID, source, state, text, dedupeKey, dedupeMs }))
    state.dispatchChain = run.catch(() => undefined)
    return run
  }

  // dispatch + an outer backoff ladder for server-confirmed rejections. The
  // inner GATE_DISPATCH_ATTEMPTS loop covers immediate retries; this ladder
  // covers a parent session that stays busy well past the settle window —
  // injected texts here carry the ONLY copy of a completion report or split
  // aggregation (callers never re-enqueue), so a long human turn must not
  // silently drop them. "failed" after the ladder is final; "duplicate" and
  // "dispatched" short-circuit immediately. Re-dispatch is safe: the dedupe
  // window is only armed on SUCCESS, so failed attempts are never mistaken
  // for delivered ones.
  async dispatchWithRetry(
    args: { sessionID: string; source: string; text: string },
    retryDelays: readonly number[] = GATE_DISPATCH_RETRY_DELAYS_MS,
  ): Promise<GateDispatchResult> {
    let result = await this.dispatch(args)
    for (let attempt = 0; result.status === "failed" && attempt < retryDelays.length; attempt++) {
      if (this.isCleared(args.sessionID)) {
        break
      }
      const delay = retryDelays[attempt]!
      log(`[prism] gate: dispatch failed, retrying with backoff`, {
        sessionID: args.sessionID,
        source: args.source,
        attempt: attempt + 1,
        delay,
        error: result.error,
      })
      const state = this.state.get(args.sessionID)
      await sleep(delay, state?.abortController.signal)
      if (this.isCleared(args.sessionID)) {
        break
      }
      result = await this.dispatch(args)
    }
    return result
  }

  clear(sessionID: string): void {
    // Abort first: in-flight waits (waitForIdle / waitForReservation) and the
    // dispatch retry chain listen on the signal and must not keep polling a
    // session that is gone. The state entry itself is then dropped.
    if (this.clearedSessions.size >= 5000) {
      const first = this.clearedSessions.keys().next().value
      if (first) this.clearedSessions.delete(first)
    }
    this.clearedSessions.add(sessionID)
    this.state.get(sessionID)?.abortController.abort()
    this.state.delete(sessionID)
  }

  clearAll(): void {
    this.clearedAll = true
    for (const state of this.state.values()) {
      state.abortController.abort()
    }
    this.state.clear()
  }
}
