import { describe, expect, test } from "bun:test"
import { BackgroundManager } from "../src/core/background/manager"
import { PromptGate } from "../src/core/prompt-gate"
import { parseConfig } from "../src/config/load"
import type { PrismClient } from "../src/core/client-types"
import type { ResolvedModel } from "../src/models"

// Mock client simulating OpenCode sessions in memory.
function createMockClient(): {
  client: PrismClient
  childSessions: Map<string, { parentID: string; prompts: unknown[]; aborted: boolean }>
} {
  const childSessions = new Map<string, { parentID: string; prompts: unknown[]; aborted: boolean }>()
  let childCounter = 0
  const client: PrismClient = {
    session: {
      get: async ({ path }) => ({
        data: {
          id: path.id,
          directory: "/work",
          model: { id: "gpt-5.6-sol", providerID: "openai" },
        },
      }),
      create: async ({ body }) => {
        const id = `child_${++childCounter}`
        childSessions.set(id, {
          parentID: String((body as Record<string, unknown>).parentID),
          prompts: [],
          aborted: false,
        })
        return { data: { id } }
      },
      abort: async ({ path }) => {
        const session = childSessions.get(path.id)
        if (session) session.aborted = true
      },
      prompt: async () => {},
      promptAsync: async ({ path, body }) => {
        childSessions.get(path.id)?.prompts.push(body)
      },
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
    tui: {
      showToast: async () => {},
    },
  }
  return { client, childSessions }
}

const SESSION_MODEL: ResolvedModel = { providerID: "openai", modelID: "gpt-5.6-sol" }

function createManager(overrides: { concurrency?: number; pollingIntervalMs?: number; model?: ResolvedModel } = {}) {
  const { client, childSessions } = createMockClient()
  const config = parseConfig({
    background: { concurrency: overrides.concurrency ?? 5 },
  })
  const gate = new PromptGate(client, { idlePollMs: 10 })
  const manager = new BackgroundManager({
    client,
    directory: "/work",
    config,
    gate,
    resolveModel: async () => overrides.model ?? SESSION_MODEL,
    pollingIntervalMs: overrides.pollingIntervalMs ?? 60_000,
  })
  return { manager, gate, client, childSessions }
}

describe("BackgroundManager", () => {
  test("launch creates a child session with the resolved session model and fires the prompt", async () => {
    const { manager, childSessions } = createManager()
    const task = await manager.launch({
      description: "test task",
      prompt: "do the thing",
      parentSessionId: "parent",
    })
    expect(task.status).toBe("pending")

    // wait for the queue to drain
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(task.status).toBe("running")
    expect(task.sessionId).toBeDefined()
    expect(task.model).toEqual(SESSION_MODEL)
    const session = childSessions.get(task.sessionId!)
    expect(session?.parentID).toBe("parent")
    const promptBody = session?.prompts[0] as Record<string, unknown>
    expect(promptBody?.model).toEqual({ id: "gpt-5.6-sol", providerID: "openai" })
  })

  test("session.idle with output completes the task and wakes the parent", async () => {
    const { manager, gate } = createManager()
    const task = await manager.launch({
      description: "test task",
      prompt: "do the thing",
      parentSessionId: "parent",
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(task.status).toBe("running")

    manager.handleEvent({ type: "session.idle", properties: { sessionID: task.sessionId } })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(task.status).toBe("completed")
    expect(gate.hasRecentDispatch("parent")).toBe(true)
  })

  test("two sibling tasks wake the parent once", async () => {
    const { manager, gate, client } = createManager()
    let wakeCount = 0
    const originalPromptAsync = client.session.promptAsync.bind(client.session)
    client.session.promptAsync = async (...args: Parameters<PrismClient["session"]["promptAsync"]>) => {
      // only count wakes addressed to the parent session, not child launches
      if (args[0].path.id === "parent") wakeCount++
      return originalPromptAsync(...args)
    }

    const taskA = await manager.launch({ description: "A", prompt: "a", parentSessionId: "parent" })
    const taskB = await manager.launch({ description: "B", prompt: "b", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 50))

    manager.handleEvent({ type: "session.idle", properties: { sessionID: taskA.sessionId } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    // B still running: no wake yet
    expect(wakeCount).toBe(0)

    manager.handleEvent({ type: "session.idle", properties: { sessionID: taskB.sessionId } })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(taskA.status).toBe("completed")
    expect(taskB.status).toBe("completed")
    expect(wakeCount).toBe(1)
    expect(gate.hasRecentDispatch("parent")).toBe(true)
  })

  test("cancel aborts the child session and notifies", async () => {
    const { manager, childSessions } = createManager()
    const task = await manager.launch({
      description: "cancelled task",
      prompt: "work",
      parentSessionId: "parent",
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const sessionID = task.sessionId!
    const cancelled = await manager.cancelTask(task.id)
    expect(cancelled).toBe(true)
    expect(task.status).toBe("cancelled")
    expect(childSessions.get(sessionID)?.aborted).toBe(true)
  })

  test("retryable prompt failure retries once with the SAME model", async () => {
    const { manager, childSessions } = createManager()
    const client = manager["deps"].client
    let failures = 0
    const original = client.session.promptAsync.bind(client.session)
    client.session.promptAsync = async (...args: Parameters<PrismClient["session"]["promptAsync"]>) => {
      if (failures < 1) {
        failures++
        throw new Error("rate limit exceeded")
      }
      return original(...args)
    }

    const task = await manager.launch({ description: "retry me", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 150))

    // rebuilt a new session, model unchanged, one retry consumed
    expect(task.status).toBe("running")
    expect(task.retries).toBe(1)
    expect(task.model).toEqual(SESSION_MODEL)
    expect(childSessions.size).toBe(2)
  })

  test("second failure after the retry budget marks the task as error", async () => {
    const { manager } = createManager()
    const client = manager["deps"].client
    let failures = 0
    const original = client.session.promptAsync.bind(client.session)
    client.session.promptAsync = async (...args: Parameters<PrismClient["session"]["promptAsync"]>) => {
      if (failures < 2) {
        failures++
        throw new Error("rate limit exceeded")
      }
      return original(...args)
    }

    const task = await manager.launch({ description: "doomed", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(task.status).toBe("error")
    expect(task.retries).toBe(1)
  })

  test("launch throws when the session model is unresolvable", async () => {
    const { client } = createMockClient()
    const config = parseConfig({})
    const gate = new PromptGate(client, { idlePollMs: 10 })
    const manager = new BackgroundManager({
      client,
      directory: "/work",
      config,
      gate,
      resolveModel: async () => undefined,
    })
    await expect(
      manager.launch({ description: "x", prompt: "y", parentSessionId: "parent" }),
    ).rejects.toThrow("无法确定主会话")
  })
})
