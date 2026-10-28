# PiQ Harness

Keep the channel small: persist messages, aggregate a signal, and expose explicit sending.
Let Pi decide whether to read, reply, remember, or save assets. Do not forward normal assistant output.
Each conversation group owns one directory and one Pi Agent Session. Keep each member conversation's logs separate and use an explicit reply target. Read configuration from the current Pi context's cwd.
Human instructions belong in Markdown; conversation records belong in JSONL; credentials belong in environment variables.
Use the official @tencent-connect/qqbot-nodejs 1.0.5 SDK for QQ Open Platform access and retain its MIT notices. Do not add SnowLuma, OneBot, DSH, qqbot-connector, QR-login, or personal-account integration code. The Windows workbench is the only robot credential configuration entry point: it accepts AppID and password-field AppSecret input and saves group-cwd-specific Windows User environment entries. CLI connections read those same managed credentials; do not add alternate credential sources or legacy configuration compatibility. Never echo AppSecret or persist secrets in project credential files, PIQ.md, logs, source control, or API responses. The first save requires both credentials; an empty AppSecret preserves only the already-managed secret for the same group and AppID. Official conversation and message IDs are opaque strings; do not convert them to numeric QQ IDs or migrate legacy workspaces automatically.
Use `npm run verify` before delivery. Tests must use temporary directories and simulated QQ endpoints.
Never send a real QQ message as a test.

## QQ 发送频率与额度

核对日期：2026-10-28。以下规则适用于 QQ 群聊和机器人私聊。QPS 表示每秒请求数，QPM 表示每分钟请求数。

主动发送同时遵守机器人合计、单个接收方和每日额度：

| 场景 | 机器人合计上限 | 单个接收方上限 | 每日上限 |
| --- | --- | --- | --- |
| 群聊，企业或个人认证 | 60 条/分钟 | 每群 20 条/分钟 | 每群 1000 条 |
| 群聊，未认证 | 30 条/分钟 | 每群 20 条/分钟 | 每群 1000 条 |
| 私聊，企业或个人认证 | 10 条/秒 | 每用户 20 条/分钟 | 每用户 1000 条 |
| 私聊，未认证 | 5 条/秒，且 30 条/分钟 | 每用户 20 条/分钟 | 每用户 1000 条 |

同一机器人跨会话发送时合计计算机器人额度；文字、图片、语音、视频和文件按消息合计计算对应额度。认证状态未知时，按未认证的额度安排发送。主动发送还须取得目标用户或群的授权。来源：[消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)。

- 被动回复：群聊每条入站消息在 5 分钟内最多回复 5 次；私聊每条入站消息最多回复 4 次。私聊概述与接口页开头写有效期 60 分钟，但同一接口的 `msg_id` 字段仍写 5 分钟；本项目保守地在 5 分钟内完成私聊回复，实际有效性以平台返回为准。超过回复窗口后，停止使用该消息继续回复，不自动转为主动发送。来源：[发送群聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)、[发送单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)。
- HTTP 接口上限：群聊和私聊发送接口各为 100 QPS；私聊接口明确包括主动、被动等所有消息类型。私聊流式发送接口为 50 QPS，群聊使用普通发送接口。接口 QPS 与上述主动发送额度同时适用。来源：[群聊发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)、[私聊发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)、[私聊流式发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html)。
- 互动召回：用户主动联系机器人后，30 天内按当天、1–3 天、3–7 天、7–30 天四个周期，每周期最多 1 条；仅在获准并确需召回时显式调用 `qq_wakeup`。来源：[发送单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)。
- 发送前合并相关内容，减少零碎消息。遇到限频或额度耗尽，停止本批发送并按平台提示等待；发送结果未知时先核实结果，避免重复发送。保留工具维护的消息序号，不通过换工具、拆分内容、删除 `replyTo` 或反复改变 `msg_seq` 绕过限制。
