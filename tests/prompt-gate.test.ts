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
      status: async () => ({ data: { parent: { type: state.busy ? "active" : "idle" } } }),
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

  test("reservation blocks dispatch from other sources", async () => {
    const { client, state } = createMockClient()
    const gate = new PromptGate(client, { idlePollMs: 10 })
    gate.reserve("parent", "completion-path")
    const result = await gate.dispatch({ sessionID: "parent", source: "other", text: "wake" })
    expect(result.status).toBe("reserved")
    expect(result.reservedBy).toBe("completion-path")
    expect(state.dispatched).toHaveLength(0)
  })

  test("release clears the reservation", async () => {
    const { client } = createMockClient()
    const gate = new PromptGate(client, { idlePollMs: 10 })
    gate.reserve("parent", "completion-path")
    gate.release("parent")
    const result = await gate.dispatch({ sessionID: "parent", source: "other", text: "wake" })
    expect(result.status).toBe("dispatched")
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
})
