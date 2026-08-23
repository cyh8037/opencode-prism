import { describe, expect, test } from "bun:test"
import { createToolExecuteAfterHook } from "../src/hooks/tool-execute-after"
import { parseConfig } from "../src/config/load"
import type { VisionPipeline } from "../src/core/vision/pipeline"

// vision trigger gating in the tool.execute.after hook: the enabled switch,
// the tools allowlist (including the [] = nothing semantics), and the
// attachment detector gate.

// The hook's declared output type omits attachments (the real opencode output
// carries them at top level, read via cast inside the hook) — tests pass them
// through the same cast.
type HookOutput = { title: string; output: string; metadata: unknown }

function hookOutput(attachments?: unknown[]): HookOutput {
  return {
    title: "screenshot",
    output: "taken",
    metadata: {},
    ...(attachments ? { attachments } : {}),
  } as unknown as HookOutput
}

const IMAGE_ATTACHMENT = { mime: "image/png", url: "data:image/png;base64,aW1n" }

function harness(vision: Record<string, unknown>) {
  const triggered: string[] = []
  const hook = createToolExecuteAfterHook({
    config: parseConfig({ vision }),
    pipeline: {
      onToolOutput: async (input: { tool: string }) => {
        triggered.push(input.tool)
      },
    } as unknown as VisionPipeline,
  })
  return { hook, triggered }
}

describe("tool.execute.after (vision trigger)", () => {
  test("vision.enabled=false never triggers interpretation", async () => {
    const { hook, triggered } = harness({ enabled: false })
    await hook({ tool: "screenshot", sessionID: "s" }, hookOutput([IMAGE_ATTACHMENT]))
    expect(triggered).toEqual([])
  })

  test("vision.tools: [] triggers nothing (empty allowlist = no tools)", async () => {
    const { hook, triggered } = harness({ enabled: true, tools: [] })
    await hook({ tool: "screenshot", sessionID: "s" }, hookOutput([IMAGE_ATTACHMENT]))
    expect(triggered).toEqual([])
  })

  test("vision.tools listing a tool triggers only that tool", async () => {
    const { hook, triggered } = harness({ enabled: true, tools: ["screenshot"] })
    await hook({ tool: "screenshot", sessionID: "s" }, hookOutput([IMAGE_ATTACHMENT]))
    await hook({ tool: "read", sessionID: "s" }, hookOutput([IMAGE_ATTACHMENT]))
    expect(triggered).toEqual(["screenshot"])
  })

  test("omitted vision.tools inspects every tool", async () => {
    const { hook, triggered } = harness({ enabled: true })
    await hook({ tool: "read", sessionID: "s" }, hookOutput([IMAGE_ATTACHMENT]))
    await hook({ tool: "screenshot", sessionID: "s" }, hookOutput([IMAGE_ATTACHMENT]))
    expect(triggered).toEqual(["read", "screenshot"])
  })

  test("a tool output without image attachments never triggers", async () => {
    const { hook, triggered } = harness({ enabled: true })
    await hook({ tool: "screenshot", sessionID: "s" }, hookOutput())
    expect(triggered).toEqual([])
  })

  test("unsupported attachment mimes do not trigger", async () => {
    const { hook, triggered } = harness({ enabled: true })
    await hook({ tool: "screenshot", sessionID: "s" }, hookOutput([{ mime: "application/pdf", url: "x" }]))
    expect(triggered).toEqual([])
  })
})
