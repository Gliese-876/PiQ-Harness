# 第三方组件

PiQ Harness 源码按 GNU Affero General Public License v3.0 发布，完整条款见 [LICENSE](LICENSE)。第三方组件保留各自版权和许可；本项目的许可不会替代这些组件的条款。

## 官方 QQBot 接入

QQ 协议接入使用腾讯发布的 `@tencent-connect/qqbot-nodejs`，本项目固定版本为 **1.0.5**。该发布包随附 MIT 许可证，版权声明为 `Copyright (c) 2026 Tencent`。

- [官方源码仓库](https://github.com/tencent-connect/qqbot-nodejs)
- [官方 LICENSE](https://github.com/tencent-connect/qqbot-nodejs/blob/main/LICENSE)
- [npm 包](https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs)

本项目仅使用该 SDK 的公开接口，通过机器人 AppID/AppSecret 连接官方平台。机器人凭据统一在 Windows 工作台直接填写 AppID 和 AppSecret 密码框，保存到当前用户的环境变量，密钥保存后不回显；CLI 连接读取同一份已保存的凭据。项目不依赖或分发 `@tencent-connect/qqbot-connector`，不包含扫码绑定实现，也不接入 SnowLuma、OneBot 或 DSH。

分发包含此 SDK 的产物时，保留 SDK 随附的完整 LICENSE 和以下声明：

```text
MIT License

Copyright (c) 2026 Tencent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## npm 依赖

源码仓库包含依赖声明和锁文件。npm 安装的第三方包遵循各自附带的许可证与版权声明；分发这些包时应一并保留其声明。

| 主要组件 | 许可证 |
| --- | --- |
| `@tencent-connect/qqbot-nodejs@1.0.5` | MIT |
| Pi Coding Agent 及 Pi 组件 | MIT |
| TypeBox | MIT |
| TypeScript | Apache-2.0 |
| Node.js 类型定义 | MIT |

其余组件、实际版本和完整声明以 `package-lock.json` 及对应发布包中的许可证文件为准。

## 用户独立安装的可选扩展

权限扩展、写入沙箱、网页搜索、生图插件和 MiMo TTS 技能不属于 PiQ 的 npm 依赖，也不随 PiQ 自动安装。配置示例只说明如何由用户独立接入，各包和技能按自己的许可使用。把某组件列为可选项不改变其许可；若另行分发，应单独核对和保留对应授权与声明。
