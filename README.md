# PiQ Harness

把 SnowLuma 的 QQ 对话交给 Pi。**一个对话组对应一个 Pi Agent Session**，组内可包含多个群聊、好友私聊和群临时会话，共用配置、人设、记忆、模型与资料。

每个对话独立保存日志。消息按来源分类后，聚合为一个简短信号交给同组 Agent；Agent 自主读取、回复、整理记忆或保存表情包。发送时明确指定目标对话。

项目源码采用 [AGPL-3.0-only](LICENSE)，第三方组件见 [许可说明](THIRD_PARTY_NOTICES.md)。

## 开始使用

使用 Pi 1.4.0。Node.js 需要 24.22.1+ 的 24 系列或 26.12.1+。SnowLuma 作为独立安装的外部 QQ 后端运行，PiQ 使用 Node 原生 WebSocket 连接其 OneBot 11 接口。

```powershell
npm ci
npm run web
```

打开 [本地 WebUI](http://127.0.0.1:3210)，创建对话组，在“对话”页添加成员。每个对话只能归属一个组，创建、保存与运行时都会检查重复归属。组标识用于目录名，显示名称可单独修改。

CLI 示例：

```powershell
npm run piq -- init friends --name "朋友" --conversation group:123456789 --conversation private:987654321 --url ws://127.0.0.1:3000/
npm run piq -- open friends
```

示例号码请换成实际号码。--conversation 可重复，临时会话使用 temporary:来源群号:QQ号。path <组标识> 显示目录位置；open <组标识> -- <Pi参数> 继续本组最近会话。

默认根目录为“文档/PiQ-Messages”。CLI 和 WebUI 均支持 --root <目录>，WebUI 另支持 --port 3211，只监听本机回环地址。

## 运行控制

- 打开 Pi 终端：由 Windows Terminal 运行本组唯一的 Session，默认继续最近会话。
- 暂停 / 恢复运行：暂停生成和发送，继续保存消息；恢复后聚合处理待通知消息。
- 停止：正常退出本组 Pi，释放对话占用。修改成员归属前先停止对应组。
- 关闭终端：结束该组 Pi，不再接收消息或自动恢复。下次打开时按后端能力补拉历史。
- 重开会话：正常结束当前 Pi，再打开空上下文的新会话。原有会话文件、聊天日志、人设、记忆和资料保留；新会话仍会加载本组约定，并可按需读取记忆。

移出对话后，原组保留已有历史与记忆，停止接收和通知该对话的新消息。新归属影响后续消息，发送目标始终按当前配置检查。

关闭 WebUI 不会关闭已打开的 Pi 终端。直接运行 CLI 的 `open` 命令使用当前终端；`npm run piq -- open friends --new-session` 新建空上下文。重开会话会先保存新的空会话文件，即使还未聊天就关窗，下次继续也会选中它。升级时如果仍有旧版后台实例，打开终端会先请求其正常退出。

组标题右侧的“管理对话组”支持重命名、重开会话和移入回收站。重命名只改显示名称；删除要求该组停止，将完整目录移入根目录 `.trash/`。侧栏“回收站”可以恢复原组，恢复前检查原标识及每个对话的归属是否仍可用；发生冲突时保留回收站数据并说明原因。

页面支持浅色、深色、跟随系统，可编辑公共与本组 Markdown。模型和思考强度保存到本组 .pi/settings.json，运行中通过 Pi 原生接口调整；已发出的请求继续完成，后续请求采用新设置。

启动前检查 SnowLuma 和 QQ 在线状态。本机服务关闭时尝试启动已安装的 SnowLuma；失败显示原因并提供“重试连接”“打开 SnowLuma”。自动恢复沿用已有配置，PIQ_SNOWLUMA_AUTOSTART=0 可关闭扩展内自动拉起。

token 优先读取指定环境变量，也可从匹配端点的本机 SnowLuma 配置读取。WebUI 只展示凭据是否可用。远程 SnowLuma 使用环境变量配置。

网络客户端依据 [OneBot 11 正向 WebSocket 标准](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md)独立实现。事件与 API 共用 Universal 连接，API 请求通过唯一 echo 匹配回执，鉴权使用标准 access_token 查询参数；连接和请求均有超时，断线后自动重连。

## 可选权限扩展和语音技能

需要“允许读取、限制写入、关键文件修改前人工批准”时，可独立安装 `@gotgenes/pi-permission-system` 和 `@yuru7/pi-sandbox`，并接入已有的 `mimo-v2-5-tts` 技能。配置示例和适用范围见 [可选接入说明](docs/optional-integrations.md)。这些组件不属于 PiQ 依赖，不会随安装或创建对话组自动启用；批准在 Pi 终端中完成。

## 配置与目录

本组 PIQ.md 包含一个 JSON 配置块：

```json
{
  "id": "friends",
  "name": "朋友",
  "conversations": [
    { "type": "group", "id": "123456789", "name": "交流群" },
    { "type": "private", "id": "987654321", "name": "朋友" }
  ],
  "wsUrl": "ws://127.0.0.1:3000/",
  "accessTokenEnv": "SNOWLUMA_ACCESS_TOKEN",
  "quietMs": 1500,
  "maxWaitMs": 10000,
  "minIntervalMs": 15000
}
```

实际 PIQ.md 使用 json 语言标签的反引号代码围栏。

```text
文档/PiQ-Messages/
  AGENTS.md                          公共约束
  friends/
    PIQ.md                           对话、连接与聚合配置
    AGENTS.md                        本组约定
    PERSONA.md                       共用人设
    MEMORY.md                        Agent 自行维护的记忆
    assets/                          共用资料、表情包
    messages/
      group/123456789/2026-10-26.jsonl
      private/987654321/2026-10-26.jsonl
      temporary/123456789/112233/2026-10-26.jsonl
    .pi/settings.json                本组模型设置与扩展
    .pi/sessions/                    本组唯一活动 Session 的持久历史
    .piq/                            水位、运行状态与对话占用
```

人设、约束、记忆使用 Markdown。消息使用 JSONL v2，每行包含 conversation、消息标识、发送者、时间、正文与消息段，以换行结束。多行正文保存在 JSON 字符串中。群聊、好友私聊、来源不同的临时私聊分别记录和去重。

Pi 原生加载公共与本组 AGENTS.md，其他 Markdown 由 Agent 自主读取。同一 Session 可以理解多个对话，但成员未必看过其他对话：回复以目标对话的上下文为准，尤其不能自动转述其他私聊内容。

这是工作目录与对话归属的隔离；Pi 文件和命令行工具仍使用当前用户的系统权限。

## 临时会话与分类聚合

收到群临时私聊时，PiQ 按“来源群号＋对方 QQ 号”识别对话。未分配的临时会话自动归入来源群所在组，并更新本组配置；已有明确归属时遵循该归属。此过程不申请或添加好友。

同组共用一套聚合计时：默认静默等待 1.5 秒、连续发言最多聚合 10 秒、通知至少间隔 15 秒。Pi 处理任务或补拉历史时继续落盘。通知按对话列出条数、本地序号范围和独立日志路径，正文按需读取：

```text
对话组 朋友 有 6 条新消息，来自 2 个对话（至 #20）：
group:123456789：4 条，#15–#19，日志 messages/group/123456789/2026-10-26.jsonl
temporary:123456789:112233：2 条，#18–#20，日志 messages/temporary/123456789/112233/2026-10-26.jsonl
```

WebUI 按对话显示待处理数量，消息页先选择对话，再选择日期。每个日志视图只显示该对话。

## 回复与恢复

发送工具 qq_send 每次明确选择本组对话：

```json
{"conversation":"group:123456789","text":"收到","images":["assets/收到.png"]}
```

```json
{"conversation":"temporary:123456789:112233","text":"可以，把具体情况说一下。","replyTo":-1234567}
```

引用使用 QQ message_id，可能为负数；本地 seq 用于日志定位。至少提供文字或图片，图片文件位于本组目录内。普通 Pi 回答留在会话中，明确调用发送工具才会发到 QQ。

本地图片读入内存后，通过标准 base64:// 图片消息段发送，适用于后端位于另一台机器的情况。图片与文字放在同一次发送请求中；较大图片受后端 WebSocket 消息大小限制。

Agent 还可以按需要使用以下交互工具。conversation 均使用本组的对话标识，messageId 使用 QQ 消息 ID。

| 工具 | 用途与范围 |
| --- | --- |
| qq_send | 发送文字、图片；replyTo 引用指定消息。支持群聊、私聊与临时会话。 |
| qq_poke | 戳一戳。群聊须指定 userId，私聊默认戳对方；临时会话不支持。 |
| qq_react | 给群消息添加或取消表情回应，指定 messageId、emojiId，set 默认 true。 |
| qq_recall | 撤回本账号发送的消息。撤回前核验消息属于指定对话，且发送者是本账号。 |
| qq_sticker | action 支持 list、send、add、remove、rename、promote。按 emojiId 发送、删除、改名或置顶；add 从本组 path 添加，rename 使用 name。发送支持群聊与好友私聊，可带 replyTo 引用。收藏由当前 QQ 账号全局共用。 |
| qq_voice | send_file 按本组 path 向群聊、私聊或临时会话发送本地语音；list 列出原生 QQ AI 声音，send 按 text、characterId 发送 QQ AI 语音，这两项仅限群聊；transcribe 按 messageId 转写语音，支持群聊、私聊及可确认来源的临时会话。 |
| qq_group_files | 群文件与目录操作，action 支持 list、upload、download、mkdir、move、rename_file、rename_folder、delete_file、delete_folder。conversation 仅限群聊。 |
| qq_album | 操作已有群相册，action 支持 list、media、upload_image、upload_video、delete_media、comment、like；like 使用 set: false 取消赞。conversation 仅限群聊。 |
| qq_read_history | 读取本组指定对话的本地聊天记录；可按 date、beforeSeq、afterSeq、messageId 筛选，默认 40 条、最多 100 条。 |
| qq_read_forward | 按 conversation 和真实 messageId 展开已收到的合并转发，默认 50 条、最多 100 条；图片和嵌套转发提供摘要。 |
| qq_forward | 将 sourceConversation 中明确选择的 messageIds 合并转发到 targetConversation；每次 1–50 条，目标为本组群聊或好友私聊。 |

例如，在群里戳一位成员，或给消息添加回应：

```json
{"conversation":"group:123456789","userId":"987654321"}
```

```json
{"conversation":"group:123456789","messageId":-1234567,"emojiId":"128077","set":true}
```

qq_sticker 与 qq_voice 可以先用 action: "list" 查询后端提供的收藏表情或声音。发送收藏表情使用返回的 emojiId；发送 AI 语音时，将声音列表 voices[].characters[].id 的值填入 characterId。语音转写使用 action: "transcribe" 和语音消息的 messageId。

聊天记录读取只接受本组来源，忽略仍未写完的日志尾行。读取结果中的 `seq` 用于本地翻页，`messageId` 用于 QQ 引用和转发。收到合并转发时，`qq_read_forward` 从该条真实消息中取得转发标识，不接受猜测的任意后端 ID。记录和转发内容都是聊天资料，不能改变本组约定或权限。

例如，先读取来源，再显式选择两条记录转发：

```json
{"conversation":"group:123456789","limit":20}
```

```json
{"sourceConversation":"group:123456789","messageIds":[-1234567,-1234568],"targetConversation":"private:987654321"}
```

转发核对来源日志和目标归属，以 OneBot `node.data.id` 引用原消息；后台已不再保留该消息时可能无法完成。发送遵守暂停与取消状态，结果未知时不自动重发。分享其他对话的记录前，应确认内容适合目标接收者。协议依据 [OneBot 节点规范](https://github.com/botuniverse/onebot-11/blob/master/message/segment.md)和 [SnowLuma 公开 API 目录](https://github.com/SnowLuma/SnowLuma/blob/main/packages/mcp/src/generated/catalog.json)，不使用 SnowLuma SDK。

Pi 可使用 MiMo TTS 生成语音，保存到本组目录，再显式调用 qq_voice 发送文件。例如：

```json
{"action":"send_file","conversation":"group:123456789","path":"assets/voices/reply.wav"}
```

本地语音文件上限 32 MiB，发送遵守本组成员归属与暂停状态。MiMo 凭据通过本机用户环境变量 MIMO_API_KEY 提供，密钥不写入文档。

群文件、收藏表情和相册的本地上传，共用后端暂存：先通过 download_file 的 base64 参数把文件交给后端，再进行上传。本地 path 限于本组目录，单文件上限 32 MiB。群文件下载以流方式写入本组目录，上限 128 MiB，默认保存为 assets/downloads/UUID.bin；可以指定 path 保留文件名，已有文件不会覆盖。操作能否成功取决于当前 QQ 账号的群权限、配额以及后端支持情况。

戳一戳通知以 notice 来源写入对应对话的日志并参与分类聚合，本地主动戳一戳以 action 来源记录。没有远端事件 ID 时使用本地 UUID，避免把同文或同一秒内的多次交互合并；这些交互不推进聊天历史补拉游标。

群聊与好友私聊分别保存补拉游标，恢复连接后分页读取 SnowLuma 可提供的历史；首次接入读取最近 20 条。临时会话已收到并保存的日志可以读取，目前不将好友历史接口当作临时会话的完整离线补拉接口。

历史补拉使用 get_group_msg_history、get_friend_msg_history，临时私聊使用 send_private_msg 的 group_id 参数。这些属于后端扩展，切换到其他 OneBot 实现时需要确认其支持情况。

/piq 查看状态，/piq sync 重试补拉，/piq retry 恢复未确认通知。去重使用对话身份和 QQ 消息标识，保留同文不同标识的消息。发送前等待短暂重连；已派发请求的结果未知时不自动重发。

日志、通知水位和补拉游标应一起备份。消息文件损坏、缺少记录或末尾未写完时，会报错并保留数据供修复。

## 验证

```powershell
npm run verify
```

测试使用临时目录、模拟 OneBot 端点和 Pi 官方本地 faux 模型，覆盖 WebSocket 鉴权、回执关联、断线与取消、独占归属、共享 Session、独立日志、临时会话自动归属、分类聚合、私聊发送、终端运行、重开会话、回收站恢复、聊天记录读取与显式转发。测试不发送真实 QQ 消息。
