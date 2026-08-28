// 后台任务纯文本看板渲染器。无 Emoji、无 ANSI 着色:状态一律大写 ASCII
// 标签,box-drawing 边框在现代等宽终端按 1 列渲染(与 width.ts 的宽度规则
// 一致),任何平台、任何终端字体下表格都严格对齐。
//
// 所有嵌入字段都是未信任文本(description 来自父会话对话,error/resultText
// 来自 provider),渲染管线顺序固定:sanitize -> 换行替换 -> 控制字符剥离
// -> 截断 -> 补齐。剥离 ANSI 是"列表 -> 对齐表格"引入的硬要求:escape
// 序列在终端不占列宽,不清除会算进 padEndWidth 导致整行错位。
import { getStringWidth, padEndWidth, truncateWidth } from "../shared/width"
import { sanitizeSystemReminder } from "../../shared/sanitize"
import type { BgTask } from "./types"

/** 单字段渲染管线:sanitize(模板逃逸)→ ANSI 整序列剥离 → 换行压平 → 控制字符剥离。
 *  ANSI 必须整序列剥离:只删 ESC 字节会残留 "[31m" 之类的可见尾巴,既占
 *  列宽又像损坏文本。覆盖 CSI(含 ?<>= 私有参数标记,如 ESC[?25h)与 OSC
 *  (ESC]0;title BEL/ST);裸 ESC(无完整序列)由最后一道控制字符剥离兜底。
 *  范围一律用 \u 转义书写——字面控制字节会被编辑器/格式化工具静默改坏。 */
export function sanitizeCell(text: string): string {
  return sanitizeSystemReminder(text)
    .replace(/\u001b\[[0-9;?<>=]*[A-Za-z]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\n/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
}

/** 任务时长(从 manager.ts 移入,看板与通知共用)。 */
export function formatDuration(startedAt: Date | undefined, completedAt: Date | undefined): string {
  if (!startedAt || !completedAt) return "-"
  const seconds = Math.max(0, Math.round((completedAt.getTime() - startedAt.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${seconds % 60}s`
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)

function statusText(task: BgTask): string {
  const status = task.status.toUpperCase()
  // R7:错误信息统一附加在状态单元格内(错误是未信任文本,走 sanitizeCell)。
  if (task.status === "error" && task.error) {
    return `ERROR: ${sanitizeCell(task.error)}`
  }
  return status
}

function progressText(task: BgTask): string {
  if (task.status !== "running" && task.status !== "pending") return "-"
  const toolCalls = task.progress?.toolCalls ?? 0
  const queued = task.steeringQueue?.length ?? 0
  const base = task.status === "running" ? `${toolCalls} calls` : "queued"
  return queued > 0 ? `${base}, ${queued} queued` : base
}

interface Column {
  header: string
  /** 内容宽度下限与上限(截断依据)。 */
  minWidth: number
  maxWidth: number
  cell: (task: BgTask) => string
}

// 列宽 = clamp(max(表头宽, 最长内容宽), min, max);宽度按"原始"文本计算,
// 渲染时用同一边界截断,因此任何单元格都不会二次超宽。表头同样走宽度
// 引擎(当前全 ASCII,但规则不应依赖这个巧合)。
function computeWidths(tasks: BgTask[], columns: Column[]): number[] {
  return columns.map((col) => {
    const contentWidth = tasks.reduce((max, task) => Math.max(max, getStringWidth(col.cell(task))), 0)
    return clamp(Math.max(getStringWidth(col.header), contentWidth), col.minWidth, col.maxWidth)
  })
}

function renderTable(title: string | undefined, tasks: BgTask[], columns: Column[]): string {
  const widths = computeWidths(tasks, columns)

  const borderTop = `┌${widths.map((w) => "─".repeat(w + 2)).join("┬")}┐`
  const borderMid = `├${widths.map((w) => "─".repeat(w + 2)).join("┼")}┤`
  const borderBot = `└${widths.map((w) => "─".repeat(w + 2)).join("┴")}┘`

  const renderRow = (cells: string[]): string =>
    `│${cells.map((cell, i) => ` ${padEndWidth(cell, widths[i]!)} `).join("│")}│`

  const lines: string[] = []
  if (title) {
    // 行宽 = 2 + Σ(w+2) + (n-1)(首尾 │ + 每列 ` cell ` + 列间 │);
    // header 行 = `│ ` + title + ` │`,innerWidth = 行宽 - 4。
    const innerWidth = widths.reduce((sum, w) => sum + w + 2, 0) + widths.length - 3
    // 标题(含并发池信息)可能超过 innerWidth:先截断再补齐,与单元格同
    // 管线——否则超宽标题会破坏"每行等宽"的对齐承诺。
    lines.push(`│ ${padEndWidth(truncateWidth(title, innerWidth), innerWidth)} │`)
    lines.push(borderMid)
  }
  lines.push(renderRow(columns.map((col) => col.header)))
  lines.push(borderMid)
  for (const task of tasks) {
    lines.push(renderRow(columns.map((col, i) => truncateWidth(col.cell(task), widths[i]!))))
  }
  lines.push(borderBot)
  return lines.join("\n")
}

// 公共列定义

const ID_COLUMN: Column = {
  header: "ID",
  minWidth: 4,
  maxWidth: 12,
  cell: (task) => task.id,
}

const DESCRIPTION_COLUMN: Column = {
  header: "Description",
  minWidth: 8,
  maxWidth: 28,
  cell: (task) => sanitizeCell(task.description),
}

const STATUS_COLUMN: Column = {
  header: "Status",
  minWidth: 10,
  maxWidth: 40,
  cell: statusText,
}

const DURATION_COLUMN: Column = {
  header: "Duration",
  minWidth: 8,
  maxWidth: 10,
  cell: (task) => formatDuration(task.startedAt, task.completedAt),
}

const PROGRESS_COLUMN: Column = {
  header: "Progress",
  minWidth: 8,
  // 最长的自然文本是 "14 calls, 1 queued"(18 列),上限取 20 让计数信息
  // 完整可见,超长调用数仍会被截断防表格过宽。
  maxWidth: 20,
  cell: progressText,
}

const RETRIES_COLUMN: Column = {
  header: "Attempts",
  minWidth: 8,
  maxWidth: 12,
  cell: (task) => (task.retries > 0 ? `${task.retries + 1} attempts` : "-"),
}

const TERMINAL_STATUSES = new Set(["completed", "error", "cancelled"])

/** `/bg status` 看板:标题只含计数(必不超宽),并发池信息放在表格下方独立
 *  行完整显示(池信息进标题会被截断,截断点落在模型名中间观感像文本损坏)。
 *  默认(foldCompleted)表格只含进行中任务,已结束任务折叠为一行摘要——
 *  取消后主视图立即干净,`--all`(foldCompleted=false)展开全部。 */
export function renderBgDashboard(
  tasks: BgTask[],
  pool?: Array<{ key: string; active: number; limit: number }>,
  opts: { foldCompleted?: boolean } = {},
): string {
  const foldCompleted = opts.foldCompleted ?? true
  const active = tasks.filter((t) => !TERMINAL_STATUSES.has(t.status))
  const terminal = tasks.filter((t) => TERMINAL_STATUSES.has(t.status))

  if (tasks.length === 0) return "当前会话没有后台任务。"

  const lines: string[] = []
  if (foldCompleted && active.length === 0) {
    lines.push("当前没有运行中的后台任务。")
  } else {
    // 标题计数恒取进行中任务(--all 的整表里标题也只统计未结束的,语义
    // 一致);折叠模式表格只含进行中任务,--all 渲染全部(同一列配置)。
    const running = active.filter((t) => t.status === "running").length
    const pending = active.filter((t) => t.status === "pending").length
    const title = `PRISM BACKGROUND TASKS (Running: ${running}, Queued: ${pending})`
    lines.push(
      renderTable(
        title,
        foldCompleted ? active : tasks,
        [ID_COLUMN, DESCRIPTION_COLUMN, STATUS_COLUMN, DURATION_COLUMN, PROGRESS_COLUMN],
      ),
    )
  }
  if (foldCompleted && terminal.length > 0) {
    // 计数按固定顺序输出(不依赖 Map 插入序)
    const counts = new Map<string, number>()
    for (const task of terminal) {
      counts.set(task.status.toUpperCase(), (counts.get(task.status.toUpperCase()) ?? 0) + 1)
    }
    const ordered = ["COMPLETED", "ERROR", "CANCELLED"].filter((s) => counts.has(s))
    const summary = ordered.map((status) => `${counts.get(status)} ${status}`).join(", ")
    lines.push(`+ ${terminal.length} 已结束: ${summary} (bg_output <id> 查看结果)`)
  }
  if (pool && pool.length > 0) {
    // 注释行不参与表格对齐,可完整显示超宽内容(不截断)。
    lines.push(`Pool: ${pool.map((p) => `${p.key} ${p.active}/${p.limit}`).join(", ")}`)
  }
  return lines.join("\n")
}

/** 完成通知用的紧凑看板(列少,结果预览在表格下方)。 */
export function renderCompactDashboard(tasks: BgTask[], opts: { includeResults?: boolean } = {}): string {
  if (tasks.length === 0) return "当前会话没有后台任务。"
  const lines = [
    renderTable(undefined, tasks, [ID_COLUMN, DESCRIPTION_COLUMN, STATUS_COLUMN, DURATION_COLUMN, RETRIES_COLUMN]),
  ]
  if (opts.includeResults) {
    for (const task of tasks) {
      if (task.resultText) {
        // 按字符上限截断但避免切出半个代理对(resultText 来自子会话 LLM,
        // 可能含 emoji)——旧 buildTaskTable 的 slice(0, 200) 有此隐患。
        lines.push(`  ${task.id}: ${sanitizeCell(sliceChars(task.resultText, 200))}`)
      }
    }
  }
  return lines.join("\n")
}

/** 按 UTF-16 码元上限截断;末字符若为代理对的高半区则退一格。 */
function sliceChars(text: string, max: number): string {
  if (text.length <= max) return text
  const sliced = text.slice(0, max)
  const last = sliced.charCodeAt(sliced.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced
}
