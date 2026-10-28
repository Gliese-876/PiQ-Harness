# 可选 Pi 扩展、联网与语音

PiQ 只提供 QQ 通道和对话组管理。以下包由用户独立安装到 Pi，不是 PiQ 的依赖，也不会随 `npm ci`、创建对话组或启动工作台自动安装。PiQ 可以在没有它们的情况下运行。

本文按 2026-10-27 的 npm 发布包核对：

| 接入阶段 | 可选组件 | 示例固定版本 | 建议用途 |
| --- | --- | --- | --- |
| 基础聊天 | PiQ 与 Pi | Pi `1.4.0` | 先验证本组终端、日志与显式回复 |
| 权限 | `@gotgenes/pi-permission-system` | `40.3.0` | 文件和工具的允许、拒绝、人工批准规则 |
| 写入隔离 | `@yuru7/pi-sandbox` | `0.4.1` | 标准文件工具的写入检查，以及受限命令进程 |
| 联网 | `pi-web-access` | `0.45.0` | 按需搜索、读取网页和取回缓存内容 |
| 语音 | `mimo-v2-5-tts` 技能 | 使用主人已安装的技能 | 合成音频后由 `qq_send_file` 以 `kind: "voice"` 显式发送 |

两个包声明的 Pi 版本范围包含 PiQ 使用的 Pi 1.4.0。更新包之前应重新核对配置与行为；npm 固定版本和上游 GitHub `main` 可能不同。

推荐按表中顺序逐步接入。需要联网再增加 web-access，需要语音再登记 MiMo 技能；无需为了普通 QQ 聊天启用所有扩展。

先按 [README](../README.md#快速开始)完成官方机器人连接。机器人凭据统一在 Windows 工作台“连接设置”直接填写 AppID 和 AppSecret 密码框，保存到当前用户的环境变量；密钥保存后不回显，不进入项目凭据文件、日志或接口响应。首次保存填写两项；同一 AppID 的 AppSecret 留空，仅保留此前在工作台为本组保存的值。随后用“发现对话”选择加入本组的群聊和私聊。CLI 连接也使用这份已保存的凭据，当前没有其他操作系统的机器人凭据配置入口。搜索提供方、生图登录和 `MIMO_API_KEY` 仍按各自插件或技能的说明配置。

## 配置范围

在每个需要启用的对话组中独立配置。Pi 的工作目录必须是该组目录，例如 `文档/PiQ-Messages/friends`，不能是整个 `PiQ-Messages`。同一组终端里的人工审批由本机操作者作出；普通 QQ 发言不能充当批准。

外部扩展的配置按组保存，机器人连接仍遵守同 AppID 仅一个活动组的规则。一个机器人需要处理多个群聊或私聊时，将这些会话放在同组；更换 AppID 时新建组，保留旧组作为原账号的记录。

示例配置采用以下规则：

- 文件读取允许，组外读取也允许。
- 标准文件工具可以写本组普通文件，组外写入拒绝。
- 标准工具写入 `PERSONA.md`、`AGENTS.md`、`PIQ.md` 前询问。
- 标准工具写入 `.pi/` 配置、`.piq/` 运行状态和 `messages/` 日志时拒绝；这些目录仍由可信 Pi/PiQ 代码正常维护。
- Windows 的 `powershell` 每次执行前询问，`bash` 禁用。未知扩展工具默认询问。PiQ 已明确限制本地路径的 QQ 工具可以正常使用。
- 关闭模型自动审批和目录扩权，配套可选 hook 拒绝 Agent 的无沙箱重试。

权限示例只默认放行基础发送 `qq_send` 和 `qq_send_file`；结构化发送、撤回、流式发送和群管理等其他工具仍按默认 `ask` 由人确认。对话使用官方 OpenID，不要从旧权限文件沿用个人号、OneBot 或旧媒体工具的说明。

### 用原生读取工具减少审批

示例明确启用 Pi 原生 `read`、`grep`、`find`、`ls`：查看文件用 `read`，列目录用 `ls`，找文件用 `find`，搜索内容用 `grep`。权限示例已经允许这些读取操作；无需先生成 PowerShell 命令，也无需新增一套命令识别扩展。

Pi 默认工具集已有 `read`，settings 示例中的 `+grep`、`+find`、`+ls` 补齐另外三个。仅在权限文件中写 `allow` 不会自动激活工具。使用全新的终端会话加载更改；本机已检查所需 `rg`、`fd` 并实际验证四个原生读取工具可用。

需要运行程序、脚本或执行文件修改时，仍使用 `powershell` 并批准本次操作。Pi 原生 `bash` 可以通过 Git Bash 在 Windows 运行，但 **yuru7 0.4.1 的 Windows 受限执行只支持 PowerShell**：该插件将 `bash` 隐藏，受限模式下也拒绝执行。添加 `+bash` 无法使它获得受限执行能力；保持目前的 `-bash` 配置。

审批时选择 **Yes / 本次允许**。`Yes, allow ... for this session` 会允许后续匹配操作跳过询问；需要每次确认保护文件或命令时，不要选择会话放行。

## 安装与示例文件

先停止该对话组，在普通本机终端进入该组目录，执行：

```powershell
pi install -l npm:@gotgenes/pi-permission-system@40.3.0
pi install -l npm:@yuru7/pi-sandbox@0.4.1
```

`-l` 将包声明写入本组 `.pi/settings.json`，不会为所有普通 Pi 会话开启权限规则。Pi 负责获取包及其运行依赖。首次打开时需要由主人确认项目资源可信。不要在模型生成的命令中自动确认这个信任决定。

将仓库内的示例分别放到以下位置；修改已有文件前先备份，并保留原有模型、包和技能设置：

| 示例 | 放置位置 |
| --- | --- |
| [`permissions.json`](../examples/integrations/permissions.json) | `<组目录>/.pi/extensions/pi-permission-system/config.json` |
| [`pi-sandbox.json`](../examples/integrations/pi-sandbox.json) | `<组目录>/.pi/pi-sandbox.json` |
| [`pi-settings.example.json`](../examples/integrations/pi-settings.example.json) | 将需要的字段合并进 `<组目录>/.pi/settings.json` |
| [`pi-settings.web.example.json`](../examples/integrations/pi-settings.web.example.json) | 在权限示例基础上增加 web-access 的本组设置 |

`pi-settings.example.json` 中的 `C:/tools/PiQ-Harness` 是占位安装目录，必须换成本机真实路径。保留已有的 PiQ 包声明，不要重复添加。`defaultTools` 的 `+grep`、`+find`、`+ls`、`+powershell` 增加内置工具，`-bash` 移除原生 Bash 选择；其他已有选择也应保留。yuru7 对同名工具的接管和 Windows Bash 隐藏由插件自身处理。

### 禁止 Agent 提权的可选 hook

[`no-escalation.ts`](../examples/integrations/no-escalation.ts) 是独立的配置配套示例，不在 PiQ 的 `package.json` 资源清单中。只有主人在 Pi 的 `extensions` 中明确配置它时才会加载。

它拒绝 `sandbox_grant_write`，以及任何工具携带的 `sandbox_permissions: "danger-full-access"`。Pi 在实际执行工具之前触发 `tool_call`，因此拒绝会阻止 yuru7 的无沙箱重试。Windows 下它还在 `session_start` 将当前 Pi 进程的临时目录设为本组真实目录，以适配下述 yuru7 临时目录限制；其余调用交给两个外部包处理。

可以按 settings 示例直接引用仓库中的这个文件，也可以把它复制到主人维护的受信任目录并引用绝对路径。不要让 Agent 修改其代码、包声明或权限配置。主人主动在终端输入的 `!` 命令、`/permission` 等操作仍属于人工操作；不要通过这些入口解除本来要保留的边界。

### Windows 临时目录

yuru7 的 Windows 沙箱默认允许写入进程的 `%TEMP%`，但 `0.4.1` 的原生运行器拒绝该目录位于工作区的子目录中。把 `TEMP` 设置为 `<组目录>/.tmp` 会导致受限命令在执行前报错。

配套 `no-escalation.ts` 在 Windows 的 `session_start` 中把 `TEMP`、`TMP`、`TMPDIR` 设为 `realpath(ctx.cwd)`，即**本组根目录本身**。这与工作区是同一个可写根，不会额外开放组外目录。实际 Pi 1.4.0 与这两个发布版本已在隔离临时会话中验证：该 hook 生效后，获批 PowerShell 可写本组文件，尝试写同级组外文件仍被 Windows ACL 拒绝。

此设置只影响加载了这个可选 hook 的 Pi 进程及其后续子进程，不修改系统、用户或启动它的外部终端环境。会话关闭时会恢复尚未被其他组件改动的原值。其他操作系统不调整环境变量。PiQ 通用启动方式仍可使用本组 `.tmp`；仅启用这个外部集成时由 hook 应用上述兼容设置。

受限命令生成的临时文件可能出现在组根目录；Python 的正常音频输出仍应显式指定为 `assets/voices/...`。需要手工复现同一环境时，在专用终端中使用：

```powershell
$piqGroup = 'C:\Users\你的用户名\Documents\PiQ-Messages\friends'
$piqTemp = (Resolve-Path -LiteralPath $piqGroup).Path
$env:TEMP = $piqTemp
$env:TMP = $piqTemp
$env:TMPDIR = $piqTemp
Set-Location -LiteralPath $piqGroup
pi --continue
```

手工命令的环境变量只针对该终端进程及其子进程设置，不要把某一组目录设置为系统全局临时目录。工作目录不能使用指向组外的目录联接或符号链接。yuru7 在 Linux/macOS 还会允许 `/tmp`，本文示例按 Windows 配置。

## pi-web-access

需要搜索当前资料或读取网页时，可在目标组目录安装固定版本：

```powershell
pi install -l npm:pi-web-access@0.45.0
```

已有全局安装时，Pi 会继承它；本组同名包声明可以用于固定版本。不要复制一套插件源码进 PiQ，也不要修改 PiQ 的 `package.json`。完整 settings 参考 [`pi-settings.web.example.json`](../examples/integrations/pi-settings.web.example.json)，合并时保留已有模型和包设置。

0.45.0 的默认工具名为：

| 工具 | 用途 |
| --- | --- |
| `web_search` | 查询指定搜索提供方，返回结果和 `responseId` |
| `fetch_content` | 把网页、PDF 等读取为内容；启用克隆时还可下载 GitHub 仓库 |
| `get_search_content` | 用 `responseId` 分页或检索已保存的搜索、抓取结果 |
| `source_check` | 为指定说法汇集搜索证据；基础示例暂不启用 |

在 `auto` 或 `dynamic` 激活方式下，还可能先提供 `web_enable`。下面的基础示例使用 `eager`，让前三个工具从新会话开始就可见，减少“联网工具尚未启用”的疑惑。更改后关闭终端并重开会话。

### 基础配置

[`web-search.example.json`](../examples/integrations/web-search.example.json) 可作为起点：固定 Exa 搜索，`workflow: "none"` 默认不额外生成摘要；网页只使用直接 HTTP 抓取和 `readable/raw` 模式；关闭浏览器 Cookie、自动打开浏览器、GitHub 自动克隆、视频分析和证据汇总工具；PDF 使用本地 `unpdf` 提取文字。

无 API key 时，Exa 可以使用上游提供的 MCP 搜索入口；可用性仍取决于服务和网络。有自己的 Exa key 时可以添加 `"exaApiKey": "$EXA_API_KEY"`，由启动环境提供值。没有设置该环境变量时不要添加这条显式来源。其他提供方也应使用文档支持的环境变量引用，例如 `"braveApiKey": "$BRAVE_API_KEY"`，同时调整 `provider` 和 `webSearch.allowedProviders`，避免把真实密钥写进示例或仓库。

该插件默认读取 **`~/.pi/agent/web-search.json`**；已有旧配置 `~/.pi/web-search.json` 或 XDG 设置时按插件自己的兼容规则选取。**这是个人共享配置，会影响所有使用它的 Pi 会话，不是本组独立配置。** `PI_CODING_AGENT_DIR` 会改变整个 Pi agent 目录及该配置路径，不能仅为联网功能随意改它。**0.45.0 没有 `PI_WEB_ACCESS_CONFIG_DIR`，也不会自动读取本组 `.pi/web-search.json`。** 修改共享配置前先备份；已有认证和有意启用的功能按需合并。示例中的 `authFetch: {}` 会清空已配置的浏览器认证抓取 profile，使用前确认是否符合其他会话的需要。

### 缓存与权限

保持仓库 [`permissions.json`](../examples/integrations/permissions.json) 的未知工具默认 `ask`，联网工具执行前由操作者确认。若现有个人规则已经全局放行，应在本组 `permission` 中显式加入：

```json
{
  "web_enable": "ask",
  "web_search": "ask",
  "fetch_content": "ask",
  "get_search_content": "ask",
  "source_check": "ask"
}
```

不要因为名称是“读取网页”就批量设为 `allow`：`fetch_content` 会写缓存，启用 GitHub 克隆后会直接启动 `git` 或 `gh`；它们运行在扩展自身的宿主权限下，不会自动经过 yuru7 接管的 PowerShell 工具。

0.45.0 的主要本地存储位置如下：

| 内容 | 默认位置与建议 |
| --- | --- |
| 抓取正文缓存 | `<web-search.json 所在目录>/web-search-cache`；默认 1 小时、最多 128 项／128 MiB |
| GitHub 仓库 | 默认 `/tmp/pi-github-repos`，独立于 Windows `TEMP`；基础示例关闭。确需启用时，将 `githubClone.clonePath` 设为 `.tmp/web-access/repos`，让每组进程按自身工作目录解析 |
| PDF 提取结果 | 模块载入时的 `os.tmpdir()/pi-web-pdf`；PiQ 终端入口会先提供组内临时目录，自行启动 Pi 时也应先设置好 `TEMP/TMP` |
| 升级提示状态 | Pi agent 目录下 `pi-web-access/last-seen-version.json`；抓取缓存的环境变量不改变此位置 |

`PI_WEB_ACCESS_CACHE_ROOT` 只调整抓取正文缓存根，插件会在其中追加 `web-search-cache`。PiQ 为每组启动独立 Pi 进程，工作目录就是该组；因此可以在启动工作台的专用终端中设置相对缓存根：

```powershell
$env:PI_WEB_ACCESS_CACHE_ROOT = '.tmp/web-access'
npm run web
```

新开的组终端继承该变量，抓取正文会放入 `<组目录>/.tmp/web-access/web-search-cache`。恢复会话时保持相同的值，否则旧 `responseId` 对应的缓存可能无法找到。该变量不会重新定位 GitHub 克隆、PDF、升级提示或人工配置写回；也不会使这些扩展内部操作变成进程沙箱操作。

这个配置适合有人查看终端审批的联网对话组。网页内容作为资料使用；搜索结果不足时保留不确定性，回复时给出实际读取过的来源链接。需要长期保留的内容由 Agent 明确另存到本组 `assets/` 或整理进记忆，不依赖短期缓存。

## MiMo TTS

沿用主人安装的 `mimo-v2-5-tts` 技能，在本组 settings 的 `skills` 中登记它的真实目录。示例使用 `~/.agents/skills/mimo-v2-5-tts`。读取不限，因此技能脚本可以放在组外；脚本和 Python 依赖仍由主人安装和维护。

- `MIMO_API_KEY` 通过启动 Pi 的环境提供，不写入 `PIQ.md`、技能文档或仓库。
- 音色克隆样本建议放在本组 `assets/voices/`。
- 生成结果显式指定本组相对路径，例如 `--output assets/voices/reply.wav`。
- Windows 下通过 `powershell` 调用 Python，执行前在 Pi 终端批准该次命令。生成后由 `qq_send_file` 按本组路径显式发送，例如 `{"conversation":"group:GROUP_OPENID","kind":"voice","path":"assets/voices/reply.wav","replyTo":"PLATFORM_MESSAGE_ID"}`。官方 SDK 1.0.5 可直接上传 WAV、MP3、SILK；其他格式先转换或以 `kind: "file"` 发送。

MiMo API 和 QQ 后端需要网络连接。这个 yuru7 版本不限制网络。读取不限也意味着这套配置没有阻止 Agent 读取当前用户可访问的数据；文件写入规则不承担数据外发控制。

## 实际保护范围

gotgenes 对标准文件路径进行规则检查，yuru7 对自己接管的 `write`、`edit` 和受限 PowerShell 提供写入约束。PiQ 的 `qq_send` 与 `qq_send_file` 对本地图片、语音、视频和文件另有本组路径校验。其他扩展直接执行的文件或网络操作使用它们自己的实现；审批一个未知工具前，应了解它会访问哪些资源。

`PERSONA.md` 的保护分两种情况：标准 `write/edit` 命中路径规则后询问；任意 PowerShell/Python 脚本则在整个命令执行前询问。两个包不会准确推导任意脚本将修改哪些文件。因此，批准脚本前需要确认它不会私自修改保护文件或权限配置。若需要“即使批准任意脚本也绝不能修改 PERSONA”的强约束，还需要操作系统级文件只读策略及批准后的受控写入机制；此配置没有宣称提供这项能力。

yuru7 将 Windows 后端标为部分隔离，并注明硬链接等限制；配置配套 hook 也不能改变这些底层限制。不要把工具批准与底层写入隔离视为同一个保证。

## 验证与退出

先用不加载 PiQ QQ 通道的临时测试目录验证这些外部扩展，确认以下行为再应用到实际对话组：读取组外普通测试文件允许；组内普通文件可写；组外测试文件不可写；保护文件修改弹出人工批准；拒绝后原内容保留；PowerShell 每次询问；无沙箱重试和目录扩权被拒。验证只使用临时文件，不能发送真实 QQ 消息。

本机已用 Pi 1.4.0、真实安装的两个权限包和最终 hook 完成 11 项隔离验证，包括 Windows 小写 `persona.md` 的审批、`.pi/settings.json` 写入拒绝，以及实际 PowerShell 的组内写入成功／组外写入拒绝。模型使用 Pi 官方 faux，未连接真实 QQ。web-access 的 0.45.0 示例另做离线加载验证：前三个工具正确注册，抓取模式限定为 `readable/raw`；未调用搜索服务或 LLM。

实际对话组通过 PiQ 的终端入口运行，关闭终端即停止。配置修改后关闭旧终端再打开，使新的权限规则从启动时生效。停止使用时，从本组 settings 移除两个包和 `no-escalation.ts` 声明即可；保留配置备份便于以后恢复。

## 上游资料

- [gotgenes 配置与能力边界](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system)
- [yuru7 沙箱配置与 Windows 限制](https://github.com/yuru7/my-pi-extensions/tree/main/pi-sandbox)
- [pi-web-access 0.45.0 配置与工具](https://github.com/nicobailon/pi-web-access/blob/v0.45.0/README.md)
- [Pi 包的项目作用域](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Pi 的安全模型](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)
