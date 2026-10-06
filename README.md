# dsh-opencode-free-model

English | [中文](README.zh.md)

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/artorias-zj/dsh-opencode-free-model)

A DeepSeek Harness plugin that puts the **OpenCode Zen free model lane**
(`opencode.ai/zen/v1/*`) into your model picker with **no API key**.

It is a Host-only cordis plugin. It registers two provider routes on the `llm`
service, decodes all three wire protocols the lane speaks (Chat Completions /
Responses / Messages) into the harness `StreamChunk` protocol, and uses a
background probe to decide which models get advertised.

```powershell
dsh plugin --profile desktop add github:artorias-zj/dsh-opencode-free-model
```

Restart DSH afterwards and an **OpenCode Free** group appears in the model
picker.

## What it does

| | |
|---|---|
| 🔑 **No key** | The lane is keyed by a pooled credential, `Authorization: Bearer public`. The plugin holds no secret of yours, and stores none. |
| 🔀 **Three wire protocols** | `muse-spark-*` goes to `/zen/v1/responses`, `union-alpha` to `/zen/v1/messages`, everything else to `/zen/v1/chat/completions`; all three SSE dialects decode into one host block protocol. (Routing is by model id, so a model the upstream withdraws simply stops being advertised — `union-alpha` is in that state today; the mapping itself still stands.) |
| 🧭 **Protocol decided by shape** | The gateway lies in `Content-Type` (a JSON header over an SSE body is a real production incident). The verdict comes from the body's own shape, and the bytes spent sniffing it are replayed — not one token is buffered. |
| 🖐 **The fingerprint quartet** | The free tier requires the request body to declare the tool names `bash/glob/grep/read`, or it answers 403 `FreeTierError`. A missing slot is filled by promoting a real tool that can answer for it (`pwsh`→`bash` on Windows) before it is faked, and the response side restores the caller's own spelling. |
| 🧷 **Stable sessions** | One conversation maps to one stable `ses_…`. Minting a fresh session per request gets you rate-limited by the gateway's per-session accounting (429). |
| 🔍 **Availability probing** | A background probe with concurrency 2 classifies every model as `available / region-blocked / unavailable / throttled / unknown`. An egress change re-probes immediately; an all-429 round backs off exponentially; an all-refused round does not empty the picker; 5xx never demotes a model. |
| 🌍 **Region routing** | Egress-sensitive models (`muse-spark-*`) that the gateway refuses here move to the `opencode-free-model-region` route; `exposeRegionModels: false` hides it. |
| ♻️ **Reasoning-cutoff continuation** | A turn cut off with reasoning and nothing visible — no text, no tool call, no finish token — is continued once from its checkpoint, with tools forced off. |
| 🎚 **Effort levels are real budgets** | The lane ignores `reasoning_effort` and every `thinking.*` spelling; the only control it honours is `max_tokens`. So `light/balanced/deep` map to output budgets, and a model that cannot stop thinking (`canDisableThinking: false`) has every rung doubled, since thinking and the answer share one ceiling. |

## Routes

| Route id | Picker group | Contents |
|---|---|---|
| `opencode-free-model` | OpenCode Free | Free models usable from this egress |
| `opencode-free-model-region` | OpenCode Free · region-limited | Models refused by region, advertised per probe result |

The client hides a group with no models, so a VPN user sees one group and a user
without sees the second one labelled with the reason.

**Models inside a group are sorted alphabetically by display name** (case-folded,
digits in natural order: `V2.6` before `V2.10`), with the id breaking ties, so the
order is total and does not jump between refreshes. The sort lives in
`listModels()` — the kernel maps its return order straight into the browser
catalog and the settings client does not reorder, so that is the only place that
decides what is on screen. It sorts on `name` rather than `id`, because `name` is
the string in front of the user (ordering by id would file `DeepSeek V4 Flash`
under `d`).

## Configuration

Configuration comes from the bundle patch's `config` key. It applies on **every**
mount, so a key written there always wins over a default; a key it omits falls
back to the default instead of sticking from a previous mount. Only runtime
bookkeeping (`runtime.json`) is written to disk.

```yaml
- insert:
    - id: opencode-free-model
      name: 'dsh-opencode-free-model'
      config:
        enabled: true              # master switch; false advertises nothing and fails calls with CONFIG_DISABLED
        exposeRegionModels: true   # advertise region-limited models on the second route
        probeIntervalMinutes: 15   # background re-probe period, in minutes (>= 1)
        defaultMaxTokens: 32768    # per-turn output ceiling (further lowered by the model's own capacity)
        streamRecovery: true       # allow one reasoning-checkpoint continuation
        # wireOverrides:           # pin a model to a wire if the upstream moves it
        #   some-model-free: chat
        # baseUrl: https://opencode.ai
```

A key with the wrong shape is ignored with a warning rather than failing the
plugin — a plugin that refuses to load is far worse than one running with a
default.

The environment variable `OPENCODE_FREE_MODEL_BASE` overrides the upstream root
(`config.baseUrl` takes precedence).

## Install

```powershell
# from GitHub
dsh plugin --profile desktop add github:artorias-zj/dsh-opencode-free-model

# or from a local clone / development directory
dsh plugin --profile desktop add D:\Project\DSH\dsh-opencode-free-model

# verify: dump-config should contain exactly one opencode-free-model row
dsh --profile desktop --dump-config
```

The CLI writes the dependency and the `dsh.profile.bundles` entry into the
profile's `package.json`; `cordis.patch.yml` injects the loader row (`name` must
be the **bare** package name, or a client half cannot resolve the package root —
this plugin is Host-only and declares no `dsh.client`, but the rule still governs
the loader row).

Restart DSH once after installing: host plugin code is cached by URL, so toggling
the loader entry re-runs `apply()` from the cached module rather than reloading
modules you changed on disk.

## Compatibility & permissions

| | |
|---|---|
| **Profiles** | Any profile that mounts `@deepseek-ai/dsh-llm` — verified on `desktop` and `web`. Host half only: no `dsh.client` declaration, no browser code. |
| **Platform** | Anywhere Node runs. Pure ESM, no native modules, no build step, no runtime dependencies. |
| **Runtime** | Node `^22.15.0 || >=24.0.0` (the `engines.node` range). |
| **DSH version** | Built and tested against DeepSeek Harness `0.2.0-rc.2`. `engines.dsh` is deliberately *not* declared: only that one line has actually been exercised, and a SemVer range would claim more than has been verified. |
| **Credentials** | None. The lane is a public key-free allowance, so the plugin holds no secret and reads none — it never touches the credential service. |
| **Registers** | Two `llm` provider routes. It adds no tools, no commands, no slash commands, no keyboard shortcuts and no client UI. |
| **Writes** | Only under `$DSH_HOME/opencode-free-model/` — `runtime.json`, `catalog.json`, `availability.json`, each written atomically. Nothing outside that directory. |
| **Reads** | Your own attached images, and only to inline one into a request the model is already answering (through the optional `attachments` service; if it is absent, image blocks fall back to the text projection the runtime already performs). |
| **Outbound hosts** | `opencode.ai` — inference and model listing, the only destination your prompts reach — plus `api.ipify.org` / `ipinfo.io` / `ipapi.co`, which are read once to learn this machine's public IP and country so the plugin knows whether a re-probe is needed. Details in [Upstream](#upstream). |
| **Telemetry** | None. Nothing is reported anywhere except the request itself. |
| **Category** | Models & Reasoning. |

## What it looks like

The picker groups, exactly as the plugin advertises them (alphabetical, as
described under [Routes](#routes)):

```
OpenCode Free                    9 models
  Fledge Alpha Free
  Jev 1.13
  Ling 3.1 Flash Free
  Longcat 2.5 Preview Free
  MiMo V2.5
  MiMo V2.6 Flash
  Nemotron 3 Ultra
  Nemotron 3.5 Lightning
  Space Bunny

OpenCode Free · region-limited   2 models
  Muse Spark 1.2
  Muse Spark 1.3
```

And one real streamed turn, captured against the live lane — note the disjoint
token accounting:

```
finish {"kind":"stop"}
usage  {"inputTokens":34,"outputTokens":11,"totalTokens":237,"cacheReadTokens":192,"reasoningTokens":8}
tools  0
answer "OK"
```

`inputTokens` is uncached input only — `34 = 226 prompt − 192 cached` — which is
what the harness expects and what the provider's raw `prompt_tokens` does not
give you.

## Layout

```
dsh-opencode-free-model/
├── cordis.patch.yml   the loader injection row
├── package.json       dsh.bundle.patch declaration (with the files allow-list)
├── icon.svg
├── LICENSE
├── README.md          this file
├── README.zh.md       Chinese
└── lib/               the plugin, 13 modules
    index.js     Host half: apply, registration, catalog refresh, probe loop, membership, config merge
    adapter.js   OcFreeModelAdapter: providerInfo/listModels/resolveModel/prepareCall/stream
    upstream.js  upstream vocabulary: base URL, three endpoints, fingerprint quartet, session/request ids, headers
    http.js      outbound HTTP: deadlines, byte sniffing, SSE framing, failure classification
    stream.js    three-wire SSE -> host StreamChunk (block allocation, usage accounting, terminal frames, error frames)
    messages.js  tool-pairing repair + three-wire message projection
    effort.js    effort levels -> output budgets
    recovery.js  checkpoint-continuation policy
    catalog.js   capability baseline + free-lane filter + listing parser + membership split
    probe.js     availability probing (concurrency 2, failure classification, egress detection)
    store.js     JsonStore (atomic writes, coalesced writes, corrupt files preserved)
    channel.js   single-producer / single-consumer async channel
    kernel.js    the only seam allowed to import @deepseek-ai/* (attribution UA)
```

`kernel.js` is the only file that names `@deepseek-ai/*`; every other module
depends on the structural `ctx` contract alone, so the plugin pins no kernel
version and the rule is checkable with one grep.

## Upstream

One source, and it is not a relay: `https://opencode.ai/zen/v1/*`.

| Purpose | Target | Credential |
|---|---|---|
| Inference | `POST …/zen/v1/chat/completions`, `…/responses`, `…/messages` (per model) | `Authorization: Bearer public` — a public, key-free allowance; the plugin holds no user secret |
| Model listing | `GET …/zen/v1/models` | same |
| Egress IP | `api.ipify.org` / `ipinfo.io` / `ipapi.co` (reads back this machine's public IP and country code, only to decide whether a re-probe is needed) | none |

## Known limitations

- **`GenerateOptions` sampling is `temperature` / `maxTokens` / `stop` only**, and
  the only one the lane honours is the output ceiling — so `reasoningEffort`
  means "budget rung" here, not "thinking intensity".
- **An effort level is a budget**: a lower rung shortens the thinking *and* the
  answer, because the lane gives you one shared ceiling and nothing else.
- **Region verdicts require probing**: the gateway does not disclose which models
  your egress may use, so the plugin has to ask.
- **The probe period is read at mount time**: changing `probeIntervalMinutes`
  needs a plugin reload to take effect.

## License

MIT — see [`LICENSE`](LICENSE).

The wire-protocol facts (the pooled key-free credential, the client fingerprint
headers, the per-model endpoint split, the free-tier tool-fingerprint gate, the
per-session quota accounting, and the regional gate) come from the MIT-licensed
reference implementation `dsh-our-free-model` (Copyright © 2026 zouyuxuan122) and
the `zen-gate` project. Both copyright notices are carried in `LICENSE`, which is
kept as unmodified MIT text so the license is machine-detectable.
