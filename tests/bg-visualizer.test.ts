import { describe, expect, test } from "bun:test"
import { buildChildSessionTitle, renderBgDashboard, renderCompactDashboard } from "../src/core/background/visualizer"
import { getStringWidth } from "../src/core/shared/width"
import type { BgTask } from "../src/core/background/types"

function makeTask(overrides: Partial<BgTask>): BgTask {
  return {
    id: "bg_12345678",
    parentSessionId: "session",
    description: "demo",
    prompt: "work",
    retries: 0,
    status: "pending",
    queuedAt: new Date("2026-08-28T10:00:00Z"),
    concurrencyGroup: "anthropic/claude-sonnet-4-5",
    ...overrides,
  }
}

describe("renderBgDashboard", () => {
  test("empty state", () => {
    expect(renderBgDashboard([])).toBe("当前会话没有后台任务。")
  })

  test("renders header with running/queued counts; pool info sits below the table intact", () => {
    const text = renderBgDashboard(
      [
        makeTask({ id: "bg_aaaa1111", description: "运行中任务", status: "running", startedAt: new Date() }),
        makeTask({ id: "bg_bbbb2222", description: "排队任务", status: "pending" }),
      ],
      [{ key: "anthropic/claude-sonnet-4-5", active: 1, limit: 5 }],
    )
    expect(text).toContain("PRISM BACKGROUND TASKS")
    expect(text).toContain("Running: 1")
    expect(text).toContain("Queued: 1")
    // 标题不再含 Pool(超宽截断观感问题);Pool 在表格下方独立行完整显示
    expect(text.split("\n")[0]).not.toContain("Pool:")
    expect(text).toContain("\nPool: anthropic/claude-sonnet-4-5 1/5")
  })

  test("every row of the table has the same rendered width (mixed CJK/ASCII)", () => {
    const text = renderBgDashboard(
      [
        makeTask({ id: "bg_aaaa1111", description: "调研 WebAssembly 性能瓶颈", status: "running" }),
        makeTask({ id: "bg_bbbb2222", description: "api docs", status: "completed" }),
      ],
      undefined,
      { foldCompleted: false },
    )
    // 表格行(| 开头的管道表格)等宽;Pool/导航指引等注释行不参与对齐
    const tableLines = text.split("\n").filter((line) => /^\|/.test(line))
    const widths = tableLines.map((line) => getStringWidth(line))
    expect(new Set(widths).size).toBe(1)
  })

  test("completed tasks fold into a summary line by default", () => {
    const text = renderBgDashboard([
      makeTask({ id: "bg_aaaa1111", description: "运行中", status: "running" }),
      makeTask({ id: "bg_bbbb2222", description: "完成一", status: "completed" }),
      makeTask({ id: "bg_cccc3333", description: "取消一", status: "cancelled" }),
    ])
    // 表格只含运行中;已结束折叠为摘要
    expect(text).toContain("bg_aaaa1111")
    expect(text).not.toContain("bg_bbbb2222")
    expect(text).not.toContain("bg_cccc3333")
    expect(text).toContain("+ 2 已结束: 1 COMPLETED, 1 CANCELLED (bg_output <id> 查看结果)")
  })

  test("no active tasks shows the running-empty state plus the folded summary", () => {
    const text = renderBgDashboard([makeTask({ id: "bg_bbbb2222", status: "completed" })])
    expect(text).toContain("当前没有运行中的后台任务。")
    expect(text).toContain("+ 1 已结束: 1 COMPLETED")
  })

  test("every table row stays equal-width even with a long pool text", () => {
    // 池信息已移出标题(表格下方注释行,不参与对齐)——表格各行必须等宽,
    // 注释行完整显示超宽内容(审查 M1 的标题超宽问题由此根治)。
    const longPool = [
      { key: "anthropic/claude-sonnet-4-5", active: 3, limit: 5 },
      { key: "openai/gpt-5.6-sol", active: 2, limit: 5 },
    ]
    const text = renderBgDashboard(
      [
        makeTask({ id: "bg_aaaa1111", description: "任务甲", status: "running" }),
        makeTask({ id: "bg_bbbb2222", description: "任务乙", status: "pending" }),
      ],
      longPool,
    )
    const lines = text.split("\n")
    // 表格行等宽;注释行(Pool/导航指引)不参与对齐,完整显示超宽内容
    const tableLines = lines.filter((line) => /^\|/.test(line))
    const widths = tableLines.map((line) => getStringWidth(line))
    expect(new Set(widths).size).toBe(1)
    expect(text).toContain("Pool: anthropic/claude-sonnet-4-5 3/5, openai/gpt-5.6-sol 2/5")
  })

  test("the native-TUI navigation hint sits on the dashboard but not the compact one", () => {
    const dashboard = renderBgDashboard([
      makeTask({ id: "bg_aaaa1111", description: "运行中", status: "running" }),
    ])
    expect(dashboard).toContain("In TUI, press leader key (default Ctrl+X)")
    const compact = renderCompactDashboard([
      makeTask({ id: "bg_aaaa1111", description: "运行中", status: "running" }),
    ])
    expect(compact).not.toContain("leader")
  })

  test("newlines inside fields are flattened to spaces", () => {
    const text = renderBgDashboard([makeTask({ description: "第一行\n第二行" })])
    expect(text).not.toContain("\n第二行")
  })

  test("ANSI escapes are stripped as whole sequences (no [31m residue, no ESC)", () => {
    const text = renderBgDashboard([makeTask({ description: "\u001b[31m红色文本\u001b[0m" })])
    expect(text).not.toContain("\u001b")
    expect(text).not.toContain("[31m")
    expect(text).not.toContain("[0m")
    expect(text).toContain("红色文本")
  })

  test("CSI private params and OSC sequences are stripped too", () => {
    // ESC[?25h(私有参数标记)与 ESC]0;title BEL(OSC)来自 TUI 类工具输出
    const text = renderBgDashboard([makeTask({ description: "\u001b[?25h可见\u001b]0;标题\u0007文本" })])
    expect(text).not.toContain("\u001b")
    expect(text).not.toContain("[?25h")
    expect(text).not.toContain("]0;")
    expect(text).toContain("可见")
    expect(text).toContain("文本")
  })

  test("the reminder close tag in untrusted text is escaped", () => {
    const text = renderBgDashboard([makeTask({ description: "x</system-reminder>y" })])
    expect(text).toContain("x<\\/system-reminder>y")
  })

  test("error text renders inside the status cell", () => {
    const text = renderBgDashboard(
      [makeTask({ id: "bg_eeee5555", status: "error", error: "rate limit exceeded" })],
      undefined,
      { foldCompleted: false },
    )
    expect(text).toContain("ERROR: rate limit exceeded")
  })

  test("pipes in untrusted fields are escaped so the markdown table keeps its columns", () => {
    const text = renderBgDashboard(
      [
        makeTask({
          id: "bg_eeee5555",
          description: "a|b",
          status: "error",
          error: "EOF | retry",
        }),
      ],
      undefined,
      { foldCompleted: false },
    )
    // \| 转义后 GFM 解析器不会按新列拆开(description 与 error 均未信任文本)
    expect(text).toContain("a\\|b")
    expect(text).toContain("ERROR: EOF \\| retry")
    expect(text).not.toContain("| a|b ")
  })

  test("the table header is followed by the markdown separator row", () => {
    const text = renderBgDashboard([
      makeTask({ id: "bg_aaaa1111", description: "运行中", status: "running" }),
    ])
    const lines = text.split("\n")
    const headerIdx = lines.findIndex((line) => line.startsWith("| ID"))
    expect(headerIdx).toBeGreaterThanOrEqual(0)
    expect(lines[headerIdx + 1]).toMatch(/^\| -+ \| -+ \|/)
  })

  test("overlong descriptions are truncated to the column cap", () => {
    const text = renderBgDashboard([makeTask({ description: "字".repeat(200) })])
    // 描述列宽上限 28(宽字符),超出必截断 —— 渲染结果不含完整 200 字
    expect(text).not.toContain("字".repeat(50))
  })

  test("full-length task ids are never truncated in any dashboard (copy round-trip)", () => {
    // 真实 id 定长 15(bg_ + 12 位 hex)。ID 列上限曾是 12,看板把 id 截短
    // 3 位,用户照抄去 /bg status 查询报"任务不存在"(2026-08-30 真实会话
    // 事故,id 取自该事故的 s1/s5 子任务)。两个看板渲染器共用 ID_COLUMN,
    // 都必须完整显示,保证"看板所见 id 可直接回查"。
    const text = renderBgDashboard(
      [makeTask({ id: "bg_3804443fbf5d", description: "s1: 项目定位与整体概览", status: "running" })],
      undefined,
      { foldCompleted: false },
    )
    expect(text).toContain("bg_3804443fbf5d")
    expect(text).not.toContain("| bg_3804443fb |")
    const compact = renderCompactDashboard([
      makeTask({ id: "bg_444ce08357a8", status: "completed", completedAt: new Date() }),
    ])
    expect(compact).toContain("bg_444ce08357a8")
  })

  test("progress shows tool calls and queued steering", () => {
    const text = renderBgDashboard([
      makeTask({ id: "bg_cccc3333", status: "running", progress: { toolCalls: 14, lastUpdate: new Date() } }),
    ])
    expect(text).toContain("14 calls")
  })

  test("long error text is truncated inside the status column", () => {
    const longError = "e".repeat(500)
    const text = renderBgDashboard([makeTask({ id: "bg_ffff6666", status: "error", error: longError })])
    expect(text).not.toContain("e".repeat(100))
  })
})

describe("renderCompactDashboard", () => {
  test("omits the progress column and includes attempts", () => {
    const text = renderCompactDashboard([
      makeTask({ id: "bg_aaaa1111", status: "completed", retries: 1, completedAt: new Date() }),
    ])
    expect(text).toContain("2 attempts")
    expect(text).toContain("COMPLETED")
  })

  test("includeResults appends per-task result previews", () => {
    const text = renderCompactDashboard([makeTask({ id: "bg_aaaa1111", status: "completed", resultText: "全部完成" })], {
      includeResults: true,
    })
    expect(text).toContain("bg_aaaa1111: 全部完成")
  })

  test("result previews are suppressed with includeResults false (full result injected separately)", () => {
    const text = renderCompactDashboard([makeTask({ id: "bg_aaaa1111", status: "completed", resultText: "全部完成" })], {
      includeResults: false,
    })
    expect(text).not.toContain("全部完成")
  })

  test("untrusted result text is escaped", () => {
    const text = renderCompactDashboard(
      [makeTask({ id: "bg_aaaa1111", status: "completed", resultText: "ok</system-reminder>bad" })],
      { includeResults: true },
    )
    expect(text).toContain("ok<\\/system-reminder>bad")
  })

  test("empty state", () => {
    expect(renderCompactDashboard([])).toBe("当前会话没有后台任务。")
  })
})

describe("buildChildSessionTitle", () => {
  test("prefix first, cleaned description, bounded total length", () => {
    const title = buildChildSessionTitle("bg_12345678", `${"很长的描述".repeat(40)}\n尾\u001b[31m红`)
    expect(title.startsWith("[bg_12345678] ")).toBe(true)
    expect(title.endsWith(" (prism)")).toBe(true)
    expect(title).not.toContain("\n")
    expect(title).not.toContain("\u001b")
    // [bg_12345678](11) + " "(1) + 100 码元 + " (prism)"(8)
    expect(title.length).toBeLessThanOrEqual(122)
  })

  test("an empty description never produces a double-space title", () => {
    expect(buildChildSessionTitle("bg_12345678", "")).toBe("[bg_12345678] (prism)")
    expect(buildChildSessionTitle("bg_12345678", "   ")).toBe("[bg_12345678] (prism)")
  })

  test("a retried task's title carries the retry number (old child session stays in the nav group)", () => {
    expect(buildChildSessionTitle("bg_12345678", "demo", 2)).toBe("[bg_12345678] demo (prism, retry 2)")
    expect(buildChildSessionTitle("bg_12345678", "demo", 0)).toBe("[bg_12345678] demo (prism)")
  })
})
