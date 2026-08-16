# QA 记录: 模型配置重构（读父模型 + 单视觉模型 + 删多 provider）

重构内容：会话模型改为读取父会话当前模型（删除 categories/fallback 链），视觉模型改为单个 provider/model 显式配置，删除全部多 provider 机制，重试简化为同模型单次。

## WHAT WAS TESTED

1. M0 真实 API 探测：`client.session.get` 的模型字段形状
2. 单测：模型继承、同模型单重试、重试预算、视觉单模型直传、优雅降级、新 schema 校验
3. Harness QA（2026-08-16 完成）：隔离沙箱 + 真实 opencode + 真实模型跑 bg_spawn，断言子会话模型继承

## WHAT WAS OBSERVED

**M0 探测（opencode serve 4123 端口）:**

```
session.get → data.model = {"id":"big-pickle","providerID":"opencode","variant":"default"}
```

结论：session.get 直接暴露当前模型，三级获取的首选路径成立。附带发现 session.get 无 status 字段，gate 的 busy 检测改用 `session.status()` 批量接口（已修复并加测试）。

**单测：49 全绿，105 断言**

- 子会话模型 == resolveModel 返回的父会话模型（"launch creates a child session with the resolved session model"）
- 429 失败 → 同模型重建会话重试 1 次，模型不变；第二次失败 → 任务 error（重试预算 1）
- 视觉子会话 createdModel == 配置模型；无视觉模型配置 → 优雅降级（输出不动、不崩溃）
- parseModelRef 六种非法形态拒绝；split 计划 schema 拒绝 category 遗留字段
- typecheck 干净；bundle 94.7KB → 89.2KB

**Harness QA（全新沙箱 /tmp/prism-dbg.vQQthC，真实模型，exit 0）:**

```
[prism] config loaded {"user":".../prism.jsonc","project":null}
[prism] background task queued {"taskId":"bg_9f9ffe5c","key":"opencode/big-pickle","queueLength":1}
[prism] launching background task {"taskId":"bg_9f9ffe5c","sessionID":"ses_ff58b878...",
       "model":{"providerID":"opencode","modelID":"big-pickle"}}
```

- 模型真实调用了 bg_spawn（description='qa-inherit'），回复 "任务 id: `bg_9f9ffe5c`"
- **模型继承断言成立**：父会话模型 = opencode/big-pickle，子会话创建的 model 完全一致，并发 key 一致
- 已知边界复现（预期行为）：`opencode run` 模式主会话结束后 dispose 中止未完成的子任务（日志 "session idle but no output yet, waiting" → "shutdown complete"）

**2026-08-15 的挂起根因（事后查明）:** 旧沙箱数据目录状态损坏——同一沙箱内**不带插件的纯 opencode 也零输出挂起**，而全新沙箱中 bare opencode 与 prism 插件均正常。非插件代码问题，非网络问题；后续 QA 每次使用全新 `mktemp` 沙箱。

## WHY IT IS ENOUGH

- 本轮行为变化（继承、单重试、单模型、降级）由 49 个单测精确覆盖
- 真实 harness 验证了端到端链路：插件初始化 → 模型工具调用 → 排队 → 并发 → 子会话以父模型创建
- 真实 API 形状经 M0 探测固化，非猜测

## WHAT WAS OMITTED

- 子任务在真实 harness 中跑完并唤醒父会话：需要 TUI 模式（会话常驻）或 CLI continuation marker（已知边界）
- 视觉模型真实调用：沙箱免费网关无视觉模型可用（配置的 openai/gpt-5.6-sol 在沙箱中无凭据，触发的是优雅降级路径）
- tmux pane 真实生命周期：需在 tmux 会话内跑 opencode TUI（命令构造已单测覆盖）
- 无敏感信息；沙箱无 API key
