# QA 记录: 2026-08-29 子会话实时查看引导 + 拆分意图识别 + 自主触发

## 改动范围

方案经独立对抗性审查（1 P0 / 4 P1 / 7 P2，裁决见下）后定稿实施。

| 模块 | 文件 | 核心改动 |
|---|---|---|
| 防线加固(P0) | `core/background/manager.ts` | `childToolFilters` 增加 `split_task: false`（对齐 `VISION_CHILD_TOOL_FILTERS`，阻断子会话嵌套拆分）；`validateSessionHasOutput` 的 resultText 采集改为**始终**以 messages API 的 assistant 文本覆盖事件路径值（用户切进子会话输入不再污染完成通知） |
| 功能1 标题 | `core/background/visualizer.ts`, `manager.ts` | 新增 `sanitizeTruncate` / `buildChildSessionTitle`：子会话标题改为 `[bg_xxxxxxxx] 描述 (prism)`，description 经 ANSI/控制字符清洗 + 100 字符截断（TUI 导航视图 50 列显示，前缀放头部） |
| 功能1 指引 | `config/constants.ts`, `tools/bg.ts`, `commands/templates.ts`, `visualizer.ts` | `BG_SESSION_NAV_HINT` 常量（leader 键+↓/←→/↑，键位标注"默认"）三处消费：bg_spawn 返回文本（"启动后可…"）、/bg 模板规则（禁止轮询 bg_output 看过程）、/bg status 看板注释行（不进 compact 看板，不污染完成通知） |
| 功能2 配置 | `config/schema.ts` | `split.intentCheck`（默认 false）、`split.autoTrigger`（默认 true，与 `background.autoTrigger` 同构）；`load.ts` 字段级回退零改动自动覆盖 |
| 功能2 意图识别 | `core/split/json-prompt.ts`(新), `intent.ts`(新), `planner.ts`, `service.ts` | 从 planner 抽出 `runJsonPromptSession` 共享 helper（create→prompt→轮询→abort，**prompt body 统一加 tools 硬禁**：bg_*/split_task/vision_look/question——intent/planner 子会话不在 manager 任务表，视觉与递归守卫覆盖不到，P1 修复）；`checkSplitIntent` 中性提示词输出 `{intent,reason}`，30s 超时、不重试、**fail-open**；reason 经清洗+500 截断；service 流程 direct 一律返回 `skipped-intent`（dry-run 同入口，消息注明"预览判定"） |
| 功能2 自主触发 | `tools/split.ts`, `index.ts` | `createSplitTool(service, {autoTrigger})`：开启时 split_task 描述拼接自主触发准则（与 bg_spawn 准则互恰：1-2 个独立任务归 bg_spawn），关闭时回退旧描述；index 装配 `intentCheckEnabled` |
| 模板 | `commands/templates.ts` | /split 模板加"意图识别：无需拆分"转达规则（含 intentCheck=false 需重启提示）+ 子会话导航指引（与 /bg 对称） |
| 测试 | `tests/split-intent.test.ts`(新), `tests/split-tools.test.ts`(新), `tests/{split,background-manager,bg-tools,bg-templates,bg-visualizer,config}.test.ts`(更新) | 373 pass / 0 fail（基线 339 → 373，+34；审查修复轮后 377，见文末） |

## 审查裁决落实（新会话对抗性审查）

| 级别 | 问题 | 落实 |
|---|---|---|
| P0 | `childToolFilters` 未禁 `split_task`，autoTrigger 放大子会话嵌套拆分面（嵌套 run 注册在子会话名下、主会话 /split status 不可见、绕开熔断） | 2.0 前置修复 + 单测断言 prompt body |
| P1-1 | planner/intent 子会话带全量工具（promptAsync body 无 tools），守卫链覆盖不到 | `runJsonPromptSession` 统一 `JSON_CHILD_TOOL_FILTERS` 硬禁 |
| P1-2 | 用户切进子会话输入 → 事件路径污染 resultText → 完成通知把用户输入当"完整结果"注入 | `validateSessionHasOutput` 始终权威覆盖 + QA 实证项 |
| P1-3 | dry-run 与 intent 顺序语义自相矛盾 | direct 一律返回 skipped-intent，dry-run 消息注明预览判定 |
| P1-4 | 文档同步缺位 | 第 5 节交付清单落 README/CHANGELOG |
| P2×6 | reason 无清洗截断；文案未收敛单一常量；"运行中"措辞；/split 模板缺导航句；标题注入面与超长；并发/子会话残留未声明 | 全部按终稿落实；autoTrigger 默认 true 保留（用户决策），schema describe 与 README 标注"建议与 intentCheck 同开"；并发互斥与 planner/intent 子会话残留写入 README 已知边界 |

## 验证步骤与结果

### 1. 类型检查 / 单元测试 / 构建

```
bun run typecheck   # 0 错误
bun test            # 373 pass / 0 fail / 821 expect,25 个文件(基线 339 → 373,+34)
bun run build       # index.js 172.90 KB
```

新增测试覆盖(纯逻辑,守契约):`split-intent.test.ts`(extractJsonObject 容错、intent schema、reason 清洗截断不切代理对、checkSplitIntent direct/split/解析失败 fail-open/创建失败 fail-open、intent 子会话 prompt 的工具面断言);`split-tools.test.ts`(autoTrigger 开/关/缺省三种描述);`split.test.ts` +6(direct→skipped-intent 不触规划器、dry-run 预览判定、split 判定继续规划、创建失败 fail-open、解析失败 fail-open、未启用时零意图调用);`background-manager.test.ts` +3(子会话标题前缀+清洗截断、子会话 prompt 禁 split_task、用户输入不进入完成结果);`bg-tools.test.ts` +1(bg_spawn 返回含导航指引);`bg-templates.test.ts` +2(/bg 与 /split 模板新规则);`bg-visualizer.test.ts` +1(看板提示行、compact 看板不受污染)+宽度断言改为仅表格行;`config.test.ts` +3(split 新字段默认值/设置/按字段回退)。

### 2. 沙箱冒烟(scripts/qa/sandbox-run.sh,opencode 1.18.25)

插件在真实 opencode 会话加载无错误,prism 日志正常写盘。

### 3. 真实链路取证(headless `opencode run`,沙箱 /tmp/prism-qa.8xVXtT)

| 验证项 | 方法 | 实际输出 | 结论 |
|---|---|---|---|
| bg_spawn 全链路 | 指示模型调 bg_spawn + bg_wait | 子会话执行、完成通知回注("结果为:完成") | ✅ `split_task:false` 工具过滤被服务端接受,子会话正常启动 |
| 子会话标题前缀 | 查询沙箱 opencode.db | `ses_fb3889491…` title=`[bg_75c5860a] echo test (prism)`,parent_id 指向主会话 | ✅ 前缀生效且进入 TUI 导航组(parentID 分组) |
| 意图识别 direct | `intentCheck:true` 下 /split 简单任务 --dry-run | 日志 `intent verdict {"intent":"direct","reason":"任务规模极小…"}`;模型转达"无需拆分" | ✅ skipped-intent 真实生效 |
| 意图子会话 | 查询 opencode.db | `prism split intent` 会话,parent_id 挂主会话 | ✅ 一次性分类子会话创建/中止正常 |
| 意图识别 direct(第二例) | /split 两个小文件 | verdict direct(理由合理),主模型优雅降级直接执行并说明 | ✅ 判定偏保守时用户体验无损 |
| 意图识别 split + DAG | /split 调研+3 独立脚本+汇总 --max 4 | verdict split(带结构化 reason)→规划器产出 s1-s4→s1 先行,s2/s3/s4 依赖满足后并行启动→聚合回注 | ✅ 正路径全链路 |
| 子会话标题(拆分) | 查询 opencode.db | `[bg_6a96e450] s1: 调研并写摘要 (prism)` 等 4 条 | ✅ plan id 与 task id 双前缀可对号 |

真实运行中 s4 子会话曾报错一次(模型侧偶发),调度器按失败依赖路径处理,run 正常聚合——非本次改动引入,行为符合设计。

## 真实环境待人工验证项(需在交互 TUI 中确认,headless 无法覆盖)

1. TUI 中 leader 键(默认 Ctrl+X)+ ↓ 进入运行中的 Prism 子会话、←/→ 切换、↑ 返回主会话(键盘交互);指引文案与实际键位一致性(用户自定义 keybinds 场景)。
2. 用户切进子会话实时输入消息 → 完成判定不误判(busy defer)、通知不含用户输入(单测已覆盖逻辑,时序需真实环境复核)。
3. `autoTrigger:true` 时普通对话(无 /split)的复杂请求是否自主触发 split_task(模型行为,与 background.autoTrigger 的验证方式相同);简单请求不触发。
4. `/bg status` 看板下方导航指引行的 TUI 渲染效果(中英混排,注释行不参与对齐)。
5. 非 TUI 客户端(web/desktop)下导航指引文案不适用,仅作告知性文案(README 已知边界)。

## 结论

代码级验证(typecheck/373 单测/build)与真实链路取证(bg_spawn 全链路、意图识别双路径、DAG 调度、标题前缀落库)全部通过;P0/P1 修复均有对应测试。键盘交互类 5 项留待 TUI 人工验证,不阻塞提交。

## 独立审查修复轮(2026-08-29,干净上下文子代理审查 commit dff8a44)

新会话审查结论:GO with fixes——方案要点与 P0/P1 裁决全部如实落地(审查者实测:父提交基线 339/23 文件、HEAD 373/25 文件、构建 172.90 KB、沙箱 DB 取证与本文档声明一致);发现 1 P1 + 8 P2,处置如下:

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| P1-1 | P1 | 方案与 AGENTS.md 3.4 要求的版本标注缺失(BG_SESSION_NAV_HINT/buildChildSessionTitle 均未标注键位行为的验证版本) | **已修**:两处注释补"经 opencode 1.15.0 / 1.18.25 二进制验证" |
| P2-1 | P2 | QA 文档/提交信息基线数字失实(实为 339→373,+34,非 341→373,+32) | **已修**:本文档数字更正(提交信息不改史) |
| P2-2 | P2 | json-prompt.ts 注释过读:工具过滤封的是主动调用向量,Trigger A(带图工具输出自动解读)守卫不识别一次性子会话,属已知残留 | **已修**:注释改为准确表述(残留由 30s/120s 超时 + abort 兜底,非无界递归) |
| P2-3 | P2 | resultText 残留窗口:子会话纯 tool 收尾(无 completed assistant 文本)时事件路径捕获的用户输入保留并可进完成通知 | **已修**:`validateSessionHasOutput` 改为无条件覆盖(text 为 null 时清空);新增"tool-only 收尾清空用户输入"测试 |
| P2-4 | P2 | 同模型重试后新旧子会话标题完全相同,导航组内无法对号(与设计目标相悖) | **已修**:`buildChildSessionTitle` 增加 retries 参数,retry>0 时标题追加 `(prism, retry N)`;retry 测试补断言 |
| P2-5 | P2 | messages 轮询无 `{ error }` 快速失败,4xx 会烧满整个超时预算(沿袭旧 planner 行为) | **已修**:识别 `{ error }` 提前返回 null(重试/fail-open 语义由调用方决定);挂起竞速(Promise.race)不采纳——继承行为且调用方已有兜底 |
| P2-6 | P2 | split_task 与 bg_spawn 自主触发准则对"3 个无依赖且无需汇总"任务同时主张管辖 | **已修**:准则第 1 条补"且子工作间有关联或需要统一汇总" |
| P2-7 | P2 | 测试断言偏弱:intentSchema extra 字段未断言剥离、标题长度上界 130 宽于真实上界 | **已修**:补 `"extra" in data === false` 断言;上界收紧为 122 |
| P2-8 | P2 | 空/纯空白 description 产生双空格标题(纯观感) | **已修**:cleaned 为空时标题为 `[bg_xxx] (prism)`(顺带 trim) |

修复后复验:`bun run typecheck` 0 错误;`bun test` **377 pass / 0 fail**(+4:tool-only 收尾清空、retry 标题序号、空描述标题、extra 字段剥离;改写:标题上界 122)。构建复验通过。

审查未采纳项说明:P2-5 的 messages 调用 Promise.race 竞速未做——单次挂起越过 deadline 的面由调用方超时语义(fail-open/重试)兜底,加竞速会增加每个轮询点的复杂度,收益不成比例。

## 结论(终)

代码级验证(typecheck/377 单测/build)与真实链路取证全部通过;两轮独立审查(方案轮 + 实现轮)的全部 P0/P1/P2 处置完毕。键盘交互类 5 项(见上文)留待 TUI 人工验证。
