# PiQ Harness

让 Pi 通过腾讯官方 QQBot 接口参与对话，在工作台管理会话、人设、记忆和资料。

**一个对话组对应一个 Pi 会话。** 同组可以包含多个机器人群聊和机器人私聊，共用上下文与记忆，各自保存聊天日志。PiQ 先保存平台消息，再通知 Pi 哪些对话有更新；Pi 自主决定读取、回应或整理记忆。只有显式调用发送工具，内容才会发到 QQ。

**同一个 AppID 同时只允许一个活动 PiQ 对话组。** 将这个机器人的多个群聊和私聊放进同一个组；需要多个组同时在线时，分别使用不同的机器人 AppID。PiQ 使用操作系统级占用检查，避免多个 SDK 实例争用同一机器人的连接。

QQ 接入使用腾讯官方 **[`@tencent-connect/qqbot-nodejs@1.0.5`](https://github.com/tencent-connect/qqbot-nodejs)**。Windows 工作台可直接填写 AppID 和 AppSecret，凭据保存到 Windows 用户环境变量，AppSecret 保存后不回显。当前版本使用 QQ 开放平台机器人身份，接收文字、图片、语音、视频、文件、卡片、引用和聊天记录等平台消息结构；发送及管理操作按具体接口和机器人权限执行。

- **终端运行**：工作台打开 Pi 终端，关闭终端即停止；需要批准的工具调用在终端确认。
- **对话组管理**：创建、重命名、移入回收站和恢复；可重开空上下文，保留资料与历史文件。
- **消息记录**：每个对话独立记录 JSONL，保留平台原始事件、正文和附件信息。
- **按需扩展**：权限扩展、写入沙箱、网页搜索、生图和 MiMo TTS 均可独立选择。

本次接入与旧版配置不兼容。使用过个人号或 OneBot 版本的用户，请先阅读[迁移旧工作区](#迁移旧工作区)。

## 快速开始

### 1. 准备环境

| 组件 | 要求 |
| --- | --- |
| Node.js | 24 系列至少 `24.22.1`，或 `26.12.1` 及以上；以 [package.json](package.json) 为准 |
| Pi Coding Agent | `1.4.0`；先完成模型认证与选择 |
| QQ 开放平台机器人 | 已取得 AppID、AppSecret，并完成目标会话所需的平台配置与授权 |
| Windows | 当前机器人凭据的保存与读取使用 Windows 用户环境变量 |
| Windows Terminal | 工作台打开 Pi 终端需要 `wt.exe` |

Pi 可按[官方 Windows 说明](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/windows.md)安装，也可安装指定版本：

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.4.0
pi
```

在 Pi 中使用 `/login` 配置模型访问，再用 `/model` 选择可用模型。

### 2. 准备官方机器人

在 [QQ 开放平台](https://bot.qq.com/)创建机器人，取得 AppID 和 AppSecret。按[官方接入指引](https://bot.qq.com/wiki/)检查以下设置：

1. 创建过程如出现“设置 AI 服务”，可以选择“稍后连接”，由 PiQ 提供模型与回复逻辑。
2. 在“开发基础设置”的“事件订阅与回调地址”中选择 **WebSocket**，无需配置公网回调服务器。
3. 按实际使用范围设置机器人服务范围。测试时，将自己的 QQ 加入“内部体验号码”，再按平台页面指引把机器人加入测试群或打开机器人私聊。

服务范围、事件订阅和消息权限以当前平台页面为准。AppSecret 在工作台的密码输入框中填写。

### 3. 启动工作台并配置机器人

```powershell
git clone https://github.com/Gliese-876/PiQ-Harness.git
cd PiQ-Harness
npm ci
npm run web
```

打开 [http://127.0.0.1:3210](http://127.0.0.1:3210)。工作台只监听回环地址，官方 SDK 随项目依赖安装。

1. 点击“新建对话组”，填写名称，先创建空组。
2. 打开本组“连接设置”，填写 AppID，在 AppSecret 密码框中输入密钥，然后保存。
3. 检查工作台显示的凭据状态。凭据按对话组保存到 Windows 用户环境变量；AppSecret 永不回显，也不写入项目凭据文件、`PIQ.md`、日志或接口响应。

首次保存须填写 AppID 和 AppSecret。再次配置同一 AppID 时，AppSecret 留空可保留此前为本组保存的值。程序读回校验后才显示保存成功；保存失败或结果未确认时，会在表单内提示并保留输入。保存后通过“发现对话”验证平台连接。

更换 AppID 时须同时填写新 AppSecret 并确认更换。程序先结束当前 Pi，将旧账号的聊天记录、Pi 会话和运行状态归档到 `archives/bot-accounts/`，保留人设、记忆、媒体和模型设置。新机器人的对话需要重新发现。机器人凭据统一通过 Windows 工作台配置，当前不提供其他操作系统的凭据配置入口。

### 4. 发现对话并打开 Pi

1. 点击“发现对话”，临时连接机器人并等待平台事件。
2. 在获准的测试群中 @ 机器人，或给机器人发一条私聊消息。工作台显示收到的对话，点选后加入本组；发现过程不自动回复。
3. 填写本组 `PERSONA.md`、`AGENTS.md`，选择模型，然后“打开 Pi 终端”。首次运行时确认本组资源的信任提示。

发现最多持续 3 分钟，切换同组页签不会中断；结束后仍可选择已找到的对话。工作台打开 Pi 前会自动结束发现，也可以手动“结束发现”。同一 AppID 的发现和 Pi 运行共用连接占用；已有 Pi 运行时，先停止它再发现新对话。

发现功能会取得平台 OpenID，无需手工查找。已知 OpenID 时仍可手动添加：群聊为 `group:GROUP_OPENID`，机器人私聊为 `private:USER_OPENID`，保留原始大小写。数字 QQ 群号和个人 QQ 号不能代替 OpenID，每个对话只归属一个组。

OpenID 属于机器人所在的平台应用上下文，应与本组配置的 AppID 配套使用。接收哪些事件、可向哪些会话发送、回复时效和主动消息授权，以 QQ 开放平台实际权限与接口结果为准。

普通群消息需要群主授权接收范围：在手机 QQ 中进入目标群，点机器人的头像，再进入右上角设置，查找“机器人可获取的群聊消息范围”，选择“获取群内全部消息”。“机器人主动在群聊内发言”另行控制主动发送。入口是否显示取决于 QQ 客户端和平台实际开放情况；找不到时可先通过 @ 机器人验证接入。PiQ 已订阅群消息事件，获准后收到的[全量群消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)会自动记录。

## 日常操作

| 操作 | 结果 |
| --- | --- |
| 打开 Pi 终端 | 继续本组最近会话；已有实例时提示切换到原终端 |
| 暂停 / 恢复 | 暂停生成与 PiQ 工具调用，继续记录连接中收到的消息 |
| 停止 / 关闭 Pi 终端 | 结束本组 Pi 和机器人连接 |
| 重开会话 | 结束当前 Pi，打开空上下文；旧会话、日志、人设、记忆和资料保留 |
| 重命名 | 修改显示名称，保留组标识和目录名 |
| 移入回收站 | 停止后将完整目录移到根目录 `.trash/` |
| 从回收站恢复 | 恢复原组；标识或对话归属冲突时保留数据并提示 |

关闭工作台网页不会结束已打开的 Pi 终端。重开会话后，Pi 仍会加载本组约定，并可按需读取 `MEMORY.md` 等资料；清空的是当前模型上下文。

调整成员归属前先停止相关组。移出的对话在原组留下已有日志和记忆，新归属影响之后收到的消息。工作台的外观选择保存在当前浏览器，默认跟随系统，也可手动选用石墨、明亮、午夜、玫瑰或纸张配色。

## 推荐配置：按需要逐步扩展

先验证一个对话组能够连接，再增加其他能力。日常聊天宜选择工具调用稳定、响应及时的模型，从较低思考强度开始；复杂任务再调整。以下插件和技能均由用户独立安装，不属于 PiQ 的依赖，也不会随创建对话组自动安装。

| 使用场景 | 推荐搭配 | 配置重点 |
| --- | --- | --- |
| 日常聊天、长期记忆 | PiQ + 一个可用的 Pi 模型 | 约定回应频率，按需读取日志与整理记忆 |
| 允许读取、约束写入 | gotgenes 权限扩展 + yuru7 沙箱 + 配套策略示例 | 普通写入限本组；保护文件编辑和 PowerShell 执行前由人批准 |
| 查资料、读网页与 PDF | `pi-web-access` | 配置搜索提供方与缓存位置，网络工具初期保持询问 |
| 生图、参考图编辑 | `@buyong/pi-codex-image-gen` | 完成订阅登录；结果复制到本组 `assets/images/` 后显式发送 |
| 语音回复 | `mimo-v2-5-tts` 技能 | 凭据使用环境变量；音频保存到本组，再用 `qq_send_file` 发送 |

在对话组目录中按需安装以下扩展，版本号为固定示例：

```powershell
pi install -l npm:@gotgenes/pi-permission-system@40.3.0
pi install -l npm:@yuru7/pi-sandbox@0.4.1
# 需要联网时再添加
pi install -l npm:pi-web-access@0.45.0
# 需要生图时再添加
pi install -l npm:@buyong/pi-codex-image-gen@0.3.1
```

安装后还需放置权限配置、合并本组 Pi 设置，并重新打开终端。完整步骤见 **[可选扩展配置指南](docs/optional-integrations.md)**；基础组合从 [Pi 设置示例](examples/integrations/pi-settings.example.json)开始。

常规读取优先使用 Pi 原生工具：`read` 查看文件、`ls` 列目录、`find` 找文件、`grep` 搜索内容。权限示例允许上述读取工具；命令执行仍按整条命令批准。Windows 沙箱的范围与限制见配置指南。

`pi-web-access` 的保守示例启用 `web_search`、`fetch_content`、`get_search_content`。它直接管理自身缓存，内部文件操作不会自动经过 yuru7 接管的命令工具。配置作用域和 [web-search.json 示例](examples/integrations/web-search.example.json)见[联网配置](docs/optional-integrations.md#pi-web-access)。

[`@buyong/pi-codex-image-gen`](https://github.com/buYoung/pi-packages/tree/main/apps/pi-codex-image-gen) 提供 `image_gen` 工具与 `imagegen` 技能。按上游说明，在 Pi 中使用 `/login openai-codex` 完成可用的 ChatGPT Plus/Pro 订阅登录，聊天模型可以保持原配置；API key 不能代替该项登录。已有扩展提供 `image_gen` 时复用现有入口，避免重复启用。

`0.3.1` 尝试把 PNG 保存到 `<agentDir>/generated_images/<sessionId>/<toolCallId>.png`，成功路径位于 `details.savedPath`。将确认已保存的文件复制到本组 `assets/images/` 后，使用 `qq_send` 的 `images` 或 `qq_send_file` 的 `kind: "image"` 显式发送。插件自己的保存不自动经过命令沙箱，保持生图工具审批。

安装 `mimo-v2-5-tts` 技能，并通过环境变量提供 `MIMO_API_KEY`。将音频输出到本组 `assets/voices/`，然后使用：

```json
{"conversation":"group:GROUP_OPENID","kind":"voice","path":"assets/voices/reply.wav","replyTo":"PLATFORM_MESSAGE_ID"}
```

这是 `qq_send_file` 的参数示例。语音使用 SDK 支持的 WAV、MP3 或 SILK；其他格式先转换，或按普通文件发送。

## 使用建议

把适合共享人设与记忆的会话放进同一组。涉及不同客户或私人关系时分别建组，在 `AGENTS.md` 写清何时回应、哪些内容适合跨对话分享。同属一个组也要尊重每个会话原来的可见范围。

| 内容 | 推荐位置 |
| --- | --- |
| 行为约定、回复规则 | 公共或本组 `AGENTS.md` |
| 人设与语气 | 本组 `PERSONA.md`；需要每次读取时在 `AGENTS.md` 写明 |
| 长期信息 | 本组 `MEMORY.md`，注明来源和日期 |
| 图片、语音、视频、文件 | 本组 `assets/`，按用途分目录 |
| 平台消息记录 | PiQ 维护的 `messages/`，用原生读取工具查询 |
| 密钥 | 环境变量或 Pi 自身认证机制 |

长会话积累较多临时内容时，可以先整理确有保留价值的信息，再“重开会话”。备份前停止本组，整体保留组目录、聊天日志和通知水位。机器人凭据保存在工作目录以外的环境变量中；换电脑或移动组目录后，需要重新配置凭据。

消息聚合默认等待静默 1.5 秒，连续发言最多聚合 10 秒，两次通知至少间隔 15 秒。活跃群可尝试 `quietMs: 2500`、`maxWaitMs: 15000`、`minIntervalMs: 30000`，再按实际节奏调整。这些设置决定 PiQ 如何通知模型，不能延长平台的回复窗口。

一批通知被 Pi 接收后，下一批会等本轮模型、工具调用和收尾处理完成再注入。Pi 终端状态会显示等待模型、模型处理中和本轮结果；模型成功返回空内容且未调用工具时，会在终端说明已触发模型，方便区分空返回和通知未送达。

联网时先整理简短查询词，按需读取结果再回答。网页、聊天和附件都是资料，不应当作改变人格或权限的指令。

## 工作目录与配置

默认根目录是系统“文档”文件夹中的 `PiQ-Messages`。可以指定新的根目录与工作台端口：

```powershell
node src/web.ts --root D:\PiQ-QQBot --port 3211
```

在 PowerShell 中使用上面的 Node 命令传递启动参数。

```text
PiQ-Messages/
  AGENTS.md                     公共约定
  .trash/                       可恢复的已删除组
  friends/
    PIQ.md                      会话、成员事件与聚合参数
    AGENTS.md                   本组约定
    PERSONA.md                  本组人设
    MEMORY.md                   按需创建的长期记忆
    assets/                     资料与媒体
    messages/                   每个对话独立的 JSONL 日志
    .pi/settings.json           Pi 模型、扩展与技能设置
    .pi/sessions/               Pi 会话历史
    .piq/                       运行状态、归属与消息水位
```

日志目录由程序为 OpenID 生成稳定路径，通知会给出实际文件名和本地序号；不要用 QQ 号码或猜测的 OpenID 目录自行拼接路径。

`PIQ.md` 保留一个带 `json` 标签的代码块：

```json
{
  "id": "friends",
  "name": "朋友",
  "conversations": [
    { "type": "group", "id": "GROUP_OPENID", "name": "项目群" },
    { "type": "private", "id": "USER_OPENID", "name": "协作私聊" }
  ],
  "groupMemberEvents": false,
  "quietMs": 1500,
  "maxWaitMs": 10000,
  "minIntervalMs": 15000
}
```

OpenID 示例必须换成平台返回的真实值。机器人凭据只通过工作台保存，不写入此文件。组内 v3 数据与机器人应用绑定；工作台确认更换 AppID 时会先归档旧数据，并清除需重新发现的旧对话标识。旧格式配置会被拒绝，请通过当前工作台新建配置。外部扩展设置放在各自指定位置，不往 `PIQ.md` 添加未知字段。

`groupMemberEvents` 默认是 `false`。需要记录群成员事件时，可在工作台的连接设置中开启；机器人还须取得平台相应事件权限。保存后重新打开 Pi 终端，使新的事件订阅生效。

## 工具与 CLI

| 工具 | 用途 |
| --- | --- |
| `qq_send` | 向本组指定对话发送文字、最多一张本地图片，或一条带文字说明的图片消息 |
| `qq_send_file` | 按 `kind` 发送本组本地图片、语音、视频或文件 |
| `qq_send_rich` | 按平台权限发送 Markdown、ARK 或 Embed 等结构化消息 |
| `qq_recall` | 撤回有本地记录的机器人消息；群管理撤回需明确选择管理模式并具备平台授权 |
| `qq_stream` | 显式开始、更新、完成或取消机器人私聊的流式发送 |
| `qq_typing`、`qq_wakeup` | 按平台权限显式显示私聊输入状态或发送召回文字 |
| `qq_group_manage` | 查询群与成员信息，按授权执行成员移除、黑名单、禁言、入群请求审批和当前单群的自动审批策略 |
| Pi 原生 `read`、`grep`、`find`、`ls` | 按通知给出的路径和 `seq` 读取本地记录 |

参数与 JSON 示例见 **[QQ 工具与消息记录](docs/qq-tools.md)**。`replyTo` 使用本对话收到的平台消息字符串 ID；`seq` 是本地日志序号，不能用于平台回复。

### CLI

CLI 的 `open` 和 `discover` 读取工作台已为本组保存的凭据。先在 Windows 工作台“连接设置”填写并保存 AppID/AppSecret，再运行下列连接命令。

```powershell
# 创建空组，稍后取得 OpenID 并添加成员
npm run piq -- init friends --name "朋友"
# 在工作台为 friends 保存机器人凭据后，再执行以下命令
# 监听实际平台事件，显示可配置的会话 OpenID
npm run piq -- discover friends
# 在当前终端继续最近会话
npm run piq -- open friends
# 在当前终端新建空上下文
npm run piq -- open friends --new-session
# 查看组目录
npm run piq -- path friends
```

CLI 同样支持 `--root`；`init` 可重复使用 `--conversation group:GROUP_OPENID` 或 `--conversation private:USER_OPENID`。`open` 可在 `--` 后传入 Pi 参数。Pi 中的 `/piq` 查看状态，`/piq retry` 重试未确认的本地消息通知。

CLI `discover` 只显示实际收到的 `group:...` 或 `private:...`。在目标会话发送消息取得标识后，按 Ctrl+C 结束发现，再添加成员并打开 Pi；它与工作台发现功能一样占用当前 AppID。

## 连接、消息记录与限制

本地日志使用 JSONL v3，每行包含正文 `rawText`、完整平台事件 `raw` 和原样附件信息 `attachments`。平台的 `message_type` 包括文本 `0`、ARK 卡片 `3`、并行消息 `101`、聊天记录 `102` 和引用 `103`；`raw.msg_elements` 中的发送者、正文、附件、卡片和递归元素都应按收到的结构保留，不能仅因顶层正文为空就忽略消息。

收到附件时先保存平台提供的信息，不把附件存在等同于已下载或识别。平台提供的 `asr_refer_text` 是参考转写，完整字段仍在记录中。普通 Pi 输出留在本地会话，发送和流式更新都须明确指定目标并调用工具。

平台投递的其他机器人消息标记 `botAuthored: true`，与其他入站消息一起参与聚合并唤醒 Pi，由模型判断是否回应。`outgoing` 只表示本实例已经确认的自身发送；本机自身消息不产生唤醒通知。机器人来源与本机发送归属分别判断，发送回声先于回执到达时，会在收到确认回执后从待通知队列移除。

SDK 负责平台连接与重连；PiQ 的本地持久记录用于查询已收到的内容和恢复未处理通知。**当前版本不提供云端离线历史补拉。** 关闭 Pi 或平台没有投递的消息，不能靠本地日志恢复；SDK 恢复连接时能收到哪些事件仍取决于平台。

当前正式会话范围是官方机器人群聊与机器人私聊，不接管个人 QQ 账号，也不沿用旧群临时私聊或 OneBot 协议。官方 `message_type=102` 聊天记录从当前收到的事件中读取，与云端离线历史补拉分别处理。频道接口不作为群聊接口使用；本版也不会把仅支持频道的表情反应暴露为群聊工具。

群管理工具始终指定本组内的目标群。部分查询需要平台能力白名单，成员移除、禁言、黑名单和审批还需要对应管理授权；先查询再明确操作，结果未确认时不要自动重试。可选权限配置默认要求操作者批准这些新增操作。

入群自动审批策略只管理明确单独关联当前群的条目。创建时固定目标群，后续修改前重新核验；不允许借当前群操作跨群策略。该策略白名单按平台接口使用 QQ 号码字符串，其他会话和成员参数仍使用 OpenID。

消息发送可能受回复时效、主动消息授权、格式、大小和频率限制。依据工具返回的真实成功或失败结果判断，不把本地生成完成等同于已发到 QQ。结果未知时先检查平台状态，避免重复发送。

## 迁移旧工作区

这是一次明确的配置与消息格式切换。旧数字 QQ 号、旧消息 ID、临时会话标识和 OneBot 配置不能直接替换为官方 OpenID。

1. 停止旧 Pi 会话和工作台，将整个旧工作区保留为归档。
2. 使用新的空根目录启动本版本，例如 `node src/web.ts --root D:\PiQ-QQBot`。
3. 建立新对话组，在 Windows 工作台“连接设置”填写并保存 AppID/AppSecret，再用“发现对话”加入目标群聊和私聊。
4. 检查后按需复制人设、约定、记忆或媒体资料。保留旧消息和旧 Pi 会话作为归档，不将它们覆盖到新组的日志、运行状态或会话目录。

程序不自动扫描并转换旧工作区，不复用旧端点、令牌、补拉游标或旧消息格式。需要查看旧记录时，在归档目录中单独阅读。

## 开发、贡献与许可

```powershell
npm run verify
```

验证包含 TypeScript 检查和测试，使用临时目录、模拟 QQ 平台端点与 Pi 官方 faux 模型，不发送真实 QQ 消息。接入代码以官方 QQBot SDK 的公开接口为准。

感谢 [方缘（@Fangyuanz06）](https://github.com/Fangyuanz06) 在 [PR #1](https://github.com/Gliese-876/PiQ-Harness/pull/1) 中提供对话组管理、工作台主题等初始实现。采用其贡献的提交保留共同作者署名。

PiQ 源码采用 [AGPL-3.0-only](LICENSE)。腾讯 QQBot SDK 使用 MIT 许可；Pi 和可选扩展分别遵循自身许可。组件和声明见 [第三方组件说明](THIRD_PARTY_NOTICES.md)。
