# QA 记录: 2026-08-28 后台任务看板可视化 + 策略 A 自动化触发

## 改动范围

方案文件:`/tmp/prism-v05-design.md`(修订版 v1.1,经独立审查会话 90/100 评分后合入 R1-R9)。

| 模块 | 文件 | 核心改动 |
|---|---|---|
| 1. 宽度引擎 | `core/shared/width.ts`(新) | `Intl.Segmenter` 字素切分 + 宽字判定(CJK/全角/emoji 2 宽,box-drawing 1 宽,ZWJ 序列整体按 2 宽),退化路径手写;截断不切代理对 |
| 2. 并发不变式 | `background/concurrency.ts` | 构造断言有限正整数(R8),删除 `Infinity` 分支;新增 `snapshot()` 只读接口 |
| 3. bg 看板 | `background/visualizer.ts`(新) | `renderBgDashboard`(header 含并发池)/ `renderCompactDashboard`;渲染管线 sanitize → 换行压平 → 控制字符剥离 → 截断 → 补齐;错误在状态单元格 |
| 4. Split 登记处 | `split/registry.ts`(新) | `settledAt` 锚点 TTL(R1):运行中永不清理,settled 后 60min 清理;`getRunsByParentSession` 倒序 |
| 5. Split DAG 看板 | `split/visualizer.ts`(新) | 分层泳道 + 依赖标注;状态推导 SKIPPED/BLOCKED/ARCHIVED;多 run 合并 + 独立任务去重(R2) |
| 6. 接线 | `split/service.ts`, `background/manager.ts`, `hooks/command-execute-before.ts`, `config/schema.ts`, `tools/bg.ts`, `index.ts` | service 登记 + settled 标记;buildTaskTable 看板化(保留 sanitize);`status \|\| list` 整体替换(R5);`background.autoTrigger` 新增(R9);`bg_spawn` 描述拼接自主触发准则 + visionGuidance |
| 7. 测试 | `tests/{width,bg-visualizer,split-registry,split-visualizer,concurrency}.test.ts`(新 5 个),`tests/{config,split,bg-command}.test.ts`(更新) | 详见下方 |

## 验证步骤与结果

### 1. 类型检查

```
bun run typecheck        # tsc --noEmit → 0 错误
```

### 2. 单元测试

```
bun test                 # 308 pass / 0 fail / 663 expect calls,22 个文件(基线 248 → 308,+60)
```

新增测试覆盖(全部纯逻辑,守契约 #5):

- `width.test.ts`:ASCII/CJK/全角标点/假名谚文/BMP emoji(✅❤)/非 BMP emoji(🔥)/ZWJ 序列(👨👩👧)/box-drawing/变体选择符零宽;截断不切代理对、ZWJ 序列整体保留;pad 补齐与 no-op
- `bg-visualizer.test.ts`:空态;header 计数与并发池;混合 CJK/ASCII 每行渲染宽度一致(对齐断言);换行压平;ANSI 控制字符剥离;`</system-reminder>` 转义;错误单元格;超长截断;compact 版 attempts/includeResults
- `split-registry.test.ts`:按会话过滤;倒序;运行中(未 settled)超 retention 不清理;settled 后 retention 内保留/超时清理;实时引用;register 返回条目
- `split-visualizer.test.ts`:空态;3 层波次渲染;BLOCKED;SKIPPED(附上游);ARCHIVED(settled + 任务清理);串行线性;多 run 倒序;run 任务去重(plan id → task id 收集);标题转义
- `concurrency.test.ts`:Infinity/NaN/0/负数构造拒绝;snapshot 空/计数/排队可见/释放递减/排序/clear
- `config.test.ts`(+3):autoTrigger 默认 true;显式 false 保留 concurrency;非法值按字段回退
- `bg-command.test.ts`(更新):mock 加 `getConcurrencySnapshot`;/split status 空态新文案;状态大写断言

### 3. 构建

```
bun run build            # Bundled 41 modules,index.js 153.26 KB
```

### 4. 沙箱加载

```
scripts/qa/sandbox-run.sh
# sandbox: /tmp/prism-qa.XXXXXX,插件加载无崩溃,prism 日志正常写盘
```

## 真实环境待验证项(需人工在 opencode TUI 中确认)

以下项无法由单元测试覆盖(hook 触发/子会话/真实模型行为),沙箱脚本仅验证加载:

1. `/bg status` 看板在真实 TUI 中的渲染对齐(中英混排表格);
2. 启动后台任务后 `/split status` 展示 BLOCKED → RUNNING → COMPLETED/SKIPPED 全状态流转;
3. `autoTrigger: true` 时主模型收到"大范围调研"类指令是否自主调用 `bg_spawn`(模型行为);
4. `autoTrigger: false` 时 `bg_spawn` 描述回退(工具定义可在会话中通过模型行为间接确认);
5. 子会话工具列表不出现 `bg_*`(递归防护回归);
6. 完成通知的看板化输出在会话中的显示效果。

## 新会话审查(契约 #1)与修复

独立审查会话结论:**有条件通过**(R1-R9 全部落实、11 条不变量零破坏),发现缺陷并全部修复:

| 编号 | 缺陷 | 修复 |
|---|---|---|
| M1(中等) | `/bg status` 标题行含 Pool 信息时超宽 11 列,破坏对齐(padEndWidth 不截断) | `renderTable` 标题行先 `truncateWidth` 再 pad;新增 M1 回归测试(长 Pool 下每行等宽) |
| T1 | 对齐测试恰好未传 pool 参数,放走 M1 | 回归测试补传 pool;原 header 测试改为断言截断保留前缀 |
| M2(轻微) | 皮肤色调修饰符簇(🏃🏻)按码点求和计 4 宽(实际 2);组合附加符(é)计 2 宽(实际 1) | `clusterWidth` 含非 BMP/修饰符按 2 宽;`codePointWidth` 组合附加符(0x0300-0x036F)零宽;新增 2 用例 |
| M3(轻微) | split 看板 `+` 续行缩进用码点长度,中文波头下错位 | 改用 `getStringWidth(header)` 计算缩进 |
| M4(轻微) | snapshot 暴露 `active: 0` 池行,与"仅显示有任务的模型组"不符 | snapshot 过滤 `active === 0`;测试同步更新 |
| 备注 | `resultText.slice(0, 200)` 可能切出半个代理对 | 新增 `sliceChars` 高半区退格 |

修复后复验:`bun test` 311 pass / 0 fail,typecheck 0 错误,build 153.82 KB。

## 真实环境反馈修复(2026-08-28 TUI 实测,主会话 ses_fb87e141 取证)

用户在真实 TUI 中验证后反馈三个问题,基于会话数据定位并修复:

| 反馈 | 取证结论 | 修复 |
|---|---|---|
| 1. `/bg status` 只有第一次是表格,且标题显示异常 | 注入的看板标题含 Pool 段,被截断在模型名中间("deepseek/deeps");后续几次用户看到的是**模型转述**(模型把表格改写成列表) | Pool 移出标题(标题固定计数),Pool 在表格下方完整显示;`/bg` 模板加"原样转达,不改写格式、不加 emoji" |
| 2. `/bg 分析图片` 没调 bg_spawn | 模板说"图片无法作为附件传子会话",主模型有视觉能力直接自己看;`bg_spawn` 无传图通道——功能缺口 | `bg_spawn` 图片跟随:执行时从父会话最近用户消息提取图片注入 `LaunchInput.parts`(复用 `extractImageParts`,cap `MAX_IMAGES_PER_BATCH`);模板文案更新;子会话保留 `vision_look` |
| 3. `/split status` 形态不符 | SPLIT RUN 看板**完整注入过多次**(8 subtasks/5 waves 状态流转正常),用户看到的带 emoji 列表是模型转述 | `/split` 模板加"原样转达,保留分层与依赖标注,不加 emoji、不合并行" |

新增测试:`tests/bg-templates.test.ts`(模板文案 + `collectLatestUserImages` 纯函数);visualizer 标题/Pool 断言更新。

复验:`bun test` 320 pass / 0 fail,typecheck 0 错误,build 155.75 KB。

## 问题 2 二次修复(2026-08-28,会话 ses_fb868779 取证)

用户在新版插件下复测 `/bg 分析图片`(16:58 会话,模板已是新文案,确认 build 生效)仍不调 bg_spawn。取证:

- 模型 **deepseek-v4-flash(无视觉能力)**
- 消息流:新版 /bg 模板(要调 bg_spawn)→ 图片附件 → opencode 对无视觉模型报错 → **chat-message 的 `[prism vision]` 提醒注入(消息尾部,注意力最高)** 引导 vision_look → 模型选择 vision_look 同步解读,放弃 bg_spawn

**根因**:修复只解决了"调 bg_spawn 时能传图",没解决"模型在 /bg 回合被 vision 提醒带偏"。消息尾部的提醒指令压过了 system 区的模板指令(与 chat-message.ts:8-13 记录的注意力稀释教训一致)。

**修复**:
- `chat-message.ts`:检测命令回合(parts 含 "你在处理 Prism 的 /bg 命令" / "/split 命令" 模板标记),注入**命令专用提醒**替代默认 vision 提醒——引导 bg_spawn / split_task,明确"不要用 vision_look 同步解读"
- `/bg`、`/split` 模板各加"图片任务必须后台/拆分执行,不要用 vision_look 同步解读"

新增测试:vision.test.ts 两个命令回合用例(bg/split 提醒注入、不含 vision_look 引导)。

复验:`bun test` 322 pass / 0 fail,typecheck 0 错误,build 157.50 KB。

## /split status 展示优化(2026-08-28,用户实测反馈)

用户实测展示的 7 subtasks / 3 waves 看板暴露三个问题:①波头 39 字重复 3 次(行宽 100+,TUI 折行);②每行 `<- 无依赖` 冗余;③`+` 续行前缀在模型转述时被改写成 `-`。

修复(split/visualizer.ts):波头精简为 `Wave 1:` / `Wave N (依赖前一波,依赖满足即启动)`(保留 ASAP 语义,不声称整波屏障);无依赖不显示依赖段;层内统一 `[id]` 两空格缩进,去掉 `+` 续行标记。测试同步更新(+1 断言)。

复验:`bun test` 322 pass / 0 fail,typecheck 0 错误,build 157.28 KB。

## 结论

代码级验证(单测/typecheck/build)全部通过;新会话审查缺陷已全部修复;真实环境 6 项待 TUI 人工验证后提交。

## 审查修复轮(2026-08-28,严格代码审查后的 P0-P3 修复)

独立审查发现 2 P1 / 5 P2 / 4 P3,全部修复:

| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| 1 | P1 | `collectLatestUserImages` 的 continue 会跳过无图的较新用户消息、抓到更早消息的旧图——autoTrigger 下模型自主 bg_spawn 时旧图被静默注入无关子任务 | 改为严格只看最后一条用户消息、无图即止;bg 模板补"基于早前消息的图片须把路径写进 prompt" |
| 2 | P1 | `sanitizeCell` 只剥 ESC 字节,`\x1b[31m` 残留 `[31m`(实测确认),既占列宽又像损坏文本;且正则内嵌字面控制字节(NUL/0x1F)易被工具链改坏 | ANSI CSI 整序列剥离 + 裸 ESC 由控制字符剥离兜底;范围改 `\u0000-\u001f\u007f` 转义书写 |
| 3 | P2 | `run.done` reject 时 registry 条目永不 settled → prune 永不回收,进程生命周期内泄漏 | settle 在 fulfill/reject 双路径落盘 |
| 4 | P2 | `/split` 图片提醒暗示"图片自动跟随"(实际 split 链路无图片通道),无视觉模型会放弃写路径 | 提醒改为"把图片的本地路径/URL 写进 task 描述" |
| 5 | P2 | `bg_spawn` 图片跟随未按 `vision.enabled` 门控:视觉完全关闭时子会话没有 vision_look,附加图片成死附件 | vision 关闭时跳过抓图(对齐不变量 #6) |
| 6 | P2 | `/bg status --al` 等敲错的 status 变体会穿透成任务描述被 spawn 成新任务 | status/list 前缀命中但变体未识别时给用法提示(bg + split 两处) |
| 7 | P3 | `width.ts` clusterWidth 注释为 `\uXXXX` 转义乱码;`renderBgDashboard` --all 分支重复;`(?:cancel)` 冗余;表头宽度用 `header.length` 而非宽度引擎 | 注释重写;分支合并;正则精简;`getStringWidth(header)` |

验证:

- `bun run typecheck` → 0 错误
- `bun test` → **337 pass / 0 fail / 730 expect**(审查前基线 335;新增:ANSI 残留断言、旧图不跟随、结尾 assistant 跳过、status 变体用法提示 ×3 命令、旧图路径指引模板断言;改写:scans-backwards 用例反转为新语义)
- `bun run build` → index.js 164.1 KB
- 沙箱冒烟(`scripts/qa/sandbox-run.sh`):插件在真实 opencode 会话加载无错误,日志仅含预期配置信息
- 源文件控制字节复查:`visualizer.ts`、`bg-visualizer.test.ts` 均为 0 字面控制字节

真实环境待人工验证项(沿用上文 6 项,新增 2 项):

7. `/bg 分析这张图` 传图后,同一后台任务内 `bg_send` 多轮追问仍能继续读图(不重新传图,子会话上下文延续)
8. `/bg status --al`(错误变体)显示用法提示,且不再 spawn 描述为 "status --al" 的任务

## 独立审查会话复审轮(2026-08-28,干净上下文子代理审查)

新会话审查结论:首轮 7 项修复全部 PASS,无 P0/P1;新发现 1 P2 + 4 P3,已修复:

| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| R2-1 | P2 | `bg_spawn` 拉取父会话消息:未传 `query.directory`(仓库内其余 3 处 `session.messages` 均传),且按不变量 #7 用 try/catch 只能捕获 throw、`{ error }` 形态的失败被静默吞掉,降级路径零日志 | opts 增加 `directory`(index.ts 传入);改用 `errorInfoFromResult` 判错 + 降级 log(对齐"降级路径必须 log") |
| R2-2 | P3 | `bg_spawn` 工具描述仍写"子会话收不到附件",与自动传图行为自相矛盾(autoTrigger 下模型主要读工具描述) | 文案改为:当前消息附件自动传图;本地文件/早前消息的图片写路径 |
| R2-3 | P3 | ANSI 剥离只覆盖 SGR 型 CSI:`ESC[?25h`(私有参数)残留 `"[?25h"`、`ESC]0;title BEL`(OSC)残留 | CSI 参数集放宽 `[0-9;?<>=]`;新增 OSC 整序列剥离(BEL/ST 终止);实测三种家族均无残留 |
| R2-4 | P3 | split 看板把 `LAUNCH_FAILED` 哨兵渲染成"上游 launch-failed 失败"(像存在一个叫 launch-failed 的 plan);`renderRunDetails` docstring 写 `/split output sp_xxx`(实际路由是 status);split argumentHint 缺 status 变体 | 哨兵改渲染"启动失败(未能创建后台任务)"(scheduler 导出常量);docstring 修正;argumentHint 补 `status [--all] \| status <run_id>` |

验证:`bun run typecheck` 0 错误;`bun test` **339 pass / 0 fail / 737 expect**(+2:OSC/私有 CSI 剥离、LAUNCH_FAILED 文案);`bun run build` 165.1 KB;沙箱冒烟复验通过(插件在真实 opencode 会话加载无错误)。

`sliceChars` 对 ZWJ 序列可能截半簇(仅影响非对齐的结果预览行,纯外观)记录为已知取舍,未修。
