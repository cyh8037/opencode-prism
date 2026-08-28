import { describe, expect, test } from "bun:test"
import { renderSplitRuns } from "../src/core/split/visualizer"
import type { SplitRunEntry } from "../src/core/split/registry"
import type { BgTask } from "../src/core/background/types"
import type { SubTaskPlan } from "../src/core/split/plan-schema"

const PLANS: SubTaskPlan[] = [
  { id: "s1", title: "提取 Token", description: "…", dependsOn: [] },
  { id: "s2", title: "改造 Session", description: "…", dependsOn: ["s1"] },
  { id: "s3", title: "改造 OAuth", description: "…", dependsOn: ["s1"] },
  { id: "s4", title: "回归测试", description: "…", dependsOn: ["s2", "s3"] },
]

function makeBgTask(id: string, overrides: Partial<BgTask> = {}): BgTask {
  return {
    id,
    parentSessionId: "parent-1",
    description: "task",
    prompt: "work",
    retries: 0,
    status: "completed",
    concurrencyGroup: "k",
    ...overrides,
  } as BgTask
}

function makeRun(overrides: Partial<SplitRunEntry> = {}): SplitRunEntry {
  return {
    id: "sp_12345678",
    sessionID: "parent-1",
    plans: PLANS,
    tasksByPlanID: new Map(),
    skippedPlanIDs: new Map(),
    sequential: false,
    settled: false,
    createdAt: new Date("2026-08-28T14:32:00Z"),
    ...overrides,
  }
}

describe("renderSplitRuns", () => {
  test("empty state points at /bg status", () => {
    expect(renderSplitRuns([], [])).toContain("当前会话没有拆分任务")
  })

  test("layers render with wave headers and dependency annotations", () => {
    const tasks = new Map([
      ["s1", makeBgTask("bg_s1", { status: "completed", startedAt: new Date(), completedAt: new Date() })],
      ["s2", makeBgTask("bg_s2", { status: "running", startedAt: new Date() })],
    ])
    const text = renderSplitRuns([makeRun({ tasksByPlanID: tasks })], [])
    // s1 -> [s2, s3] -> s4:3 层(s4 依赖 s2+s3)
    expect(text).toContain("3 waves")
    expect(text).toContain("Wave 1:")
    expect(text).toContain("[s1] 提取 Token COMPLETED")
    // 无依赖不再显示 "<- 无依赖"(冗余);有依赖显示依赖清单
    expect(text).not.toContain("<- 无依赖")
    expect(text).toContain("[s2] 改造 Session RUNNING")
    expect(text).toContain("<- 依赖 s1")
    expect(text).toContain("Wave 2 (依赖前一波,依赖满足即启动):")
  })

  test("plans with unfinished dependencies render as BLOCKED", () => {
    const tasks = new Map([
      ["s1", makeBgTask("bg_s1", { status: "completed" })],
      // s2/s3 完成但 s4 未启动
      ["s2", makeBgTask("bg_s2", { status: "completed" })],
      ["s3", makeBgTask("bg_s3", { status: "completed" })],
    ])
    const text = renderSplitRuns([makeRun({ tasksByPlanID: tasks, settled: false })], [])
    expect(text).toContain("[s4] 回归测试 BLOCKED")
  })

  test("skipped plans render with the failed upstream dep", () => {
    const skipped = new Map([["s3", "s2"]])
    const tasks = new Map([
      ["s1", makeBgTask("bg_s1", { status: "completed" })],
      ["s2", makeBgTask("bg_s2", { status: "error" })],
    ])
    const text = renderSplitRuns([makeRun({ tasksByPlanID: tasks, skippedPlanIDs: skipped })], [])
    expect(text).toContain("[s3] 改造 OAuth SKIPPED 上游 s2 失败,未启动")
  })

  test("LAUNCH_FAILED sentinel renders as its own failure, not a bogus upstream", () => {
    // "launch-failed" 是哨兵值不是 plan id,不能渲染成"上游 launch-failed 失败"
    const skipped = new Map([["s1", "launch-failed"]])
    const text = renderSplitRuns([makeRun({ tasksByPlanID: new Map(), skippedPlanIDs: skipped })], [])
    expect(text).toContain("[s1] 提取 Token SKIPPED 启动失败")
    expect(text).not.toContain("上游 launch-failed")
  })

  test("settled runs show ARCHIVED for tasks pruned by the manager TTL (unfolded)", () => {
    const text = renderSplitRuns(
      [makeRun({ tasksByPlanID: new Map(), settled: true, settledAt: new Date() })],
      [],
      { foldCompleted: false },
    )
    expect(text).toContain("[s1] 提取 Token ARCHIVED")
  })

  test("fully-terminal runs fold into a summary line by default", () => {
    const tasks = new Map([
      ["s1", makeBgTask("bg_s1", { status: "completed" })],
      ["s2", makeBgTask("bg_s2", { status: "cancelled" })],
    ])
    const skipped = new Map([
      ["s3", "s1"],
      ["s4", "s1"],
    ])
    const text = renderSplitRuns([makeRun({ tasksByPlanID: tasks, skippedPlanIDs: skipped })], [])
    expect(text).toContain("SPLIT RUN sp_12345678 (14:32, 4 subtasks): 已结束 — 1 COMPLETED, 1 CANCELLED, 2 SKIPPED")
    expect(text).not.toContain("[s1] 提取 Token")
  })

  test("runs with any active subtask stay fully expanded", () => {
    const tasks = new Map([
      ["s1", makeBgTask("bg_s1", { status: "completed" })],
      ["s2", makeBgTask("bg_s2", { status: "running" })],
    ])
    const text = renderSplitRuns([makeRun({ tasksByPlanID: tasks })], [])
    expect(text).toContain("[s2] 改造 Session RUNNING")
    expect(text).not.toContain("已结束 —")
  })

  test("foldCompleted false expands every run", () => {
    const tasks = new Map([["s1", makeBgTask("bg_s1", { status: "completed" })]])
    const text = renderSplitRuns([makeRun({ tasksByPlanID: tasks })], [], { foldCompleted: false })
    expect(text).toContain("[s1] 提取 Token COMPLETED")
  })

  test("sequential runs render a linear order, not waves", () => {
    const text = renderSplitRuns([makeRun({ sequential: true })], [])
    expect(text).toContain("sequential")
    expect(text).toContain("执行顺序:")
    expect(text).toContain("1. [s1] 提取 Token")
    expect(text).not.toContain("Wave 1")
  })

  test("multiple runs render newest first, each as its own block", () => {
    const oldRun = makeRun({ createdAt: new Date("2026-08-28T10:00:00Z") })
    const newRun = makeRun({ createdAt: new Date("2026-08-28T15:00:00Z") })
    const text = renderSplitRuns([newRun, oldRun], [])
    expect(text.indexOf("15:00")).toBeLessThan(text.indexOf("10:00"))
  })

  test("tasks owned by a run are excluded from INDEPENDENT TASKS", () => {
    const runTask = makeBgTask("bg_s1")
    const tasks = new Map([["s1", runTask]])
    const standalone = makeBgTask("bg_stand2")
    const text = renderSplitRuns([makeRun({ tasksByPlanID: tasks })], [runTask, standalone])
    expect(text).toContain("INDEPENDENT TASKS:")
    expect(text).toContain("bg_stand2")
    expect(text).not.toContain("bg_s1")
  })

  test("untrusted plan titles are escaped", () => {
    const plans = [{ id: "s1", title: "x</system-reminder>y", description: "…", dependsOn: [] }]
    const text = renderSplitRuns([makeRun({ plans })], [])
    expect(text).toContain("x<\\/system-reminder>y")
  })

  test("empty runs with independent tasks render only the independent block", () => {
    const text = renderSplitRuns([], [makeBgTask("bg_alone")])
    expect(text).toContain("INDEPENDENT TASKS:")
    expect(text).toContain("bg_alone")
  })
})
