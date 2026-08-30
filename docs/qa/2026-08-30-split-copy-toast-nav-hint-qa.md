# QA 记录: 2026-08-30 Split 启动文案优化、TUI Toast 启动反馈与导航指引统一

## 背景

按「Prism 启动文案优化与多处引导一致性改造实施方案」落地：① `leader 键` 属 Neovim 极客术语，普通用户无法对应到具体按键，全部统一为直接写 `Ctrl+X`；② 启动回执中的内部工程词汇 `回注主会话` 改为自然表述 `任务完成后将自动在此汇总结果`；③ `/split` 启动时补充 TUI Toast 瞬时气泡（持久留痕仍由回执文本承担，双通道）；④ 顺带修复基线中 23 个因上一轮「工具/命令 schema 英文化」重构遗留的测试断言漂移（main 分支 `bun test` 在本次改动前即有 23 fail）。

## 改动范围

| 文件 | 改动 |
|---|---|
| `config/constants.ts` | `BG_SESSION_NAV_HINT`：`press leader key (default Ctrl+X) then ↓ to view child session output live, ←/→ to cycle, ↑ to return to parent session` → `press Ctrl+X then ↓ to view child session output live (←/→ to cycle, ↑ to return to parent session)`。常量注释同步更新（决策依据与 keybinds 可覆盖的边界保留） |
| `core/split/service.ts` | ① `launched` 消息改为两段式自然短句（TUI 版含 `Ctrl+X + ↓`，非 TUI 版仅 `/split status`；两者均以「任务完成后将自动在此汇总结果」收尾）；② 启动路径新增 best-effort `client.tui.showToast?.()`（`Prism Split` / info / 4s，`void toast.catch(() => {})` 吞错，与 manager/hook 的 Toast 先例同构） |
| `commands/templates.ts`、`core/background/visualizer.ts`、`hooks/command-execute-before.ts` | 均消费 `BG_SESSION_NAV_HINT` / `navigationHint()`，常量更新后自动对齐，无硬编码改动（逐步验证确认） |
| `README.md` | 「TUI 实时子会话导航」一节：`Leader 键（默认 Ctrl+X）后按 ↓` → `Ctrl+X 后按 ↓`，并补充键位可通过 `keybinds` 自定义的说明 |
| `tests/`（7 个文件） | ① 同步本次文案断言（`bg-visualizer.test.ts`、`bg-tools.test.ts`、`bg-templates.test.ts`）；② 修复英文化遗留漂移 23 处（模板断言、`bg_wait` 返回文本、vision_look 拒绝/占位符/无图提示、chat-message 命令回合夹具改用 `BG_COMMAND_TEMPLATE_MARKER`/`SPLIT_COMMAND_TEMPLATE_MARKER` 常量、split 工具降级文案、autoTrigger 准则断言、split 工具 mock 消息）；③ 新增 `SplitService launch receipt` 两个用例（TUI 版回执含子任务数/具体键位/无术语残留 + 恰好一次 Toast；非 TUI 版无键位且保留 status 查询） |

## 验证步骤与结果

### 1. 类型检查 / 单元测试 / 构建

```
bun run typecheck   # 0 错误
bun test            # 447 pass / 0 fail / 1071 expect，27 文件（基线 422 pass / 23 fail → 全绿，+2 新用例）
bun run build       # index.js 180.11 KB
```

### 2. 沙箱真实验证（`opencode serve` 常驻 + HTTP API 驱动，1.18.25，隔离 XDG 沙箱）

| 验证项 | 实际输出 | 结论 |
|---|---|---|
| 原生 `/split` 异步链路 | `POST /session/{id}/command` 触发：hook 即时回执「拆分任务已启动：正在做意图判定与规划…」→ 意图判定 verdict(split) → 规划器出 2 子任务 → 后台任务 queued/launching | ✅ 异步链路与 DAG 调度不变 |
| gate 回注启动回执（新文案） | `[PRISM SPLIT]` 注入：`拆分任务已启动（共 2 个子任务，按依赖并发执行）。进度可通过快捷键 Ctrl+X + ↓ 查看子会话，或输入 /split status 查询；任务完成后将自动在此汇总结果。` → 模型逐字转达 | ✅ 两段式新文案 + 具体键位 |
| 旧文案残留扫描 | 全量会话消息（含模板与全部回执）：`leader` 0 处、`回注主会话` 0 处、`拆分计划已启动` 0 处、`Ctrl+X` 3 处（模板 1 + 回执 1 + 转达 1） | ✅ 无漂移 |
| 聚合报告（管线尾部） | 子任务 COMPLETED → `[PRISM SPLIT REPORT]` 注入父会话（s1/s2 带结果） | ✅ 拆分收尾路径未受影响 |
| Toast 副作用 | prism.log 全程无 showToast/error 相关异常；非 TUI（headless serve）下 Toast 调用静默跳过/吞错 | ✅ best-effort 语义成立 |

### 3. 已知边界（如实记录）

1. **Toast 气泡的视觉效果**：headless serve 无 TUI 渲染面，只能验证调用路径无异常；气泡的实际呈现需在真实 TUI 中人工确认（与既有 Toast（启动/取消/投递）同一通道，风险低）。
2. **键位写死与 keybinds 自定义**：文案从「leader 键（默认 Ctrl+X）」改为直接写 `Ctrl+X`，用户自定义 keybinds 后文案会与实际键位不符——这是可读性对齐度的既定权衡（方案决策），README 已补充自定义说明。
3. 英文化遗留的 23 个测试失败在本次改动前的 main 分支即存在（上一轮 commit 翻译了 schema 未同步测试），本次一并修复，非新引入回归。

## 文档同步

- README：「TUI 实时子会话导航」键位表述更新。
- 其余 QA 历史记录（`docs/qa/2026-08-29-*.md`）为存档证据，不回写。
