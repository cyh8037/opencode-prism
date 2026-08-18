import type { PluginInput } from "@opencode-ai/plugin"
import { loadConfig } from "./config/load"
import { parseModelRef } from "./models"
import type { ResolvedModel } from "./models"
import { PromptGate } from "./core/prompt-gate"
import type { PrismClient } from "./core/client-types"
import { BackgroundManager, type ResolveModelFn } from "./core/background/manager"
import { VisionPipeline, type GetVisionModelFn } from "./core/vision/pipeline"
import { CurrentModelTracker } from "./core/vision/model-tracker"
import { SplitService } from "./core/split/service"
import { TmuxManager } from "./tmux/manager"
import { createToolExecuteAfterHook } from "./hooks/tool-execute-after"
import { createChatMessageHook } from "./hooks/chat-message"
import { createChatParamsHook } from "./hooks/chat-params"
import { createEventHook } from "./hooks/event"
import { createCommandExecuteBeforeHook } from "./hooks/command-execute-before"
import { createBgTools } from "./tools/bg"
import { createVisionLookTool } from "./tools/vision-look"
import { BG_COMMAND, SPLIT_COMMAND, type PrismCommandDefinition } from "./commands/templates"
import { log } from "./shared/log"
import { guardHook } from "./shared/hook-guard"

function modelFromRecord(value: unknown): ResolvedModel | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const providerID = record.providerID
  const modelID = record.id ?? record.modelID
  if (typeof providerID !== "string" || typeof modelID !== "string") return undefined
  return { providerID, modelID }
}

// Read the parent session's CURRENT model. Tier order: session object (the
// authoritative "what is this session using right now" source), latest
// message info, then the opencode config default captured by the config hook.
async function resolveSessionModel(
  client: PrismClient,
  sessionID: string,
  directory: string,
  opencodeDefault: ResolvedModel | undefined,
): Promise<ResolvedModel | undefined> {
  try {
    const response = await client.session.get({ path: { id: sessionID }, query: { directory } })
    const fromSession = modelFromRecord(response.data?.model)
    if (fromSession) return fromSession
  } catch (error) {
    log("[prism] session.get failed while resolving session model", { sessionID, error })
  }

  try {
    const messagesResponse = await client.session.messages({
      path: { id: sessionID },
      query: { directory },
    })
    const messages = messagesResponse.data
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i] as { info?: { model?: unknown } } | undefined
        const fromMessage = modelFromRecord(message?.info?.model)
        if (fromMessage) return fromMessage
      }
    }
  } catch (error) {
    log("[prism] messages fetch failed while resolving session model", { sessionID, error })
  }

  if (opencodeDefault) {
    log("[prism] falling back to opencode default model for session", { sessionID })
  }
  return opencodeDefault
}

export async function Prism(input: PluginInput): Promise<Record<string, unknown>> {
  const directory = input.directory
  const client = input.client as unknown as PrismClient
  const serverUrl = (input as unknown as { serverUrl?: string }).serverUrl

  const { config, warnings } = loadConfig(directory)
  if (warnings.length > 0) {
    const toast = client.tui.showToast?.({
      body: {
        title: "Prism config",
        message: `${warnings.length} 处配置问题，已回退到默认值（详见插件日志）`,
        variant: "warning",
        duration: 6000,
      },
    })
    if (toast) void toast.catch(() => {})
  }

  // Vision model: explicit "provider/model" reference from config; empty
  // string inherits the session's current model when it is image-capable
  // (tracker fed by chat.params); an invalid reference stays permanently off.
  // No hardcoded default — an unconfigured plugin must never silently depend
  // on a specific vendor's model.
  const visionRef = config.vision.model.trim()
  let visionModel: ResolvedModel | undefined
  let visionRefInvalid = false
  if (visionRef === "") {
    log("[prism] vision: vision.model empty, inheriting the session model when image-capable")
  } else {
    const parsed = parseModelRef(visionRef)
    if (!parsed) {
      visionRefInvalid = true
      log(`[prism] warning: invalid vision.model reference, vision feature disabled: ${visionRef}`)
    } else {
      visionModel = parsed
    }
  }

  // opencode's default model, captured from the config hook input as a
  // last-resort fallback for session-model resolution.
  let opencodeDefaultModel: ResolvedModel | undefined

  const gate = new PromptGate(client)

  const tmux = new TmuxManager({ client, directory, config, serverUrl })
  await tmux.init()

  const resolveModel: ResolveModelFn = (parentSessionID) =>
    resolveSessionModel(client, parentSessionID, directory, opencodeDefaultModel)

  const manager = new BackgroundManager({
    client,
    directory,
    config,
    gate,
    resolveModel,
    onSessionCreated: (event) => {
      void tmux.onSessionCreated(event)
    },
    onSessionDeleted: (event) => {
      void tmux.onSessionDeleted(event)
    },
  })

  // Per-session model tracker: chat.params fires before every LLM call with
  // the resolved model and its capabilities — the same signal opencode's
  // runtime uses to accept image parts.
  const modelTracker = new CurrentModelTracker()

  // Explicit model wins; otherwise inherit the session's current model when
  // it accepts images; an invalid vision.model stays permanently off.
  const getVisionModel: GetVisionModelFn = (sessionID) => {
    if (visionModel) return visionModel
    if (visionRefInvalid) return undefined
    const snapshot = modelTracker.get(sessionID)
    return snapshot?.visionCapable ? snapshot.model : undefined
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  // Same decision, but waits for the session's capability snapshot: chat.
  // message (trigger B) fires BEFORE the session's first chat.params, so a
  // fresh session has no known capability when an image arrives (e.g. a
  // message recalled from another session's history). The LLM call for the
  // just-submitted message is imminent, so the wait is short and bounded.
  const waitForVisionModel = async (
    sessionID: string,
    timeoutMs: number,
  ): Promise<ResolvedModel | undefined> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const snapshot = modelTracker.get(sessionID)
      if (snapshot?.capabilityKnown) {
        return snapshot.visionCapable ? snapshot.model : undefined
      }
      await sleep(50)
    }
    const snapshot = modelTracker.get(sessionID)
    return snapshot?.visionCapable ? snapshot.model : undefined
  }

  const vision = new VisionPipeline({
    client,
    directory,
    config,
    gate,
    background: manager,
    getVisionModel,
    waitForVisionModel,
  })

  const splitService = new SplitService({
    client,
    directory,
    manager,
    gate,
    resolvePlannerModel: (sessionID) =>
      resolveSessionModel(client, sessionID, directory, opencodeDefaultModel),
  })

  return {
    config: async (configInput: unknown) => {
      // Capture opencode's default model for the session-model fallback tier.
      // The hook receives the resolved config itself (not { config }), and the
      // top-level model is a "provider/model" string.
      const rawModel = (configInput as { model?: unknown } | undefined)?.model
      if (typeof rawModel === "string" && rawModel.trim()) {
        opencodeDefaultModel = parseModelRef(rawModel) ?? opencodeDefaultModel
      }

      // Register slash commands by mutating the config in place. The 1.18
      // plugin API discards the hook's return value (the signature is
      // `(config) => Promise<void>`), so in-place mutation is the only way
      // commands reach the config that the TUI slash menu reads.
      const cfg = configInput as { command?: Record<string, PrismCommandDefinition> }
      cfg.command = {
        ...(cfg.command ?? {}),
        bg: BG_COMMAND,
        split: SPLIT_COMMAND,
      }
    },
    tool: {
      ...createBgTools(manager),
      vision_look: createVisionLookTool(vision),
    },
    // Every hook is guarded: a throwing plugin hook is published by opencode
    // as Session.Event.Error and rendered as an error in the TUI, so Prism
    // swallows its own failures into the file log instead.
    "tool.execute.after": guardHook("tool.execute.after", createToolExecuteAfterHook({ config, pipeline: vision })),
    "chat.message": guardHook("chat.message", createChatMessageHook({ config, pipeline: vision, tracker: modelTracker })),
    "chat.params": guardHook("chat.params", createChatParamsHook(modelTracker)),
    "command.execute.before": guardHook(
      "command.execute.before",
      createCommandExecuteBeforeHook({ manager, splitService, client }),
    ),
    event: guardHook("event", createEventHook(manager, modelTracker)),
    dispose: async () => {
      try {
        await manager.shutdown()
        await tmux.sweep()
        gate.clearAll()
      } catch (error) {
        log("[prism] dispose failed (swallowed)", { error })
      }
    },
  }
}

export default Prism
