import { describe, expect, test } from "bun:test"
import { BackgroundManager } from "../src/core/background/manager"
import { PromptGate } from "../src/core/prompt-gate"
import { TERMINAL_TASK_RETENTION_MS, TASK_TTL_MS } from "../src/config/constants"
import { parseConfig } from "../src/config/load"
import type { PrismClient } from "../src/core/client-types"
import type { BgTask } from "../src/core/background/types"
import type { ResolvedModel } from "../src/models"

// Mock client simulating OpenCode sessions in memory. statusData is a live
// object: tests mutate it to drive the polling path.
function createMockClient(
  statusData: Record<string, { type?: string }> = {},
  noToast = false,
): {
  client: PrismClient
  childSessions: Map<string, { parentID: string; prompts: unknown[]; aborted: boolean }>
  statusData: Record<string, { type?: string }>
  toasts: Array<{ title: string; message: string; variant: string }>
} {
  const childSessions = new Map<string, { parentID: string; prompts: unknown[]; aborted: boolean }>()
  const toasts: Array<{ title: string; message: string; variant: string }> = []
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
      status: async () => ({ data: statusData }),
    },
    tui: noToast
      ? ({} as PrismClient["tui"])
      : {
          showToast: async (params: { body: { title: string; message: string; variant: string } }) => {
            toasts.push(params.body)
          },
        },
  }
  return { client, childSessions, statusData, toasts }
}

const SESSION_MODEL: ResolvedModel = { providerID: "openai", modelID: "gpt-5.6-sol" }

function createManager(
  overrides: {
    concurrency?: number
    pollingIntervalMs?: number
    model?: ResolvedModel
    statusData?: Record<string, { type?: string }>
    noToast?: boolean
  } = {},
) {
  const { client, childSessions, statusData, toasts } = createMockClient(overrides.statusData ?? {}, overrides.noToast ?? false)
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
  return { manager, gate, client, childSessions, statusData, toasts }
}

// Drive the polling loop directly (it normally runs on an interval).
const poll = (manager: BackgroundManager): Promise<void> =>
  (manager as unknown as { pollRunningTasks(): Promise<void> }).pollRunningTasks()

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
    expect(promptBody?.model).toEqual({ providerID: "openai", modelID: "gpt-5.6-sol" })
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

  // opencode part data carries no role/state fields (role lives on the
  // message), so the result must be captured from the message history.
  test("completion captures the final assistant text from the message history", async () => {
    const { manager, gate, client } = createManager()
    client.session.messages = async () => ({
      data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "完整的图片解读结果" }] }],
    })
    const task = await manager.launch({
      description: "解读图片",
      prompt: "用 vision_look 读图",
      parentSessionId: "parent",
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(task.status).toBe("running")

    manager.handleEvent({ type: "session.idle", properties: { sessionID: task.sessionId } })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(task.status).toBe("completed")
    expect(task.resultText).toBe("完整的图片解读结果")
    expect(gate.hasRecentDispatch("parent")).toBe(true)
  })

  test("injects the FULL result into the parent notification for a single completed task", async () => {
    const { manager, client } = createManager()
    const fullResult = `图片解读结果: ${"很长的内容".repeat(300)}` // far beyond the 200-char preview
    client.session.messages = async () => ({
      data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: fullResult }] }],
    })
    const wakes: Array<Record<string, unknown>> = []
    const originalPromptAsync = client.session.promptAsync.bind(client.session)
    client.session.promptAsync = async (...args: Parameters<PrismClient["session"]["promptAsync"]>) => {
      if (args[0].path.id === "parent") wakes.push(args[0].body as Record<string, unknown>)
      return originalPromptAsync(...args)
    }

    const task = await manager.launch({ description: "解读图片", prompt: "用 vision_look 读图", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    manager.handleEvent({ type: "session.idle", properties: { sessionID: task.sessionId } })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(task.status).toBe("completed")
    expect(wakes.length).toBe(1)
    const text = (wakes[0]?.parts as Array<{ text?: string }> | undefined)?.map((part) => part.text ?? "").join("") ?? ""
    expect(text).toContain("完整结果:")
    expect(text).toContain(fullResult) // not the 200-char preview
  })

  test("caps an oversized single-task result and points to bg_output", async () => {
    const { manager, client } = createManager()
    const oversized = "x".repeat(25_000) // above MAX_NOTIFICATION_RESULT_CHARS
    client.session.messages = async () => ({
      data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: oversized }] }],
    })
    const wakes: Array<Record<string, unknown>> = []
    const originalPromptAsync = client.session.promptAsync.bind(client.session)
    client.session.promptAsync = async (...args: Parameters<PrismClient["session"]["promptAsync"]>) => {
      if (args[0].path.id === "parent") wakes.push(args[0].body as Record<string, unknown>)
      return originalPromptAsync(...args)
    }

    const task = await manager.launch({ description: "大结果", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    manager.handleEvent({ type: "session.idle", properties: { sessionID: task.sessionId } })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const text = (wakes[0]?.parts as Array<{ text?: string }> | undefined)?.map((part) => part.text ?? "").join("") ?? ""
    expect(text).toContain("（结果过长已截断")
    expect(text).toContain('bg_output("')
    expect(text).not.toContain(oversized)
  })

  test("multi-task batches keep the preview table instead of full results", async () => {
    const { manager, client } = createManager()
    const wakes: Array<Record<string, unknown>> = []
    const originalPromptAsync = client.session.promptAsync.bind(client.session)
    client.session.promptAsync = async (...args: Parameters<PrismClient["session"]["promptAsync"]>) => {
      if (args[0].path.id === "parent") wakes.push(args[0].body as Record<string, unknown>)
      return originalPromptAsync(...args)
    }

    const taskA = await manager.launch({ description: "A", prompt: "a", parentSessionId: "parent" })
    const taskB = await manager.launch({ description: "B", prompt: "b", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    manager.handleEvent({ type: "session.idle", properties: { sessionID: taskA.sessionId } })
    manager.handleEvent({ type: "session.idle", properties: { sessionID: taskB.sessionId } })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(taskA.status).toBe("completed")
    expect(taskB.status).toBe("completed")
    const text = (wakes[0]?.parts as Array<{ text?: string }> | undefined)?.map((part) => part.text ?? "").join("") ?? ""
    expect(text).not.toContain("完整结果:")
    expect(text).toContain("bg_output(task_id)")
  })

  test("part.updated captures assistant text and ignores synthetic prompt parts", async () => {
    const { manager } = createManager()
    const task = await manager.launch({ description: "t", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(task.status).toBe("running")

    manager.handleEvent({
      type: "message.part.updated",
      properties: {
        sessionID: task.sessionId,
        part: { id: "prompt-part", type: "text", text: "work", synthetic: true },
      },
    })
    expect(task.resultText).toBeUndefined()

    manager.handleEvent({
      type: "message.part.updated",
      properties: {
        sessionID: task.sessionId,
        part: { id: "assistant-part", type: "text", text: "完整的解读结果" },
      },
    })
    expect(task.resultText).toBe("完整的解读结果")
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

  test("polling skips streaming sessions instead of completing them", async () => {
    const { manager, statusData } = createManager()
    const task = await manager.launch({ description: "t", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    statusData[task.sessionId!] = { type: "streaming" }
    await poll(manager)
    expect(task.status).toBe("running")
  })

  test("polling marks error-status sessions as error, not completed", async () => {
    const { manager, statusData } = createManager()
    const task = await manager.launch({ description: "t", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    statusData[task.sessionId!] = { type: "error" }
    await poll(manager)
    expect(task.status).toBe("error")
    expect(task.error).toBeDefined()
  })

  test("polling cancels sessions deleted server-side", async () => {
    const { manager, statusData } = createManager()
    const task = await manager.launch({ description: "t", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    statusData[task.sessionId!] = { type: "deleted" }
    await poll(manager)
    expect(task.status).toBe("cancelled")
  })

  test("polling completes idle sessions that produced output", async () => {
    const { manager, statusData } = createManager()
    const task = await manager.launch({ description: "t", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    statusData[task.sessionId!] = { type: "idle" }
    await poll(manager)
    expect(task.status).toBe("completed")
  })

  test("counts each tool part once across repeated part.updated events", async () => {
    const { manager } = createManager()
    const task = await manager.launch({ description: "t", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const sessionID = task.sessionId!
    const emit = (id: string, tool: string) =>
      manager.handleEvent({ type: "message.part.updated", properties: { sessionID, part: { id, type: "tool", tool } } })
    emit("p1", "read")
    emit("p1", "read") // same part, repeated update
    emit("p2", "write")
    expect(task.progress?.toolCalls).toBe(2)
    expect(task.progress?.lastTool).toBe("write")
  })

  test("falls back to counting every update when the part has no id", async () => {
    const { manager } = createManager()
    const task = await manager.launch({ description: "t", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const sessionID = task.sessionId!
    manager.handleEvent({
      type: "message.part.updated",
      properties: { sessionID, part: { type: "tool", tool: "read" } },
    })
    manager.handleEvent({
      type: "message.part.updated",
      properties: { sessionID, part: { type: "tool", tool: "read" } },
    })
    expect(task.progress?.toolCalls).toBe(2)
  })

  test("task lifecycle works without a toast API (no crash, no error status)", async () => {
    const { manager } = createManager({ noToast: true })
    const task = await manager.launch({ description: "t", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(task.status).toBe("running")
    manager.handleEvent({ type: "session.idle", properties: { sessionID: task.sessionId } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(task.status).toBe("completed")
  })

  test("a batch shows one start toast and one terminal toast", async () => {
    const { manager, toasts } = createManager()
    const taskA = await manager.launch({ description: "A", prompt: "a", parentSessionId: "parent" })
    const taskB = await manager.launch({ description: "B", prompt: "b", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 50))

    manager.handleEvent({ type: "session.idle", properties: { sessionID: taskA.sessionId } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    // A alone finishing must not toast (B still running)
    expect(toasts.filter((t) => t.message.includes("COMPLETED"))).toHaveLength(0)

    manager.handleEvent({ type: "session.idle", properties: { sessionID: taskB.sessionId } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const messages = toasts.map((t) => t.message)
    expect(messages.filter((m) => m.includes("Started"))).toHaveLength(1)
    expect(messages.filter((m) => m.includes("COMPLETED"))).toHaveLength(1)
  })

  test("cancel toast uses the warning variant", async () => {
    const { manager, toasts } = createManager()
    const task = await manager.launch({ description: "t", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await manager.cancelTask(task.id)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const cancelToast = toasts.find((t) => t.message.includes("CANCELLED"))
    expect(cancelToast?.variant).toBe("warning")
  })

  // Regression: startTask throwing before it claims the slot (e.g. a network
  // rejection from session.create) used to leak the acquired slot forever —
  // with concurrency 1 the key would never run another task.
  test("a session.create failure releases the concurrency slot", async () => {
    const { manager, client } = createManager({ concurrency: 1 })
    let createCalls = 0
    const originalCreate = client.session.create.bind(client.session)
    client.session.create = async (...args: Parameters<PrismClient["session"]["create"]>) => {
      createCalls++
      if (createCalls === 1) throw new Error("network down")
      return originalCreate(...args)
    }

    const first = await manager.launch({ description: "doomed", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(first.status).toBe("error")

    // A leaked slot would leave this task pending forever.
    const second = await manager.launch({ description: "next", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(second.status).toBe("running")
    await manager.shutdown()
  })

  // Regression: after shutdown cleared the maps, an in-flight processKey loop
  // still held its queue array reference and could start NEW sessions (the
  // cleared semaphore handed out slots again).
  test("shutdown prevents queued tasks from starting", async () => {
    const { manager, childSessions } = createManager({ concurrency: 1 })
    await manager.launch({ description: "blocker", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(childSessions.size).toBe(1)

    // Queued behind the single slot; the loop sits in acquire() for it.
    await manager.launch({ description: "queued", prompt: "work", parentSessionId: "parent" })
    await manager.shutdown()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(childSessions.size).toBe(1) // no session created post-shutdown
  })

  test("launch rejects after shutdown", async () => {
    const { manager } = createManager()
    await manager.shutdown()
    await expect(
      manager.launch({ description: "late", prompt: "work", parentSessionId: "parent" }),
    ).rejects.toThrow("shutting down")
  })

  // Regression: shutdown's abort snapshot runs while session.create is in
  // flight, so the just-created session is not in it — startTask must retire
  // it itself or it would run orphaned with no manager oversight.
  test("shutdown aborts a session created while shutdown was in flight", async () => {
    const { manager, client, childSessions } = createManager({ concurrency: 1 })
    let releaseCreate!: () => void
    let createBlocked!: () => void
    const blocked = new Promise<void>((resolve) => (createBlocked = resolve))
    const releasePromise = new Promise<void>((resolve) => (releaseCreate = resolve))
    const originalCreate = client.session.create.bind(client.session)
    client.session.create = async (...args: Parameters<PrismClient["session"]["create"]>) => {
      createBlocked()
      await releasePromise
      return originalCreate(...args)
    }

    const task = await manager.launch({ description: "doomed", prompt: "work", parentSessionId: "parent" })
    await blocked // startTask is now inside session.create
    await manager.shutdown()
    releaseCreate()

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(task.status).toBe("cancelled")
    expect(childSessions.size).toBe(1)
    expect(Array.from(childSessions.values())[0]?.aborted).toBe(true)
  })

  // Terminal tasks used to accumulate forever (resultText, toolPartIds,
  // multi-MB image parts) — the maps must stay bounded over a long session.
  test("finalize drops the run's heavy payloads", async () => {
    const { manager } = createManager()
    const task = await manager.launch({
      description: "t",
      prompt: "work",
      parts: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" }],
      parentSessionId: "parent",
    })
    task.progress = { toolCalls: 3, toolPartIds: new Set(["p1", "p2"]), lastUpdate: new Date() }
    ;(manager as unknown as { finalizeTask(t: BgTask, s: BgTask["status"], e?: string): void }).finalizeTask(
      task,
      "completed",
    )
    expect(task.status).toBe("completed")
    expect(task.parts).toBeUndefined()
    expect(task.progress?.toolPartIds).toBeUndefined()
  })

  test("terminal tasks are pruned after the retention window", async () => {
    const { manager } = createManager()
    const fresh = await manager.launch({ description: "fresh", prompt: "work", parentSessionId: "parent" })
    const stale = await manager.launch({ description: "stale", prompt: "work", parentSessionId: "parent" })
    const internals = manager as unknown as {
      finalizeTask(t: BgTask, s: BgTask["status"], e?: string): void
      pruneStaleTasks(): void
    }
    internals.finalizeTask(fresh, "completed")
    internals.finalizeTask(stale, "completed")
    stale.completedAt = new Date(Date.now() - TERMINAL_TASK_RETENTION_MS - 1000)

    internals.pruneStaleTasks()

    expect(manager.getTask(stale.id)).toBeUndefined()
    expect(manager.getTask(fresh.id)).toBeDefined()
    expect(manager.getTasksByParentSession("parent").map((t) => t.id)).toEqual([fresh.id])
  })

  // Regression: an unreachable status map or message history used to be
  // treated as "idle" / "has output", falsely completing every running task
  // and aborting child sessions that were still working server-side.
  test("an API outage does not falsely complete running tasks", async () => {
    const { manager, client, childSessions } = createManager()
    const task = await manager.launch({ description: "t", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(task.status).toBe("running")
    expect(task.sessionId).toBeDefined()

    // Full outage: the status map itself is unreachable — the sweep must skip.
    client.session.status = async () => {
      throw new Error("server down")
    }
    client.session.messages = async () => {
      throw new Error("server down")
    }
    await poll(manager)
    expect(task.status).toBe("running")

    // Status map reachable but message history unreachable: still fail-closed.
    client.session.status = async () => ({ data: { [task.sessionId!]: { type: "idle" } } })
    await poll(manager)
    expect(task.status).toBe("running")

    const child = Array.from(childSessions.values())[0]
    expect(child?.aborted).toBe(false)
    await manager.shutdown()
  })

  test("cancelAllByParentSession retires every task of a parent session without waking it", async () => {
    const { manager, gate } = createManager()
    const a = await manager.launch({ description: "a", prompt: "work", parentSessionId: "parent" })
    const b = await manager.launch({ description: "b", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(a.status).toBe("running")
    expect(b.status).toBe("running")

    await manager.cancelAllByParentSession("parent", "parent session deleted")

    expect(a.status).toBe("cancelled")
    expect(b.status).toBe("cancelled")
    // skipNotification: true — no wake dispatched to the deleted parent
    expect(gate.hasRecentDispatch("parent")).toBe(false)
    await manager.shutdown()
  })

  test("cancel clears the session link so late session.deleted events are no-ops", async () => {
    const { manager } = createManager()
    const task = await manager.launch({ description: "t", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const sessionID = task.sessionId!
    await manager.cancelTask(task.id)
    expect(task.sessionId).toBeUndefined()
    manager.handleEvent({ type: "session.deleted", properties: { sessionID } })
    expect(task.status).toBe("cancelled")
  })

  test("resume re-runs a completed task's child session with a continuation prompt", async () => {
    const { manager, childSessions } = createManager()
    const task = await manager.launch({ description: "t", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    manager.handleEvent({ type: "session.idle", properties: { sessionID: task.sessionId } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(task.status).toBe("completed")

    const resumed = await manager.resume(task.id, "展开第二步的细节")
    expect(resumed.status).toBe("running")
    expect(resumed.completedAt).toBeUndefined()
    const prompts = childSessions.get(task.sessionId!)!.prompts
    expect(prompts).toHaveLength(2)
    const followUp = prompts[1] as { parts?: Array<{ type: string; text?: string }> }
    expect(followUp.parts?.[0]?.text).toBe("展开第二步的细节")
    await manager.shutdown()
  })

  test("running tasks past the TTL are warned once, not cancelled", async () => {
    const { manager, toasts, statusData } = createManager()
    const task = await manager.launch({ description: "long", prompt: "work", parentSessionId: "parent" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    statusData[task.sessionId!] = { type: "busy" } // keep it from completing via the sweep
    task.startedAt = new Date(Date.now() - TASK_TTL_MS - 1000)

    await poll(manager)
    expect(task.status).toBe("running")
    expect(toasts.some((t) => t.message.includes("仍在继续"))).toBe(true)

    await poll(manager) // second sweep must not warn again
    expect(toasts.filter((t) => t.message.includes("仍在继续"))).toHaveLength(1)
    expect(task.status).toBe("running")
    await manager.shutdown()
  })
})
