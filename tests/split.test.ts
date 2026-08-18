import { describe, expect, test } from "bun:test"
import { subTaskPlanArraySchema } from "../src/core/split/plan-schema"
import { buildSplitReport, runSplit } from "../src/core/split/scheduler"
import { BackgroundManager } from "../src/core/background/manager"
import { PromptGate } from "../src/core/prompt-gate"
import { parseConfig } from "../src/config/load"
import type { PrismClient } from "../src/core/client-types"

describe("subTaskPlanArraySchema", () => {
  test("accepts a valid acyclic plan", () => {
    const result = subTaskPlanArraySchema.safeParse([
      { id: "s1", title: "a", description: "a", dependsOn: [] },
      { id: "s2", title: "b", description: "b", dependsOn: ["s1"] },
    ])
    expect(result.success).toBe(true)
  })

  test("rejects duplicate ids", () => {
    const result = subTaskPlanArraySchema.safeParse([
      { id: "s1", title: "a", description: "a", dependsOn: [] },
      { id: "s1", title: "b", description: "b", dependsOn: [] },
    ])
    expect(result.success).toBe(false)
  })

  test("rejects unknown dependencies", () => {
    const result = subTaskPlanArraySchema.safeParse([
      { id: "s1", title: "a", description: "a", dependsOn: ["ghost"] },
    ])
    expect(result.success).toBe(false)
  })

  test("rejects cycles", () => {
    const result = subTaskPlanArraySchema.safeParse([
      { id: "s1", title: "a", description: "a", dependsOn: ["s2"] },
      { id: "s2", title: "b", description: "b", dependsOn: ["s1"] },
    ])
    expect(result.success).toBe(false)
  })

  test("rejects unknown extra fields", () => {
    const result = subTaskPlanArraySchema.safeParse([
      { id: "s1", title: "a", description: "a", dependsOn: [], category: "quick" },
    ])
    expect(result.success).toBe(false)
  })
})

function createManager() {
  const client: PrismClient = {
    session: {
      get: async () => ({
        data: { id: "parent", directory: "/work", model: { id: "gpt-5.6-sol", providerID: "openai" } },
      }),
      create: async ({ body }) => ({ data: { id: `child_${(body as Record<string, unknown>).title}` } }),
      abort: async () => {},
      prompt: async () => {},
      promptAsync: async () => {},
      messages: async () => ({
        data: [
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "done", state: { status: "completed" } }],
          },
        ],
      }),
      status: async () => ({ data: {} }),
    },
    tui: { showToast: async () => {} },
  }
  const gate = new PromptGate(client, { idlePollMs: 10 })
  const manager = new BackgroundManager({
    client,
    directory: "/work",
    config: parseConfig({}),
    gate,
    resolveModel: async () => ({ providerID: "openai", modelID: "gpt-5.6-sol" }),
    pollingIntervalMs: 60_000,
  })
  return { manager }
}

describe("runSplit", () => {
  test("launches layer 0 immediately and dependents after completion", async () => {
    const { manager } = createManager()
    const result = runSplit(manager, {
      parentSessionId: "parent",
      plans: [
        { id: "s1", title: "first", description: "independent work", dependsOn: [] },
        { id: "s2", title: "second", description: "depends on s1", dependsOn: ["s1"] },
      ],
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.tasksByPlanID.has("s1")).toBe(true)
    expect(result.tasksByPlanID.has("s2")).toBe(false) // waiting on s1

    const s1 = result.tasksByPlanID.get("s1")!
    manager.handleEvent({ type: "session.idle", properties: { sessionID: s1.sessionId } })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(result.tasksByPlanID.has("s2")).toBe(true)
    expect(s1.status).toBe("completed")

    const s2 = result.tasksByPlanID.get("s2")!
    manager.handleEvent({ type: "session.idle", properties: { sessionID: s2.sessionId } })
    await result.done
    expect(s2.status).toBe("completed")
  })

  test("sequential mode launches one task at a time", async () => {
    const { manager } = createManager()
    const result = runSplit(manager, {
      parentSessionId: "parent",
      sequential: true,
      plans: [
        { id: "s1", title: "a", description: "a", dependsOn: [] },
        { id: "s2", title: "b", description: "b", dependsOn: [] },
      ],
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.tasksByPlanID.size).toBe(1)

    const s1 = result.tasksByPlanID.get("s1")!
    manager.handleEvent({ type: "session.idle", properties: { sessionID: s1.sessionId } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(result.tasksByPlanID.size).toBe(2)
  })

  test("removes its terminal listener once the run settles", async () => {
    const { manager } = createManager()
    const listenerCount = () =>
      (manager as unknown as { terminalListeners: Set<unknown> }).terminalListeners.size
    const before = listenerCount()

    const result = runSplit(manager, {
      parentSessionId: "parent",
      plans: [{ id: "s1", title: "only", description: "work", dependsOn: [] }],
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    const s1 = result.tasksByPlanID.get("s1")!
    manager.handleEvent({ type: "session.idle", properties: { sessionID: s1.sessionId } })
    await result.done

    expect(listenerCount()).toBe(before)
  })

  test("buildSplitReport lists every plan with status", () => {
    const plans = [
      { id: "s1", title: "one", description: "", dependsOn: [] },
      { id: "s2", title: "two", description: "", dependsOn: ["s1"] },
    ]
    const report = buildSplitReport(new Map(), plans)
    expect(report).toContain("[PRISM SPLIT REPORT]")
    expect(report).toContain("s1 one")
    expect(report).toContain("s2 two")
  })
})
