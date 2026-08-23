import { describe, expect, test } from "bun:test"
import { createCommandExecuteBeforeHook } from "../src/hooks/command-execute-before"
import type { BackgroundManager } from "../src/core/background/manager"
import type { BgTask } from "../src/core/background/types"

// Command-layer routing for /bg subcommands. The manager interactions are
// stubbed — manager semantics (queueing, resume, ownership) are covered in
// background-manager.test.ts; what matters here is which subcommand maps to
// which manager call and what text the user sees.

type SendResult = { queued: boolean; queueLength: number }

function createHook(options: {
  tasks: BgTask[]
  sendResult?: SendResult | Error
  cancelled?: boolean
}): { hook: ReturnType<typeof createCommandExecuteBeforeHook>; toasts: string[] } {
  const manager = {
    getTasksByParentSession: () => options.tasks,
    getTask: (id: string) => options.tasks.find((task) => task.id === id),
    cancelTask: async () => options.cancelled ?? true,
    cancelAllByParentSession: async () => {},
    send: async () => {
      if (options.sendResult instanceof Error) throw options.sendResult
      if (!options.sendResult) throw new Error("send not expected")
      return { task: options.tasks[0]!, ...options.sendResult }
    },
  } as unknown as BackgroundManager
  const toasts: string[] = []
  const client = {
    tui: {
      showToast: async (params: { body: { message: string } }) => {
        toasts.push(params.body.message)
      },
    },
  } as never
  const hook = createCommandExecuteBeforeHook({
    manager,
    serverUrl: "http://localhost:4096",
    client,
  })
  return { hook, toasts }
}

function makeTask(overrides: Partial<BgTask>): BgTask {
  return {
    id: "bg_1",
    parentSessionId: "session",
    description: "demo",
    prompt: "work",
    retries: 0,
    status: "running",
    queuedAt: new Date(),
    ...overrides,
  } as BgTask
}

async function run(hook: ReturnType<typeof createCommandExecuteBeforeHook>, command: string, args: string): Promise<string> {
  const output = { parts: [] as Array<{ type: string; text?: string }> }
  await hook({ command, sessionID: "session", arguments: args }, output)
  return output.parts.map((part) => part.text ?? "").join("\n")
}

describe("/bg command routing", () => {
  test("status with no tasks says so", async () => {
    const text = await run(createHook({ tasks: [] }).hook, "bg", "status")
    expect(text).toContain("当前会话没有后台任务")
  })

  test("status lists the session's tasks", async () => {
    const text = await run(
      createHook({ tasks: [makeTask({ id: "bg_9", description: "编译文档", status: "running" })] }).hook,
      "bg",
      "status",
    )
    expect(text).toContain("bg_9")
    expect(text).toContain("编译文档")
    expect(text).toContain("running")
  })

  test("send to a running task reports the queued message without a toast (instant)", async () => {
    const { hook, toasts } = createHook({
      tasks: [makeTask({ status: "running" })],
      sendResult: { queued: true, queueLength: 1 },
    })
    const text = await run(hook, "bg", "send bg_1 注意边界情况")
    expect(text).toContain("已排队")
    expect(text).toContain("bg_1")
    expect(toasts).toHaveLength(0)
  })

  test("send to a finished task reports the resumed session and toasts first (may wait on a slot)", async () => {
    const { hook, toasts } = createHook({
      tasks: [makeTask({ status: "completed" })],
      sendResult: { queued: false, queueLength: 0 },
    })
    const text = await run(hook, "bg", "send bg_1 展开第二步")
    expect(text).toContain("已恢复运行")
    expect(toasts.some((t) => t.includes("正在恢复"))).toBe(true)
  })

  test("send failure surfaces the error text", async () => {
    const text = await run(
      createHook({
        tasks: [makeTask({ status: "running" })],
        sendResult: new Error("child session gone"),
      }).hook,
      "bg",
      "send bg_1 追问",
    )
    expect(text).toContain("发送失败")
    expect(text).toContain("child session gone")
  })

  test("output for a task owned by another session is denied", async () => {
    const text = await run(createHook({ tasks: [makeTask({ parentSessionId: "other" })] }).hook, "bg", "output bg_1")
    expect(text).toContain("无权操作其他会话的任务")
  })

  test("cancel with an id cancels the owned task and toasts before the abort wait", async () => {
    const { hook, toasts } = createHook({ tasks: [makeTask({})], cancelled: true })
    const text = await run(hook, "bg", "cancel bg_1")
    expect(text).toContain("已取消任务")
    expect(text).toContain("bg_1")
    expect(toasts.some((t) => t.includes("正在取消"))).toBe(true)
  })

  test("cancel without an id retires the whole session with a toast", async () => {
    const { hook, toasts } = createHook({ tasks: [makeTask({})] })
    const text = await run(hook, "bg", "cancel")
    expect(text).toContain("已取消当前会话的全部后台任务")
    expect(toasts.some((t) => t.includes("正在取消"))).toBe(true)
  })

  // /split task descriptions fall through to the command template (the model
  // calls split_task); only the deterministic subcommands run natively.
  test("/split status routes natively; a task description produces no output here", async () => {
    const { hook } = createHook({ tasks: [] })
    expect(await run(hook, "split", "status")).toContain("当前会话没有后台任务")
    const output = { parts: [] as Array<{ type: string; text?: string }> }
    await hook({ command: "split", sessionID: "session", arguments: "重构整个模块 --dry-run" }, output)
    expect(output.parts).toHaveLength(0)
  })
})
