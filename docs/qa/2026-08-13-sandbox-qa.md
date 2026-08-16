# QA 记录: 2026-08-13 隔离沙箱 harness 验证

## WHAT WAS TESTED

隔离 XDG 沙箱（`/tmp/prism-qa.DZHN7F`，data/config/state/cache 全部指向临时目录）中加载本地插件路径，驱动真实 `opencode run --format json`：

1. 插件加载与初始化（配置加载、provider 快照异步拉取、链解析警告）
2. 真实模型驱动 `bg_spawn` 端到端：工具注册 → 模型工具调用 → 排队 → 并发槽 → 子会话创建

环境：opencode 1.18.15，沙箱仅连接 1 个 provider（opencode 免费网关），QA 专属配置 `/tmp/prism-qa.DZHN7F/prism.jsonc`：

```jsonc
{
  "categories": {
    "quick": { "fallbackChain": ["deepseek-v4-flash-free"] },
    "deep": { "fallbackChain": ["deepseek-v4-flash-free"] }
  }
}
```

## WHAT WAS OBSERVED

**初始化日志（stdout 捕获）:**

```
[prism] config loaded {"user":"/tmp/prism-qa.DZHN7F/prism.jsonc","project":null}
[prism] provider snapshot updated {"providerCount":1,"providers":["opencode"],...}
[prism] warning: vision chain has no resolvable entry with the current providers {...}
```

provider 快照正确过滤为已连接子集（1 个），vision 链警告正确触发（沙箱没有视觉模型可用）。

**bg_spawn 端到端（事件流捕获）:**

模型真实调用了工具：

```
{"type":"tool","tool":"bg_spawn","state":{"status":"completed",
 "input":{"description":"qa-task","prompt":"回复两个字：完成"},
 "output":"后台任务已入队: `bg_e359acef` ..."}}
```

引擎侧：

```
[prism] background task queued {"taskId":"bg_e359acef","key":"opencode/deepseek-v4-flash-free","queueLength":1}
[prism] launching background task {"taskId":"bg_e359acef","sessionID":"ses_0066826c...","model":{"providerID":"opencode","modelID":"deepseek-v4-flash-free"}}
```

子会话以正确模型创建，并发 key 为 provider/model。模型随后回复 "任务 id: `bg_e359acef`"。

**发现的问题（1 个，已知边界）:**

`opencode run` 非交互模式在主会话结束后退出进程，dispose → shutdown 中止了仍在运行的子任务（日志 `shutting down BackgroundManager`）。TUI 模式下会话常驻，后台任务正常存活。修复方向：CLI run 模式 continuation marker（保持一个未完成 todo 直到后台任务清空），参考 oh-my-openagent 的 background-task-marker 机制，列为后续里程碑。

## WHY IT IS ENOUGH

- 单测（49 个）覆盖并发信号量、gate 去重/预约、模型链解析与视觉过滤、split DAG 调度、tmux 命令构造
- harness 验证证明插件在真实 opencode 中完整初始化、工具可被模型调用、引擎链路（排队 → 并发 → 会话创建 → 模型注入）全部真实工作
- 完成判定 + 父会话唤醒路径由单测以 mock 事件流覆盖（session.idle → validateOutput → complete → gate dispatch、兄弟任务合并单次唤醒、fallback 重试换链）

## WHAT WAS OMITTED

- 子任务在真实 harness 中跑完并唤醒父会话：需要 TUI 模式（session 常驻）或 CLI continuation marker
- tmux pane 生命周期真实验证：需要在 tmux 会话内跑 opencode TUI，断言 `tmux list-panes` 中 attach 命令（命令构造已单测覆盖）
- 视觉解读真实调用：沙箱没有视觉模型可用
- 无敏感信息：沙箱无 API key，全部经免费网关
