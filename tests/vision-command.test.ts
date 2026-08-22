import { describe, expect, test } from "bun:test"
import { createCommandExecuteBeforeHook } from "../src/hooks/command-execute-before"
import { VisionPipeline } from "../src/core/vision/pipeline"
import { BackgroundManager } from "../src/core/background/manager"
import { PromptGate } from "../src/core/prompt-gate"
import { parseConfig } from "../src/config/load"
import type { PrismClient } from "../src/core/client-types"

const FAKE_PNG_URL = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")}`
const VISION_MODEL = { providerID: "openai", modelID: "gpt-5.6-sol" }

function createVisionCommandHarness(messagesData: unknown[] = []) {
  const childSessions = new Map<string, { prompts: unknown[] }>()
  let counter = 0
  const client: PrismClient = {
    session: {
      get: async () => ({ data: { id: "parent", directory: "/work", model: { id: "m", providerID: "openai" } } }),
      create: async () => {
        const id = `child_${++counter}`
        childSessions.set(id, { prompts: [] })
        return { data: { id } }
      },
      abort: async () => {},
      prompt: async () => {},
      promptAsync: async ({ path, body }) => {
        childSessions.get(path.id)?.prompts.push(body)
      },
      messages: async () => ({ data: messagesData }),
      status: async () => ({ data: {} }),
    },
    tui: { showToast: async () => {} },
  }
  const config = parseConfig({ vision: { model: "openai/gpt-5.6-sol" } })
  const gate = new PromptGate(client, { idlePollMs: 10 })
  const manager = new BackgroundManager({
    client,
    directory: "/work",
    config,
    gate,
    resolveModel: async () => VISION_MODEL,
    pollingIntervalMs: 60_000,
  })
  const vision = new VisionPipeline({
    client,
    directory: "/work",
    config,
    background: manager,
    getVisionModel: () => VISION_MODEL,
  })
  const hook = createCommandExecuteBeforeHook({
    manager,
    splitService: {} as never,
    serverUrl: "http://localhost:4096",
    vision,
  })
  const run = async (argumentsText: string) => {
    const output = { parts: [] as Array<{ type: string; text?: string }> }
    await hook({ command: "vision", sessionID: "parent", arguments: argumentsText }, output)
    return output.parts.map((part) => part.text ?? "").join("\n")
  }
  return { run, childSessions, client }
}

describe("/vision command", () => {
  test("no arguments prints usage", async () => {
    const { run } = createVisionCommandHarness()
    const text = await run("")
    expect(text).toContain("用法: /vision")
    expect(text).toContain("last")
  })

  test("explicit image URL returns the interpretation and carries the goal", async () => {
    const { run, childSessions } = createVisionCommandHarness([
      { info: { role: "assistant" }, parts: [{ type: "text", text: "解读结果：图表呈上升趋势", state: { status: "completed" } }] },
    ])
    const text = await run(`${FAKE_PNG_URL} --goal 读出 Q3 的数值`)
    expect(text).toContain("图表呈上升趋势")
    const promptBody = Array.from(childSessions.values())[0]?.prompts[0] as Record<string, unknown>
    expect(JSON.stringify(promptBody)).toContain("读出 Q3 的数值")
  })

  test("'last' resolves the session's most recent image message", async () => {
    const { run } = createVisionCommandHarness([
      { info: { role: "user" }, parts: [{ type: "text", text: "看图" }, { type: "file", mime: "image/png", url: FAKE_PNG_URL }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "这是一个登录页", state: { status: "completed" } }] },
    ])
    const text = await run("last --goal 找出报错信息")
    expect(text).toContain("这是一个登录页")
  })

  test("'last' without any image message prints guidance", async () => {
    const { run } = createVisionCommandHarness([{ info: { role: "user" }, parts: [{ type: "text", text: "无图" }] }])
    const text = await run("last")
    expect(text).toContain("没有找到任何图片消息")
  })
})
