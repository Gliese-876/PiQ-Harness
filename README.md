# PiQ Harness

让 Pi 参与 QQ 对话，在本地工作台管理会话、人设、记忆和资料。

**一个对话组对应一个 Pi 会话。** 同组可以包含多个 QQ 群聊、好友私聊和群临时会话，共用上下文与记忆，各自保存聊天日志。PiQ 先保存消息，再通知 Pi 哪些对话有更新；Pi 自主决定读取、回应或整理记忆。只有显式调用发送工具，内容才会发到 QQ。

PiQ 通过公开 OneBot 及后端 API 独立接入 SnowLuma，**不使用、不包含 SnowLuma SDK**。SnowLuma 和 Pi 均需单独安装。

- **终端运行**：工作台打开 Pi 终端，关闭终端即停止；需要批准的工具调用在终端确认。
- **对话组管理**：创建、重命名、移入回收站和恢复；可重开空上下文，保留资料与历史文件。
- **聊天工具**：文字、图片、语音、戳一戳、表情回应、群文件，以及聊天记录读取和合并转发。
- **按需扩展**：可搭配权限扩展、写入沙箱、`pi-web-access` 和 MiMo TTS，分别配置在需要它们的对话组。

## 快速开始

### 1. 准备环境和 Pi

| 组件 | 要求 |
| --- | --- |
| Node.js | 24 系列至少 `24.22.1`，或 `26.12.1` 及以上；以 [package.json](package.json) 的 engines 为准 |
| Pi Coding Agent | 本项目使用和验证的版本为 `1.4.0`；先完成模型认证与选择 |
| SnowLuma | 已安装并登录 QQ，启用 OneBot 11 正向 WebSocket 的 Universal 节点 |
| Windows Terminal | 工作台的“打开 Pi 终端”需要 `wt.exe`；其他环境可使用 CLI 在现有终端运行 |

Pi 可按[官方 Windows 说明](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/windows.md)安装，也可通过 npm 安装指定版本：

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.4.0
pi --version
pi
```

在 Pi 终端中使用 `/login` 配置模型访问，再用 `/model` 选择可用模型。原生 Windows 的默认 Bash 环境参见上述说明；本文推荐的权限配置使用 PowerShell。

### 2. 启动工作台

```powershell
git clone https://github.com/Gliese-876/PiQ-Harness.git
cd PiQ-Harness
npm ci
npm run web
```

打开 [http://127.0.0.1:3210](http://127.0.0.1:3210)。工作台只监听本机回环地址。

### 3. 创建第一个对话组

1. 点击“新建对话组”，填写名称；可以先创建空组并准备资料。
2. 在“对话”页添加 QQ 群聊、好友私聊等成员。每个对话只能属于一个组。
3. 在“连接设置”填入 SnowLuma 实际启用的 WebSocket 端点。PiQ 默认值是 `ws://127.0.0.1:3001/`，端口以你的后端配置为准。
4. 在“文档”页填写本组 `PERSONA.md` 和 `AGENTS.md`，在“模型”页选择可用模型与思考强度。
5. 点击“打开 Pi 终端”。首次运行时由本机操作者确认信任本组资源，使 Pi 加载 `.pi/settings.json` 中声明的 PiQ 扩展。

`wsUrl` 只填写端点地址，`accessTokenEnv` 填环境变量名，默认是 `SNOWLUMA_ACCESS_TOKEN`。令牌优先从该变量取得；本机端点也可读取匹配的本地 SnowLuma 配置，工作台只显示是否可用。远程后端使用环境变量。修改环境变量后，重新启动承载工作台和 Pi 的终端。

## 日常操作

| 操作 | 结果 |
| --- | --- |
| 打开 Pi 终端 | 继续本组最近会话；已有实例时提示切换到原终端 |
| 暂停 / 恢复 | 暂停生成与 PiQ 工具调用，继续保存收到的消息；工作台仍可查看日志 |
| 停止 / 关闭 Pi 终端 | 结束本组 Pi；下次打开时按后端能力补拉历史 |
| 重开会话 | 结束当前 Pi，打开空上下文；旧会话、聊天日志、人设、记忆和资料保留 |
| 重命名 | 修改显示名称，保留组标识和目录名 |
| 移入回收站 | 停止后将完整目录移到根目录 `.trash/` |
| 从回收站恢复 | 恢复原组；原标识或对话归属已被占用时提示冲突并保留数据 |

工作台右上角的“外观”默认选择“跟随系统”：系统深色使用石墨（Graphite），系统浅色使用明亮（Light）。也可手动选择午夜（Midnight）、玫瑰（Rose）、纸张（Paper）等配色；选择保存在当前浏览器，刷新后继续使用。

关闭工作台网页不会结束已打开的 Pi 终端。重开会话后，Pi 仍会加载本组约定，并可按需读取 `MEMORY.md` 等资料；这一操作清空的是当前模型上下文。

调整成员归属前先停止相关组。移出的对话在原组留下已有日志与记忆，新消息随后进入新归属组。未单独分配的群临时私聊，会归入来源 QQ 群所在组。

## 推荐配置：从日常聊天逐步扩展

建议先完成一个组的基本连接，再按需要增加能力。模型优先选择工具调用稳定、响应时间合适的选项；日常聊天从工作台提供的默认或较低思考强度开始，复杂任务再提高。下面的外部插件和技能**均为可选项**，不属于 PiQ 依赖，也不会随 `npm ci` 或创建对话组自动安装。

| 使用场景 | 推荐搭配 | 配置重点 |
| --- | --- | --- |
| 日常聊天、长期记忆 | PiQ + 一个可用的 Pi 模型 | 明确人设和回应频率，让 Pi 按需读取日志与整理记忆 |
| 允许读取、约束写入 | `@gotgenes/pi-permission-system` + `@yuru7/pi-sandbox` + 配套本地策略示例 | 普通写入限本组；保护文件编辑和 PowerShell 执行前由人批准 |
| 查资料、读网页与 PDF | 在前述组合上增加 `pi-web-access` | 配置搜索提供方、抓取缓存；网络工具初期保持询问 |
| 语音回复 | 增加 `mimo-v2-5-tts` 技能 | 用环境变量提供凭据；音频保存到本组，再由 `qq_voice` 发送 |

可在工作台显示的**本组目录**中安装已核对的版本：

```powershell
pi install -l npm:@gotgenes/pi-permission-system@40.3.0
pi install -l npm:@yuru7/pi-sandbox@0.4.1
# 需要联网能力时再添加
pi install -l npm:pi-web-access@0.45.0
```

安装后还需要放置权限配置、合并本组 Pi 设置，并重新打开终端。完整步骤、可复制的 JSON 和 Windows 临时目录适配见 **[可选扩展配置指南](docs/optional-integrations.md)**；基础组合从 [Pi 设置示例](examples/integrations/pi-settings.example.json)开始。

`pi-web-access` 提供 `web_search`、`fetch_content`、`get_search_content`、`source_check` 等工具；本文的保守示例只启用前三项。它会自行管理缓存，也提供 GitHub 克隆等功能；这些内部读写不自动经过 yuru7 接管的命令工具。推荐先使用指南中的保守配置，明确缓存位置，按需开启克隆、远程抓取和视频处理。[联网配置](docs/optional-integrations.md#pi-web-access)提供 [Pi 设置示例](examples/integrations/pi-settings.web.example.json)和 [web-search.json 示例](examples/integrations/web-search.example.json)；请先确认它们各自的配置作用域。

权限组合提供工具审批和受限命令执行。读取仍按当前用户权限开放；任意脚本以整条命令接受批准，获批后仍可修改组内文件。Windows 沙箱的已知限制，以及保护文件的实际范围，在配置指南中单独说明。

## 使用建议

### 按信任关系组织对话

把适合共享人设和记忆的对话放在同一组，例如一个项目群与该项目的协作私聊。涉及不同客户或不同私人关系时分组管理。目录分组管理的是会话和日志，操作系统访问范围由运行环境及所选权限扩展决定。

在本组 `AGENTS.md` 写清什么时候回应、什么时候保持沉默、哪些内容适合跨对话分享。转发记录时先确认接收者；同属一个对话组也要尊重各对话原来的可见范围。

### 让上下文和资料各有位置

| 内容 | 推荐位置 |
| --- | --- |
| 行为约定、回复规则 | 公共或本组 `AGENTS.md` |
| 人设、语气、稳定偏好 | 本组 `PERSONA.md`；需要每次加载时在 `AGENTS.md` 明确要求读取 |
| 从真实互动整理的长期信息 | 本组 `MEMORY.md`，注明来源和日期 |
| 图片、语音、群文件下载 | 本组 `assets/`，例如 `assets/voices/`、`assets/downloads/` |
| 聊天流水 | PiQ 维护的 `messages/`，使用读取工具查询 |
| 密钥与令牌 | 环境变量或 Pi 自身的认证机制，不写入聊天、角色和记忆文档 |

长会话积累过多临时任务时，可以先让 Pi 整理确有保留价值的信息，再“重开会话”。维护备份时停止本组，整体备份组目录；聊天日志、通知水位和补拉游标一起保留。

### 控制群聊回应频率

默认参数适合作为起点：静默等待 1.5 秒，连续发言最多聚合 10 秒，两次通知至少间隔 15 秒。活跃群可尝试 `quietMs: 2500`、`maxWaitMs: 15000`、`minIntervalMs: 30000`，减少连续唤醒，再按实际聊天节奏调整。

联网时先把需求整理成简短查询词，按需读取结果，再决定如何回复。网页和转发内容都作为资料处理；搜索提供方会收到查询内容，因此不要自动把整段私人聊天发送给它。

## 工作目录与配置

默认根目录是系统“文档”文件夹下的 `PiQ-Messages`。工作台支持 `--root` 和 `--port`：

```powershell
npm run web -- --root D:\PiQ-Messages --port 3211
```

```text
PiQ-Messages/
  AGENTS.md                     公共约定
  .trash/                       可恢复的已删除组
  friends/
    PIQ.md                      成员、连接和聚合参数
    AGENTS.md                   本组约定
    PERSONA.md                  本组人设
    MEMORY.md                   按需创建的长期记忆
    assets/                     资料与媒体
    messages/
      group/<群号>/<日期>.jsonl
      private/<QQ号>/<日期>.jsonl
      temporary/<来源群>/<QQ号>/<日期>.jsonl
    .pi/settings.json           Pi 模型、扩展与技能设置
    .pi/sessions/               Pi 会话历史
    .piq/                       运行状态、归属和消息水位
```

`PIQ.md` 中保留一个带 `json` 标签的代码块，例如：

```json
{
  "id": "friends",
  "name": "朋友",
  "conversations": [
    { "type": "group", "id": "123456789", "name": "交流群" },
    { "type": "private", "id": "987654321", "name": "朋友" }
  ],
  "wsUrl": "ws://127.0.0.1:3001/",
  "accessTokenEnv": "SNOWLUMA_ACCESS_TOKEN",
  "quietMs": 1500,
  "maxWaitMs": 10000,
  "minIntervalMs": 15000
}
```

号码和端点请替换为实际配置。扩展各自的设置放在其指定位置，不往 `PIQ.md` JSON 中添加未知字段。连接与聚合参数修改后重启本组；工作台修改模型和思考强度时，会尝试通过 Pi 原生接口应用到后续请求。

## 工具与 CLI

| 能力 | 工具 |
| --- | --- |
| 发送文字和图片 | `qq_send` |
| 读取本地聊天 | Pi 原生 `read`、`grep` 等文件工具，按通知中的日志路径和序号定位 |
| 读取合并转发、显式转发记录 | `qq_read_forward`、`qq_forward` |
| 发送本地或 QQ AI 语音、语音转写 | `qq_voice` |
| 戳一戳、表情回应、撤回本账号消息 | `qq_poke`、`qq_react`、`qq_recall` |
| 收藏表情、群文件、群相册 | `qq_sticker`、`qq_group_files`、`qq_album` |

参数、JSON 示例、适用对话类型及大小限制见 **[QQ 工具与消息恢复](docs/qq-tools.md)**。`messageId` 是 QQ 消息 ID，可能为负数；`seq` 是本地日志序号。

```powershell
# 创建组；--conversation 可以重复
npm run piq -- init friends --name "朋友" --conversation group:123456789 --url ws://127.0.0.1:3001/
# 在当前终端继续最近会话
npm run piq -- open friends
# 在当前终端新建空上下文
npm run piq -- open friends --new-session
# 查看组目录
npm run piq -- path friends
```

CLI 同样支持 `--root`，`open` 可在 `--` 后传入 Pi 参数。临时私聊标识使用 `temporary:来源群号:QQ号`。Pi 中的 `/piq` 查看通道状态，`/piq sync` 重试补拉，`/piq retry` 重试未确认的通知。

## 常见问题

**打开了终端，但没有回复。** 先确认 Pi 已信任本组资源、模型可用、QQ 后端在线，并且本组没有暂停。聚合计时、当前任务和历史补拉会推迟通知；Pi 也会根据约定选择保持沉默。

**SnowLuma 没有自动启动。** PiQ 可以尝试启动默认“文档/SnowLuma”位置的本机安装。其他安装位置可手动启动后端，再填写实际端点和令牌环境变量。`PIQ_SNOWLUMA_AUTOSTART=0` 可关闭扩展内自动拉起；连接重试不等于 Pi 关窗后恢复运行。

Windows 下自动启动的 SnowLuma 及其子进程共用隐藏控制台，Pi 使用可见终端。自动启动日志保存在 SnowLuma 安装目录的 `logs/piq-launch-*.stdout.log` 和 `logs/piq-launch-*.stderr.log`，启动失败时可在本机查看。

**关闭终端期间的消息能否补回？** 群聊和好友私聊按后端可提供的历史补拉，首次接入取最近 20 条。暂时失败时保留补拉位置，并在连接正常时自动重试；工作台会显示补拉错误，也可用 `/piq sync` 立即重试。群临时私聊目前保留已收到的本地日志，完整离线补拉取决于后端能力，不能按好友历史处理。

**删除后恢复失败。** 检查原组标识是否被新目录占用，以及成员对话是否已归属其他组。解决冲突后再恢复；回收站中的原数据会保留。

**更换 OneBot 后端是否能直接使用？** WebSocket 通信按 OneBot 11 独立实现；历史补拉、临时会话、群文件和相册等能力还依赖后端公开扩展 API，迁移时需逐项确认。

## 开发、贡献与许可

```powershell
npm run verify
```

验证包含 TypeScript 检查和测试。测试使用临时目录、模拟 QQ 端点与 Pi 官方 faux 模型，不发送真实 QQ 消息。网络接入依据 [OneBot 11 标准](https://github.com/botuniverse/onebot-11)及 [SnowLuma 公开 API 目录](https://github.com/SnowLuma/SnowLuma/blob/main/packages/mcp/src/generated/catalog.json)，始终独立实现。

感谢 [方缘（@Fangyuanz06）](https://github.com/Fangyuanz06) 在 [PR #1](https://github.com/Gliese-876/PiQ-Harness/pull/1) 中提供对话组管理、合并转发读取和工作台主题的初始实现。采用其贡献的提交保留共同作者署名。

本项目采用 [AGPL-3.0-only](LICENSE)。SnowLuma、Pi 以及可选插件和技能分别遵循自身许可，详见 [第三方组件说明](THIRD_PARTY_NOTICES.md)。
