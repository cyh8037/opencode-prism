import { describe, expect, test } from "bun:test"
import { subTaskPlanArraySchema } from "../src/core/split/plan-schema"
import { buildSplitReport, layerPlans, runSplit } from "../src/core/split/scheduler"
import { SplitService } from "../src/core/split/service"
import { SplitRunRegistry } from "../src/core/split/registry"
import { createSplitTool } from "../src/tools/split"
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

  test("duplicate dependencies are not falsely rejected as a cycle", () => {
    // Kahn counts indegree from dependsOn: a duplicated entry ["s1", "s1"]
    // would inflate s2's indegree past the edges the queue actually removes,
    // leaving it stuck at degree 1 and falsely reporting a cycle.
    const result = subTaskPlanArraySchema.safeParse([
      { id: "s1", title: "a", description: "a", dependsOn: [] },
      { id: "s2", title: "b", description: "b", dependsOn: ["s1", "s1"] },
    ])
    expect(result.success).toBe(true)
  })

  test("self-dependency is rejected as a cycle", () => {
    const result = subTaskPlanArraySchema.safeParse([
      { id: "s1", title: "a", description: "a", dependsOn: ["s1"] },
    ])
    expect(result.success).toBe(false)
  })
})

function createManager(options: { unresolvableModel?: boolean } = {}) {
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
    resolveModel: async () =>
      options.unresolvableModel ? undefined : { providerID: "openai", modelID: "gpt-5.6-sol" },
    pollingIntervalMs: 60_000,
  })
  return { manager, client }
}

describe("layerPlans", () => {
  test("independent plans form a single layer", () => {
    const layers = layerPlans([
      { id: "s1", title: "a", description: "", dependsOn: [] },
      { id: "s2", title: "b", description: "", dependsOn: [] },
    ])
    expect(layers).toHaveLength(1)
    expect(layers[0]!.map((p) => p.id)).toEqual(["s1", "s2"])
  })

  test("a diamond dependency lands in three waves", () => {
    const layers = layerPlans([
      { id: "s1", title: "base", description: "", dependsOn: [] },
      { id: "s2", title: "left", description: "", dependsOn: ["s1"] },
      { id: "s3", title: "right", description: "", dependsOn: ["s1"] },
      { id: "s4", title: "join", description: "", dependsOn: ["s2", "s3"] },
    ])
    expect(layers.map((layer) => layer.map((p) => p.id))).toEqual([["s1"], ["s2", "s3"], ["s4"]])
  })

  test("an unorderable remainder (cycle) is appended, not dropped", () => {
    // Schema validation rejects cycles before layering ever sees them; this
    // only pins the total-function behavior.
    const layers = layerPlans([
      { id: "s1", title: "a", description: "", dependsOn: ["s2"] },
      { id: "s2", title: "b", description: "", dependsOn: ["s1"] },
    ])
    expect(layers).toHaveLength(1)
    expect(layers[0]!.map((p) => p.id).sort()).toEqual(["s1", "s2"])
  })
})

describe("SplitService dry-run", () => {
  function createPlannerClient(plannerText: string, prompts: unknown[] = []): PrismClient {
    return {
      session: {
        get: async () => ({
          data: { id: "parent", directory: "/work", model: { id: "gpt-5.6-sol", providerID: "openai" } },
        }),
        create: async () => ({ data: { id: "planner_session" } }),
        abort: async () => {},
        prompt: async () => {},
        promptAsync: async ({ body }) => {
          prompts.push(body)
        },
        messages: async () => ({
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: plannerText, state: { status: "completed" } }],
            },
          ],
        }),
        status: async () => ({ data: {} }),
      },
      tui: { showToast: async () => {} },
    }
  }

  const plannerText = JSON.stringify([
    { id: "s1", title: "调研", description: "收集上下文", dependsOn: [] },
    { id: "s2", title: "实现A", description: "写模块A", dependsOn: ["s1"] },
    { id: "s3", title: "实现B", description: "写模块B", dependsOn: ["s1"] },
    { id: "s4", title: "整合", description: "合并验证", dependsOn: ["s2", "s3"] },
  ])

  function createService(client: PrismClient): SplitService {
    return new SplitService({
      client,
      directory: "/work",
      manager: {} as never,
      gate: new PromptGate(client, { idlePollMs: 10 }),
      registry: new SplitRunRegistry(),
      resolvePlannerModel: async () => ({ providerID: "openai", modelID: "gpt-5.6-sol" }),
    })
  }

  const plannerPromptText = (prompts: unknown[]): string => {
    const first = prompts[0] as { parts?: Array<{ text?: string }> }
    return first?.parts?.[0]?.text ?? ""
  }

  test("renders the plan grouped into parallel waves with ASAP semantics", async () => {
    const prompts: unknown[] = []
    const service = createService(createPlannerClient(plannerText, prompts))

    const outcome = await service.split({ sessionID: "parent", task: "做大改造", dryRun: true })

    expect(outcome.kind).toBe("dry-run")
    expect(outcome.message).toContain("4 个子任务")
    expect(outcome.message).toContain("分 3 波执行")
    expect(outcome.message).toContain("第 1 波（无依赖，立即启动）")
    expect(outcome.message).toContain("依赖在前一波")
    expect(outcome.message).toContain("即启动，不等整波全部结束")
    expect(outcome.message).toContain("s4 整合 (依赖: s2, s3)")
  })

  test("sequential dry-run renders the launch order, not waves", async () => {
    const service = createService(createPlannerClient(plannerText))

    const outcome = await service.split({ sessionID: "parent", task: "做大改造", dryRun: true, sequential: true })

    expect(outcome.message).toContain("串行执行")
    expect(outcome.message).toContain("执行顺序:")
    expect(outcome.message).toContain("1. s1 调研")
    expect(outcome.message).toContain("4. s4 整合")
    expect(outcome.message).not.toContain("第 1 波")
  })

  test("maxSubtasks is clamped to the schema bounds for both entry points", async () => {
    const over: unknown[] = []
    await createService(createPlannerClient(plannerText, over)).split({
      sessionID: "parent",
      task: "x",
      dryRun: true,
      maxSubtasks: 50,
    })
    expect(plannerPromptText(over)).toContain("2 到 12 个子任务")

    const under: unknown[] = []
    await createService(createPlannerClient(plannerText, under)).split({
      sessionID: "parent",
      task: "x",
      dryRun: true,
      maxSubtasks: 0,
    })
    expect(plannerPromptText(under)).toContain("2 到 2 个子任务")

    const fractional: unknown[] = []
    await createService(createPlannerClient(plannerText, fractional)).split({
      sessionID: "parent",
      task: "x",
      dryRun: true,
      maxSubtasks: 4.5,
    })
    expect(plannerPromptText(fractional)).toContain("2 到 12 个子任务")
  })
})

describe("SplitService intent check", () => {
  const plannerText = JSON.stringify([{ id: "s1", title: "only", description: "work", dependsOn: [] }])

  // 第一个创建的子会话固定为 intent_session，后续为 planner_session；
  // messages 按会话 id 返回各自的预设文本。
  function createIntentAwareClient(opts: {
    intentText: string
    plannerText?: string
    createFails?: boolean
  }): { client: PrismClient; prompts: Array<{ pathId?: string; body?: Record<string, unknown> }> } {
    const prompts: Array<{ pathId?: string; body?: Record<string, unknown> }> = []
    let sessionCount = 0
    const client: PrismClient = {
      session: {
        get: async () => ({
          data: { id: "parent", directory: "/work", model: { id: "gpt-5.6-sol", providerID: "openai" } },
        }),
        create: async ({ body }) => {
          sessionCount++
          if (opts.createFails && sessionCount === 1) return { error: { message: "refused" } }
          // 按创建请求的 title 命名会话（而非顺序）：关闭意图识别时第一个
          // 创建的就是 planner 会话。
          const title = String((body as Record<string, unknown>).title)
          return { data: { id: title.includes("intent") ? "intent_session" : "planner_session" } }
        },
        abort: async () => {},
        prompt: async () => {},
        promptAsync: async ({ path, body }) => {
          prompts.push({ pathId: path?.id, body: body as Record<string, unknown> })
        },
        messages: async ({ path }) => {
          const text = path?.id === "intent_session" ? opts.intentText : (opts.plannerText ?? "")
          return {
            data: text
              ? [{ info: { role: "assistant" }, parts: [{ type: "text", text, state: { status: "completed" } }] }]
              : [],
          }
        },
        status: async () => ({ data: {} }),
      },
      tui: { showToast: async () => {} },
    }
    return { client, prompts }
  }

  function createService(client: PrismClient): SplitService {
    return new SplitService({
      client,
      directory: "/work",
      manager: {} as never,
      gate: new PromptGate(client, { idlePollMs: 10 }),
      registry: new SplitRunRegistry(),
      resolvePlannerModel: async () => ({ providerID: "openai", modelID: "gpt-5.6-sol" }),
      intentCheckEnabled: true,
    })
  }

  test("a direct verdict returns skipped-intent without invoking the planner", async () => {
    const { client, prompts } = createIntentAwareClient({ intentText: '{"intent":"direct","reason":"单步任务"}' })
    const outcome = await createService(client).split({ sessionID: "parent", task: "修 typo", dryRun: true })
    expect(outcome.kind).toBe("skipped-intent")
    expect(outcome.message).toContain("无需拆分")
    expect(outcome.message).toContain("单步任务")
    expect(outcome.message).toContain("预览判定")
    expect(outcome.message).toContain("split.intentCheck=false")
    // planner 从未被调用:唯一的 prompt 是意图子会话的
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.pathId).toBe("intent_session")
  })

  test("a non-dry-run direct verdict omits the preview note", async () => {
    const { client } = createIntentAwareClient({ intentText: '{"intent":"direct"}' })
    const outcome = await createService(client).split({ sessionID: "parent", task: "修 typo" })
    expect(outcome.kind).toBe("skipped-intent")
    expect(outcome.message).not.toContain("预览判定")
    expect(outcome.message).toContain("无需拆分")
  })

  test("a split verdict proceeds to the planner", async () => {
    const { client, prompts } = createIntentAwareClient({ intentText: '{"intent":"split"}', plannerText })
    const outcome = await createService(client).split({ sessionID: "parent", task: "x", dryRun: true })
    expect(outcome.kind).toBe("dry-run")
    expect(outcome.message).not.toContain("意图识别")
    expect(prompts.some((p) => p.pathId === "planner_session")).toBe(true)
  })

  test("an intent-session creation failure fails open to the normal flow", async () => {
    const { client, prompts } = createIntentAwareClient({
      intentText: '{"intent":"direct"}',
      plannerText,
      createFails: true,
    })
    const outcome = await createService(client).split({ sessionID: "parent", task: "x", dryRun: true })
    expect(outcome.kind).toBe("dry-run")
    expect(prompts.some((p) => p.pathId === "planner_session")).toBe(true)
  })

  test("unparseable intent output fails open", async () => {
    const { client } = createIntentAwareClient({ intentText: "直接做吧", plannerText })
    const outcome = await createService(client).split({ sessionID: "parent", task: "x", dryRun: true })
    expect(outcome.kind).toBe("dry-run")
  })

  test("services without intentCheckEnabled skip the check entirely (option absent, not wired)", async () => {
    const { client, prompts } = createIntentAwareClient({ intentText: '{"intent":"direct"}', plannerText })
    const service = new SplitService({
      client,
      directory: "/work",
      manager: {} as never,
      gate: new PromptGate(client, { idlePollMs: 10 }),
      registry: new SplitRunRegistry(),
      resolvePlannerModel: async () => ({ providerID: "openai", modelID: "gpt-5.6-sol" }),
    })
    const outcome = await service.split({ sessionID: "parent", task: "x", dryRun: true })
    expect(outcome.kind).toBe("dry-run")
    expect(prompts.some((p) => p.pathId === "intent_session")).toBe(false)
  })
})

describe("split_task tool", () => {
  const ctx = { sessionID: "parent" }

  test("forwards flags to the service and returns its message", async () => {
    const calls: Array<Record<string, unknown>> = []
    const service = {
      split: async (request: Record<string, unknown>) => {
        calls.push(request)
        return { kind: "launched", message: "拆分计划已启动：3 个子任务" }
      },
    } as never
    const definition = createSplitTool(service).split_task!
    const result = await definition.execute(
      { task: "重构模块", dry_run: true, sequential: true, max: 5 },
      ctx as never,
    )
    expect(result).toContain("拆分计划已启动")
    expect(calls[0]).toEqual({
      sessionID: "parent",
      task: "重构模块",
      dryRun: true,
      sequential: true,
      maxSubtasks: 5,
    })
  })

  test("degrades a throwing service to an actionable message", async () => {
    const service = {
      split: async () => {
        throw new Error("boom")
      },
    } as never
    const definition = createSplitTool(service).split_task!
    const result = await definition.execute({ task: "x" }, ctx as never)
    expect(result).toContain("拆分失败")
    expect(result).toContain("boom")
  })
})

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

  test("a failed dependency skips its dependents and cascades downstream", async () => {
    const { manager } = createManager()
    const plans = [
      { id: "s1", title: "base", description: "a", dependsOn: [] },
      { id: "s2", title: "mid", description: "b", dependsOn: ["s1"] },
      { id: "s3", title: "leaf", description: "c", dependsOn: ["s2"] },
      { id: "s4", title: "free", description: "d", dependsOn: [] },
    ]
    const result = runSplit(manager, { parentSessionId: "parent", plans })

    await new Promise((resolve) => setTimeout(resolve, 50))
    const s1 = result.tasksByPlanID.get("s1")!
    await manager.cancelTask(s1.id) // dependency fails terminally

    // the independent plan still runs and completes
    const s4 = result.tasksByPlanID.get("s4")!
    manager.handleEvent({ type: "session.idle", properties: { sessionID: s4.sessionId } })

    await result.done
    expect(result.skippedPlanIDs.get("s2")).toBe("s1")
    expect(result.skippedPlanIDs.get("s3")).toBe("s2") // cascaded through the skipped s2
    expect(result.tasksByPlanID.has("s2")).toBe(false)
    expect(result.tasksByPlanID.has("s3")).toBe(false)
    expect(s4.status).toBe("completed")

    const report = buildSplitReport(result.tasksByPlanID, plans, result.skippedPlanIDs)
    expect(report).toContain("s2 mid: SKIPPED (上游 s1 失败，未启动)")
    expect(report).toContain("s3 leaf: SKIPPED (上游 s2 失败，未启动)")
    expect(report).toContain("s4 free: COMPLETED")
  })

  // Regression: a rejected launch() used to only mark the plan terminal —
  // its dependents then passed the depsTerminal check and ran on missing
  // upstream output, and the report showed a misleading "未启动".
  test("a launch failure marks the plan as failed and skips its dependents", async () => {
    const { manager } = createManager({ unresolvableModel: true })
    const plans = [
      { id: "s1", title: "base", description: "a", dependsOn: [] },
      { id: "s2", title: "mid", description: "b", dependsOn: ["s1"] },
      { id: "s3", title: "free", description: "c", dependsOn: [] },
    ]
    const result = runSplit(manager, { parentSessionId: "parent", plans })
    await result.done

    expect(result.tasksByPlanID.size).toBe(0) // no session ever launched
    expect(result.skippedPlanIDs.get("s1")).toBe("launch-failed")
    expect(result.skippedPlanIDs.get("s2")).toBe("s1") // cascaded as a failed dependency
    expect(result.skippedPlanIDs.get("s3")).toBe("launch-failed") // its own launch failed too

    const report = buildSplitReport(result.tasksByPlanID, plans, result.skippedPlanIDs)
    expect(report).toContain("s1 base: 启动失败")
    expect(report).toContain("s2 mid: SKIPPED (上游 s1 失败，未启动)")
    expect(report).toContain("s3 free: 启动失败") // free plan's launch failed too
  })
})
