# QA 记录: 2026-08-29 命令执行审查修复（P0/P1/P2）+ 双份显示实测

## 背景

`/bg`、`/split` 命令原生执行重构（0.5.0）经工程 + 交互双维度审查，报告要求修复以下问题：

- **P0**：`/split cancel`（裸调用）穿透缺陷——旧版取消当前会话全部后台任务，重构后该分支被删除且无前缀拦截，裸 `cancel` 穿透到任务描述语义，会 spawn 一个名为 "cancel" 的拆分任务。
- **P1**：`/bg` 原生回执操作指引顺序反了（工具名在前、原生命令在后）。
- **P1**：`--parallel` 分支无用户可见反馈（只有模型指令 part）。
- **P1**：注入 part + 模型转达的双份显示需 1.18 实测确认（本次 QA 核心）。
- **P2**：`/bg` 启动失败文案 raw message 直出，无可行动引导。
- **P2**：split 两段式等待无预期管理（dry-run 用户不知道要等多久）。

## 改动范围

| 文件 | 改动 |
|---|---|
| `hooks/command-execute-before.ts` | ① **恢复 `/split cancel` 裸调用**（`cancelAllByParentSession`，与 `/bg` 对称）+ 新增 cancel 前缀拦截（`^(?:cancel)(?:\s|$)` → 用法提示，防 `cancel --all` 等变体穿透）；② 两处 `cancelMatch` 正则加 `(?!--)` 负向断言（`cancel --all` 不再被当作 task id 报"任务不存在"）；③ `/bg` 原生回执指引顺序反转（`/bg output` / `/bg cancel` 在前，`bg_output`/`bg_cancel` 降为补充）；④ `--parallel` 注入加"已交给模型拆分（N=x）"用户可见反馈；⑤ 启动失败 catch 改用 `errorInfoFromObject` 提取信息，shutdown 与可重试失败给出不同行动引导；⑥ split 回执补预期管理（"通常需十几秒，失败会自动提示"）；⑦ split 用法提示补 `cancel [<sp_run_id\|task_id>]` 语义 |
| `commands/templates.ts` | 转达指令从"原样转达"强化为"**完整转达**（含操作指引行，不要省略、压缩或重排）"——防裁剪走样（沙箱实测发现模型只转达回执第一行、裁剪指引行）；split 模板补回"不要自行合并行" |
| `tests/bg-command.test.ts` | createHook 记录 `cancelAllByParentSession` 调用；新增裸 cancel 回归测试（断言不穿透 spawn）、cancel 变体前缀拦截测试、失败 hint 区分测试；回执断言更新为 `/bg output` 指引；`--parallel` 加反馈断言 |
| `tests/bg-templates.test.ts` | "原样转达"断言改为"完整转达 / 不要省略、压缩或重排" |

## 验证结果

### 1. 类型检查 / 单元测试 / 构建

```
bun run typecheck   # 0 错误
bun test            # 424 pass / 0 fail / 978 expect，27 文件
bun run build       # index.js 180.93 KB
```

### 2. 沙箱真实验证（`opencode serve` 常驻 + HTTP API 驱动，1.18.25）

**双份显示实测（本次 QA 核心，沙箱 `/tmp/prism-dd.*`）：**

命令消息（user role）parts 结构——`/bg <任务描述>` 后从消息历史取回：

```
text | text(synthetic)
```

即：命令模板 part + **hook 注入的回执以独立 `synthetic: true` text part 持久化**（回执原文完整三行：入队行 + 操作指引行 + 导航行）。命令回合的 assistant 消息再转达同一内容：

```
后台任务已入队: `bg_c84c7ad7` (简单验证任务（无需深入，回复收到即可）)

模型 opencode/big-pickle

用 `/bg output bg_c84c7ad7` 查询结果、`/bg cancel bg_c84c7ad7` 取消（也可让模型调用 bg_output / bg_cancel）。

启动后，TUI 中按 leader 键（默认 Ctrl+X）后按 ↓ 实时查看子会话输出，←/→ 切换，↑ 返回主会话。
```

**结论**：双份显示在数据层成立——注入 part 合入命令消息（OpenCode 1.2.0+ 命令注入的宿主机制）与模型转达并存。**判定为宿主机制而非缺陷**：synthetic part 原文可见是冗余保险（模型转达走样时用户仍可读原文），且首轮旧构建实测发现模型会裁剪指引行（只转达第一行）——模板强化为"完整转达"后，新构建实测**三行逐字完整转达，裁剪走样消失**。

其他验证项：

| 验证项 | 实际输出 | 结论 |
|---|---|---|
| 新指引文案 | synthetic part 含 `用 /bg output bg_xxx 查询结果、/bg cancel bg_xxx 取消（也可让模型调用 bg_output / bg_cancel）` | ✅ 原生命令在前 |
| 子任务真实执行 | `bg_c84c7ad7` 5s COMPLETED，结果"收到。" | ✅ 启动/执行链路正常 |
| 完成通知回注 | `[PRISM BACKGROUND TASKS] 全部后台任务已结束 (1 个)` 看板注入，模型转达保留 `\|` 表格 | ✅ 通知链路回归 |
| 模型继承 | 子会话模型 opencode/big-pickle（与主会话一致） | ✅ 继承回退链 |
| 失败文案 | 新会话首条消息即 `/bg` 且未配置默认模型 → 注入 `后台任务启动失败: 无法确定主会话的当前模型`（可行动提示） | ✅ 已知边界 #1 复现 |
| 转达裁剪修复 | 旧构建：模型只转达第一行；新构建（完整转达指令）：三行逐字 | ✅ 修复生效 |

## 已知边界（如实记录）

1. **synthetic part 的 TUI 视觉呈现未验证**：headless 沙箱确认了消息历史的数据层结构（synthetic 标记 + 原文持久化），但 TUI 界面上 synthetic part 与普通 part 的视觉区分（是否折叠/高亮）需 TUI 人工确认。无论呈现如何，信息不丢（原文 + 模型转达双通道）。
2. **转达完整性仍是模型纪律**："完整转达"指令修复了当前模型（big-pickle）的裁剪行为；换模型后的服从度未测，措辞已按最坏情况加强（原文可见为兜底）。
3. **`cancel --all` 语义**：前缀拦截给出的是用法提示（"不带参数取消当前会话全部任务"），未实现 `--all` 显式旗标——若用户习惯 `cancel --all`，提示会引导到裸 cancel，属可接受的等价发现路径。
4. **失败 hint 正则**：`/shutting down/i` 匹配基于英文错误文案（manager.launch 抛出的字面量），若未来改文案需同步。

## 文档同步

- CHANGELOG [Unreleased]：审查修复条目（`/split cancel` 恢复、回执指引顺序、完整转达指令、失败提示可行动化）。
- 本 QA 文档补充原生执行 QA（`2026-08-29-native-command-execution-qa.md`）未覆盖的 parts 数据层证据。
