# QA 记录: 2026-08-29 终态 toast 分级摘要 + 失败防刷屏

## 改动范围

背景：整批收尾 toast 原样取**最后一个落地任务**的状态与 variant——混合批次（部分失败）末尾弹绿色 "COMPLETED: 最后一个任务"，variant 主动误导；失败路径逐任务弹 toast，run 级取消（`/split cancel sp_xxx`）连弹 N 条。修复原则：**toast 内容粒度与触发条件对齐**（收尾=会话级摘要，失败=任务级详情），注入链路零改动。

| 文件 | 改动 |
|---|---|
| `core/background/manager.ts` | `notifyParent` 的 toast 分支抽为 `showTerminalToast`：① `allComplete` 且任务数 >1 → 摘要 toast `全部后台任务已结束: N 成功, M 失败[, K 取消]`（variant：有失败→error，仅取消→warning，全成→success）；② 单任务收尾与批内失败保留原单任务文案，失败/取消**追加 `task.error` 原因摘要**（`sanitizeTruncate` 80 字符，复用单元格清洗管线）；③ 批内失败 toast 按**每父会话 8s 窗口合并**（`FAILURE_TOAST_COALESCE_MS`，无计时器，时间戳随 `pruneStaleTasks` 清理；收尾摘要/注入看板仍报告全部失败计数）；④ `siblingTasks` 计算提前复用 |
| `core/client-types.ts` | 新增 `ToastVariant` 联合类型（"info"/"success"/"warning"/"error"），`PrismTui.showToast` 与 `showToast` 签名收窄（原裸 `string`） |
| `hooks/command-execute-before.ts` | `/split cancel sp_xxx` 循环改传 `skipNotification: true`（对齐 `cancelAllByParentSession` 既有语义），循环后弹**单条** info 摘要 toast；命令回执与 split 聚合报告（`run.done` 链路，与 manager 通知无关）照常 |
| `core/split/service.ts` | 启动回执文案修正："子任务进度通过 toast 展示"（与实际行为不符，单个子任务成功不弹 toast）→ 改为"TUI 子会话导航（leader 键+↓）与 /split status 查看，全部结束后汇总报告回注" |

**明确不改**：不引入批次实体（收尾 toast 维持父会话口径，与注入看板一致）；不把 toast 做成注入看板复制品；单任务 `/bg` 收尾文案不变。

## 验证步骤与结果

### 1. 类型检查 / 单元测试 / 构建

```
bun run typecheck   # 0 错误
bun test            # 381 pass / 0 fail / 857 expect，25 个文件（基线 377 → 381，+4 重写 +3 新增 -1 合并）
bun run build       # index.js 175.24 KB
```

测试更新（`tests/background-manager.test.ts`）：
- **重写**"a batch shows one start toast and a summary settle toast"：双任务批次收尾断言摘要 `全部后台任务已结束`+`2 成功`+success variant，且回归断言**不再出现** `COMPLETED` 单任务文案（旧实现回归探测器）。
- **新增**"a mixed batch toasts the failure with its reason, then settles with an error summary"：A 失败（promptAsync 按内容注入失败）→ 批内失败 toast 含原因 `rate limit exceeded`；B 完成收尾 → 摘要 `1 成功, 1 失败` + **error variant**（针对"variant 说谎"回归）。
- **新增**"mid-batch cancellation toasts coalesce inside the window"：双取消 + 一任务运行 → 仅 1 条 `CANCELLED` toast（8s 窗口合并）；收尾摘要 `1 成功, 2 取消` + warning variant。
- **新增**"a single failing task keeps the per-task toast and appends the reason"：单任务路径文案回归 + 原因摘要。
- **新增**"cancelTask with skipNotification silences both the toast and the parent injection"：run 级取消参数的 manager 侧语义。

测试更新（`tests/bg-command.test.ts`）：`/split cancel sp_xxx` 用例断言 `cancelTask` 收到 `skipNotification: true`、hook 弹单条"已取消 N 个子任务"摘要。

### 2. 沙箱冒烟（scripts/qa/sandbox-run.sh，opencode 1.18.25）

插件在真实 opencode 会话加载无错误，prism 日志正常写盘（沙箱 /tmp/prism-qa.765A86）。

### 3. 真实链路取证（headless `opencode run`，真实模型 opencode/big-pickle）

| 验证项 | 方法 | 实际输出 | 结论 |
|---|---|---|---|
| 批量收尾回注（refactor 后无回归） | bg_spawn 双任务（x1.txt=one / x2.txt=two）+ bg_wait 保活 | opencode.db part 表落库 `[PRISM BACKGROUND TASKS]\n全部后台任务已结束 (2 个)` 看板（09:44:16，双 COMPLETED + 结果预览）；日志 `gate: session still busy after settle, dispatching anyway`（正常路径） | ✅ 收尾注入与 refactor 前行为一致；摘要 toast 与该注入同代码块、同触发条件，调用点被证实执行 |
| 批内失败路径 | 09:35 批次 b.txt 任务真实报错（provider `session error`） | 落库 `后台任务状态更新` 看板：`bg_37354a77 │ ERROR: session error │ 5s`、`仍有 1 个任务运行中`（09:35:42，A 仍在跑 → isFailure 单任务路径） | ✅ 批内失败 toast + 注入真实触发，与单任务文案+原因摘要新格式同分支 |
| 子会话标题 | 查询 opencode.db | `[bg_28a27d6e] 创建 a.txt（内容 alpha） (prism)` 等 | ✅ 无回归 |
| toast 调用无异常 | grep prism.log `toast failed` | 0 条 | ✅ 无失败调用（headless 下 TUI API 缺失时 optional chaining 静默跳过，无法区分"未调用/成功"，渲染效果见第 4 节） |
| 意图判定默认值（顺带，上午改动） | `/split 创建两个文件…` | 判定 direct，主模型直接执行并转达 | ✅ `split.intentCheck` 默认 true 生效（无 split 子会话落库） |

环境备注：09:35–09:42 期间 provider（opencode/big-pickle）整体停滞，一次重试会话零消息、首批双任务因 `opencode run` 进程退出孤儿化（任务生命周期归属插件进程，符合既有设计）；provider 恢复后重跑成功，停滞与本改动无关。

### 4. 真实环境待人工验证项（需交互 TUI，headless 无法覆盖）

1. 批量收尾摘要 toast 的 TUI 渲染：文案 `全部后台任务已结束: 2 成功`、success/error/warning 变体配色。
2. 批内失败 toast 的原因摘要显示（80 字符截断、控制字符清洗后）。
3. 8s 窗口合并的体感：连续失败/批量取消只见到一条 toast。
4. `/split cancel sp_xxx` 在 TUI 中的完整时序：单条"正在取消…"→ 单条"已取消 N 个子任务"→ 无逐任务 CANCELLED 刷屏。

## 追加排查: split 运行 id 丢下划线（同日第二项，无代码改动）

**用户报告**：`/split status` 多运行概览中部分 run id 显示为 `sp9af49652`（丢下划线），照显示复制 `status sp9af49652` 无法命中。

**取证（用户本机 ~/.local/share/opencode/opencode.db，会话 ses_fb340403effea25PLgpqA5Fevx）**：会话内 3 次 split run（sp_eded4453 / sp_f12c57bb / sp_9af49652）全程正常；40+ 个含 id 的 part 逐一比对，生成、注入、模型转达三环全部正确。关键时间线：概览注入（正确 `sp_9af49652`）→ 用户输入 `status sp9af49652`（无下划线，全场唯一变形形态）→ 未匹配 `sp_\S+` 正则，返回**用法提示** → 用户重输 `status sp_9af49652` → 命中，成功展开 DAG 明细。

**渲染器实测**：opencode TUI 的 markdown 解析为 **marked**（二进制 strings 指纹确认，lockfile 锁定 17.0.1/18.0.7）。本机用同版本实测：`SPLIT RUN sp_9af49652 ... (status sp_9af49652 ...)` 经 marked 解析后下划线**完整保留**（CommonMark 兼容，不做配对吞字）——"显示层吞字"假设被排除。

**结论**：根因是**用户复制/手输 id 时丢失下划线**（输入侧一次性误差），非任何软件环节 bug；这也解释了"只有被复制的那一行出问题"。

**处置**：排查期间曾先后实现 id 前缀改 `sp-`、解析容错归一（normalizeRunID）两个方案，经用户确认均**完全回退**——保持 `sp_` 格式与严格匹配不变，本项无代码改动进入交付。

## 结论

代码级验证（typecheck / 381 单测 / build）与真实链路取证（批量收尾注入落库、批内失败注入落库、标题无回归）全部通过；toast 分级摘要、variant 纠偏、防刷屏逻辑均有对应单测。TUI 渲染类 4 项留待人工验证，不阻塞交付。
