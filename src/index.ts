import type { PluginInput } from "@opencode-ai/plugin"
import { loadConfig } from "./config/load"
import { parseModelRef } from "./models"
import type { ResolvedModel } from "./models"
import { PromptGate } from "./core/prompt-gate"
import type { PrismClient } from "./core/client-types"
import { BackgroundManager, type ResolveModelFn } from "./core/background/manager"
import { VisionPipeline } from "./core/vision/pipeline"
import { CurrentModelTracker } from "./core/vision/model-tracker"
import { SplitService } from "./core/split/service"
import { SplitRunRegistry } from "./core/split/registry"
import { createToolExecuteAfterHook } from "./hooks/tool-execute-after"
import { createChatParamsHook } from "./hooks/chat-params"
import { createEventHook } from "./hooks/event"
import { createChatMessageHook } from "./hooks/chat-message"
import { createCommandExecuteBeforeHook } from "./hooks/command-execute-before"
import { createBgTools } from "./tools/bg"
import { createSplitTool } from "./tools/split"
import { createVisionLookTool } from "./tools/vision-look"
import { createBgCommand, createSplitCommand, type PrismCommandDefinition } from "./commands/templates"
import { log } from "./shared/log"
import { guardHook } from "./shared/hook-guard"
import { resolveServerUrl } from "./shared/server-url"

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

  // Resolve once so the /bg output --full hint prints a consistent attach URL
  // (port-0 fallback, OPENCODE_PORT, config).
  const attachServerUrl = resolveServerUrl(serverUrl, process.env, log)

  // Per-session model tracker: chat.params fires before every LLM call with
  // the resolved model and its capabilities — the same signal opencode's
  // runtime uses to accept image parts.
  const modelTracker = new CurrentModelTracker()

  // Tracker-first resolution: chat.params snapshots the session's model
  // before every LLM call, so the common case (a session that has already
  // made calls in this process) resolves from memory with zero network
  // cost. Known staleness window: the snapshot refreshes only on the next
  // chat.params, so a /models switch followed by an immediate /bg or
  // /split (before the parent's next LLM call) resolves the pre-switch
  // model — accepted as the price of the fast path, self-healing on the
  // parent's next call. Only when the snapshot is missing (no call made in
  // this process yet) do we pay the network path.
  const resolveModel: ResolveModelFn = (parentSessionID) => {
    const snapshot = modelTracker.get(parentSessionID)
    if (snapshot) return Promise.resolve(snapshot.model)
    return resolveSessionModel(client, parentSessionID, directory, opencodeDefaultModel)
  }

  const manager = new BackgroundManager({
    client,
    directory,
    config,
    gate,
    resolveModel,
  })

  // Explicit model wins; otherwise inherit the session's current model when
  // it accepts images; an invalid vision.model stays permanently off. The
  // enabled switch short-circuits everything — registration and the
  // tool.execute.after hook (tool-execute-after.ts) gate too; this third gate
  // covers the pipeline's manual paths (vision_look is unregistered when
  // disabled, so this is defense in depth, not dead code).
  const getVisionModel = (sessionID: string): ResolvedModel | undefined => {
    if (!config.vision.enabled) return undefined
    if (visionModel) return visionModel
    if (visionRefInvalid) return undefined
    const snapshot = modelTracker.get(sessionID)
    return snapshot?.visionCapable ? snapshot.model : undefined
  }

  const vision = new VisionPipeline({
    client,
    directory,
    config,
    background: manager,
    getVisionModel,
  })

  // /split status 看板的数据源:runSplit 的 tasksByPlanID/skippedPlanIDs
  // 只活在 service 局部,登记后 command hook 才能读到(见 registry.ts)。
  const splitRegistry = new SplitRunRegistry()

  const splitService = new SplitService({
    client,
    directory,
    manager,
    gate,
    registry: splitRegistry,
    resolvePlannerModel: (sessionID) => resolveModel(sessionID),
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
        // vision.enabled drops the read-image guidance from both templates:
        // it references vision_look, which is unregistered when disabled.
        bg: createBgCommand(config.vision.enabled),
        // split.tool gates BOTH split entries: the command's task mode runs
        // through the split_task tool (template-instructed), so without the
        // tool a registered command could not execute — do not register it.
        ...(config.split.tool ? { split: createSplitCommand(config.vision.enabled) } : {}),
      }
    },
    tool: {
      // autoTrigger (策略 A)与 visionEnabled 同模式:插件加载时读取,切换
      // 需重启 opencode。client 供 bg_spawn 图片跟随(/bg 分析图片)读取
      // 父会话最近消息。
      ...createBgTools(manager, {
        visionEnabled: config.vision.enabled,
        autoTrigger: config.background.autoTrigger,
        client,
        directory,
      }),
      // Read once at plugin load: toggling it requires restarting opencode.
      ...(config.split.tool ? createSplitTool(splitService) : {}),
      // vision.enabled gates registration the same way split.tool does: a
      // disabled feature must not leave a tool the model can call and fail
      // with, and children (whose prompts prism builds) lose vision_look too.
      ...(config.vision.enabled ? { vision_look: createVisionLookTool(vision) } : {}),
    },
    // Every hook is guarded: a throwing plugin hook is published by opencode
    // as Session.Event.Error and rendered as an error in the TUI, so Prism
    // swallows its own failures into the file log instead.
    "tool.execute.after": guardHook("tool.execute.after", createToolExecuteAfterHook({ config, pipeline: vision })),
    "chat.params": guardHook("chat.params", createChatParamsHook(modelTracker)),
    // Pasted-image hint path (vision.chatImages): inject a "call vision_look"
    // reminder into the user message before the model's turn — zero blocking,
    // the model performs the actual interpretation via the tool.
    "chat.message": guardHook(
      "chat.message",
      createChatMessageHook({ config, pipeline: vision, background: manager, tracker: modelTracker }),
    ),
    "command.execute.before": guardHook(
      "command.execute.before",
      createCommandExecuteBeforeHook({ manager, serverUrl: attachServerUrl, client, registry: splitRegistry }),
    ),
    event: guardHook("event", createEventHook(manager, modelTracker, gate)),
    dispose: async () => {
      try {
        await manager.shutdown()
        gate.clearAll()
      } catch (error) {
        log("[prism] dispose failed (swallowed)", { error })
      }
    },
  }
}

export default Prism
