import { describe, expect, test } from "bun:test"
import { SplitRunRegistry } from "../src/core/split/registry"
import type { SplitRunEntry } from "../src/core/split/registry"
import type { BgTask } from "../src/core/background/types"
import type { SubTaskPlan } from "../src/core/split/plan-schema"

const PLAN: SubTaskPlan = { id: "s1", title: "调研", description: "收集上下文", dependsOn: [] }

function makeEntry(overrides: Partial<SplitRunEntry> = {}): SplitRunEntry {
  return {
    id: "sp_12345678",
    sessionID: "parent-1",
    plans: [PLAN],
    tasksByPlanID: new Map(),
    skippedPlanIDs: new Map(),
    sequential: false,
    settled: false,
    createdAt: new Date("2026-08-28T10:00:00Z"),
    ...overrides,
  }
}

function makeTask(id: string): BgTask {
  return {
    id,
    parentSessionId: "parent-1",
    description: "task",
    prompt: "work",
    retries: 0,
    status: "completed",
    concurrencyGroup: "k",
  } as BgTask
}

describe("SplitRunRegistry", () => {
  test("register and query by parent session", () => {
    const registry = new SplitRunRegistry(60 * 60_000)
    registry.register(makeEntry({ sessionID: "parent-1", createdAt: new Date("2026-08-28T10:00:00Z") }))
    registry.register(makeEntry({ sessionID: "parent-2", createdAt: new Date("2026-08-28T10:00:00Z") }))
    expect(registry.getRunsByParentSession("parent-1")).toHaveLength(1)
    expect(registry.getRunsByParentSession("parent-2")).toHaveLength(1)
    expect(registry.getRunsByParentSession("other")).toHaveLength(0)
  })

  test("runs are returned newest first", () => {
    const registry = new SplitRunRegistry(60 * 60_000)
    registry.register(makeEntry({ createdAt: new Date("2026-08-28T10:00:00Z") }))
    registry.register(makeEntry({ createdAt: new Date("2026-08-28T11:00:00Z") }))
    const runs = registry.getRunsByParentSession("parent-1")
    expect(runs[0]!.createdAt.getTime()).toBe(new Date("2026-08-28T11:00:00Z").getTime())
  })

  test("running (unsettled) entries are never pruned, even past the retention window", () => {
    const registry = new SplitRunRegistry(60 * 60_000)
    // 运行 90 分钟未结束(长任务超 TTL 只警告不杀)——视图必须仍在
    registry.register(makeEntry({ settled: false, createdAt: new Date(Date.now() - 90 * 60_000) }))
    expect(registry.getRunsByParentSession("parent-1")).toHaveLength(1)
  })

  test("settled entries survive for the retention window, then are pruned", () => {
    const registry = new SplitRunRegistry(60 * 60_000)
    const oldSettled = makeEntry({
      settled: true,
      settledAt: new Date(Date.now() - 61 * 60_000),
      createdAt: new Date(Date.now() - 120 * 60_000),
    })
    registry.register(oldSettled)
    expect(registry.getRunsByParentSession("parent-1")).toHaveLength(0)

    const freshSettled = makeEntry({
      settled: true,
      settledAt: new Date(Date.now() - 30 * 60_000),
      createdAt: new Date(Date.now() - 90 * 60_000),
    })
    registry.register(freshSettled)
    expect(registry.getRunsByParentSession("parent-1")).toHaveLength(1)
  })

  test("pruning is lazy (register and query only) and does not touch live references", () => {
    const registry = new SplitRunRegistry(60 * 60_000)
    const tasks = new Map<string, BgTask>([["s1", makeTask("bg_x")]])
    const entry = registry.register(makeEntry({ tasksByPlanID: tasks }))
    // 任务对象是实时引用:外部变化直接反映
    tasks.get("s1")!.status = "running"
    expect(entry.tasksByPlanID.get("s1")!.status).toBe("running")
  })

  test("register returns the entry for settle-after-done wiring", () => {
    const registry = new SplitRunRegistry(60 * 60_000)
    const entry = registry.register(makeEntry())
    entry.settled = true
    entry.settledAt = new Date()
    expect(registry.getRunsByParentSession("parent-1")[0]!.settled).toBe(true)
  })

  test("register assigns a sp_ id when none is provided", () => {
    const registry = new SplitRunRegistry(60 * 60_000)
    const { id } = registry.register(makeEntry({ id: undefined }))
    expect(id).toMatch(/^sp_[0-9a-f]{12}$/)
  })

  test("getRun finds a run by its id across sessions", () => {
    const registry = new SplitRunRegistry(60 * 60_000)
    const entry = registry.register(makeEntry({ id: "sp_abcd1234", sessionID: "parent-1" }))
    expect(registry.getRun("sp_abcd1234")).toBe(entry)
    expect(registry.getRun("sp_unknown")).toBeUndefined()
  })
})
