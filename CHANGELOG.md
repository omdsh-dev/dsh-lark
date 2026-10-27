# Changelog

## Unreleased — 2026-10-19

适配 DSH 0.2.1-rc.2：宿主移除了运行时 invariant 注册表，凭据存储改为优先于环境变量，`working_directory` 让会话的执行目录可以中途改变。

### Changed
- **对齐 0.2.1 的依赖与兼容声明。** 11 个 `@deepseek-ai/dsh-*` 开发依赖升到 `0.2.1-rc.2`，`@deepseek-ai/cordis` 升到 `^4.0.5`，`@deepseek-ai/cordis-plugin-loader` 升到 `^1.0.6`；`package.json` 新增 `engines.dsh: ^0.2.1-rc.2`——宿主自 0.2.1 起以它作为唯一的兼容判据，而本包此前既无 `engines.dsh` 也无 DSH peer，任何版本都会被静默放行。
- **`@deepseek-ai/schemastery` 改为精确钉 `3.18.1`。** 3.18.3 起，同一个 `meta.volatile` 元数据在**解析**时也会把字段变成引用单元（DSH 自己的包用 `.get()` 读的那种），`config.appId` 不再返回字符串，凭据检查随即失败并转入扫码流程——测试与线上都会如此。本包只借这个元数据让宿主的 settings 能写入这些字段，值必须保持原样，所以钉死版本而不是放宽范围；改用引用形态是一次涉及这七个字段每一处读取的迁移，另作安排。
- **删除 invariant 伴随插件。** 0.2.1 移除了 `@deepseek-ai/dsh-invariants`、`ctx.invariants` 服务以及所有 `<pkg>/invariant` 子路径；`src/invariant.ts`、`./invariant` 导出、两处构建入口、`lib/invariant.js`、相关测试与 README 产物清单同步删除，`cordis.patch.yml` 里那段"诊断组合可以加一行"的注释改为说明它已不存在。
- **`/stop` 改传结构化取消原因。** 宿主按 `kind` 读取取消原因来写 `turn/end`，此前传字符串 `'user'` 会在记录原因时抛 `unreachable variant`；现在传 `{ kind: 'user' }`。
- **计划评审的"仅计划模式"守卫改读服务自身状态。** 此前从会话日志折叠 `plan/mode`，而 `Session` 从来没有 `events` 成员，守卫从未生效；现在读 `planMode.get(agent)`（宿主 0.2.1 公开的读法），服务只发布 `set` 时仍然放行而不是拒绝。
- **连接日志写明密钥来源。** 宿主的凭据存储优先于环境变量，所以"扫码存过、环境变量还导出着"的部署连的是存储里那份；日志现在显示「来自凭据存储」或「来自环境变量」，不再只报引用名。
- **`headless` profile 不再被当成已引导。** 0.2.1 的 headless 不读凭据存储，`isOnboarded` 却无条件读 `.credentials.yaml`，于是报告"已引导"并启动一个认证不上的服务；现在按 profile 判断，headless 只认环境变量对。
- **文档**：`denyTools` 的说明补上 `working_directory`——会话沙箱是本会话被绑定的目录，该工具移动的是执行目录，而 `/cd`、会话选择器和 `send_file` 仍按绑定的目录解析；想保持两者一致就把它列进 `denyTools`（默认不变）。

### Known limitations
- 计划评审的守卫对只发布 `set` 的旧宿主仍然放行：服务答不出状态时不拒绝，是刻意保留的宽容。
- `working_directory` 默认不拦：跟随宿主自己的 workspace 分组，还是钉住绑定的目录，留给部署决定。

## Unreleased — 2026-10-11

第三轮复检后逐条收口的修复：一条 Windows 回归、一条资源边界、一条授权口径，以及若干低危尾巴。

### Fixed
- **`approvers` 现在也管计划审批卡。** 批准一份计划会离开规划模式并开始执行，属于一次授权而不是一次回答；此前提问卡的点击只校验"来自卡片所属聊天"，`approvers` 只作用于审批卡，于是 `approvers: [alice]` 的部署里任何能驱动该会话的成员都能按"批准"把计划放行。提问存储新增 `requiresApprover`（只有计划审批传 true），点击时向渠道问一次同一份名单；普通提问不受影响——它不授予任何东西，仍是"这个聊天服务到的人都能答"。
- **群聊 `/get` 与模型的 `send_file` 共用同一份额度。** "每群最多 3 个待决文件"此前只在模型那条路上生效，人类 `/get` 可以连续发起、堆出任意多张待决卡，每张都把整个文件（默认上限 20 MiB）留在内存里直到有人决定或 30 分钟超时。现在群聊 `/get` 在读文件**之前**先占额度，占不到就回一句"先决定完再发"，并在审批结束时释放（与 `deliverFile` 同一套记账）。
- **群聊 `/get` 的审批卡与文件发往敲命令的那个群。** 此前用"会话绑定的聊天"，两个群通过 `/sessions` 收养同一个会话、后者覆盖绑定时，A 群敲的 `/get` 会把文件发到 B 群并由 B 群批准。现在以消息自己的聊天为准。
- **Windows 上 `upgrade` 不再必坏。** 上一轮把 `shell: true` 去掉后，判据仍是"传入的命令字符串是否是 `.cmd`/`.bat`"，而 `upgrade()` 传的是裸名 `npm` / `dsh-lark-channel`——裸名不经 `cmd.exe` 直接 `ENOENT`（`start`/`stop`/`restart` 因为走 `whichSync` 拿到带后缀的绝对路径而不受影响）。现在先在 PATH 上解析出这个命令实际指向的文件，再按文件判垫片；`whichSync` 也接受平台参数，解析规则与测试都可注入。
- **`isOnboarded` 读现代宿主的落点。** 此前只读 `<DSH_HOME>/settings.yaml`，而现代宿主首启就把该文件改名 `settings.yaml.imported` 并把段落导入 profile、此后写入落 profile 的 patch——命名实例扫码成功后仍会打印"还在等扫码"并空等满十分钟。现在同时读：旧的 settings 文档与它的 `.imported` 副本（按 row 的 section 名）、文件式凭据提供者的 `.credentials.yaml`（按该 row 独有的引用名）、以及 profile patch 里**该 row 自己那一条操作**（精确匹配 entry id，兄弟行的密钥不会被当成这一行的）。
- **问题卡重试分支也会重绘已结算的卡。** 首次发送失败后的重试此前跳过了"发送途中已结算就立刻重绘"的检查，于是慢速重试期间被结算的提问会留下一张仍在邀请按下的新卡。残留一条已知限制：首次 `send` 若"卡已渲染但 promise 拒绝"，存储拿不到那张卡的 id，无法重绘它——重试仍是更划算的取舍（偶发重复卡胜过一次没人被问到的提问），这一点写在字段说明里。
- **`cot` 的 drain 收尾接上 `.catch`**：`void settled.finally(...)` 的 rejection 此前无人接管（`outbound.ts` 里同一写法已修），一次失败的思考过程写入会变成进程级未处理拒绝。
- **凭据轮换监听盯的是实际使用的引用**：此前固定监听身份自带的 `LARK_APP_SECRET`，而密钥实际按 `resolved.appSecretRef ?? identity.secretRef` 解析——配了自定义 `appSecretRef` 的部署轮换时静默。
- **`loosensSandbox` 先查部署表的名字再 `resolve`**：`resolve` 从记录里取键，原型链上的名字（`constructor` 之类）也能"解析成功"且没有旋钮，于是被判成"不放宽"而跳过审批人。宿主命令层本来就会拒绝这些名字，所以此前不可利用；现在这道门与那条命令问的是同一个问题。
- **`cot` 的 `boundResult` 按码点切分**（`cards.ts` 的 `clip` 上一轮已改）：此前会把代理对劈成半个字符，并把一个 emoji 记成两个"已截断字符"。
- **卡片上的决定人名字限长 64 码点**：名字来自平台回调或聊天名册，长度不由本渠道决定；与 `bridge.ts` 解析名字时的裁剪保持一致，属纵深防御。
- **每键状态都有上限**：`hintedWorkspaces`、`reportedBots` 到上限即清空（最坏是重复一次提示，绝不会给出错误答案），工作区查询缓存按插入顺序淘汰最旧一条（代价是一次重新解析）；会话阶梯的 epoch 与绑定的 generation 在"没有任何在飞的走查"之后删除，不再随每个换过目录/换过会话的对话永久增长。
- **`removeBot` 也校验实例名**（`addBot` 一直校验）：这个名字决定 patch 里哪一行被改动。
- **`HostSettingsDescriptor` 声明 `user`**：`settings-store` 一直在结构化读它（宿主确实发布该字段），窄接口里却没有这一项。

### Added
- **`windowsCommandLine` / `resolveOperatorCommand` 的单元测试**（含每个 `cmd.exe` 元字符都必须被拒绝、裸名按 PATH 解析、路径按原样保留），补上这条路径此前没有任何用例的空档——它正是上一轮 Windows 回归发生的地方。
- **CI 增加 `pnpm build`**：发布产物由 release workflow 的 `prepare` 生成，此前没有任何一步构建过它们，打包或声明回归要到发版才暴露。
- **测试钉住本轮的行为**：`approvers` 门（普通提问仍开放）、重试期间结算的重绘、群聊 `/get` 的额度（含释放后可再次发起）、以及 `isOnboarded` 的三种现代落点与"只认自己那一条操作"的精确性。

### Known limitations
- 仓库仍没有 lint/格式化配置（历史上从未有过）；本轮补了 Windows 命令行解析的单测，但引入哪套 linter、开哪些规则属于维护者决策，没有代为决定。
- 群聊 `/get` 的额度是按"聊天"记的，与模型侧共享：一个群同时有模型发起的文件待批时，人类 `/get` 也会被同一份额度挡住——这正是"每群待决文件总量"的本意。

## Unreleased — 2026-10-07

一次针对"不安全、不规范"的全量复查后的修复：安全边界、宿主契约、跨平台与健壮性。

### Fixed
- **网页提问面板不再把上一批的答案交回给这一批。** 面板此前只认事件窗口里**最新一次**留下成功结果的 `ask_user_question` 调用，而且只要窗口里有一条这样的结算、当前又摆着任何一张卡，就把那条结算的答案原样 `answer()` 回去——既不看它问的是不是这一批。于是出现过：日志里 `scope/depth/format` 的提问收到了上一批 `dir/scope/ui`（目录名/范围/UI 库）的答案，模型只能自己发现"答案串了"再重问一次；另一次 4 个答案被交回给一个只问了 2 个问题的调用。现在折叠报出窗口里**每一次**已结算的调用，每条都带着它当时问的问题（题数、id、题干、标题、选项标签顺序、是否多选），面板只退休与**当前这批问题完全一致**的那一条，最新的匹配胜出。按新旧认不行——阻塞式请求不带调用 id，而模型会跨批次复用 id；一次都没匹配上就什么都不退休，面板照旧等按键，而且不消耗这次挂载的退休机会。飞书那半边同类：`settleElsewhere` 现在只结算**本批次自己开出的卡**（`ChatQuestionBatch.questionIds`），不再按问题 id 在整个会话的待答卡里找——那同样会把上一批的卡用这一批的答案结掉。
- **在飞书答完后，网页上的提问真的会退场。** 收回网页那份拷贝是宿主的空白（网关只在自己客户端回复或请求生命周期结束时结清转发的请求），插件这一半此前只做两件事：把结算记进 fold、把记录的答案 `answer()` 回去——后者失败时被 `.catch(() => {})` 吞掉，而"退休"是一次性的（`retired.current` 在提交前就置位），一次失败或一次认错批次之后就再没有第二次机会，于是那张卡一直摆在 composer 里；如果那次结算不是这一批的，面板还会把别人的答案当成"已在别处作答"的记录显示出来。现在：只在匹配到本批次的结算时才置位并提交；提交本身就是退场（宿主早已结清，答案在那边被丢弃，本地却因此收回卡片）；卡片自己的通道已不接受作答时退回卡片提供的关闭动作；两者都拒绝就在面板上写明原因，而不是继续摆在那里像还在等人按。记录锁存的也改成**匹配到的那一批**的答案，不再是"窗口里最后一条结算"。
- **`/status` 会把"这个会话已被归档"说出来。** 这张卡片的承诺是"你的下一条消息会怎么跑"，而对一个归档会话，答案是拒绝。此前它只报 `running/idle/unbound/switched`，于是一个仍然持有活 agent 的归档会话被报成"空闲"——读者据此以为一切正常，实际上下一条消息会被宿主的归档门拒掉。现在归档集合被单独读成一行，与 activity 正交（归档不会拿走活 agent，门却会拒掉它的每一步），在网页端取消归档后随刷新消失；这一行与拒绝消息用的是同一句话，卡片不会承诺驱动路径随后拒绝的路线。
- **已经绑定（活 agent）的归档会话不再绕过拒绝。** 归档拒绝此前只写在会话阶梯的 `resume` 档，而这个聊天已经持有该会话 agent 时根本不走阶梯：`acquire` 直接把绑定交回去，消息照发，宿主归档门把回合结束成 `blocked`，聊天里既没有请求也没有回答。现在拒绝上移到阶梯的准入点，每一次取用（含绑定快路径）都先问一次；被拒的 id 既不 `lookup`、也不 `resume`、更不 `create`。
- **归档恰好在准入之后落地时，聊天拿到的是原因而不是沉默。** 这个竞态关不掉——归档可能发生在准入与第一步之间——所以 `turn/end` 为 `blocked` 且该会话此刻在归档集合里时，聊天会收到同一句说明。`blocked` 还有别的来源，因此只有归档集合能解释它时才开口，不猜别的成因。
- **装桥失败不再变成"哑巴"，也不再被误报成注册失败。** 传输连上之后如果安装处理器的过程中抛错，此前会留下一个**连着但没有任何处理器**的僵尸传输：每条消息都被吞掉，群里静悄悄，和"机器人掉线"完全一样，只有一行控制台日志。现在这一异常被捕获，报出真实原因**和调用栈**（进控制台与诊断文件），并**关闭**该传输；同时不再向外抛，所以正在 onboard 的调用方不会把它报成"应用注册失败"。
- **扫码注册成功后凭证不再丢。** onboarding 落盘时把 `{appId, appSecret, registeredBy}` 整包写进设置，而 `registeredBy` 不是这个 row 声明的字段；宿主会**整条拒绝**含未声明字段的补丁，于是刚拿到的 appId 一起丢了，控制台只剩"凭证仅本次进程有效"。现在落盘只发这个 row 自己的字段（appId / appSecret / appSecretRef），并且设置接缝自己也会**丢掉未声明字段并说明**，不再让一个多余字段把整包带走（schema 不可读时保持原样）。
- **来自未设置环境变量的非字符串值不再被当成密钥。** `appSecret` 与 `appId` 一样是配置边界的值：`!!js process.env.LARK_APP_SECRET` 在变量缺失时给到插件的不是 `undefined`，而旧判断只排除 `undefined` 与 `''`，于是这个值会被当作"内联密钥"返回（挡住凭据存储里真正的密钥），`migrateAppSecret` 甚至可能把它**写进凭据存储覆盖掉好密钥**。现在只有非空字符串才算配置了密钥，其余一律回落到引用。
- **没配 appId 时不再报"应用注册失败"。** 部署用 `appId: !!js process.env.LARK_APP_ID` 时，环境变量缺失会让这个值以**非字符串**（而不是 `undefined`）的形式到达插件；原来的判断只放过 `undefined` 与 `''`，于是把这个值原样交给了注册流程，官方 SDK 直接拒绝（`appId must be a non-empty string`）——本该出现的"扫码创建应用"变成了一句"应用注册失败"。现在只有非空字符串才算"配置了 appId"，其余情况一律按"没配置"进入扫码流程（`configuredAppId`，`OnboardingRun.appId` 也随之改为 `unknown`：它是配置边界的值，不是已经校验过的字符串）。
- **群聊 `/get` 现在和 `send_file` 走同一道门。** `/get` 与模型发文件的唯一区别是谁按下了发起，而群聊要防的是"文件进了这个房间"，不是"谁想让它进来"；同一个人批准自己的命令在群里不是形式，是那道边界本身。私聊照旧直接发。卡片点击落在群聊那条按聊天串行的事件通道上，所以在消息处理里等审批会死锁，群聊分支因此把发送交给 `spawn` 的独立任务。
- **提问卡片的点击必须来自卡片所属聊天。** 卡片可以被转发，而按钮负载跟着卡片走；会话、选项之外现在还要对上聊天，对不上就拒绝并在控制台说明。卡片 id 从可猜的自增计数改为 `q-<uuid>`，位置解析只接受规范十进制（`''` 与 `0x1` 不再被 `Number` 读成 0 和 1）。提交字段数与长度都有上限。
- **审批/文件审批的结算文案按自身键读取**（`Object.hasOwn`）：`'constructor'` 这类键此前会在原型链上找到东西，`?? 兜底` 因此永远不触发，卡片随后去读一个函数上的字段。
- **`fill()` 用函数替换 `%s`**：模型文本里的 `$&`、`` $` ``、`$'` 此前会被当成替换模式，把本渠道自己的文案改写掉。
- **卡片上所有来自模型的文本都有上限**：问题 600、选项标签 80、选项说明 200、标题 120、选项最多 20 个，超出部分写明截断或未显示。此前只有审批卡的命令与理由有上限，而平台会拒收超限卡片——卡片落不下去的提问会被答成空，模型读到的和"人拒绝了"一模一样。
- **`clip()` 按码点切割与计数**：此前按 UTF-16 码元切，会把代理对劈成半个字符，并把一个 emoji 记成两个"已截断字符"。
- **工作区标签同时按两种分隔符取尾部，且不再把根带进标签**：此前只按 `/` 切，Windows 路径会在群聊副标题里露出整条 `F:\...`（连同登录名）。
- **systemd unit 每个值都加引号，并转义 `%`**：`WorkingDirectory` 此前不带引号，路径里的空格会把这一行截断；`%` 是 systemd 的说明符前缀（`%i`/`%h`），不写成 `%%` 就会被替换成别的东西。换行无法在一行里表达，因此直接拒绝而不是静默拆成两行。
- **unit 文件以 `0o600` 创建**（而不是先写后 `chmod`）：文件可能带着 App Secret，默认权限会在写入与 `chmod` 之间留出一个所有本机用户都能读的窗口，进程若在中间死掉则是永久的。
- **Windows 不再用 `shell: true` 重新解释参数**：只有 `.cmd`/`.bat` 这类平台不会直接执行的垫片才交给 `cmd.exe`，且每个 token 单独加引号，含 `%`、`"`、`&`、`|` 等无法安全转义的字符直接拒绝（而不是拼成另一个路径或另一条命令）。
- **profile 名使用严格字符集**（字母数字开头，只含 `.`/`_`/`-`，长度 64）：这个名字会变成路径片段、unit 里的值和命令行 token，`patchPath`/`addBot`/`removeBot` 也一并校验，`remove` 不再绕过 `start` 的那道检查。
- **已 onboard 的 settings 段识别容忍缩进与引号**：只认列首未加引号的形式会让已经扫码完成的部署再走十分钟的扫码流程。
- **`logs` 只读日志尾部**（256 KiB）：此前整文件读进内存，一个长期运行、没被重启截断过的日志足以把这条诊断命令变成 OOM。
- **入站文件逐级创建目录，并在创建下一级之前证明上一级在 workspace 内**：`mkdir(recursive)` 会跟着链接把整条链建在链接指向的地方，事后证明无法撤销已经发生的事；失败时只清掉本次真正创建的那几级。
- **工作区比较改走 `isSamePath`**：这些路径都是规范形式，在大小写折叠的宿主上同一个目录有两种写法，`===` 会让 `/ws` 把默认目录列两遍。
- **图片附加失败的提示不再带宿主路径**：这句话会进模型上下文、在群里还会上屏。
- **`ownVersion()` 校验清单形状**并在缺失时明确报错，而不是在三次调用之后以 undefined 的形式炸开。
- **流式渲染的结算链不再留下未处理的 rejection**（`finally` 会把拒绝继续抛出去）。
- **托管状态字段标了 volatile**（工作区、模型、epoch、session 选择与凭据）：宿主只写 schema 标记为 volatile 的字段，没标记时它会拒绝写入，而渠道只在内存里记着、看上去却像成功了——`/cd`、`/model`、epoch、session 选择与扫码凭据现在真的写回宿主 settings。
- **App Secret 轮换会被察觉并报告**：订阅宿主的凭据事件、重新解析引用，但已经建好的连接仍然用它启动时拿到的那份 secret，所以换 secret 后要重启服务（已知限制，已写进 README）。
- **`prepare`/`prepack` 产物不再缺浏览器半边。** 这条链（Git 与 tarball 安装走它）此前只编 Host 声明、只打包三个服务端入口，于是发布包与源码安装里 `dsh.client` 指着一个并不存在的 `lib/client.js`，网页端的审批与提问面板在那里整块消失——而它正是这一版的主打。现在它先编 Client 面（声明与 JS；需要 jsx 与 DOM 库，Host 面不能有），再复用与 `pnpm build` 同一份浏览器半边契约打包，两条路径产出逐字节相同的 `lib/client.js`；README 源码安装一节里那句"不要用 `pnpm run prepare`"也随之改掉。打包测试改为逐条核对 `package.json` 声明的路径——旧断言拿打包后被重建的 `lib/` 自比，恒等，所以漏掉了这次缺件——并让 `pnpm pack` 在 Windows 上真的能起来。
- **没有写入路径的宿主会在控制台说明原因**：宿主按 Loader 行 id 写入而本部署没给这个插件命名行 id 时，说的是"缺少行 id"（操作者能据此修），而不是笼统地说宿主没有 settings 服务。

### Changed
- **`/new` 不再数数，改为当场铸一个新 id。** 此前"第几次重开"是一个计数器（`chatEpochs`），折进 id 成 `--e<N>`：计数器一旦没写进 settings（旧接缝在新宿主上静默失效就会这样），重启后回到 0，`/new` 于是又把 `--e1` 交出去——那是 10/5 用过、后来被归档的会话。宿主的归档门禁会拒掉它的每一个模型步，于是"新会话"既不新也不吭声。现在 `/new` 生成 `--s<8 位随机>`，按构造不可能是这个会话跑过的任何 id；"当前在哪个会话"改由一个按（会话 × 目录）的指针记录（复用 `chatSessions`），`/sessions` 写的是它，`/new` 写的也是它。`/cd` 不再清指针：每个目录各自记着自己上次接的会话，切回来还在（旧计数器按目录计数的那点好处，现在由指针承担）。旧 `chatEpochs` 只读保留，跑在 `--e<N>` 上的会话照旧接得回来；旧的按会话键存的 pick 会在启动时迁移到锚点键上。
- **归档会话改为在聊天里明确拒绝，而不是偷偷解归档。** 解归档是会话主人的决定；此前那段"先取消归档再开始"只写在会话阶梯的 `create` 档，而归档会话的日志可读、`resume` 档先命中，所以它对自己要解决的场景是死代码。现在 `resume` 前检查归档集合，命中就回一条可见消息（"这个会话已被归档…请在网页端恢复它，或发 `/new`"）并结束本轮——不再出现"消息发出去什么都没发生"。阶梯的拒绝是终态：不会退到 `create` 去覆盖刚刚拒绝的那个 id。
- **托管状态的失败不再只留在终端。** 会话指针、工作区、模型这些写入失败时，除了控制台，还会写进 `diagnosticsFile` 指向的诊断文件；settings 绑定在启动阶段给出的那行原因（诊断文件那时还没打开）也会在桥安装时补写进去。`/new` 的回复把"存不住"说准确（"本部署无法保存会话状态"），不再一律归因于"未组合 settings"。
- README（中文与英文）补充群聊 `/get` 的审批门、托管状态的持久化条件，以及 App Secret 轮换需要重启。
- CI 改为在 `ubuntu-latest` 与 `windows-latest` 上跑：这个包的行为本来就是平台形状的（launchd plist / systemd unit、Windows 垫片、路径分隔符），只在 Linux 上跑的测试会一直把 POSIX 假设保持成绿色。
- 两个 workflow 的 action 固定到 tag 所指向的 commit（`actions/checkout`、`pnpm/action-setup`、`actions/setup-node`），而不是可被移动的 `@v4`；发布任务持有 npm token 与 `id-token: write`，这正是"tag 被挪走"最要紧的地方。注释里保留 tag 名，更新时一行一个。
- 测试去掉 5 处 POSIX 字面量断言（`sanitizeFileName`、`parseArguments`、`servicePath`、`expandHome`、`invocation` 的 npx 判定），`invocation()` 本身也改为同时认两种分隔符；`tsconfig.vitest.json` 工程下的类型检查此前有 56 个错误，现已清零。

## dsh-v0.2.0-rc.2-v0.0.2 — 2026-10-06

适配 DeepSeek Harness `0.2.0-rc.2`；上一版本为 `dsh-v0.2.0-rc.2-v0.0.1`（296eb79）。

### Added
- **网页面板不再重复作答：审批「谁先答算谁的」。** 同一个审批会同时出现在飞书卡片和网页面板上，第一份回答生效。飞书先答时，网页上那份面板其实已经无可决定，但收回它是宿主的职责——宿主只在客户端回复或请求生命周期结束时结清转发的请求——于是按钮留在了屏幕上。本插件补上这一半：浏览器端读会话日志里的 `approval/asked` / `approval/decided` 审计对，也就是两个界面本来就共享的唯一记录，认出「这个请求已被别处决定」，在面板上写明 `已在别处决定` 并自动结清。选择器对所有会话生效，不只是本渠道驱动的会话：chain 选择器是 owner props 的纯函数（会话 id、会话快照、待审请求），读不到「某个聊天是否正在驱动这个会话」这类活事实；会话 id 也答不了这个问题，因为 `/sessions` 允许接续不是自己派生的会话。代价是这份面板替换了宿主的面板，因此它复刻了宿主的 Enter/Esc 键、提交锁定、asker 的 `reason`（含本地化的 `displayReason`）以及关联工具调用的命令。飞书端行为不变：卡片照发、照旧竞速、照旧判定；网页先答时，聊天里那张已结算的卡片会写明 `已在网页端决定`。
- **网页端提问面板。** `ask_user_question` 同样「谁先答算谁的」：浏览器端读日志认出「已在别处作答」后自动结清，且收束时展示日志里记下的答案（而不是本机没答完的草稿），状态条从警示色换为完成色。相关键与审批不同——审批按工具调用（asker 没给调用 id 时退化为工具名），提问只认最新一次留下成功结果的 `ask_user_question` 调用。除此之外，它按宿主那份提问向导逐项复刻，替换后不丢功能：
  - 一题一页的分页与进度、上一题/下一题、把整张卡片收起；
  - 跳过本题、作答校验、提交期间的锁定；
  - **倒计时与「慢慢回答」**：网页可以叫停自己的倒计时，宿主于是像阻塞式提问一样一直等；编辑草稿、把焦点放进作答区、窗口失焦或切走标签页，都会让倒计时跟着人走（冻结或续跑），而截止时间始终归宿主所有，面板只负责显示；
  - **草稿跨重挂载存活**，连「慢慢回答」这个选择一起恢复；请求消失后草稿自动清理，不会成为下一个请求的答案；
  - **只读回顾卡**：已结算的调用可以从工具调用行重新打开，显示当时记录的答案，没有提交入口；
  - **关闭语义与宿主一致**：带工具调用的请求只是把面板收回工具调用行（随时可再打开），宿主没给过调用 id 的请求则等于放弃整组问题。

  两个面板都改用宿主的 DOM 契约而不是渠道私有属性（提问面板 `data-question-key` / `data-question-scroll`，审批面板 `data-approval-key` / `data-approval-scroll`），会话的 Escape 路由与宿主的 e2e 选择器照旧匹配。飞书端照旧发卡；网页先答时，聊天里已结算的卡片写明 `已在网页端作答`，这一批剩下的问题也不再继续开卡。
- **`/ws` 变成工作区选择卡，点一行即切换。** 卡片一页 10 行，当前目录固定在首页第一行并标注「当前」「默认」，其余按宿主注册表的顺序；`上一页` / `下一页` 只重绘卡片——不切换、不释放会话、不丢弃 pick，反复翻页是安全的。按下的行所带的路径不被信任：切换走的是和 `/cd <路径>` 完全相同的守卫（目录必须存在、不是文件系统根或家目录、必须落在 `workspaceRoots` 内），并校验点击者与卡片所属会话。切换成功后清掉本会话的接续选择与缓存的会话列表，并释放当前 agent，下一条消息在新目录下重新走一遍会话阶梯。`/cd <名称或路径>` 保留：宿主还不知道的新目录没有行，只能靠它。
- **浏览器半边随包发布。** 新增 `./client` 导出与 `dsh.client` 声明（platform `web`，inject `@deepseek-ai/dsh-client-ui-session`、`@deepseek-ai/dsh-api-session-controller`、`@deepseek-ai/dsh-client-locale`），并补上构建浏览器包用的 tsconfig、tsdown 配置与 lightningcss/react 开发依赖。`cordis.patch.yml` 不需要额外一行：宿主 client 模块系统会为声明了 `dsh.client` 的包按 `<包名>/client.js` 取用，多写一行 `'dsh-lark-channel/client'` 反而会被扫描跳过、却在宿主 Loader 里被导入而在 Node 里失败。
- **`/sessions` 支持翻页，`还有 N 个更早的会话` 不再出现。** 一页 8 行，当前会话固定在首页第一行并标注「当前使用中」，`上一页` / `下一页` 只重绘卡片。翻页不消耗卡片，也不改变任何会话状态。拿不到宿主投影缓存的部署照旧报告被扣下的数量，而不是给一个会跳动的页数。
- **`/sessions` 的卡片是一次性的：选过一次就不再可点。** 卡片的行由**某一次派生**授权，所以第一次选择就把整张卡片结算掉——语义色 + 结算标题 + 没有任何可点控件 + 关闭页脚，与审批卡、提问卡结算是同一套形态（`clicks.ts` 的模块注释早就把这类卡单列了）。成功时保留被选中的那一行：标签会被截断，读者需要一个地方确认自己落在哪个会话上。要换一个就再发一次 `/sessions`。服务端按**渲染标记**（同一张卡的所有按钮共用一个 `a`）记录已花掉的卡片，重放的点击——平台重投，或终态重绘没送达——会被拒绝并同样收敛到结算卡。三种「选不了」的出口也一律结算：会话已不在可接续列表、卡片所属工作区已移动、派生在飞行中改变；它们恰恰证明用户看的列表已经过期，再画一张可点的活卡就是邀请第二次点在刚被证伪的列表上。

### Fixed
- **审批面板不再僵在等待态，关联命令也不再消失。** 已结算读取改为跟随会话当前的 Client Session 代次，而不是页面首次绑定的那一代：Session scope 在 retain 计数归零时会被回收再重建（离开会话再回来就是一次），原来捕获的绑定会一直折叠一个再也没人写入的窗口，于是别处的决定再也认不出来——聊天已经答完，面板还停在等待状态，关联工具调用结算后命令行也消失了。现在每次 attach、以及本页作答的每一次按下都重新解析绑定，同时释放已退役代次的窗口；重新跟随是安全的，因为折叠是重扫整个窗口而不是消费增量。
- **审批面板的关联命令取全了。** 命名调用参数还没到不算数，继续找同一 id 的已派发调用（之前在这一行提前返回，命令就丢了）；已经结算的调用改为从它自身的结果记录里取命令——这正是「活得比调用久」的面板本来就该显示的。提取逻辑搬进独立模块，不经过表现层即可单测。
- **`/new` 不再对着一个已被宿主归档的会话说话。** 派生会话 id 可能在宿主里被归档，宿主的归档门其后会拒绝它的每一步：命令自己的提示到了，下一条消息却写进旧会话的日志，回合以 `blocked` 结束，聊天里既没有请求也没有回答。派生 id 能重新变可达的地方只有创建这一级，所以现在先把它从归档集合里撤出再建 agent——只对本渠道自己的派生 id 生效，绝不重开一个人特意接续、却被宿主归档的会话（那种情况下 resume 失败仍然拒绝，而不是原地重开）。
- **切走之后，聊天不再继续收到上一个会话的输出。** 一个会话的事件靠「会话 → 渲染器」的绑定送进聊天，而这份绑定此前与进程同寿：`/sessions` 选行、`/cd`、`/new`、`/ws` 都只释放旧 agent，从不摘掉旧绑定，于是聊天切走之后仍在渲染那个会话——它的流式正文、它的审批卡、它的提问卡——与刚切到的那一个并排落进同一个聊天。**网页端正在跑的会话尤其明显**：它归浏览器所有（宿主注册表里已经活着，本渠道只是收养，`owned=false`），释放碰都不碰它，两路输出会一直并行。现在「会话身份改变」的那一刻就摘掉旧绑定：从派发表与创建缓存里同时删掉、结算它开着的那张卡；并且只在这四个真的换了会话的入口做——`/model` 恢复的是同一个会话，渲染器照旧复用。会话本身不动：它归开它的那一端（浏览器、定时任务），停不停由那一端决定。顺带把创建缓存的键从「会话」改成「聊天 + 会话」，一个聊天离开某个会话时不会顺手带走另一个聊天的在飞创建。

### Changed
- README（中文与英文）补齐「网页端同步 / 网页端的审批面板 / 网页端的提问面板」三节，`/ws` 的说明改为选择卡，`/new` 说明补充归档处理，环境要求改为 DeepSeek Harness `0.2.0-rc.1` 或更新（本仓库按 `0.2.0-rc.2` 构建与测试）。
- README（中文与英文）的 `/sessions` 说明改为分页 + 一张卡片只接一次选择。
- `cordis.patch.yml` 中的 `denyTools` 示例改为空数组（默认值本来就是空：提问与计划审批都不再依赖遮蔽工具，在聊天里即可回答），并说明浏览器半边不需要再加一行配置。
- **`/sessions` 不再为每一行打开会话日志。** 每次派生此前要对窗口内每个候选调用两次会话查询（`listEvents` + `readEvent`），而每次调用都会物化并克隆**整条**日志。实测一次冷派生 8.1 秒（22 次采样：最短 6.5 秒、最长 10.5 秒），其中列全量语料只占 0.6 秒，其余 7.5 秒全在描述候选上，约每个候选 1 秒。宿主本来就为每个会话折叠并落盘了 `title` / `sessionStats` / `sessionListMetadata` / `turnOutline`——就是它**自己的会话列表**读的那份记录——现在直接按 header 读这份记录：零 I/O、无日志读取、无需缓存。两级读取：体积固定的三个键对**全部**候选读，唯一随会话增长的那个（`turnOutline`）只对**当前页**的行读。拿不到这份缓存、或 header 不带格式代次的部署自动退回原来的日志路径，行为不变。配套删掉了 120 秒 TTL 的派生缓存 `lastOffered`：宿主已经折叠过的事实让一次派生只值一次语料列表，而一个记下来的列表会授权会话可能已经走出的行——现在每次渲染与每次点击都重新派生。
- **`/sessions` 行标签的语义随之有三处变化**，都来自「读宿主已折叠的事实」而非「自己读日志」：`lastSaid` 取**最后一个 turn 的第一条**人类消息（`turnOutline` 有意忽略同一 turn 内的后续插话，所以中途插话不再改写行标签），截断由 40 字符变为 50；`turns` 是「有已关闭 step 的 turn 数」而不是 `turn/start` 事件数，被中断的 turn 会差 1；新鲜度的上限是**上一个检查点**（会话创建 / `turn/end` / 会话释放，外加节流写回），也就是宿主自己会话列表的同一份语义。本渠道有活 agent 的会话改读投影注册表的当前 cut，不受这个上限影响。

**已知限制与后续。** `conversation.approval.detail` 插槽由宿主声明，插件无法再次声明，因此第三方往该插槽的贡献不会渲染，审批面板自己提取关联命令。网页半边本身是临时方案：根治点在宿主——网关应当在前序监听器抢先判定时，给已投递的浏览器推 `cancel` 帧；或者让渠道注册进 `forwardWaterfall`，与浏览器共享同一个 settled。届时这份浏览器半边应整体删除，而不是继续扩展。

## 0.0.7 — 2026-08-19

Thanks to @HarveyZed for `/session` (#9, the groundwork for `/sessions`),
@heshuaichen-charlie for the file transfer (#7) and the pnpm build-policy fix (#3), and
@vidgewong for proxy support (#5).

### Added
- `/sessions` continues a session this conversation did not start: the one `/new` left behind, or the one opened on a laptop in the web UI and now wanted on a phone. A conversation's session id is derived — chat, workspace, epoch — and that derivation is what makes a restarted process find the same conversation again; a pick is an override on it, and everything else follows from what a chat can safely be shown and safely be given. Nothing is typed: a session id is a machine identifier, so every switch is a press on a row this channel produced, which is also what keeps authorization in one place. The list is that place — a conversation is offered its own past sessions and sessions no conversation owns, never another chat's, whose title alone summarizes what was said there. The workspace decides what is on offer, because a session carries the directory it runs in and continuing one from elsewhere would move the sandbox without anyone saying so. Two kinds never appear at all: work an agent delegated to itself, which is a transcript answering to nobody rather than a conversation, and anything the operator archived, since archiving is the host's own “hide this from every surface” and a chat still offering it would be the one place that decision did not land. What each row shows is what a person recognizes a conversation by — the last thing a HUMAN said in it, since the same stream also carries system prompts and skill catalogs, and titles are folded from the first prompt, which makes half of them “Hello” — and the list reads newest-activity first, which is the timestamp each row prints. And a pick is undone by picking: the conversation's own derived session is always a row, so going back is the same gesture as going away, while `/cd` and `/new` end a pick on their own — both of them ARE a change of session. A picked session that cannot be resumed is never started over in place: a pick names a conversation that already exists, so an empty session created under its id would be written over the very thing someone asked to carry on with; the chat is told, and the pick is retired so the next message lands on its own session.
- Files sent to the chat land in the workspace, so the model reads them instead of guessing. The transport already put a `<file name="app.log"/>` marker in the message text, which showed the model a name and no bytes — the worst of both, because a model handed a file name answers as though it had read the file. Every file a message carries (documents, images, voice notes, video; a sticker is not a file) is now streamed into `.dsh-lark/inbox/<timestamp>-<message hash>/` under the conversation's own workspace, and a note riding the same message names the absolute path. The sender's file name is sanitized to one safe component, per-message directories scope collisions to a single message, and a name that survives sanitizing down to nothing lands as `file`. Nothing is dropped in silence: a file over the per-file ceiling, over the per-message total, refused by configuration, or lost to a failed download leaves a note saying so, because a model that received a file and believes it did not is worse off than one that knows what it is missing. Images pass through this and the attachment path both, and are downloaded exactly once. The first landing in a workspace adds one line suggesting `.dsh-lark/` for `.gitignore`; the channel never edits that file itself, and never deletes what it landed.
- `send_file` hands the model's own artifacts back to the person who asked — a report, a diff, a generated image, exported data — from inside the workspace and only ever to the chat the agent already belongs to. In a direct message it goes straight out: the reader is the person already driving the agent, so an approval would only breed the fatigue that ends in blind approving. In a group every send raises an approval card showing where the file sits inside the workspace, the workspace's own name and the size, and the bytes are read BEFORE the room is asked so what the card certifies is the artifact that leaves. Both halves of that location are cut from the canonical path the containment check cleared, so a symlink still cannot present itself as a file the room believes it is approving, while the operator's home directory and login name stay out of the group. Reading first is what bounds the card's cost, and the count of undecided cards is bounded too: three per chat, after which a send is refused on the spot rather than pinning a fourth buffer for the half-hour a card may stand. There is no setting that turns that group card off, and none that raises the three — either would be an official back door onto the prompt-injection chain (ADR 0002). A path that leaves the workspace is refused after `realpath`, not before it, so a symlink cannot walk out through a name that looks local; the refusal reaches the model in English with the reason, and an escape attempt reaches the operator console.
- `/get <path>` sends one workspace file to the chat, with no agent and no card: a human who typed the path has stated his intent, and making him approve his own command is theatre. It answers in a chat that has no session yet, resolves relative paths against the conversation's workspace, and walks the exact same containment check the model's tool does. A file that cannot be read is reported by its place inside the workspace, with the absolute prefix taken out of the filesystem's own message too — a read failure is the branch an injected instruction can provoke on purpose, and in a group the reply is read by the whole room. The same scrub covers what `send_file` tells the model, which no more gets a path it did not type itself than any other refusal here hands it one.
- Four configuration fields, both switches on by default: `receiveFiles` (`true`) and `maxReceiveFileBytes` (20 MiB) for what arrives, `sendFiles` (`true`) and `maxSendFileBytes` (20 MiB) for what leaves. Inbound content never enters the model's context — it lands on disk and the model gets a path — and the outbound risk is handled structurally by the gate above, so a gate that only exists when a deployment goes looking for it would be a gate designed not to be used. Where `sendFiles` is off, or the host registry cannot take a per-agent tool, `send_file` is absent and the standing prompt says so, so the model writes its findings into the reply instead of offering an attachment forever; `/get` stays available either way.
- The approval card names the escalation it is granting, and can grant more than one call. A host approval request carries the tool and the reason but not the sandbox mode being asked for — that rides the call's own `sandbox_permissions`, which this channel already snapshots, so the card can say "this call asks to be raised to danger-full-access" instead of showing a command and hoping. Where a call did ask, a third button settles the approval and then switches the conversation to that preset, in that order: the preset also sets the approval policy to `never`, and `never` REFUSES what still needs approval, so switching first could reject the very decision being made. The button says all of that where it is pressed.
- `/permission` answers with a picker, and a switch runs from the agent's own idle phase. The host command always took a preset name; a bare `/permission` only printed one, so switching meant knowing the name and typing it. Rows now carry what each preset means — the host's own name and description, plus this channel's own words for the unconfined one, which stops the ASKING as well as the confining — and a press runs the host's own command. Reading is a read: the preset comes from the published `permissions` projection, because running `/permission` to find out appends to the session log, and a card that "just looks" must not be a second writer. Writing waits its turn: every switch is queued per conversation and claims the agent's idle phase through `runMaintenance`, so it can never land beside a running turn or inside the publication of one — the two ways this channel has already torn a session log. A card settles the moment it is pressed and repaints when the switch lands, so what it says is what happened.
- One rule decides who may change a preset, wherever it was asked from. The picker, the typed `/permission <name>` and the approval card's third button now pass the same check, and it is asymmetric on purpose: taking the sandbox off is a grant and needs whoever may approve one, while putting it back on is something anyone who may drive the conversation can do. The typed form used to walk straight into the host command, so the card could refuse a switch that typing performed — and the card, gating both directions the same way, refused an ordinary member the switch that makes their own conversation safer.
- `/status` gained the preset row, so a session that stopped asking is something you can see rather than something you notice by the silence. The approval card's third button appears only where the switch it promises can actually happen: the preset has to exist in this deployment, the command has to be composed, and the host has to lend an idle phase to run it from.

- The websocket transport respects the proxy environment, so a deployment behind a corporate proxy connects instead of hanging on a handshake nothing routes. `respectProxyEnv` is on, which means `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` are read the way every other tool on that host reads them.

### Fixed
- A profile installs even where a dependency wants to run a build script. pnpm holds unapproved build scripts back, and a bot that never finished installing is a bot that never starts: the generated profile now approves what it actually needs and pins `strictDepBuilds: false`, so a future dependency's script is skipped with a warning rather than failing the install of a running deployment.
- Settled approval cards best-effort resolve a decider name from the chat roster when the platform callback carries only an open id. Missing roster permission, lookup failures, and departed members still settle the approval and safely show the open id, while unauthorized clicks never trigger a roster lookup.
- A control card's buttons keep working. The transport drops a repeated card action for twelve hours, keyed by the message, the operator and the payload — right for a redelivered event, wrong for a person pressing refresh a second time, picking a model they picked before, or switching a preset back. Every rendering of the status, model and permission cards now stamps its payloads, so a later press is a different event, and a click is answered immediately with the work done behind it: the platform stops showing a callback's result after a few seconds, which is why a switch that worked looked like a dead button.
- A card click resolves the conversation the way a message does — by key, then the session it derives to — instead of scanning bindings for a matching chat. A chat that had run `/new` or `/cd` was still holding its older sessions in that table, so a click found the first, released one and reported that nothing was running beside a conversation that plainly was. A conversation with no live agent is now opened for the switch rather than told to send a message first: a preset belongs to the durable session, which outlives the process.
- Two people talking in one chat no longer answer for each other under a finer session scope. The transport merges a chat's burst into a single message with the latest sender and thread attached, which is right when a chat owns the session and wrong for `chat-thread` and `chat-sender`; the merge window is now closed for those scopes.
- A reply is aimed where the turn actually takes the message: `agent/inbox/claimed`, which lands before the turn's first step. The session log's own order is `turn/start`, `step/start`, `user/message`, so aiming at that last record arrived after the turn had already begun producing. An artifact `send_file` hands over early in a turn now lands under the ask for the same reason, because both the renderer's aim and the file's travel through one place.
- Who may loosen a conversation's permissions is decided by what the preset DOES, not by what it is called. A deployment defines its own preset table, so `unrestricted-prod: { sandbox: danger-full-access, approval: never }` walked past a check that only knew the name `danger-full-access`; the sandbox mode and the approval policy now decide, and a preset whose bundle cannot be read needs an approver rather than being assumed harmless.
- A conversation's queued switches are cancelled BEFORE its agent is released, and the release waits for them. Releasing is what makes an agent idle, so a switch waiting for exactly that could slip through the window and write to a session being disposed. Cancellation also reaches into the wait itself rather than queueing behind it, and disposal now waits for the work that surrounds a switch — opening an agent, answering the chat, repainting a card — not only for the command.

## 0.0.6 — 2026-08-15

- `dsh-lark-channel upgrade` installs the newest CLI and restarts the bot on it, in one command. `start` pins the plugin to the CLI's OWN version, so a globally installed CLI upgraded by re-running `start` alone would silently re-pin the version it already had; `start` and `status` now also mention a newer release when one exists. Through npx there is nothing to install and the command says so instead of pretending.
- The CLI spells commands back the way you invoked it. Run through `npx` its binary lives in a throwaway cache, so every hint that said `dsh-lark-channel status` was telling half its users to run something that does not exist; usage and every message now print `npx dsh-lark-channel@latest …` for that caller and the bare name for an installed one. Installing globally stays a choice the reader makes, not a machine-wide change the tool makes for them.
- `/new` starts a fresh session where the conversation already stands. A session id is derived rather than allocated, so nothing varied when someone wanted an empty context without moving: an epoch — stored beside the workspace and model maps, absent meaning zero — now folds into the id, and zero derives exactly the id it always did. It is per (conversation × directory), so starting over in one workspace leaves the thread you would `/cd` back to intact. Nothing is deleted: the previous session stays on disk, and the workspace and model route carry over.
- Chat agents are told where they woke up, in one sentence: the bot account they speak as, that their reply IS the message, and that answering is optional. Without it an agent read "say hello to the other bot" as an investigation and shelled out to a CLI to send a message its own reply would have sent. A message from another agent carries one more line — the exact `<at user_id="…"></at>` that hands the turn back to THAT agent, or silence to end it — which rides that message rather than every human one. By id rather than by name: names repeat, and a mention resolving to the wrong colleague or to nobody would end an exchange meant to continue.
- Two bots can talk to each other, by default. A message from a bot used to be dropped outright; bot traffic is now narrowed rather than gated, like every other reach here — `botPeers` restricts it to named ids when a deployment wants that, and empty narrows nothing. What bounds the exchange instead is `botHops`: a conversation may run six consecutive bot-sourced turns before the channel stops and says so in the chat, and a human message refills the budget. Each bot is named once per chat on the operator console, whether it was answered or narrowed out, and a channel never answers its own voice.
- A second bot can be composed alongside the first. `instance` names a row, and that name keys the three identifiers two rows would otherwise write over each other with: the settings section holding their workspace and model maps, the credential holding their app secret, and the prefix their session ids carry — without which two bots invited to the SAME group derive one session id and share one agent. A row with no name keeps the original identifiers byte for byte, so nothing an existing deployment has stored moves.
- `/status` reports what the conversation is spending: how full the model's context is (`32.5k / 128k`, with the share of the window) and the whole-session token totals, read from the host's own token-meter projections. Both rows appear only where a deployment composed that meter and the session has actually made a request — a row claiming zero where nothing is measured is a lie an operator acts on.

### Changed
- The app secret is stored through the host `credentials` seam instead of the user settings document. Onboarding writes the scanned secret to the credential `LARK_APP_SECRET` and keeps only a reference in settings; a secret already sitting in the settings document moves behind that reference on the next boot, so an existing deployment is repaired by restarting rather than by scanning again. A deployment that injects `appSecret` in its composition still owns it, and one with no credentials provider composed keeps working exactly as before.

### Fixed
- A profile is never pushed back to an older plugin. `start` pinned the profile to the CLI's own version unconditionally, so installing an older CLI and running it downgraded a working bot — and a bot downgraded past the credential migration finds a settings section it cannot read, connects to nothing, and quietly asks to be set up again. Both `start` and `add` now refuse, naming the two versions and the upgrade.
- `upgrade`, `add`, and `remove` act on the service that is installed rather than on a default. Each read the profile from a constant and the workspace from the current directory, so `upgrade` run in `/tmp` rewrote a `--profile web --workspace /repo` service into `lark` and `/tmp`, and `add` edited a profile nobody was running. The installed unit already records both, so it is read back from there, and an explicit `--profile` / `--workspace` still wins.
- `add` brings the profile's plugin to the CLI's exact version before writing a row. The row names an `instance`, an option only a new enough plugin has; an older one rejects the whole row and takes the bot down with it — so a new CLI could break a profile it had not updated.
- A question the model marked `multi_select` can now be answered with more than one option. Its card was built from single-choice controls, so the first press settled a question that may take three answers; it now renders a form whose multi-select submits the chosen set in one action, carrying option positions rather than labels. A submission that names nothing leaves the card live, and typing an answer still works as it does for every other question.

## 0.0.5 — 2026-08-15

- Model questions reach the chat as cards. `ask_user_question` is shadowed in each chat agent's own layer — the host's layered tool registry resolves the nearest registration and reserves only `run_code` from shadowing — so the model's options render as buttons and a click answers them; when no option fits, an ordinary reply is the answer and does not start another turn. Cancellation, session release, and a thirty-minute silence all settle the question empty and repaint its card, so a turn is never hung on one. `ask_user_question` accordingly leaves the default `denyTools`.
- Plan review reaches the chat. `exit_plan_mode` is shadowed per chat agent the same way the question tool is, wherever a plan service exists to leave plan mode afterwards: the plan is sent as an ordinary message so its markdown renders, and the decision follows as a card. Approval calls the plan service's own public switch rather than a copy of its state machine; words typed instead go back to the model as feedback, and a dismissed review tells it to stop and wait rather than present again. `denyTools` is empty by default as a result.
- `/model` answers with a picker over the advertised routes — the route in use states itself instead of offering a press, and a conversation that left the default gets a way back — while `/model use <provider/model>` and `/model reset` stay exactly as they were, for anyone who already knows the route. `/status` answers with a readout of what the next message will do, and a refresh that re-reads live state rather than repainting a snapshot. Both cards carry the conversation they govern, so a forwarded card governs nothing and a per-sender conversation cannot be switched by someone else in the room.

### Changed
- Every interactive card rebuilt on one visual language: a semantic ink per state, one type role per purpose, a 20px grid, and copy that names the action rather than the gesture. Options that carry an explanation become full-width clickable rows so the reason sits inside the thing you press, instead of a legend below it. This channel's own copy is bilingual and ships an `i18n` map per string, so one card serves a mixed room in each reader's language, while model-authored text stays literal and untranslated — rewriting a command would be a lie about what runs.

### Fixed
- The bot's slash panel is published from a RESUMED session too, not only a fresh one. A chat that already had a durable session never took the create rung again, so the panel froze at whatever the channel offered the day that session began: every command added later worked when typed and was invisible to anyone who reached for `/`.
- A tool whose per-agent shadow could not be registered is denied again, and the guard that enforces it is installed whenever anything is actually denied. It used to be keyed on the CONFIGURED deny list, so an empty one skipped installing the guard the fallback depends on.
- Concurrency hardening across the bridge, closing six verified races. Inbound handling returns its promise to the transport, restoring the SDK's per-chat serialization that a voided promise had discarded. Approval questions copy an immutable call snapshot — keyed by session and cleaned per turn — so a card can never show one session's command while approving another's, and live as a small state machine registered before the card send, so an abort before, during, or after the send settles exactly once and repaints the card. Conversation releases advance a generation synchronously, so a walk that a release supersedes disposes its own product and retries instead of handing out a dying agent. Binding creation is single-flight. Reply targets correlate through the host's `user/message` events — a turn may consume several queued messages, and the answer follows the message actually consumed (the last of several), never arrival order; a turn that claims no message sends unaimed rather than guessing.
- The reconnect watchdog now spends a budget: the platform meters connection attempts, so a never-resolving outage would have had it rebuilding forever. Ten rebuilds per thirty minutes are admitted — comfortably above what the backoff produces for a genuinely degraded link — and beyond that it pauses, says for how long, and resumes when the window slides, rather than burning the quota.
- A reconnect watchdog supervises the transport's own recovery promise: the SDK's reconnect loop has terminal states (source-verified give-up paths, and a hang that schedules nothing), which left a live process with a silently dead lifeline for hours. A `reconnecting` not followed by `reconnected` within the deadline now rebuilds the transport through its public lifecycle, retrying under capped backoff and never going silent.
- Operator console lines carry timestamps; the incident above was dated off a file mtime because the log could not say when its last line was written.

## 0.0.4 — 2026-08-14

### Added
- In-chat workspace switching: `/cd <path|name>` points a conversation at a directory and `/ws` lists every workspace the host registry knows, each reachable by bare name. Every (conversation × directory) pair owns a durable session, so returning to a directory resumes the context built there. Switches persist through the settings service, `workspaceRoots` fences where `/cd` may go, the filesystem root / home root / home's parent are never accepted, and both commands run without an agent.
- Per-conversation model switching: `/model` shows the current route and the host llm registry's advertised catalog, `/model use <provider/model|model>` switches from the next message on — the same session resumes under the new route with its context intact — and `/model reset` returns to the deployment default. Switches persist through the settings service; unlisted routes are set with a note, since the host catalog is advisory.
- `/status` reports the conversation's workspace, model route, session id, turn activity, pending approvals, and the running plugin's version — without creating a session to answer.
- A packaging spec packs the real tarball on every `pnpm test`, asserting the emitted runtime files and their relative-import graph ship closed.

### Fixed
- `files` now ships `lib` wholesale: the version helper became a bundler chunk shared by two entries, and the enumerating list did not carry it, so installs crash-looped on `ERR_MODULE_NOT_FOUND`. `prepack` is declared alongside `prepare`.
- A `/cd` or `/model` switch that disposes a mid-turn agent clears the conversation's running mark itself, so `/status` cannot report a disposed turn as still running.
- A message racing a switch's release can no longer be handed an agent mid-disposal: session acquisition re-derives the id and self-heals a stale binding.

## 0.0.3 — 2026-08-14

### Fixed
- systemd units now send the bot's console to `~/.dsh-lark-channel.log` instead of the journal, which had left the log file empty on Linux — `start` could never relay the first-run QR code there.
- `start` under systemd now attempts `loginctl enable-linger` and says so when lingering stays off, since a user service otherwise stops at logout.

### Added
- `dsh-lark-channel logs [-f]` prints the bot's recent console output, following it with `-f`.

## 0.0.2 — 2026-08-14

### Added
- A one-command deployment CLI: `npx dsh-lark-channel start` provisions a dedicated profile, runs it in the background under launchd or `systemd --user` from the first moment, and relays the log to the terminal until the QR scan lands. `stop`, `restart`, and `status` manage it afterwards; systems with no supervisor fall back to a foreground run.
- Unit files carry an explicit PATH (a supervisor's stunted default cannot run a `#!/usr/bin/env node` dsh), are user-only, escape everything interpolated, and forward environment-supplied Lark credentials so the supervised process sees them too.
- CI runs typecheck and tests on push and pull request.

## 0.0.1 — 2026-08-14

- First npm release: the Lark/Feishu IM bot channel plugin, installable with `dsh plugin --profile web add dsh-lark-channel` — the registry tarball ships `lib/` prebuilt, so nothing compiles on install.
