import { describe, expect, test } from "bun:test"
import {
  checkSplitIntent,
  extractJsonObject,
  intentSchema,
  sanitizeIntentReason,
} from "../src/core/split/intent"
import type { PrismClient } from "../src/core/client-types"

const MODEL = { providerID: "openai", modelID: "gpt-5.6-sol" }

describe("extractJsonObject", () => {
  test("parses a bare object", () => {
    expect(extractJsonObject('{"intent":"direct","reason":"简单"}')).toEqual({
      intent: "direct",
      reason: "简单",
    })
  })

  test("parses a fenced object", () => {
    expect(extractJsonObject('```json\n{"intent":"split"}\n```')).toEqual({ intent: "split" })
  })

  test("parses an object embedded in prose", () => {
    expect(extractJsonObject('结论：{"intent":"split","reason":"可并行"} 以上。')).toEqual({
      intent: "split",
      reason: "可并行",
    })
  })

  test("returns null for malformed or brace-free text", () => {
    expect(extractJsonObject('{"intent":"direct"')).toBe(null)
    expect(extractJsonObject("[1, 2]")).toBe(null)
    expect(extractJsonObject("没有花括号")).toBe(null)
  })
})

describe("intentSchema", () => {
  test("rejects an unknown intent value", () => {
    expect(intentSchema.safeParse({ intent: "maybe" }).success).toBe(false)
  })

  test("reason is optional", () => {
    expect(intentSchema.safeParse({ intent: "direct" }).success).toBe(true)
  })

  test("extra fields are stripped and never reach the returned message", () => {
    const parsed = intentSchema.safeParse({ intent: "split", reason: "r", extra: 1 })
    expect(parsed.success).toBe(true)
    expect("extra" in (parsed.success ? parsed.data : {})).toBe(false)
  })
})

describe("sanitizeIntentReason", () => {
  test("strips control characters, newlines and ANSI sequences", () => {
    expect(sanitizeIntentReason("第一行\n第二行\u001b[31m红")).toBe("第一行 第二行红")
  })

  test("truncates to the cap without cutting surrogate pairs", () => {
    const long = "🚀".repeat(400) // 800 UTF-16 units, ends mid-pair when sliced raw
    const result = sanitizeIntentReason(long)
    expect(result.length).toBeLessThanOrEqual(500)
    expect(() => encodeURI(result)).not.toThrow()
  })

  test("undefined becomes an empty string", () => {
    expect(sanitizeIntentReason(undefined)).toBe("")
  })
})

describe("checkSplitIntent", () => {
  function intentClient(
    text: string,
    opts: { createError?: boolean } = {},
  ): PrismClient {
    return {
      session: {
        get: async () => ({ data: { id: "parent" } }),
        create: async () =>
          opts.createError ? { error: { message: "refused" } } : { data: { id: "intent_session" } },
        abort: async () => {},
        prompt: async () => {},
        promptAsync: async () => ({}),
        messages: async () => ({
          data: [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }],
        }),
        status: async () => ({ data: {} }),
      },
      tui: { showToast: async () => {} },
    }
  }

  const run = (client: PrismClient) =>
    checkSplitIntent({
      client,
      directory: "/work",
      parentSessionID: "parent",
      task: "修个 typo",
      model: MODEL,
    })

  test("a direct verdict comes back with its reason", async () => {
    const intent = await run(intentClient('{"intent":"direct","reason":"单步任务"}'))
    expect(intent.intent).toBe("direct")
    expect(intent.reason).toBe("单步任务")
  })

  test("a split verdict is returned as-is", async () => {
    const intent = await run(intentClient('{"intent":"split"}'))
    expect(intent.intent).toBe("split")
  })

  test("unparseable output fails open to split", async () => {
    const intent = await run(intentClient("我觉得直接做就好"))
    expect(intent.intent).toBe("split")
  })

  test("a session-create failure fails open to split", async () => {
    const intent = await run(intentClient('{"intent":"direct"}', { createError: true }))
    expect(intent.intent).toBe("split")
  })

  test("the intent child prompt carries the prism tool lockdown", async () => {
    const bodies: unknown[] = []
    const client = intentClient('{"intent":"split"}')
    const original = client.session.promptAsync.bind(client.session)
    client.session.promptAsync = async (args) => {
      bodies.push(args.body)
      return original(args)
    }
    await run(client)
    const tools = (bodies[0] as { tools?: Record<string, boolean> }).tools ?? {}
    expect(tools.split_task).toBe(false)
    expect(tools.bg_spawn).toBe(false)
    expect(tools.vision_look).toBe(false)
    expect(tools.question).toBe(false)
  })
})
