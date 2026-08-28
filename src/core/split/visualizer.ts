// 任务拆分 DAG 看板:/split status 的渲染器。
//
// 分层泳道 + 依赖标注(而非 ASCII 拓扑连线):任意 DAG 在字符终端画连线
// 必然交叉错乱且不可单测;分层复用 scheduler.layerPlans,与 dry-run 文本
// 同源同语义。措辞遵守 service.ts 的教训:运行时按 ASAP 触发(任务的依赖
// 一完成即启动),绝不声称"整波屏障"。
//
// 多 run 合并规则(R2):按 createdAt 倒序渲染全部未过期 run 的 DAG 区块,
// 随后渲染独立任务 = 本会话全部 bg 任务 - 所有 run 的任务 id 集合(去重),
// 与 /bg status 的合并视图保留后台任务可见性(D7)。
import type { BgTask } from "../background/types"
import { formatDuration, renderCompactDashboard, sanitizeCell } from "../background/visualizer"
import type { SplitRunEntry } from "./registry"
import { LAUNCH_FAILED, layerPlans } from "./scheduler"

function formatTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  return `${hours}:${minutes}`
}

// 单个 plan 的实时状态推导(见方案 1.3):skipped -> SKIPPED;有任务 ->
// 任务状态;未 settled -> BLOCKED(依赖未完成);已 settled -> ARCHIVED。
function planStatus(entry: SplitRunEntry, planId: string): { status: string; detail?: string } {
  const skippedDep = entry.skippedPlanIDs.get(planId)
  if (skippedDep) {
    // LAUNCH_FAILED 是哨兵值不是 plan id:语义是"该子任务自身启动失败"
    // (manager 拒绝——模型解析失败/关停中),不是"某个上游失败了"。
    if (skippedDep === LAUNCH_FAILED) {
      return { status: "SKIPPED", detail: "启动失败(未能创建后台任务,详见插件日志)" }
    }
    return { status: "SKIPPED", detail: `上游 ${sanitizeCell(skippedDep)} 失败,未启动` }
  }
  const task = entry.tasksByPlanID.get(planId)
  if (task) {
    const duration = task.startedAt && task.completedAt ? ` (${formatDuration(task.startedAt, task.completedAt)})` : ""
    return { status: task.status.toUpperCase() + duration }
  }
  if (!entry.settled) {
    return { status: "BLOCKED" }
  }
  return { status: "ARCHIVED" }
}

function renderPlanLine(entry: SplitRunEntry, plan: { id: string; title: string; dependsOn: string[] }): string {
  const title = sanitizeCell(plan.title)
  const { status, detail } = planStatus(entry, plan.id)
  // 无依赖不显示"<- 无依赖"(Wave 1 每行都写是冗余);有依赖显示依赖清单
  const deps = plan.dependsOn.length > 0 ? ` <- 依赖 ${plan.dependsOn.join(", ")}` : ""
  const suffix = detail ? `${status} ${detail}` : status
  return `[${plan.id}] ${title} ${suffix}${deps}`
}

function renderRun(entry: SplitRunEntry): string {
  const plans = entry.plans
  const lines: string[] = []

  if (entry.sequential) {
    lines.push(`SPLIT RUN ${entry.id} (${formatTime(entry.createdAt)}, ${plans.length} subtasks, sequential):`)
    lines.push("执行顺序:")
    plans.forEach((plan, index) => {
      lines.push(`${index + 1}. ${renderPlanLine(entry, plan)}`)
    })
    return lines.join("\n")
  }

  const layers = layerPlans(plans)
  lines.push(`SPLIT RUN ${entry.id} (${formatTime(entry.createdAt)}, ${plans.length} subtasks, ${layers.length} waves, parallel):`)
  layers.forEach((layer, index) => {
    // 波头精简:39 字的"依赖在前一波;各任务在其依赖完成后即启动,不等
    // 整波全部结束"在多层看板里重复 N 次,行宽撑到 100+ 列触发 TUI
    // 折行;"依赖满足即启动"保留 ASAP 语义(不声称整波屏障)。
    const header =
      index === 0 ? "Wave 1:" : `Wave ${index + 1} (依赖前一波,依赖满足即启动):`
    lines.push(header)
    // 每行统一 `[id]` 前缀缩进,不再用 `+` 续行标记:层内行数多时
    // `+` 前缀在模型转述里常被改写成 `-`,统一格式减少变形空间。
    for (const plan of layer) {
      lines.push(`  ${renderPlanLine(entry, plan)}`)
    }
    if (index < layers.length - 1) {
      lines.push("──>")
    }
  })
  return lines.join("\n")
}

// 单个 plan 的终态字符串;仍在进行(BLOCKED/运行中)返回 undefined。
function planTerminalStatus(entry: SplitRunEntry, planId: string): string | undefined {
  if (entry.skippedPlanIDs.has(planId)) return "SKIPPED"
  const task = entry.tasksByPlanID.get(planId)
  if (!task) return entry.settled ? "ARCHIVED" : undefined
  if (task.status === "completed" || task.status === "error" || task.status === "cancelled") {
    return task.status.toUpperCase()
  }
  return undefined
}

/** 全部子任务进入终态的 run:折叠为一行摘要(主视图降噪,明细可展开)。 */
function renderRunSummary(entry: SplitRunEntry): string {
  const counts = new Map<string, number>()
  for (const plan of entry.plans) {
    const status = planTerminalStatus(entry, plan.id) ?? "?"
    counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  // 计数按固定顺序输出(不依赖 Map 插入序)
  const ordered = ["COMPLETED", "ERROR", "CANCELLED", "SKIPPED", "ARCHIVED"].filter((s) => counts.has(s))
  const summary = ordered.map((status) => `${counts.get(status)} ${status}`).join(", ")
  return `SPLIT RUN ${entry.id} (${formatTime(entry.createdAt)}, ${entry.plans.length} subtasks): 已结束 — ${summary} (status ${entry.id} 查看明细)`
}

/**
 * /split status 看板:按 createdAt 倒序渲染全部未过期 run + 独立任务区块。
 * 默认(foldCompleted)将全部终态的 run 折叠为一行摘要——取消后主视图立即
 * 干净,但 CANCELLED/SKIPPED 因果保留;`--all`(foldCompleted=false)展开全部。
 */
export function renderSplitRuns(
  runs: SplitRunEntry[],
  allBgTasks: BgTask[],
  opts: { foldCompleted?: boolean } = {},
): string {
  const foldCompleted = opts.foldCompleted ?? true
  // 去重按 TASK id 收集:tasksByPlanID 的键是 plan id("s1"),值是任务
  // (bg_xxx)——用 plan id 与任务 id 比较永远匹配不上,run 的任务会漏进
  // 独立区块。
  const runTaskIds = new Set<string>()
  for (const run of runs) {
    for (const task of run.tasksByPlanID.values()) {
      runTaskIds.add(task.id)
    }
  }
  const independent = allBgTasks.filter((task) => !runTaskIds.has(task.id))

  if (runs.length === 0 && independent.length === 0) {
    return "当前会话没有拆分任务。可用 /bg status 查看后台任务。"
  }

  const sections: string[] = []
  for (const run of runs) {
    const allTerminal = run.plans.every((plan) => planTerminalStatus(run, plan.id) !== undefined)
    if (foldCompleted && allTerminal) {
      sections.push(renderRunSummary(run))
    } else {
      sections.push(renderRun(run))
    }
  }
  if (independent.length > 0) {
    sections.push(`INDEPENDENT TASKS:\n${renderCompactDashboard(independent, { includeResults: false })}`)
  }
  return sections.join("\n\n")
}

/** 单个 run 的完整 DAG 明细(`/split status sp_xxx`)。 */
export function renderRunDetails(run: SplitRunEntry): string {
  return renderRun(run)
}
