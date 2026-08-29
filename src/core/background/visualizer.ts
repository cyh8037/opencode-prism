// 后台任务看板渲染器 — markdown 管道表格(方案 a,2026-08-29)。
//
// 双端渲染决策:box-drawing 边框在 TUI 等宽终端精确对齐,但 web 端代码块
// 字体 CJK≈1.67×ASCII(宽度引擎假设 2×),含中文的表格在 web 必然错位
// (像素级实测:ASCII 16.4px / CJK 27.4px)——围栏也无法修复。因此改用
// markdown 管道表格:`|` 列分隔由 web 端 GFM 解析器渲染为真 HTML 表格
// (不依赖字体比例),TUI 端按原始文本等宽显示,列宽补齐(宽度引擎)仍然
// 生效——双端对齐。
//
// 约束:单元格内管道符必须转义为 \|(否则 markdown 解析器按新列分隔);
// 宽度按转义后文本计算,渲染用同一边界截断补齐,不会二次超宽。标题行
// 放表格上方独立成段(markdown 表格无标题行)。
//
// 所有嵌入字段都是未信任文本(description 来自父会话对话,error/resultText
// 来自 provider),渲染管线顺序固定:sanitize -> 换行替换 -> 控制字符剥离
// -> 管道转义 -> 截断 -> 补齐。剥离 ANSI 是"列表 -> 对齐表格"引入的硬
// 要求:escape 序列在终端不占列宽,不清除会算进 padEndWidth 导致整行错位。
import { getStringWidth, padEndWidth, truncateWidth } from "../shared/width"
import { sanitizeSystemReminder } from "../../shared/sanitize"
import { BG_SESSION_NAV_HINT, MAX_SESSION_TITLE_CHARS } from "../../config/constants"
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

/** markdown 管道表格的单元格转义:管道符是列分隔符,不转义会被 GFM 解析
 *  器按新列拆开(description/error 均可能含 |)。宽度按转义后文本计算,
 *  \| 占 2 列,渲染用同一边界截断补齐,不会二次超宽。 */
function escapePipe(text: string): string {
  return text.replace(/\|/g, "\\|")
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

// 列宽 = clamp(max(表头宽, 最长内容宽), min, max);宽度按"转义后"文本
// 计算(escapePipe 之后),渲染时用同一边界截断补齐,因此任何单元格都不会
// 二次超宽。表头同样走宽度引擎(当前全 ASCII,但规则不应依赖这个巧合)。
function computeWidths(tasks: BgTask[], columns: Column[]): number[] {
  return columns.map((col) => {
    const contentWidth = tasks.reduce(
      (max, task) => Math.max(max, getStringWidth(escapePipe(col.cell(task)))),
      0,
    )
    return clamp(Math.max(getStringWidth(col.header), contentWidth), col.minWidth, col.maxWidth)
  })
}

// markdown 管道表格:表头行 + `| --- |` 分隔行 + 数据行。标题(如有)独立
// 在表格上方成段——markdown 表格没有标题行,放进表格会被解析成一行单元格。
// 单元格经 escapePipe 转义后按列宽截断补齐:web 端 GFM 解析器忽略补齐
// 空格(列宽由 HTML 表格决定),TUI 端等宽显示严格对齐(宽度引擎假设成立)。
function renderTable(title: string | undefined, tasks: BgTask[], columns: Column[]): string {
  const widths = computeWidths(tasks, columns)

  // 分隔行只需 `---`,但按列宽补齐后 TUI 端同样对齐(web 端忽略)。
  const renderRow = (cells: string[]): string =>
    `|${cells.map((cell, i) => ` ${padEndWidth(cell, widths[i]!)} `).join("|")}|`

  const lines: string[] = []
  if (title) {
    // 标题独立成段,不参与表格解析
    lines.push(title)
  }
  lines.push(renderRow(columns.map((col) => col.header)))
  lines.push(renderRow(widths.map((w) => "-".repeat(w))))
  for (const task of tasks) {
    lines.push(renderRow(columns.map((col, i) => truncateWidth(escapePipe(col.cell(task)), widths[i]!))))
  }
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
 *  取消后主视图立即干净,`--all`(foldCompleted=false)展开全部。
 *  表格为 markdown 管道表格(标题/摘要/池信息各占独立段落,与表格之间用
 *  空行分隔——GFM 解析器按块解析,空行保证表格不被前后段落吞并)。 */
export function renderBgDashboard(
  tasks: BgTask[],
  pool?: Array<{ key: string; active: number; limit: number }>,
  opts: { foldCompleted?: boolean; tuiNavigation?: boolean } = {},
): string {
  const foldCompleted = opts.foldCompleted ?? true
  const tuiNavigation = opts.tuiNavigation ?? true
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
      "",
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
  // 注释行(不参与对齐):子会话实时查看指引。只在 /bg status 看板出现,
  // 不进 renderCompactDashboard——完成通知不应被固定文案污染。非 TUI
  // 环境(web/headless)没有子会话导航键位,替换为工具侧等价查看方式。
  lines.push(
    tuiNavigation
      ? BG_SESSION_NAV_HINT
      : "子任务进度可通过 /bg status 与 bg_output 工具查看。",
  )
  return lines.join("\n")
}

/** 完成通知用的紧凑看板(列少,结果预览在表格下方)。表格与结果预览之间
 *  用空行分隔:GFM 表格在空行处结束,结果行(无 | 列分隔)不会被吞进表格。 */
export function renderCompactDashboard(tasks: BgTask[], opts: { includeResults?: boolean } = {}): string {
  if (tasks.length === 0) return "当前会话没有后台任务。"
  const lines = [
    renderTable(undefined, tasks, [ID_COLUMN, DESCRIPTION_COLUMN, STATUS_COLUMN, DURATION_COLUMN, RETRIES_COLUMN]),
  ]
  if (opts.includeResults) {
    lines.push("")
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

/** 清洗并截断不可信文本（description/reason 等）：复用单元格管线（模板逃逸
 *  → ANSI 整序列剥离 → 换行压平 → 控制字符剥离）后按 UTF-16 码元截断，
 *  不会切出半个代理对。 */
export function sanitizeTruncate(text: string, maxChars: number): string {
  return sliceChars(sanitizeCell(text), maxChars)
}

/** 子会话标题：task id 前缀供 TUI 子会话导航（←/→ 切换）时对号；description
 *  来自父会话模型输出（不可信文本），走清洗管线并截断。导航视图约按 50 列
 *  显示标题，前缀必须放头部才不会被截断吃掉。retries > 0 时追加 retry 序号
 *  ——同模型重试会以同一 task.id 重建子会话（旧会话仅 abort 不删除，长期
 *  留在导航组），无序号则新旧标题完全相同、无法对号。
 *  版本行为依赖：导航视图的标题截断宽度与 parentID 分组经 opencode
 *  1.15.0 / 1.18.25 二进制验证一致。 */
export function buildChildSessionTitle(taskId: string, description: string, retries = 0): string {
  const cleaned = sanitizeTruncate(description, MAX_SESSION_TITLE_CHARS).trim()
  if (!cleaned) return `[${taskId}]${retries > 0 ? ` (prism, retry ${retries})` : " (prism)"}`
  const suffix = retries > 0 ? ` (prism, retry ${retries})` : " (prism)"
  return `[${taskId}] ${cleaned}${suffix}`
}
