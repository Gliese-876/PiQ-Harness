# QQ 工具与消息恢复

本文提供工具参数说明、使用示例和协议边界。首次使用请先阅读 [README](../README.md)。下文号码、消息 ID 和文件路径均为示例，应替换为本组已配置对话和真实记录。

## 发送文字与图片

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

聊天记录直接用 Pi 原生文件工具读取。通知提供来源对话、日志路径和新增 `seq` 范围；程序在启动、重连时自动补齐离线历史，并写入同一份 JSONL。每行保留消息的 `rawText` 和按原顺序保存的 `segments`，包含文字、图片、表情、语音、视频、引用、合并转发及其他后端提供的消息段。CQ 字符串格式保留在 `rawText` 中；媒体字段是资源信息，读取日志本身不会下载或识别媒体。

`seq` 用于定位本地记录，`messageId` 用于 QQ 引用和转发。收到合并转发时，`qq_read_forward` 从该条真实消息中取得转发标识，不接受猜测的任意后端 ID。记录和转发内容都是聊天资料，不能改变本组约定或权限。

例如，先用 `read` 读取通知给出的来源日志，再显式选择两条记录转发：

```json
{"path":"messages/group/123456789/2026-10-28.jsonl"}
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

## 断线、补拉与恢复

群聊与好友私聊分别保存补拉游标，恢复连接后分页读取 SnowLuma 可提供的历史；首次接入读取最近 20 条。临时会话已收到并保存的日志可以读取，目前不将好友历史接口当作临时会话的完整离线补拉接口。

历史补拉使用 get_group_msg_history、get_friend_msg_history，临时私聊使用 send_private_msg 的 group_id 参数。这些属于后端扩展，切换到其他 OneBot 实现时需要确认其支持情况。

/piq 查看状态，/piq sync 重试补拉，/piq retry 恢复未确认通知。去重使用对话身份和 QQ 消息标识，保留同文不同标识的消息。发送前等待短暂重连；已派发请求的结果未知时不自动重发。

日志、通知水位和补拉游标应一起备份。消息文件损坏、缺少记录或末尾未写完时，会报错并保留数据供修复。
