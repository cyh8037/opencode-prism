import { describe, expect, test } from "bun:test"
import { createCommandExecuteBeforeHook } from "../src/hooks/command-execute-before"
import type { BackgroundManager } from "../src/core/background/manager"
import type { BgTask } from "../src/core/background/types"
import { SplitRunRegistry } from "../src/core/split/registry"

// Command-layer routing for /bg subcommands. The manager interactions are
// stubbed — manager semantics (queueing, resume, ownership) are covered in
// background-manager.test.ts; what matters here is which subcommand maps to
// which manager call and what text the user sees.

type SendResult = { queued: boolean; queueLength: number }

function createHook(options: {
  tasks: BgTask[]
  sendResult?: SendResult | Error
  cancelled?: boolean
  registry?: SplitRunRegistry
  onCancelTask?: (taskID: string, options?: { skipNotification?: boolean }) => Promise<boolean>
}): { hook: ReturnType<typeof createCommandExecuteBeforeHook>; toasts: string[] } {
  const manager = {
    getTasksByParentSession: () => options.tasks,
    getTask: (id: string) => options.tasks.find((task) => task.id === id),
    cancelTask: async (taskID: string, cancelOptions?: { skipNotification?: boolean }) => {
      if (options.onCancelTask) return options.onCancelTask(taskID, cancelOptions)
      return options.cancelled ?? true
    },
    cancelAllByParentSession: async () => {},
    getConcurrencySnapshot: () => [],
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
    registry: options.registry ?? new SplitRunRegistry(),
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
    expect(text).toContain("RUNNING")
  })

  test("unrecognized status variants get a usage hint instead of falling through to task semantics", async () => {
    const { hook } = createHook({ tasks: [] })
    // 穿透会把敲错的状态查询当成任务描述 spawn 出去
    expect(await run(hook, "bg", "status --al")).toContain("用法: /bg status")
    expect(await run(hook, "bg", "status  --all")).toContain("用法: /bg status")
    expect(await run(hook, "split", "status --al")).toContain("用法: /split status")
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
    expect(await run(hook, "split", "status")).toContain("当前会话没有拆分任务")
    const output = { parts: [] as Array<{ type: string; text?: string }> }
    await hook({ command: "split", sessionID: "session", arguments: "重构整个模块 --dry-run" }, output)
    expect(output.parts).toHaveLength(0)
  })

  test("/split cancel sp_xxx cancels the run's unfinished subtasks only", async () => {
    const registry = new SplitRunRegistry()
    const running = makeTask({ id: "bg_r1", status: "running" })
    const done = makeTask({ id: "bg_r2", status: "completed" })
    const { id: runID } = registry.register({
      sessionID: "session",
      plans: [],
      tasksByPlanID: new Map([
        ["s1", running],
        ["s2", done],
      ]),
      skippedPlanIDs: new Map(),
      sequential: false,
      settled: false,
      createdAt: new Date(),
    })
    const cancelledCalls: Array<{ id: string; skipNotification?: boolean }> = []
    const { hook, toasts } = createHook({
      tasks: [running, done],
      registry,
      onCancelTask: async (taskID, cancelOptions) => {
        cancelledCalls.push({ id: taskID, skipNotification: cancelOptions?.skipNotification })
        return true
      },
    })
    const text = await run(hook, "split", `cancel ${runID}`)
    expect(cancelledCalls).toEqual([{ id: "bg_r1", skipNotification: true }]) // completed 跳过
    expect(text).toContain(`已取消拆分任务 \`${runID}\` 的 1 个子任务`)
    // 整批取消只弹一条汇总 toast（防逐任务 CANCELLED 刷屏）
    expect(toasts.some((t) => t.includes(`已取消拆分任务 \`${runID}\` 的 1 个子任务`))).toBe(true)
  })

  test("/bg status bg_xxx shows the single task as a table even when finished", async () => {
    const done = makeTask({ id: "bg_done1", description: "已完成任务", status: "completed", startedAt: new Date(), completedAt: new Date() })
    const { hook } = createHook({ tasks: [done] })
    const text = await run(hook, "bg", "status bg_done1")
    expect(text).toContain("bg_done1")
    expect(text).toContain("已完成任务")
    expect(text).toContain("COMPLETED")
    // 已结束任务仍以表格行展示,不折叠为摘要
    expect(text).not.toContain("已结束")
  })

  test("/bg status bg_xxx rejects foreign tasks", async () => {
    const { hook } = createHook({ tasks: [makeTask({ parentSessionId: "other" })] })
    expect(await run(hook, "bg", "status bg_1")).toContain("无权操作其他会话的任务")
    expect(await run(hook, "bg", "status bg_unknown")).toContain("任务不存在")
  })

  test("/split status sp_xxx expands a single run's full DAG", async () => {
    const registry = new SplitRunRegistry()
    const running = makeTask({ id: "bg_r1", status: "running", startedAt: new Date() })
    const { id: runID } = registry.register({
      sessionID: "session",
      plans: [{ id: "s1", title: "搭建组件库", description: "…", dependsOn: [] }],
      tasksByPlanID: new Map([["s1", running]]),
      skippedPlanIDs: new Map(),
      sequential: false,
      settled: false,
      createdAt: new Date(),
    })
    const { hook } = createHook({ tasks: [running], registry })
    const text = await run(hook, "split", `status ${runID}`)
    expect(text).toContain("[s1] 搭建组件库 RUNNING")
  })

  test("/split status sp_xxx rejects unknown and foreign runs", async () => {
    const registry = new SplitRunRegistry()
    const { id: runID } = registry.register({
      sessionID: "other",
      plans: [],
      tasksByPlanID: new Map(),
      skippedPlanIDs: new Map(),
      sequential: false,
      settled: false,
      createdAt: new Date(),
    })
    const { hook } = createHook({ tasks: [], registry })
    expect(await run(hook, "split", `status ${runID}`)).toContain("无权查看其他会话的拆分任务")
    expect(await run(hook, "split", "status sp_nope")).toContain("拆分任务不存在或已过期")
  })

  test("/split cancel sp_xxx rejects unknown and foreign runs", async () => {
    const registry = new SplitRunRegistry()
    const { id: runID } = registry.register({
      sessionID: "other",
      plans: [],
      tasksByPlanID: new Map(),
      skippedPlanIDs: new Map(),
      sequential: false,
      settled: false,
      createdAt: new Date(),
    })
    const { hook } = createHook({ tasks: [], registry })
    expect(await run(hook, "split", `cancel ${runID}`)).toContain("无权取消其他会话的拆分任务")
    expect(await run(hook, "split", "cancel sp_nope")).toContain("拆分任务不存在或已过期")
  })
})
