# dsh-lark · DeepSeek Harness 飞书 / Lark 插件

[![npm](https://img.shields.io/npm/v/dsh-lark-channel)](https://www.npmjs.com/package/dsh-lark-channel) [![CI](https://github.com/omdsh-dev/dsh-lark/actions/workflows/ci.yml/badge.svg)](https://github.com/omdsh-dev/dsh-lark/actions/workflows/ci.yml) [![license](https://img.shields.io/badge/license-BSD--3--Clause-blue)](LICENSE)

简体中文 | [English](README.en.md)

**把你正在使用的 DeepSeek Harness（DSH）接进飞书。**

直接在聊天里给 Agent 派任务、看执行过程、切换工作区和模型。遇到提问、计划确认或工具审批，也不用回到终端，直接在飞书里处理。需要时，还能把多个 Agent 放进同一个群里协作。

## 快速开始

```sh
npm i -g dsh-lark-channel
dsh-lark-channel start
```

终端会显示二维码。用飞书扫码完成应用创建，然后私聊机器人，或在群里 @ 它即可开始。

启动命令会在首次安装依赖前写好 profile 的 pnpm 构建策略：未经批准的依赖构建脚本一律警告并跳过，而不是让安装失败；`protobufjs` 那个只打印提示的 postinstall 还会被按名字记为跳过。因此不需要手工执行 `pnpm approve-builds`。

不想装到全局也可以直接跑，只是之后每条命令都要带 `npx`：

```sh
npx dsh-lark-channel@latest start
```

如果还没有安装 DeepSeek Harness，先运行：

```sh
npm i -g @deepseek-ai/dsh
```

无需公网服务器，也无需配置回调地址。

## 为什么值得装

- **不用守着终端**：从飞书发起任务，随时查看进度和结果。
- **不只是聊天机器人**：可以切换真实工作区和模型，执行 Harness 已有的命令与工具。
- **关键决定仍由你控制**：模型提问、计划审阅和工具审批都会回到当前聊天，按钮或文字都能作答。
- **上下文不会混在一起**：不同聊天、话题和工作区可以保留各自的会话。
- **Agent 之间也能协作**：一条命令添加更多机器人，让它们在群聊中通过 @ 交接回合，并用轮数上限防止无限对话。

## 可以这样开始

先看看当前状态和可用工作区：

```text
/status
/ws
/cd my-project
/model
```

然后直接派一个任务：

```text
检查这个项目为什么构建失败。先给我计划，需要操作时让我确认。
```

Agent 的执行过程会显示在飞书中；需要你参与时，会发送提问、计划或审批卡片。渠道自带文案会按每位读者的飞书语言显示中文或英文。

## 主要能力

| 能力 | 使用体验 |
|---|---|
| 持久会话 | 重启后可以恢复；后续消息继续当前上下文，`/new` 可以原地重开一个 |
| 多工作区 | `/ws` 查看、`/cd` 切换；回到原工作区时继续之前的任务 |
| 模型切换 | `/model` 打开模型选择卡片；切换后保留当前会话，也可随时恢复默认模型 |
| 原生执行过程 | 在飞书中查看推理、工具调用和结果，最终答案单独发送 |
| 人机协作卡片 | 单选、多选或文字回答问题；批准计划或提出修改意见；允许或拒绝工具调用 |
| 权限预设 | `/permission` 打开预设卡片，写明每个预设能碰到什么、会不会弹审批；放开沙箱需要审批人权限，切回更安全的预设不需要 |
| 实时状态 | `/status` 展示工作区、模型、session 和当前权限预设；可用时还显示上下文占用与累计 token，并支持刷新 |
| 会话隔离 | 可按聊天、话题或群成员划分独立 Agent 会话 |
| 多 Agent 协作 | 多个机器人拥有独立设置、凭据和 session，可以在同一个群里对话与交接任务 |
| 斜杠命令 | 宿主自带的命令（`/plan`、`/compact` 等）直接进入 DSH 命令运行时 |
| 文件收发 | 人发文件进聊天，agent 在工作区里读；agent 的产物发回聊天，群聊里先弹审批卡 |

## 常用命令

| 命令 | 用途 |
|---|---|
| `/status` | 查看并刷新工作区、模型和 session；可用时包含上下文与 token 状态 |
| `/ws` | 查看可用工作区 |
| `/cd <名称或路径>` | 切换工作区 |
| `/get <路径>` | 把工作区里的文件发到聊天 |
| `/put <路径> [--into <文档链接>]` | 把工作区产物新建为飞书文档，或追加到指定文档 |
| `/model` | 打开模型选择卡片 |
| `/model use <provider/model>` | 直接切换模型 |
| `/model reset` | 恢复默认模型 |
| `/permission` | 打开权限预设卡片 |
| `/permission <预设名>` | 直接切换权限预设 |
| `/doc list` | 查看当前打开的文档评论会话（仅应用注册者私聊可用） |
| `/doc reset <文档链接>` | 重置一篇文档的评论上下文（仅应用注册者私聊可用） |
| `/new` | 原地开一个新会话，清空上下文，工作区和模型保持不变 |
| `/stop` | 停止当前任务 |
| `/help` | 查看全部命令（含宿主提供的） |

## 日常运行

macOS 和采用 systemd 的 Linux 会使用用户级后台服务，关闭终端后仍可运行：

```sh
dsh-lark-channel status
dsh-lark-channel logs -f
dsh-lark-channel restart
dsh-lark-channel stop
```

用 `npx` 启动的话，这些命令同样要带 `npx dsh-lark-channel@latest` 前缀——工具会按你实际的启动方式打印提示，读到什么就能直接粘贴。

升级：

```sh
dsh-lark-channel upgrade
```

它会装上最新的 CLI 并在新版本上重启机器人。用 npx 的话不需要这一步，`npx dsh-lark-channel@latest start` 本来就是最新。有新版本时，`start` 和 `status` 会顺带提醒你一行。

连接异常时，插件会在限额和退避控制下自动重建 WebSocket，避免进程仍在但机器人已经静默离线。

### 添加更多 Agent

给第二个飞书应用添加一套独立的 Agent：

```sh
dsh-lark-channel add reviewer
```

命令会写入新实例、重启服务并显示二维码。扫码后，这个机器人拥有自己的设置、App Secret 和 session，不会与第一个机器人共享上下文。

把两个机器人加入同一个群后，它们可以通过 @ 把回合交给对方。例如，让一个 Agent 完成修改后 @ 另一个 Agent 复核，后者也可以 @ 回去要求调整。默认最多连续进行 6 个机器人轮次；任何人发言都会恢复额度。需要移除时：

```sh
dsh-lark-channel remove reviewer
```

移除会保留该实例的凭据和设置，之后用同一个名字重新添加即可恢复。

如果希望飞书和 `dsh web` 共用同一个 profile：

```sh
dsh plugin --profile web add dsh-lark-channel@latest
dsh web
```

<details>
<summary>权限与高级选项</summary>

- 飞书应用的可用范围决定谁能找到机器人；`senderAllowlist`、`groupAllowlist` 和 `approvers` 可以进一步收窄权限。
- `workspaceRoots` 可以限制聊天中允许切换到的目录。
- `sessionScope` 支持 `chat`、`chat-thread` 和 `chat-sender` 三种会话粒度。
- `instance` 用于命名额外的机器人实例；第一个机器人保持未命名，以兼容已有设置和会话。
- `botPeers` 可以限制允许对话的机器人，`botHops` 控制连续机器人轮次，默认是 6。
- 会改变状态的卡片绑定原聊天，转发到其他聊天后不能操作原会话。
- 部署提供 credentials 服务时，扫码得到的 App Secret 会存入其中；旧版本写在 settings 中的 secret 会在下次启动时自动迁移。
- 图片附件默认关闭；只有确认当前模型支持视觉时，才应开启 `attachImages`。
- `receiveFiles` 默认开：入站文件落在当前会话工作区的 `.dsh-lark/inbox/<时间戳>-<消息哈希>/` 下，只增不删，清理是你的决定；首次落地时会提醒把 `.dsh-lark/` 加进 `.gitignore`，但不会替你去改这个文件。
- `sendFiles` 默认开：私聊直接发，群聊每次弹审批卡片，卡片上是文件在工作区内的位置、工作区名和大小（不是宿主的绝对路径——群里每个人都会看到它）；**没有关闭群聊审批的开关**，因为那会是提示注入外泄链的官方后门。
- 出站文件的路径一律只说“工作区内的相对位置”，宿主绝对前缀不会出现在任何一句给人或给模型看的话里——包括读取失败时文件系统自己的报错（`/get` 的回复和 `send_file` 给模型的报错）。失败分支恰恰是提示注入能主动触发的那条。
- 一个群同时最多有 3 个持有内容的 Agent 出站操作，`send_file` 与 `send_doc` 共用这个额度：审批前要先冻结实际发送内容，所以数量必须有上限。第 4 次会在读取内容前被拒绝并告诉模型等前面几个先有结果。这个数字不可配置，调大等于同时买回内存风险和审批疲劳。
- 渠道不再自动读取云文档正文或落盘快照；聊天与评论中的文档链接只作为指针交给 Agent，需要内容时由 Agent 自己通过 lark-cli 读取。
- `sendDocs` 默认开：Agent 可用 `send_doc` 把工作区 Markdown 产物新建为飞书文档；私聊新建后只加发起人，群聊新建必须先审批、允许后才创建并加当前群。模型侧不再接受 `into`；人明确输入的 `/put --into <链接>` 仍可追加，且不会改变目标文档的原有权限。
- 新建文档成功但添加协作者失败时，渠道仍会回真实链接，并说明这篇文档只有机器人能打开、你无法自行共享它（共享的前提是先能打开），可在权限恢复后用工作区里同样的内容重新发布；文档 token 同时写入操作台，这是运维处理“谁都打不开的文档”的唯一入口。不会把已经存在的文档伪装成完全成功或完全失败。
- 一轮被中途取消时，已经写进飞书的内容不会被说成失败：渠道照实回链接，并注明“这一轮已取消，但写入已经生效，不要重发”，同时写入操作台。请求还在路上时被取消，则明说平台是否已生效未知、重发前请先确认。把已生效的追加报成失败，人就会重发，同一段内容会被追加两遍。
- 模型可见的文档能力只剩 `send_doc` 的“写”一档，启动时通过 `application.v6.scope.list` 探测；探测被拒、超时或 scope 名单未实测时保持乐观可用，真实 `permission_violations` 才会纠偏。`commentDocs` 是评论会话面开关，不是模型工具能力档。
- 真实文档调用若返回 `permission_violations`，下一次 Agent 创建时会收起对应工具。`docAuthorizeOnDemand` 默认开：授权链接优先私聊发给扫码注册者；授权请求同时携带精确缺失 scope 与 `drive.notice.comment_add_v1` 事件订阅。没有注册者记录时才退回原聊天，并明确警示该链接可以修改应用配置。扫码后会重新探测，`addons` 未灰度或权限仍在审批时只报告“权限未变化”，不会声称授权成功。
- `commentDocs` 默认开：文档评论中有人 @ 机器人时，渠道按文档派生会话，把引文、提问、文档链接和不可信数据提示合成入站消息，并把终态回复写回触发线程。首次开会话会私聊通知注册者，公开可见文档会附风险提醒；最多保持 100 篇活跃文档，超出后释放最久未用的 Agent，但不删除持久会话。评论会话面不给模型注册任何文档读写工具：要读内容 Agent 自己用 lark-cli，那一条终态回复就是回到线程的唯一出口；超过 10000 个 Unicode code point 的回复会在发送前截断并带可见说明。
- 应用注册者可在与机器人的私聊中用 `/doc list` 查看当前文档评论会话，用 `/doc reset <文档链接>` 重置一篇文档的上下文；重置代数经 settings 持久化，插件重启后不会恢复旧上下文。群聊和其他用户不能读取或重置这份全局清单。`/status` 会显示评论事件最近到达时间，从未收到时直接提示检查事件订阅。
- 审批结束卡会记录决定人：回调未带姓名时，渠道会尽力从当前聊天成员名单解析；没有成员查询权限、查询失败或成员已不在群内时仍安全显示 open_id，绝不会影响审批或文件发送。
- 单文件上限默认 20 MiB，收发分别由 `maxReceiveFileBytes` / `maxSendFileBytes` 配置；文档类产物（pdf / xlsx / docx）在聊天里只能下载、没有在线预览，这是上游 SDK 把普通文件固定按 `stream` 类型上传带来的已知取舍。
- 语音消息只落盘，不会被转写成文字。
- 配置在启动时读取，修改后需要重启服务。

</details>

## 环境要求

- Node.js `^22.19.0 || >=24`
- DeepSeek Harness `0.1.0-rc.6` 或更新版本
- 飞书或 Lark 租户

原生思考过程需要飞书 PC 7.70、移动端 7.74 或更新版本；旧客户端可以使用 `output: 'stream'`。

## 开发

```sh
pnpm install
pnpm test
pnpm build
```

## License

[BSD-3-Clause](LICENSE)

本项目是非官方社区插件，与 DeepSeek、飞书或 Lark 不存在隶属、授权或背书关系。
