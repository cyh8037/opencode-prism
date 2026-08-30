# QA 记录: 2026-08-30 看板 ID 列截断修复（`/bg status <id>` 报"任务不存在"）

## 背景（真实会话事故取证）

用户在真实会话中 `/bg status <id>` 连续报"任务不存在"。证据取自 `opencode.db`（会话 `ses_faefca561ffedihFIjYkXdtYOt`，"oh-my-openagent 项目调研"，2026-08-30 12:52–12:56）：

| 时间 | 事件 |
|---|---|
| 12:53:09 | `/split` 拆出子任务 s1，真实 id `bg_3804443fbf5d`（定长 15；子会话标题 `[bg_3804443fbf5d] s1: …` 为证） |
| 12:53:28 | 看板注入显示 `\| bg_3804443fb \|`（截短 3 位） |
| 12:53:40 / 12:53:55 / 12:54:21 | 三次 `/bg status bg_3804443fb` → 三次"任务不存在: bg_3804443fb" |
| 12:54:21 | `/bg status 3804443fb`（无 `bg_` 前缀）→ 用法提示（前缀拦截按设计工作，非缺陷） |
| 12:56:11 | `/bg status bg_444ce0835`（s5，真实 id `bg_444ce08357a8`）→ 再次"任务不存在" |
| 对照 | 12:55:35 启动回执（文本行，不截断）中的 `bg_73cd1b80c417` 可正常查询 |

## 根因

- id 生成：`bg_` + 12 位 hex = 定长 15（`manager.launch` 生成处）。本次未发布改动刚把随机段从 32 位加长到 48 位（碰撞窗口收敛），**ID 列宽上限未随之同步**。
- 看板 ID 列 `ID_COLUMN.maxWidth: 12`——按旧 11 字符 id（`bg_` + 8 hex）设计；渲染时 `truncateWidth` 按列宽截断。全部看板表格共用 `ID_COLUMN`（`/bg status` 看板、`/split status` 的 run 明细与 INDEPENDENT TASKS 区块、单任务看板），无一幸免。
- `manager.getTask` 为 Map 精确匹配，截短 id 查不到 → `checkTaskOwnership` 报"任务不存在"。
- 既有单测全部使用 `bg_aaaa1111` 等旧形态短 id（11 字符，低于旧上限），从未暴露截断路径。

## 改动范围

| 文件 | 改动 |
|---|---|
| `core/background/visualizer.ts` | `ID_COLUMN.maxWidth` 12 → 15，注释标明"id 定长 15、ID 列禁止截断（复制回查闭环）" |
| `tests/bg-visualizer.test.ts` | 新增定长 id 回归测试：用事故真实 id 断言两个看板渲染器（`renderBgDashboard` / `renderCompactDashboard`）完整显示、不含截短形态 |
| `README.md` | 命令示例与看板示例的 id 同步为真实长度形态（旧示例含非 hex 字符，一并修正） |
| `CHANGELOG.md` | [Unreleased] 增补修复条目 |

## 验证步骤与结果

```
bun run typecheck   # 0 错误
bun test            # 441 pass / 0 fail / 1035 expect，27 文件（基线 440 → 441，+1）
```

- 回归测试直接复现事故形态：15 字符 id 在两个看板渲染器中完整显示，且不再出现 12 字符截短形态。
- 沙箱说明：本次改动是渲染层列宽常量（纯函数、确定性输出），不涉及 hook 触发 / 子会话生命周期 / 回注调度语义，单测覆盖充分、无需沙箱生命周期验证；事故本身即生产环境真实复现，修复后"看板 id → `/bg status`/`/bg output`/`/bg cancel` 查询"闭环由回归测试锁定。
