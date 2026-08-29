# QA 记录: 2026-08-29 看板改 markdown 管道表格（方案 a，修复 web 端表格错位）

## 背景与根因

用户截图反馈：`/bg status` 看板在 opencode web 端列错位（TUI 正常）。上一轮初步归因于"模型转达时剥掉 ```text 围栏"；本轮对截图做像素级测量后**推翻该推断**，确认真正根因：

1. **围栏实际生效**：ID 列分隔符 x=445 在表头/行1/行2/行3 四行完全对齐 → 空格被保留（代码块渲染，非 markdown 空格折叠）。
2. **错位来自字体宽度比例**：Description 列之后的分隔符各行错位（表头 805 / 行1-2 773 / 行3 763，CJK 越多错得越左）。实测字号 ASCII≈16.4px、CJK≈27.4px，**比例 1.67**，而宽度引擎（`core/shared/width.ts`）假设 2.0。

```
行1: " s1: 调研目录结构     " = 10 ASCII + 6 CJK → 10×16.4 + 6×27.4 = 328px → 445+328 = 773 ✓
行3: " s3: 调研测试覆盖情况 " = 6 ASCII + 8 CJK  → 6×16.4 + 8×27.4 = 317px → 445+317 = 762 ≈ 763 ✓
表头: " Description          " = 22 ASCII          → 22×16.4 = 360px   → 445+360 = 805 ✓
```

结论：**web 端代码块字体 CJK≈1.67×ASCII（CJK 按 1em 进宽、ASCII 按 ~0.6em 进宽），只要表格含中文，围栏无法修复 web 对齐**——box-drawing 表格的双端对齐假设只在 TUI 等宽终端成立。

## 方案：markdown 管道表格

看板改输出 GFM 管道表格（`| ID | ... |` + `| --- |` 分隔行 + 数据行）：

- **web 端**：GFM 解析器渲染为真 HTML 表格（列宽由浏览器决定，不依赖字体比例）→ 永远对齐；
- **TUI 端**：原始文本等宽显示，列宽补齐（宽度引擎）仍然生效 → 照旧对齐；
- **不再包围栏**：围栏会把表格降级为代码块，web 端错位复现。`fence()` 仅保留给纯分层缩进文本（dry-run 计划、`/split status sp_xxx` 单 run 明细），分层文本无列对齐、不受 CJK 比例影响，围栏保形 web 端缩进。
- **约束**：单元格内管道符转义为 `\|`（description/error 均可能含 `|`，不转义会被 GFM 按新列拆开）；宽度按转义后文本计算；标题行放表格上方独立成段（markdown 表格无标题行）；表格与前后段落之间空行分隔（GFM 按块解析）。

## 改动范围

| 文件 | 改动 |
|---|---|
| `core/background/visualizer.ts` | `renderTable` 从 box-drawing 改为 markdown 管道表格；新增 `escapePipe`（单元格 `\|` 转义）；标题移出表格独立成段；`renderCompactDashboard` 表格与结果预览之间空行分隔；文件头注释改为方案 a 说明 |
| `hooks/command-execute-before.ts` | `/bg status`、`/bg status <id>`、`/split status` 看板去 `fence()`（含 INDEPENDENT TASKS 表格，围栏会使其降级代码块）；`/split status sp_xxx` 与 dry-run 计划保留 `fence()`（纯分层文本）；`fence()` 注释更新 |
| `core/background/manager.ts` | 完成通知注入：去掉 ```text 围栏，指令改为"保留表格的 \| 列分隔结构" |
| `commands/templates.ts` | `/bg`、`/split` 模板追加"注入内容是表格时保留表格的 \| 列分隔结构" |
| `tests/` | bg-command（围栏断言 → 管道表格断言）、bg-templates（转达指令断言）、bg-visualizer（表格行匹配改 `^\|`、新增管道转义测试、分隔行测试） |

## 验证步骤与结果

### 1. 类型检查 / 单元测试 / 构建

```
bun run typecheck   # 0 错误
bun test            # 421 pass / 0 fail / 960 expect，27 文件（基线 419 → 421，+2 新增管道转义/分隔行测试）
bun run build       # index.js 179.41 KB
```

### 2. 渲染输出抽查（脚本直调 renderBgDashboard / renderCompactDashboard）

```
PRISM BACKGROUND TASKS (Running: 3, Queued: 0)
| ID          | Description          | Status     | Duration | Progress |
| ----------- | -------------------- | ---------- | -------- | -------- |
| bg_4285a379 | s1: 调研目录结构     | RUNNING    | -        | 0 calls  |
| bg_e89b0301 | s2: 调研依赖情况     | RUNNING    | -        | 0 calls  |
| bg_c70143ba | s3: 调研测试覆盖情况 | RUNNING    | -        | 0 calls  |
```

### 3. 沙箱真实验证（`opencode serve` 常驻 + HTTP API 驱动，1.18.25）

沙箱 4：`/bg status` 空态 → 注入 `当前会话没有后台任务。`（无围栏），模型回执"没有后台任务可处理，无需操作" ✅

沙箱 5：真实启动后台任务 → 任务完成后注入的完成通知：

```
<system-reminder>
[PRISM BACKGROUND TASKS]
全部后台任务已结束 (1 个):

请把下方的状态看板表格原样转达给用户（保留表格的 | 列分隔结构，不要改写为列表、不要添加 emoji 或任何符号）：

| ID          | Description            | Status     | Duration | Attempts |
| ----------- | ---------------------- | ---------- | -------- | -------- |
| bg_acdda690 | 调研当前目录的文件数量 | COMPLETED  | 7s       | -        |

完整结果:
当前目录：一级条目 21 个；递归统计全部文件 5613 个（含 `.git`、`node_modules`、`dist` 等）。
</system-reminder>
```

模型转达（assistant 消息）**逐字保留管道表格**：

```
| ID          | Description            | Status     | Duration | Attempts |
| ----------- | ---------------------- | ---------- | -------- | -------- |
| bg_acdda690 | 调研当前目录的文件数量 | COMPLETED  | 7s       | -        |

完整结果:
当前目录：一级条目 21 个；...
```

✅ 注入无围栏、模型保留 `|` 列分隔 → web 端 GFM 将渲染为 HTML 表格。

### 4. 已知边界

1. **web 端 HTML 表格渲染待人工确认**：沙箱是 headless，无法验证 opencode web 前端是否按 GFM 解析 markdown 表格。若 web 渲染器不支持 GFM 表格，管道表格会以原始文本显示（`| a | b |`，可读性尚可），但不会更差（无围栏不会再错位）。TUI 端已由单测等宽断言 + 沙箱消息内容确认。
2. **`/split status` 的 run 区块缩进在 web 端折叠**：混合内容（分层文本 + INDEPENDENT TASKS 表格）无法整体围栏（表格会被降级），run 区块的 2 空格缩进在 web 端 markdown 下折叠为 1 空格——行前缀（`[s1]` / `Wave N:`）保留结构语义，属可接受视觉损失；`/split status sp_xxx`（纯分层文本）仍围栏保形。
3. **转义后的 `\|` 显示**：description 含 `|` 时 TUI 端显示 `\|`（转义原文），仅影响罕见含管道符的描述文本。
4. **模型对"保留 | 列分隔"指令的服从度**：本沙箱 big-pickle 逐字保留；换模型后的行为未测，指令措辞已加强（模板 + 通知注入双处）。

## 文档同步

- AGENTS.md：3.6 注入文本契约更新（表格改 markdown 管道表格、不包围栏；围栏仅保留给分层文本；web 端 CJK 字体比例 1.67 的结论）。
- README：看板渲染说明（管道表格 + web/TUI 双端策略）。
- CHANGELOG [Unreleased]：看板改 markdown 管道表格修复 web 端错位。
