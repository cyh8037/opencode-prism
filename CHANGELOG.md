# Changelog

本文件记录每个发布版本中**用户可感知**的变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.2.0-beta.0] - 2026-08-22

### 破坏性变更

- **移除 tmux pane 可视化**：整个 tmux 模块（pane 生命周期、attach 命令、布局）及相关 `tmux` 配置节。旧配置中的 `tmux` 节会被静默忽略，无需迁移。子任务可见性改为 toast + 完成通知 + `/bg output <id> --full` 的 `opencode attach` 提示。
- **移除 `vision.chatImages` 配置**：对话贴图不再自动解读（原机制依赖实验性 `messages.transform` hook，且解读结果不落会话历史）。改为手动路径——`vision_look` 工具与新增的 `/vision` 命令，结果均持久化在会话历史中。旧配置中的 `chatImages` 会被静默忽略。
- **对话贴图自动解读改为手动**：纯文本主模型收到用户贴图时，由主模型调用 `vision_look(images: ["last"], goal: ...)` 解读，或用户直接 `/vision last`。

### 新增

- **`vision_look` 支持 `goal` 关注点与 `"last"` 哨兵**：goal 让解读只回答关注点相关内容（信噪比更高、占用上下文更少）；`"last"` 表示"本会话最近的一张图片"，解决纯文本主模型无法引用贴图 URL 的问题。
- **`/vision` 命令**：`/vision <路径/URL ... | last> [--goal <关注点>]`，插件原生执行，解读结果直接注入对话。
- **`/bg resume <task_id> <追问>`**：在已结束任务的子会话里继续追问，保留其上下文，无需重新启动任务。

### 修复与改进

- **安全**：图片 URL 仅允许 http(s) 协议经 fetch 获取（拒绝 `file://` 等——Bun 的 fetch 会直接读取本地文件，构成任意文件读取面）；`data:` URL 纳入 8MB 上限与魔数校验，声称的 mime 不再被信任。
- **JSONC 配置解析**：修复字符串值含 `, ]` / `, }` 时被尾逗号剥离逻辑静默破坏的问题。
- **后台任务**：排队超 30 分钟自动取消，**运行中**超时只告警不取消（长任务不再被误杀）；任务结果改为全部 assistant 文本按序拼接（上限 20k，多轮子会话的中间结论不再丢失）；汇总通知投递失败自动重试一次。
- **/split**：上游子任务失败时，依赖它的下游级联标记 `SKIPPED`（不再基于空结果继续执行），汇总报告展示跳过原因。
- **视觉解读超时治理**：单次解读超时降为 60s，且超时不再触发第二次重试（最坏阻塞从 240s 降至 60s）。
- **跨平台**：Windows 日志路径改用 `%APPDATA%`；`.\relative.png` 反斜杠相对路径可识别；日志文件超 10MB 自动轮转。
- **其他**：`/bg output --full` 的 attach 提示在服务端启用密码认证时附加说明；删除大量历史遗留死代码（provider 优先级链、chat.message hook、孤儿类型等）。

## [0.1.0-beta.0] - 2026-08-13

首个 beta。

- 视觉自动解读：工具输出图片附件自动解读并追加；对话贴图两阶段注入（`messages.transform`）
- 后台并行引擎：`/bg` 命令 + `bg_spawn/bg_output/bg_cancel` 工具，按 provider/model 并发信号量、toast 进度、会话内汇总通知
- `/split` 任务拆分：规划器产出依赖图（DAG），按层并发调度
- tmux pane 可视化：每个后台任务一个 pane，实时显示子 agent TUI
- PromptGate 内部消息注入闸门：按会话预留、同文本去重、忙时等待 settle
