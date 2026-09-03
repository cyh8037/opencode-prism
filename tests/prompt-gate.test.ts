import { describe, expect, test } from "bun:test"
import { PromptGate } from "../src/core/prompt-gate"
import type { PrismClient } from "../src/core/client-types"

function createMockClient(): {
  client: PrismClient
  state: { dispatched: string[]; busy: boolean }
} {
  const state = {
    dispatched: [] as string[],
    busy: false,
  }
  const client: PrismClient = {
    session: {
      get: async () => ({ data: { id: "parent" } }),
      create: async () => ({ data: { id: "child" } }),
      abort: async () => {},
      prompt: async () => {},
      promptAsync: async ({ body }) => {
        state.dispatched.push(JSON.stringify(body))
      },
      messages: async () => ({ data: [] }),
      // the status map only contains non-idle sessions: busy → entry, idle → absent
      status: async () => ({ data: state.busy ? { parent: { type: "busy" } } : {} }),
    },
    tui: {
      showToast: async () => {},
    },
  }
  return { client, state }
}

describe("PromptGate", () => {
  test("dispatches when session is idle", async () => {
    const { client } = createMockClient()
    const gate = new PromptGate(client, { idlePollMs: 10 })
    const result = await gate.dispatch({ sessionID: "parent", source: "test", text: "hello" })
    expect(result.status).toBe("dispatched")
  })

  test("collapses duplicate dispatch of the same text within the dedupe window", async () => {
    const { client, state } = createMockClient()
    const gate = new PromptGate(client, { idlePollMs: 10, semanticDedupeMs: 60_000 })
    await gate.dispatch({ sessionID: "parent", source: "a", text: "same" })
    const second = await gate.dispatch({ sessionID: "parent", source: "b", text: "same" })
    expect(second.status).toBe("duplicate")
    expect(state.dispatched).toHaveLength(1)
  })

  test("a dispatch racing a reservation waits for the release instead of being dropped", async () => {
    const { client, state } = createMockClient()
    const gate = new PromptGate(client, { idlePollMs: 10, reservationPollMs: 10 })
    gate.reserve("parent", "completion-path")
    const pending = gate.dispatch({ sessionID: "parent", source: "other", text: "wake" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(state.dispatched).toHaveLength(0) // still waiting out the reservation
    gate.release("parent", "completion-path")
    const result = await pending
    expect(result.status).toBe("dispatched")
    expect(state.dispatched).toHaveLength(1)
  })

  test("release only clears a reservation with a matching source", async () => {
    const { client } = createMockClient()
    const gate = new PromptGate(client, { idlePollMs: 10 })
    gate.reserve("parent", "background-completion:bg_a")
    gate.reserve("parent", "background-completion:bg_b") // overlapping holder takes over
    gate.release("parent", "background-completion:bg_a") // stale release must be a no-op
    expect(gate.isReserved("parent")).toBe(true)
    gate.release("parent", "background-completion:bg_b")
    expect(gate.isReserved("parent")).toBe(false)
  })

  test("release clears the reservation", async () => {
    const { client } = createMockClient()
    const gate = new PromptGate(client, { idlePollMs: 10 })
    gate.reserve("parent", "completion-path")
    gate.release("parent")
    const result = await gate.dispatch({ sessionID: "parent", source: "other", text: "wake" })
    expect(result.status).toBe("dispatched")
  })

  test("a failed dispatch is retried instead of dropped", async () => {
    const { client, state } = createMockClient()
    let failures = 0
    const original = client.session.promptAsync.bind(client.session)
    client.session.promptAsync = async (...args: Parameters<PrismClient["session"]["promptAsync"]>) => {
      if (failures < 2) {
        failures++
        return { error: { message: "session busy" }, response: { status: 503 } }
      }
      return original(...args)
    }
    const gate = new PromptGate(client, { idlePollMs: 10, dispatchRetryDelayMs: 10 })
    const result = await gate.dispatch({ sessionID: "parent", source: "test", text: "wake" })
    expect(result.status).toBe("dispatched")
    expect(failures).toBe(2)
    expect(state.dispatched).toHaveLength(1)
  })

  test("a thrown dispatch error is not retried (the request may have been delivered)", async () => {
    const { client, state } = createMockClient()
    let calls = 0
    client.session.promptAsync = async () => {
      calls++
      throw new Error("network down")
    }
    const gate = new PromptGate(client, { idlePollMs: 10, dispatchRetryDelayMs: 10 })
    const result = await gate.dispatch({ sessionID: "parent", source: "test", text: "wake" })
    expect(result.status).toBe("failed")
    expect(calls).toBe(1) // no retry: a retry could inject a duplicate wake
    expect(state.dispatched).toHaveLength(0)
  })

  test("waits for a busy session to settle before dispatching", async () => {
    const { client, state } = createMockClient()
    const gate = new PromptGate(client, { idlePollMs: 10, idleSettleMs: 500 })
    state.busy = true
    const order: string[] = []
    void gate.dispatch({ sessionID: "parent", source: "test", text: "wake" }).then((r) => order.push(r.status))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(order).toHaveLength(0) // still waiting for idle
    state.busy = false
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(order).toEqual(["dispatched"])
  })

  test("different text is not deduped", async () => {
    const { client, state } = createMockClient()
    const gate = new PromptGate(client, { idlePollMs: 10, semanticDedupeMs: 60_000 })
    await gate.dispatch({ sessionID: "parent", source: "a", text: "task bg_1 done" })
    await gate.dispatch({ sessionID: "parent", source: "b", text: "task bg_2 done" })
    expect(state.dispatched).toHaveLength(2)
  })

  test("concurrent dispatches serialize instead of dropping the second", async () => {
    const { client, state } = createMockClient()
    const gate = new PromptGate(client, { idlePollMs: 10, idleSettleMs: 500 })
    state.busy = true
    const results: string[] = []
    void gate.dispatch({ sessionID: "parent", source: "a", text: "first" }).then((r) => results.push(r.status))
    await new Promise((resolve) => setTimeout(resolve, 20))
    void gate.dispatch({ sessionID: "parent", source: "b", text: "second" }).then((r) => results.push(r.status))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(state.dispatched).toHaveLength(0) // both waiting for idle
    state.busy = false
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(results).toEqual(["dispatched", "dispatched"])
    expect(state.dispatched).toHaveLength(2)
  })

  test("a queued dispatch is still deduped against the first one", async () => {
    const { client, state } = createMockClient()
    const gate = new PromptGate(client, { idlePollMs: 10, idleSettleMs: 500, semanticDedupeMs: 60_000 })
    state.busy = true
    const results: string[] = []
    void gate.dispatch({ sessionID: "parent", source: "a", text: "same" }).then((r) => results.push(r.status))
    await new Promise((resolve) => setTimeout(resolve, 20))
    void gate.dispatch({ sessionID: "parent", source: "b", text: "same" }).then((r) => results.push(r.status))
    state.busy = false
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(results).toEqual(["dispatched", "duplicate"])
    expect(state.dispatched).toHaveLength(1)
  })

  // The session was deleted (event hook -> gate.clear) while a dispatch was
  // waiting out its busy window: the wait must abort immediately instead of
  // polling a dead session for the rest of the settle window, and the
  // dispatch must fail without ever calling promptAsync on it.
  test("clear() aborts a dispatch waiting on a busy session: no further polling, no prompt call", async () => {
    const { client, state } = createMockClient()
    let statusCalls = 0
    let promptCalls = 0
    client.session.status = async () => {
      statusCalls++
      return { data: state.busy ? { parent: { type: "busy" } } : {} }
    }
    client.session.promptAsync = async () => {
      promptCalls++
      return { data: {} }
    }
    const gate = new PromptGate(client, { idlePollMs: 10, idleSettleMs: 60_000 })
    state.busy = true
    const pending = gate.dispatch({ sessionID: "parent", source: "test", text: "wake" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(statusCalls).toBeGreaterThan(0) // the wait is polling

    gate.clear("parent")
    const result = await pending
    expect(result.status).toBe("failed")
    const callsAtClear = statusCalls
    const promptAtClear = promptCalls
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(statusCalls).toBe(callsAtClear) // no polling after the clear
    expect(promptCalls).toBe(promptAtClear) // no prompt ever dispatched
  })

  test("dispatchWithRetry exhausts the outer backoff ladder for a persistently busy parent", async () => {
    const { client, state } = createMockClient()
    let calls = 0
    client.session.promptAsync = async () => {
      calls++
      return { error: { message: "session busy" }, response: { status: 503 } }
    }
    const gate = new PromptGate(client, { idlePollMs: 10, dispatchRetryDelayMs: 10 })
    const result = await gate.dispatchWithRetry(
      { sessionID: "parent", source: "test", text: "wake" },
      [10, 10, 10],
    )
    // inner GATE_DISPATCH_ATTEMPTS (3) x (1 + outer ladder length 3) = 12 tries
    expect(calls).toBe(12)
    expect(result.status).toBe("failed")
    expect(state.dispatched).toHaveLength(0)
  })

  test("dispatchWithRetry succeeds through the outer ladder after inner retries exhaust", async () => {
    const { client, state } = createMockClient()
    let rounds = 0
    const original = client.session.promptAsync.bind(client.session)
    client.session.promptAsync = async (...args: Parameters<PrismClient["session"]["promptAsync"]>) => {
      rounds++
      // whole inner retry loop fails twice, then the third round lands
      if (rounds <= 6) {
        return { error: { message: "session busy" }, response: { status: 503 } }
      }
      return original(...args)
    }
    const gate = new PromptGate(client, { idlePollMs: 10, dispatchRetryDelayMs: 10 })
    const result = await gate.dispatchWithRetry(
      { sessionID: "parent", source: "test", text: "wake" },
      [10, 10],
    )
    expect(result.status).toBe("dispatched")
    expect(state.dispatched).toHaveLength(1)
  })

  test("clear() aborts dispatchWithRetry immediately without completing backoff ladder or creating orphan state", async () => {
    const { client, state } = createMockClient()
    let calls = 0
    client.session.promptAsync = async () => {
      calls++
      return { error: { message: "session busy" }, response: { status: 503 } }
    }
    const gate = new PromptGate(client, { idlePollMs: 10, dispatchRetryDelayMs: 20 })
    const promise = gate.dispatchWithRetry(
      { sessionID: "parent", source: "test", text: "wake" },
      [500, 500, 500],
    )
    // Wait for first inner retry attempt to fail and enter backoff
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls).toBeGreaterThanOrEqual(1)
    gate.clear("parent")
    const result = await promise
    expect(result.status).toBe("failed")
    // Subsequent calls were cut short by clear() rather than waiting all 3x500ms
    expect(calls).toBeLessThan(12)

    // A later dispatch to the cleared session fails immediately without promptAsync
    const beforeLaterCalls = calls
    const later = await gate.dispatch({ sessionID: "parent", source: "test", text: "wake2" })
    expect(later.status).toBe("failed")
    expect(calls).toBe(beforeLaterCalls)
  })
})
