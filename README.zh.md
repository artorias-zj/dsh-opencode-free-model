# dsh-opencode-free-model

[English](README.md) | 中文

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/artorias-zj/dsh-opencode-free-model)

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
| 🔀 **三线协议** | 三条网关方言都已实现并解码成同一套宿主块协议：免费清单走 `/zen/v1/chat/completions`，`muse-spark-*` 走 `/zen/v1/responses`，`union-alpha` 走 `/zen/v1/messages`。（分流按模型 id 固定；上游撤掉的模型就不再被挂出——`union-alpha` 与带 `-contributor-free` 后缀的 Muse Spark 目前都是这种状态，所以现在每一个在线的免费模型都走 chat 线；另外两条映射等它们回来时仍然有效。） |
| 🧭 **按形状判协议** | 网关会撒谎 `Content-Type`（JSON 头 + SSE 体是线上真实事故）。判定只看 body 自己的形状，嗅探掉的字节原样回放，不缓冲任何一个 token。 |
| 🖐 **工具指纹闸门** | 免费档要求请求体声明一个**名字恰好是 `read`** 的工具，否则 403 `FreeTierError`。插件一并声明 `bash/glob/grep` 以扩大覆盖面，缺的槽位优先由真实工具顶替（Windows 上 `pwsh`→`bash`），顶不了才放假工具，并在响应侧把工具名改回调用方的拼写。 |
| 🧷 **稳定会话** | 同一 conversation 映射出稳定的 `ses_…`，而且是网关自己的**解码后**形状。12 位 hex 是 `~(time × 0x1000 + counter)`，counter 必须很小——随手写的 hex 或 sha256 前缀会解出一个大 counter，请求其余部分再正确也是 403。每次请求换会话还会被 per-session 额度限流成 429；这套推导同时给你稳定性和规范形状。 |
| 🪪 **保留归因、改写被拒的 token** | 宿主强制每条请求带归因 User-Agent，而这条车道恰好拒绝其中 `deepseek-harness/<version>` 这一个产品 token。插件保留归因，只把产品名改写成 `dsh`，版本号与来源 URL 原样保留——见[上游](#上游)。 |
| 🔍 **可用性探测** | 后台并发 2 探测每个模型，区分 `available / region-blocked / unavailable / throttled / unknown`。出口 IP 变化立即重探；整轮 429 指数退避；整轮全拒不清空选择器；5xx 不降级模型。每条判定记的是探测**开始**的时刻而不是应答的时刻，所以慢回合不会被误当成更新的样本。 |
| 🎫 **每个模型一条探测 session** | 这条车道的配额按上游 session 计，不是按键、也不是按回合。整轮共用一条 session 时，第一个模型就把额度花光，后面每个模型都读回 `429 throttled` —— 本出口能服务的模型被扣掉了它们根本没碰过的配额。现在每条探测从模型 id 派生自己的 session，同一模型的探测 session 也因此在多轮之间、重启之后保持稳定，不会每次都走进一个新的配额桶。 |
| 🕰 **判定只对它被测量的那条路径成立** | 网关路由哪些模型取决于它看到的公网地址，所以开个 VPN 就可能换掉名单，账号却一点没变。上一出口的判定因此被标记为 `stale`，既不继续相信、也不删除：历史留着，但一条 stale 记录读作"未测量"，于是旧路径上的地区拒绝不会再继续藏住新路径能服务的模型。路径改变时仍在途的那一轮会被**取代**——结果直接丢弃而不是落盘，因为一轮里最慢的模型最后到，而那恰恰是它用过期结论覆盖新鲜判定的时刻。节流退避同时被重置，理由是同一个：它描述的是旧路径的配额，带过去就是把新路径挡在它从没撞上过的墙后面。 |
| 🎯 **拒绝说的是一个模型，不是整份名单** | 回合中途的 `RegionError` 以前会触发一整轮探测，从和你自己回合同一个配额池里花掉每个模型一条探测，只为确认一个拒绝已经说清楚、而且只关于某一个模型的事实——还是在最糟糕的时刻。现在它直接记下那一条判定，一个探测请求都不发。该记录不带编造的 `latencyMs` 或 `startedAt`，因为根本没有计时。 |
| 🌍 **地区路由** | 出口敏感模型（`muse-spark-*`）被地区拒绝时移入 `opencode-free-model-region` 路由；`exposeRegionModels: false` 可隐藏。当前没有在线的免费模型对出口敏感，所以该路由通常是空的。 |
| 📏 **窗口是量出来的，不是抄来的** | 清单只公开 id，别的什么都不说；而 models.dev 给这些 id 标的 `200000` 只是一个**下限**——这条车道在 `deepseek-v4.1-flash-free` 上接受过 1025229 token 的 prompt，在 `glm-5.3-flash-free` 上接受过 900694 token 的，两次都回 200。所以先查精确 id 覆盖表、再走族模式：精确 id 是更窄的主张。`deepseek-v4.1-flash-free` 为 1048576 / 384000 且支持视觉（它的族行原本写的是 128000 / 64000、不支持视觉），`glm-5.3-flash-free` 与 `nemotron-3.5-super-vl-free` 为 1048576 / 131072 且支持视觉，`big-pickle` 为 262144 / 131072 且支持视觉、不再吃保守回退值。`beam-free` 与 `flint-40b-free` **故意**保留回退值——它们没有实测数字，编一个比给出诚实下限更糟。 |
| 🧮 **不合法的 usage 直接丢掉，而不是照抄** | 免费车道的多模态回合会报出比模型自身窗口还大的 prompt——实测在一个 256k 窗口的模型上、一轮很短的视觉对话之后报出约 619k 总量——宿主会拿这个样本做软预算，然后在真实对话只有几千 token 的情况下以 `CONTEXT_WINDOW_EXCEEDED` 硬失败。所以只要一份计数的输入侧装不进该 id 在目录里声明的窗口，它在源头就被丢弃：输出与推理计数保留，prompt 侧归零、`totalTokens` 省略，并且本轮之后一直把输入记 0——因为一旦某次尝试的 prompt 成了未知，后面任何求和都拼不回它。这条只对量出来的窗口生效：超过**回退值**的计数只能证明回退值太小，不能证明计数是错的。 |
| 🧠 **供应商的推理字段不会被悄悄丢掉** | 只要 assistant 消息上已经带着 `reasoning_content` 字符串，Chat 投影就把它原样发往上游，显式空串也一样——对推理模型来说「有但为空」和「没有这个字段」是两句不同的话，而工具回填那一轮再看到自己的推理才接得上线索，看不到就会从头重来。这里保的是供应商的那**字段**，不是 harness 的推理**块**——后者永不投影到线上。要注意 harness 是把思考当作块来传的，所以实践中这个字段通常并不存在、这段判断多半什么也找不到：留着它是为了让「丢掉它」继续是一个决定，而不是一次意外。 |
| ♻️ **推理断流续写** | 纯推理被截断（无正文、无工具调用、无终帧）时，把检查点当作上下文续写一次，续写强制禁用工具。 |
| 🎚 **思考档位就是真正的控制** | 网关会**校验** `reasoning_effort`，且档位确实改变推理量，所以每个模型只挂出它真正接受的档位（`none`…`max`），插件把选中的那个原样下发。各模型菜单不同：`big-pickle` 没有 `minimal`/`xhigh`，而 `-free` 系列七个档位全收。模型没声明的档位绝不下发——退回该模型默认档，而不是换一个 400。 |

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
OpenCode Free                   8 个模型
  Beam
  Big Pickle
  DeepSeek V4.1 Flash
  Flint 40B
  GLM 5.3 Flash
  MiMo V2.6 Flash
  Nemotron 3.5 Lightning
  Nemotron 3.5 Super VL
```

`Jev 1.13` 出现在上游清单里但没有任何一条线能服务——三套协议都回
`400 ModelProtocolUnsupported`——所以它不进种子，第一轮探测就会把它摘掉。
`LongCat 2.5 Preview` 与 `Space Bunny` 则已经不在清单上了，因此也离开了名册；
它们的显示名仍留在表里，而那张表只会被一个网关确实点过名的 id 查到时才用得上。

以及一轮真实流式回合（打在线上车道），注意 usage 的拆账方式：

```
finish {"kind":"stop"}
usage  {"inputTokens":34,"outputTokens":16,"totalTokens":50,"reasoningTokens":14}
tools  0
answer "OK"
```

`inputTokens` 只算未命中的输入 —— 供应商的 `prompt_tokens` 减去命中缓存的前缀 —— 这是宿主期望的口径，
而原始 `prompt_tokens` 不会给你这个数。上面这次没有命中缓存，所以该字段是缺失而不是 0。

只有站得住脚的计数才会被记账。宿主是拿最近一次样本做软预算的，所以一个比模型自身窗口还大的
prompt 数不只是"不准"，它就是小对话被 `CONTEXT_WINDOW_EXCEEDED` 硬失败的原因：插件丢掉输入侧而不是
把它转出去，保留输出与推理计数，并且本轮不再累加输入。

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
    index.js     Host 半身：apply、注册、目录刷新、探测循环（记下判定开始时刻）、membership、配置合并
    adapter.js   OcFreeModelAdapter：providerInfo/listModels/resolveModel/prepareCall/stream（usage 过滤、`upstreamFinish`）
    upstream.js  上游词表：基址、三条端点、工具指纹、会话/请求 id、请求头
    http.js      出站 HTTP：截止时间、字节嗅探、SSE 拆帧、失败分类
    stream.js    三线 SSE → 宿主 StreamChunk（块分配、usage 拆账与超窗丢弃、终帧、错误帧）
    messages.js  工具配对修复 + 三线消息投影（含 `reasoning_content` 原样回传）
    effort.js    逐模型思考档位 → reasoning_effort
    recovery.js  检查点续写策略
    catalog.js   能力基线表 + 精确 id 覆盖层 + 免费车道过滤 + listing 解析 + membership 拆分
    probe.js     可用性探测（并发 2、每模型独立 session、失败分类、出口探测、开始时刻）
    store.js     JsonStore（原子写、合并写、坏文件保留）
    channel.js   单生产/单消费异步通道
    kernel.js    唯一允许 import @deepseek-ai/* 的缝（归因 UA）
```

`kernel.js` 是唯一提到 `@deepseek-ai/*` 的文件，其余模块只依赖结构性 `ctx` 契约，
因此不锁内核版本、可以被静态检查（一条 grep 即可验证）。

这里有两处容易忽略的细节。`stream.js` 的丢弃逻辑由 `adapter.js` 施加，而不是在解码器里——
一份计数是否**不可能**，取决于目录为这个 id 声明的窗口：精确 id 覆盖行或族模式行，绝不会是保守回退值。
以及，只有当宿主的兜底把一个异常收尾映射成 `stop` 时，终帧才会带 `upstreamFinish: <供应商原始 token>`，
这样严格的消费者（手动探测、事后复盘）就可以拒绝把"看着干净"的回合当成通过。

## 上游

只有一个来源，不是中转站：`https://opencode.ai/zen/v1/*`。

| 用途 | 目标 | 凭证 |
|---|---|---|
| 推理 | `POST …/zen/v1/chat/completions`、`…/responses`、`…/messages`（按模型分流） | `Authorization: Bearer public` —— 公共免密额度，插件不含任何用户密钥 |
| 模型清单 | `GET …/zen/v1/models` | 同上 |
| 出口 IP | `api.ipify.org` / `ipinfo.io` / `ipapi.co`（只读本机出口 IP 与国家码，用于判断是否需要重探） | 无 |

### 关于 User-Agent 的这处冲突，说明白

宿主的 provider 契约要求每条请求都带归因 User-Agent，并声明任何做法都不能把它省掉。
那个字符串就是 `deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)`。
而这条车道对这个产品 token 直接回 403 `FreeTierError`——实测大小写不敏感、且与头部其余内容无关；
反过来，不带版本的裸词 `deepseek-harness`、写在括号 URL 里的同一串词、以及
`deepseek_harness/…` 全部放行。

所以插件发的是
`opencode/1.18.31 dsh/<version> (+https://github.com/deepseek-ai/deepseek-harness)`：
车道用来识别客户端的 token，加上只改了产品名拼写的归因。这是**有意为之且在文档里写明的偏离**——
不这么做，车道会对每一个回合回 403。全插件只有 `lib/http.js` 的 `userAgentWith` 一处做这件事，
`lib/kernel.js` 仍然原样报告宿主自己的字符串，保住了这条缝的诚实性。

线上其余部分都不设闸：`/zen/v1` 与 `/inference/v1` 都通，
`x-opencode-client` / `x-opencode-request` / `x-opencode-session-id` / `x-opencode-project`
逐个删掉也都通。真正决定成败的只有两项——会话 id 的解码形状，以及上面的 User-Agent token；
只修其中一项仍然 403。

## 已知限制

- **`GenerateOptions` 的采样是 `temperature` / `maxTokens` / `stop` 加 `reasoningEffort`**，
  车道侧真正生效的是输出上限与思考档位。两者互相独立：档位决定模型想多久，上限同时约束思考与答案。
- **思考档位是逐模型的**：网关会校验该字段，且各模型接受的集合确实不同（`big-pickle` 拒绝
  `minimal`/`xhigh`；`space-bunny-free` 若回到名册，它拒绝 `none`）。模型没声明的档位不会下发，而是替换成该模型的默认档。
- **地区判定依赖探测**：网关不公开哪些模型对你的出口可用，只能问出来。
- **探测周期在挂载时读取**：改 `probeIntervalMinutes` 需要重载插件才生效。
- **车道的闸门不是公开契约**：会话 id 形状与被拒的 User-Agent token 都是实测出来的，不是文档写的，
  因此网关随时可能再收紧一次。真收紧时，每个回合都会以 `FreeTierError` 失败并被呈现为
  `CLIENT_ERROR` 且带 `fingerprintRejected: true`——那是"去找新版本"的信号，不是"重新认证"。
- **归因 User-Agent 是被改写，而不是被省略**：见[关于 User-Agent 的这处冲突](#关于-user-agent-的这处冲突说明白)。

## License

MIT（见 [`LICENSE`](LICENSE)）。

线协议事实（免密池化凭证、客户端指纹头、按模型分端点、免费档工具指纹闸门、
per-session 额度记账、地区闸门）来自 MIT 许可的参考实现 `dsh-our-free-model`
(Copyright © 2026 zouyuxuan122) 与 `zen-gate` 项目。两份版权声明都写在 `LICENSE` 里，
而 `LICENSE` 保持未改动的 MIT 原文，以便被工具自动识别为 MIT。
