# QA 记录: 2026-08-29 /bg、/split 命令原生执行 + 看板围栏 + TUI 环境门控

## 背景

命令的任务描述形式此前走"模板模式"：注入命令模板 → 主模型读模板 → 调用 `bg_spawn` / `split_task` 工具 → 转达结果。实测存在两类问题：① 模型回合可能不走工具（自己开干或答非所问，沙箱两次复现）；② 一次命令至少烧两个模型回合（模板回合 + 工具调用）。方案经沙箱机制实验修正：**opencode 1.18 的命令流无法跳过 LLM 回合**（空模板探针实测仍触发回合，且空模板路径下 hook 推入的 parts 会丢失）——因此最终形态为「hook 原生启动 + 模板缩为纯转达指令 + 删除 $ARGUMENTS」，回合从"模型决策启动"降级为"模型无脑转达"。生态对照：与 L.E.A.D. 的"钩子管确定性状态、模型只做受控任务"同构，`command.execute.before` 该用法在社区属前沿（官方示例未演示、社区手册未收录）。

## 改动范围

| 文件 | 改动 |
|---|---|
| `hooks/command-execute-before.ts` | ① `/bg <任务描述>`：hook 内 `await manager.launch`（秒级 I/O，与 cancel/send 的 await 先例同级），图片附件直接从命令消息 parts 提取（vision 门控），pushText 确定性回执；② `/bg <描述> --parallel N`：语义拆分需 LLM，不原生启动，注入【并行启动 N=x】指令 part 交由模型并行调 bg_spawn（唯一保留的模型决策分支）；③ `/split <任务描述>`：立即回执"已启动"，`void splitService.split()` 异步执行，产物经 **`gate.dispatch`** 回注（dry-run 计划加围栏）；④ 空参数/非法旗标给用法提示；⑤ 所有看板（`/bg status`、`/split status`、单任务看板、run 明细）包 ` ```text ` 围栏 |
| `commands/templates.ts` | 两份模板缩为纯转达指令 + 强禁令（"不要调用任何工具…不要重复执行任务"）；**删除 `$ARGUMENTS`**（防双发的关键：模型看不到任务描述）；`--parallel` 规则收敛到【并行启动】分支；导航指引按 `tuiNavigation` 条件生成 |
| `core/background/image-follow.ts`（**新增**） | 从 `tools/bg.ts` 抽出 `collectLatestUserImages` + 新增 `collectImageFollowParts`（bg_spawn 工具路径与 /bg 命令路径共用的图片跟随封装，不变量 #7 判错 + 静默降级） |
| `tools/bg.ts` | 接入共享 image-follow；`bg_spawn` 回执导航文案按 `tuiNavigation` 门控（新增 opts） |
| `core/background/manager.ts` | 完成通知的看板加围栏 + "请把围栏内状态看板原样转达"指令（通知路径此前无转述约束，实测模型会把表格转成 bullet 列表） |
| `core/background/visualizer.ts` | `renderBgDashboard` 增加 `tuiNavigation` opts（默认 true）：非 TUI 时导航提示行替换为工具侧等价查看方式 |
| `core/split/service.ts` | `SplitServiceDeps` 增加 `tuiNavigation`：`launched` 消息的子会话查看指引条件化 |
| `core/client-types.ts` | 新增 `isTuiClient` 运行时探测（`typeof client?.tui?.showToast === "function"`） |
| `index.ts` | 装配：`tuiNavigation` 探测一次传入工具/模板/服务/hook 四处 |

## 机制实验（决定方案形态，全部可复现）

1. **命令回合不可跳过**：探针插件注册空模板命令 + hook push part → 仍触发完整 LLM 回合（step_start→text→step_finish），user 消息只剩裸参数、hook parts 丢失 → 结论：B 方案"零回合"不可行，且模板必须非空承接 parts。
2. **token 对比（同环境同模型 opencode/big-pickle）**：旧模板回合 input 8,729–10,718 tokens 且后随 bg_spawn 工具调用回合（≥2 回合）；新原生回合 input 9,518/9,620（系统提示词占大头，模板缩小收益 ~1k）**但为单回合**，无工具调用往返。防双发：整个命令回合仅 1 次 `background task queued`。

## 验证步骤与结果

### 1. 类型检查 / 单元测试 / 构建

```
bun run typecheck   # 0 错误
bun test            # 419 pass / 0 fail / 951 expect，27 文件（基线 407 → 419，+12；模板/命令断言改写）
bun run build       # index.js 180.91 KB
```

新增测试：`/bg` 原生启动（launch 入参/截断/回执/失败透出）、`--parallel` 指令注入与 n<2 拦截、空参数用法提示、命令附件图片跟随（vision 开/关两向）、`/split` 异步启动（旗标解析、gate 注入、dry-run 计划围栏）、模板无 `$ARGUMENTS`、非 TUI 模板文案替换、看板围栏断言。

### 2. 沙箱真实验证（`opencode serve` 常驻 + HTTP API 驱动，1.18.25）

| 验证项 | 实际输出 | 结论 |
|---|---|---|
| 原生 `/bg` 启动 | 日志 `background task queued → launching`（单次）；模型回执逐字转达"后台任务已入队: bg_a02c9acd…" | ✅ 启动收进插件，防双发成立 |
| 模型继承回退链 | 日志 `falling back to opencode default model` → 用 config 默认模型启动 | ✅ 三级回退第三级生效（见已知边界 1） |
| 原生 `/split` dry-run | 意图判定 verdict(split) → 规划器出 3 子任务 2 波计划 → `[PRISM SPLIT]` 注入，计划包 ` ```text ` 围栏 | ✅ 异步链路 + gate 回注 |
| 原生 `/split` 真实执行 | 意图判定 → 2 个无依赖任务立即启动（第 3 个 BLOCKED 等依赖，ASAP 生效）→ 注入"拆分计划已启动" | ✅ DAG 调度不变 |
| `/split status` 围栏看板 | ` ```text\nSPLIT RUN sp_xxx … [s2] COMPLETED (4s) / [s1] RUNNING / [s3] BLOCKED ``` ` | ✅ 实时 DAG 围栏内对齐 |
| run 取消 → 收尾 | `/split cancel sp_xxx` → `[PRISM SPLIT REPORT]` 注入（s1 CANCELLED / s2 COMPLETED 带结果 / s3 SKIPPED）→ 模型正确转达逐子任务状态 | ✅ 取消/聚合/回注全链路 |
| `/bg status` 围栏 | 注入内容 ` ```text\n当前会话没有后台任务。\n``` ` | ✅ |

### 3. 已知边界（如实记录）

1. **新会话首条消息即 `/bg` 且未配置默认模型**：原生路径在模型继承链前两级（Session 对象、消息 info.model）为空时依赖第三级（config `model`）；均未配置时报"无法确定主会话的当前模型"并给出明确错误——这是三级回退链的既定语义，会话发生任意一轮回合后（tracker 有快照）重试即自愈。旧模板路径因模型回合先发生而天然规避，属于行为等价性换确定性的已知代价。
2. **模型对禁令的服从度**：big-pickle 在转达回合中仍自行跑了一次只读 glob（无第二次 launch，防双发未被击穿）。禁令降低了越权面但不承诺清零——这是模板模式的固有边界。
3. **`isTuiClient` 探测信号**：headless serve 下 host 客户端同样暴露 `tui.showToast`（本沙箱导航提示仍为 TUI 版即此原因），信号能否区分 web 会话**待真实 web 端人工验证**；探测失败时行为回退为现状（显示 TUI 提示），不会更差。
4. **命令消息附件经 parts 提取**：headless 的 command API 无法携带附件，该路径仅单测覆盖，真实贴图场景待 TUI 人工验证。
5. 环境侧问题（非本次引入）：沙箱中 provider 的 glob 工具执行偶发挂起（s1 子任务 busy 直到取消），与 0.4.0-beta 验证时观察一致。

## 文档同步

- README：`/bg`、`/split` 行为说明（原生执行/回执确认/`--parallel` 保留）、看板围栏说明。
- CHANGELOG [Unreleased]：命令原生执行 + 看板围栏 + TUI 门控。
- AGENTS.md：数据边界解析规范（3.5）、注入文本契约（3.6）、3.2 自主触发入口检查清单、4 节沙箱技法、3.4 版本矩阵。
