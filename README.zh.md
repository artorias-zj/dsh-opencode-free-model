# dsh-opencode-free-model

[English](README.md) | 中文

DeepSeek Harness 插件：**免 API Key** 接入 **OpenCode Zen 免费模型车道**（`opencode.ai/zen/v1/*`）。

一个纯 Host 半身的 cordis 插件。它在 `llm` 服务上注册两条 provider 路由，
把车道上的三套线协议（Chat Completions / Responses / Messages）统一解码成宿主的
`StreamChunk` 流式协议，并用后台探测决定哪些模型挂进模型选择器。

```powershell
dsh plugin --profile desktop add github:artorias-zj/dsh-opencode-free-model
```

装完重启 DSH，模型选择器里会出现 **OpenCode Free** 分组。

## 能做什么

| | |
|---|---|
| 🔑 **免密** | 车道用的是池化凭证 `Authorization: Bearer public`，插件里没有、也不存任何属于你的密钥。 |
| 🔀 **三线协议** | `muse-spark-*` 走 `/zen/v1/responses`，`union-alpha` 走 `/zen/v1/messages`，其余走 `/zen/v1/chat/completions`；三套 SSE 事件全部解码成同一套宿主块协议。（分流按模型 id 固定，上游把某个模型从清单里撤掉时它就不再被挂出——`union-alpha` 目前就是这种状态，映射本身仍然有效。） |
| 🧭 **按形状判协议** | 网关会撒谎 `Content-Type`（JSON 头 + SSE 体是线上真实事故）。判定只看 body 自己的形状，嗅探掉的字节原样回放，不缓冲任何一个 token。 |
| 🖐 **指纹四元组** | 免费档要求请求体声明 `bash/glob/grep/read` 四个工具名，否则 403 `FreeTierError`。缺的槽位优先由真实工具顶替（Windows 上 `pwsh`→`bash`），顶不了才放假工具，并在响应侧把工具名改回调用方的拼写。 |
| 🧷 **稳定会话** | 同一 conversation 映射出稳定的 `ses_…`；每次请求换会话会被网关按 per-session 额度限流成 429。 |
| 🔍 **可用性探测** | 后台并发 2 探测每个模型，区分 `available / region-blocked / unavailable / throttled / unknown`。出口 IP 变化立即重探；整轮 429 指数退避；整轮全拒不清空选择器；5xx 不降级模型。 |
| 🌍 **地区路由** | 出口敏感模型（`muse-spark-*`）被地区拒绝时移入 `opencode-free-model-region` 路由；`exposeRegionModels: false` 可隐藏。 |
| ♻️ **推理断流续写** | 纯推理被截断（无正文、无工具调用、无终帧）时，把检查点当作上下文续写一次，续写强制禁用工具。 |
| 🎚 **努力档位 = 真实预算** | 车道的 `reasoning_effort` / `thinking.*` 全被忽略，唯一真正生效的是 `max_tokens`。所以 `light/balanced/deep` 映射为输出预算；常思模型（`canDisableThinking: false`）的档位 ×2（与答案共享上限）。 |

## 路由

| 路由 id | 选择器分组名 | 内容 |
|---|---|---|
| `opencode-free-model` | OpenCode Free | 当前出口可用的免费模型 |
| `opencode-free-model-region` | OpenCode Free · region-limited | 被地区拒绝、按探测结果挂出的模型 |

分组内没有模型时客户端会自行隐藏该分组，所以 VPN 用户看不到第二个分组，非 VPN 用户能看到并知道原因。

**分组内模型按显示名首字母排序**（大小写不敏感，数字按自然序：`V2.6` 在 `V2.10` 前），同名的再按 id 定序，
所以顺序是确定的、刷新不会跳。排序发生在 `listModels()` —— 内核把它的返回顺序原样映射成浏览器
目录、设置页客户端也不再排序，所以这是唯一决定屏幕顺序的地方；排序用的是用户真正读到的 `name`
而不是 `id`（否则 `DeepSeek V4 Flash` 会被排到 `d` 开头）。

## 配置

配置来自 bundle patch 的 `config` 键。**每次挂载都生效**，因此这里写的键永远赢过默认值；
没写的键回落到默认值，不会被上一次挂载的状态粘住。只有运行期记账（`runtime.json`）
会落到磁盘。

```yaml
- insert:
    - id: opencode-free-model
      name: 'dsh-opencode-free-model'
      config:
        enabled: true              # 总开关；false 时不挂模型且调用报 CONFIG_DISABLED
        exposeRegionModels: true   # 是否把地区受限模型挂进第二个路由
        probeIntervalMinutes: 15   # 后台重探周期（分钟，≥1）
        defaultMaxTokens: 32768    # 单轮输出上限（还会被模型自身容量压低）
        streamRecovery: true       # 是否允许一次纯推理检查点续写
        # wireOverrides:           # 上游改线时把某个模型钉死在某条协议上
        #   some-model-free: chat
        # baseUrl: https://opencode.ai
```

形状不对的键会被忽略并记一条 warning，而不是让插件加载失败——一个拒绝加载的插件
比一个带着默认值跑起来的插件糟得多。

环境变量 `OPENCODE_FREE_MODEL_BASE` 可覆盖上游基址（`config.baseUrl` 优先）。

## 安装

```powershell
# 从 GitHub 安装
dsh plugin --profile desktop add github:artorias-zj/dsh-opencode-free-model

# 或从本地克隆/开发目录安装
dsh plugin --profile desktop add D:\Project\DSH\dsh-opencode-free-model

# 验证：dump-config 里应恰好出现一条 opencode-free-model 条目
dsh --profile desktop --dump-config
```

CLI 会把依赖与 `dsh.profile.bundles` 条目写进 profile 的 `package.json`；
`cordis.patch.yml` 负责注入插件条目（`name` 必须是**裸包名**，否则浏览器半身解析不到包根——
本插件是 Host-only，没有 `dsh.client` 声明，但这条规矩仍然适用于 loader 行）。

装完需要重启一次 DSH：宿主插件代码是按 URL 缓存的，切换 loader 条目只会重跑 `apply()`，
不会重新加载改动过的模块。

## 兼容性与权限

| | |
|---|---|
| **Profile** | 任何挂了 `@deepseek-ai/dsh-llm` 的 profile —— 已在 `desktop` 与 `web` 上验证。纯 Host 半身：没有 `dsh.client` 声明，没有浏览器代码。 |
| **平台** | 有 Node 的地方都能跑。纯 ESM，无原生模块、无构建步骤、无运行时依赖。 |
| **运行时** | Node `^22.15.0 || >=24.0.0`（即 `engines.node` 范围）。 |
| **DSH 版本** | 针对 DeepSeek Harness `0.2.0-rc.2` 构建与测试。**故意不声明 `engines.dsh`**：实际跑过的只有这一条版本线，写一个 SemVer 区间等于宣称超出验证范围的兼容性。 |
| **凭证** | 无。这条车道是公共免密额度，插件不持有也不读取任何密钥 —— 它完全不碰凭证服务。 |
| **注册了什么** | 两条 `llm` provider 路由。不加任何 tool、命令、斜杠命令、快捷键或客户端 UI。 |
| **写盘** | 只在 `$DSH_HOME/opencode-free-model/` 下 —— `runtime.json`、`catalog.json`、`availability.json`，均为原子写。该目录之外不写任何东西。 |
| **读取** | 你自己附加的图片，且仅用于把图片内联进一次模型本来就要回答的请求（走可选的 `attachments` 服务；该服务不存在时，图片块回落到运行时本就会做的文本投影）。 |
| **出网目标** | `opencode.ai` —— 推理与模型清单，你的 prompt 只发往这里 —— 以及 `api.ipify.org` / `ipinfo.io` / `ipapi.co`，只读一次本机出口 IP 与国家码，用来判断是否需要重探。详见[上游](#上游)。 |
| **遥测** | 无。除了请求本身，不向任何地方上报任何东西。 |
| **分类** | Models & Reasoning。 |

## 长什么样

选择器里的分组，就是插件实际广告出来的内容（字母序，规则见[路由](#路由)）：

```
OpenCode Free                    9 个模型
  Fledge Alpha Free
  Jev 1.13
  Ling 3.1 Flash Free
  Longcat 2.5 Preview Free
  MiMo V2.5
  MiMo V2.6 Flash
  Nemotron 3 Ultra
  Nemotron 3.5 Lightning
  Space Bunny

OpenCode Free · region-limited   2 个模型
  Muse Spark 1.2
  Muse Spark 1.3
```

以及一轮真实流式回合（打在线上车道），注意 usage 的拆账方式：

```
finish {"kind":"stop"}
usage  {"inputTokens":34,"outputTokens":11,"totalTokens":237,"cacheReadTokens":192,"reasoningTokens":8}
tools  0
answer "OK"
```

`inputTokens` 只算未命中的输入 —— `34 = 226 prompt − 192 cached` —— 这是宿主期望的口径，
而供应商原始返回的 `prompt_tokens` 不会给你这个数。

## 结构

```
dsh-opencode-free-model/
├── cordis.patch.yml   loader 注入行
├── package.json       dsh.bundle.patch 声明（含 files 白名单）
├── icon.svg
├── LICENSE
├── README.md          英文说明
├── README.zh.md       本文件
└── lib/               插件本体，13 个模块
    index.js     Host 半身：apply、注册、目录刷新、探测循环、membership、配置合并
    adapter.js   OcFreeModelAdapter：providerInfo/listModels/resolveModel/prepareCall/stream
    upstream.js  上游词表：基址、三条端点、指纹四元组、会话/请求 id、请求头
    http.js      出站 HTTP：截止时间、字节嗅探、SSE 拆帧、失败分类
    stream.js    三线 SSE → 宿主 StreamChunk（块分配、usage 拆账、终帧、错误帧）
    messages.js  工具配对修复 + 三线消息投影
    effort.js    努力档位 → 输出预算
    recovery.js  检查点续写策略
    catalog.js   能力基线表 + 免费车道过滤 + listing 解析 + membership 拆分
    probe.js     可用性探测（并发 2、失败分类、出口探测）
    store.js     JsonStore（原子写、合并写、坏文件保留）
    channel.js   单生产/单消费异步通道
    kernel.js    唯一允许 import @deepseek-ai/* 的缝（归因 UA）
```

`kernel.js` 是唯一提到 `@deepseek-ai/*` 的文件，其余模块只依赖结构性 `ctx` 契约，
因此不锁内核版本、可以被静态检查（一条 grep 即可验证）。

## 上游

只有一个来源，不是中转站：`https://opencode.ai/zen/v1/*`。

| 用途 | 目标 | 凭证 |
|---|---|---|
| 推理 | `POST …/zen/v1/chat/completions`、`…/responses`、`…/messages`（按模型分流） | `Authorization: Bearer public` —— 公共免密额度，插件不含任何用户密钥 |
| 模型清单 | `GET …/zen/v1/models` | 同上 |
| 出口 IP | `api.ipify.org` / `ipinfo.io` / `ipapi.co`（只读本机出口 IP 与国家码，用于判断是否需要重探） | 无 |

## 已知限制

- **`GenerateOptions` 的采样只有 `temperature` / `maxTokens` / `stop`**，车道侧真正生效的只有输出上限，
  所以 `reasoningEffort` 在这里的含义是"预算档位"而不是"思考强度"。
- **努力档位是预算**：低档位会同时缩短思考与答案，因为车道只有一个共享上限可控。
- **地区判定依赖探测**：网关不公开哪些模型对你的出口可用，只能问出来。
- **探测周期在挂载时读取**：改 `probeIntervalMinutes` 需要重载插件才生效。

## License

MIT（见 [`LICENSE`](LICENSE)）。

线协议事实（免密池化凭证、客户端指纹头、按模型分端点、免费档工具指纹闸门、
per-session 额度记账、地区闸门）来自 MIT 许可的参考实现 `dsh-our-free-model`
(Copyright © 2026 zouyuxuan122) 与 `zen-gate` 项目。两份版权声明都写在 `LICENSE` 里，
而 `LICENSE` 保持未改动的 MIT 原文，以便被工具自动识别为 MIT。
