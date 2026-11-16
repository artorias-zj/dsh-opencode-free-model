# dsh-opencode-free-model

English | [中文](README.zh.md)

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/artorias-zj/dsh-opencode-free-model)

A DeepSeek Harness plugin that puts the **OpenCode Zen free model lane**
(`opencode.ai/inference/*`) into your model picker with **no API key**.

It is a Host-only cordis plugin. It registers two provider routes on the `llm`
service, decodes all three wire protocols the lane speaks (Chat Completions /
Responses / Messages) into the harness `StreamChunk` protocol, and decides which
models get advertised from what a background probe measures and from what your
own turns have already reported.

```powershell
dsh plugin --profile desktop add github:artorias-zj/dsh-opencode-free-model
```

Restart DSH afterwards and an **OpenCode Free** group appears in the model
picker.

## What it does

| | |
|---|---|
| 🔑 **No key** | The lane is keyed by a pooled credential, `Authorization: Bearer public`. The plugin holds no secret of yours, and stores none. |
| 🔀 **Three wire protocols** | All three gateway dialects are implemented and decoded into one host block protocol, under the official 2.2.x client's provider-family paths: `/inference/openai/v1/chat/completions` for the free roster, `/inference/openai/v1/responses` for `muse-spark-*`, `/inference/anthropic/v1/messages?beta=true` for `union-alpha`. The model listing rides `/inference/v1/models`, which every style answers. `endpointStyle: flat` moves inference to `/inference/v1/{chat/completions,responses,messages}`, and `endpointStyle: zen` restores the pre-2.1 `/zen/v1/…` paths byte-for-byte — so a gateway that disagrees with the default is one config key away from the shape this plugin shipped before. (Routing is by model id, and a model the upstream withdraws simply stops being advertised — `union-alpha` and the `-contributor-free` Muse Spark ids are in that state today, so every live free model currently rides the chat wire; the other two mappings still stand for when they return.) |
| 🧭 **Protocol decided by shape** | The gateway lies in `Content-Type` (a JSON header over an SSE body is a real production incident). The verdict comes from the body's own shape, and the bytes spent sniffing it are replayed — not one token is buffered. |
| 🖐 **The fingerprint tool gate** | The free tier refuses a request body that does not declare a tool named exactly `read` (403 `FreeTierError`). The plugin declares that one, plus `bash/glob/grep` for a wider footprint, filling a missing slot by promoting a real tool that can answer for it (`pwsh`→`bash` on Windows) before it is faked, and the response side restores the caller's own spelling. One body is exempt: a conversation-title request — no tools declared, one to three turns, not one of them an assistant or tool turn, and a title marker in the system or leading text — ships exactly as the caller wrote it, with no tool append, no rename and no prompt injection, because the free tier answers an agent-shaped tool list on a toolless title call with 403/429. The desktop profile runs a session-titles extension, so those are real requests rather than a hypothetical. |
| 🧷 **Stable sessions** | One conversation maps to one stable `ses_…`, in the gateway's own *decoded* id form. The twelve hex digits are `~(time × 0x1000 + counter)` and the counter must stay small — a random hex or sha256 prefix decodes to a large counter and is refused 403 no matter how correct the rest of the request is. Minting a fresh session per request also gets you rate-limited by per-session accounting (429); the derivation gives stability and a canonical shape at once. A turn that arrives with no conversation id falls back to a reserved `global` seed and therefore shares one upstream session with every other id-less turn on the machine — minting a fresh one per request is not an option, since the quota is per session and a new id each time spends the allowance into 429s, so the plugin says so once instead of letting concurrent id-less conversations share state silently. |
| 🪪 **Attribution without the refused token** | The harness requires an attribution User-Agent on every request, and this lane refuses exactly one product token in it (`deepseek-harness/<version>`). The plugin keeps the attribution but rewrites that product name to `dsh`, preserving version and origin URL — see [Upstream](#upstream). |
| 🔍 **Availability without asking** | A real turn's own outcome records `available / throttled / region-blocked / unavailable` for that one model, with no extra request and no invented latency — a success is evidence the lane is open, a 429 evidence it is throttled, a `RegionError` evidence this exit is excluded. The verdict therefore arrives as a by-product of work the user already paid for, and a model no turn has touched keeps whatever it was measured at. A background probe with concurrency 2 still exists and still classifies every model as `available / region-blocked / unavailable / throttled / unknown`, but it is now the *fallback*: it fills in the models no turn has reached, rather than being the only way a verdict can be learned. An egress change re-probes immediately; an all-429 round backs off exponentially; an all-refused round does not empty the picker; 5xx never demotes a model. Each probed verdict is stamped with when the probe *started*, not when it answered, so a slow reply cannot read as fresher than a newer sample. |
| 🧯 **A burned IP is refused locally, not re-probed** | The upstream counts the free tier per egress IP, so a burned address answers every request — any model, any session — with `FreeUsageLimitError` and a `Retry-After` measured in hours. The plugin used to learn that by spending probes against the wall, and by failing your next turn for it. Now one real `429` opens the window locally for as long as `Retry-After` says, or six hours when the response names no usable window, and every later turn is refused before a payload is built or a socket opened: `RATE_LIMIT`, with the retry time in the message. A client-gate `403 FreeTierError` is a different verdict — it locks the lane with no window at all, because waiting cannot change what this client looks like. A success clears the breaker rather than letting the clock run out, and an egress change clears it too, since the window described the old exit's bucket. `laneBreaker: false` turns the local refusal off while still recording the verdicts behind it. |
| 🚪 **The exit is the lever the quota moves on** | Because the ceiling is counted per egress IP, the address the lane dials from is the only thing that changes what the counter sees. `freeLane.proxyUrl` accepts `http`, `https`, `socks5` and `socks5h` — credentials included — and `freeLane.fromEnvironment: true` makes the lane follow `HTTPS_PROXY`/`HTTP_PROXY` and honour `NO_PROXY`; empty means direct, and the environment is not consulted unless you ask, because a machine-wide `HTTPS_PROXY` exported for corporate traffic must not silently reroute a lane whose quota is counted per IP. Nothing is ever rotated, scored or switched on your behalf: an address is configured, validated once, and used for every request after it. A bad address fails at configuration time, in front of the person who typed it, instead of an hour later as `fetch failed` on a turn. |
| 🎫 **One probe session per model** | Quota on this lane is ledged per project id × egress, and was counted per upstream session before that, so a round that shared one session spent the whole allowance on its first model and read every model after it back as `429 throttled` — dropping models the egress could serve, over quota they never touched. Each probe now derives its own session from the model id, and a background purpose (a probe, a catalog refresh) derives a session of its own rather than inheriting a live turn's, so neither spends the bucket the other is midway through. One model's probe session also stays stable across rounds and restarts instead of walking into a fresh quota bucket every time. |
| 🕰 **A verdict is only true of the path it was measured on** | Which models the gateway routes is a property of the public address it sees, so turning a VPN on can change the roster with no account change at all. Verdicts from the previous egress are therefore marked `stale` rather than trusted or deleted: the history stays, but a stale row reads as "not measured", so a region refusal collected on the old path cannot keep hiding a model the new path serves. A round still in flight when the path changes is also *superseded* — its answers are discarded instead of being persisted, because the slowest models in a round land last, which is exactly when they would overwrite fresh verdicts with obsolete ones. The throttle backoff is reset for the same reason: it described the old path's quota, and carrying it over parks the new path behind a wall it never hit. |
| 🎯 **A refusal is about one model, not the roster** | A mid-turn `RegionError` used to force a full probe round, spending one probe per model — out of the same quota pool as your own turns — to learn something the refusal had already said about exactly one of them, at the worst possible moment. It now records exactly that one verdict from the turn that already happened, with no probe request at all, and the rest of the roster is left alone. The row carries no invented `latencyMs` or `startedAt`, since nothing was timed. |
| 🌍 **Region routing** | Egress-sensitive models (`muse-spark-*`, and `beam-free`, which the upstream's own 2.2 docs name as region-gated) that the gateway refuses here move to the `opencode-free-model-region` route; `exposeRegionModels: false` hides it. Which of them actually needs that route is an answer about your exit address, so it comes from the passive verdicts above as much as from a probe. |
| 📏 **Windows that are measured, not published** | The listing stopped being a bare id list: it now publishes `limit.context`, `limit.output`, `modalities.input` and `capabilities.reasoning.effort` per row, so the catalog reads those as a middle layer instead of guessing the whole shape from the id. Precedence is per field, narrowest first: this plugin's own measured per-id row → the listing's published value → the family pattern → the conservative fallback. A measured row still wins, because the published `200000/32000` for the `-free` ids behaves as a *floor*: this lane accepted a 1025229-token prompt on `deepseek-v4.1-flash-free` and a 900694-token one on `glm-5.3-flash-free`, both answered with a 200. So `deepseek-v4.1-flash-free` is 1048576 / 384000 with vision (its family row said 128000 / 64000, vision off), `glm-5.3-flash-free` and `nemotron-3.5-super-vl-free` are 1048576 / 131072 with vision, and `big-pickle` 262144 / 131072 with vision instead of the fallback. Every other id takes the published figure where the listing states one, because no measurement contradicts it. `beam-free` and `flint-40b-free` keep the published or fallback value on purpose — nothing has been measured for them, and a guess would be worse than an honest floor. |
| 🧮 **An impossible usage stamp is dropped, not metered** | Free-lane multimodal turns have reported a prompt larger than the model's own window — observed as roughly 619k total on a 256k-window model after a short vision turn — and the host soft-budgets from that sample, then fail-closes with `CONTEXT_WINDOW_EXCEEDED` while the real conversation is a few thousand tokens. So a stamp whose input side cannot fit the window the catalog claims for that id is discarded at the source: output and reasoning counts survive, the prompt side is zeroed and `totalTokens` omitted, and the turn's accumulator holds input at 0 for the rest of the turn, because once one attempt's prompt is unknown no later sum rebuilds it. It fires only where the window is a measured row — a stamp above the *fallback* proves the fallback is undersized, not that the stamp is wrong. |
| 🧠 **A provider reason field is never silently dropped** | When an assistant message already carries a `reasoning_content` string, the Chat projection sends it upstream exactly as it arrived, an explicit empty string included — to a reasoning model "present but empty" and "absent" are different statements, and one that sees its own reasoning again on a tool follow-up turn keeps its thread where one without it restarts the problem. This is the provider *field* being preserved, not the harness's reasoning *blocks*, which are never projected onto the wire. Note that the harness transmits thinking as blocks, so in practice the field is usually absent and the guard finds nothing: it is there so that dropping it stays a decision rather than an accident. |
| ♻️ **Reasoning-cutoff continuation** | A turn cut off with reasoning and nothing visible — no text, no tool call, no finish token — is continued once from its checkpoint, with tools forced off. |
| 🎚 **Thinking levels are the real control** | The gateway *validates* `reasoning_effort` and the level measurably moves reasoning volume, so each model advertises the rungs it actually accepts (`none` … `max`) and the plugin sends the selected one verbatim. The menus differ per model: `big-pickle` has no `minimal`/`xhigh`, while the `-free` ids accept all seven. A level a model does not declare is never forwarded — it falls back to that model's default rather than drawing a 400. |
| 🏷 **Two tool names go out under an alias** | Reproduced from a real DSH request: this lane answers `429` for a body declaring `subagent_fork`, and for `read_image` together with `working_directory`. Sending the *same* request with only those names changed makes the complete 80-tool request succeed, so the refusal is keyed on the name, not the tool's shape or count. Those two go out as `conversation_delegate` / `workspace_directory`, keeping their description and schema; the name is restored in every tool call the decoder surfaces, and history is rewritten to match — a body that declares the alias while its own history calls the original name is exactly the inconsistency the alias exists to remove. An alias never lands on a name the caller really declared (it becomes `…2` instead). |
| 🧹 **Tool history is repaired, not just renamed** | The free tier refuses a body that still carries tool vocabulary the shaped request does not declare, and a history written before the shaping is full of it. So the pass is a repair: an emptied `tool_calls: []` field is removed outright (upstream measured a 400 for exactly that array), a call to a tool this request never declared is dropped *together with the result paired to it* so no orphan `role: 'tool'` row is left dangling, an assistant row with nothing left to say goes with the calls it lost, and a `tool_choice` naming a tool the shaped body no longer serves is removed rather than asking the model for a tool it was never given. All three wire shapes are covered — `tool_calls` / `function_call`, `function_call` / `function_call_output`, and `tool_use` / `tool_result`. Toolless replays are untouched: a body that declared no tools of its own has no gate to satisfy, and a forwarding client's context is not this lane's to delete. |
| ✂️ **A split tool name does not become a ghost tool** | Some gateways split `tool_calls[].function.name` across delta frames, and resolving each fragment on arrival folds half a name into a wrong or unknown tool — the harness then executes a ghost call, or reports a call to `deep` that no tool answers to. The name is buffered instead and resolved once, right before its first consumer needs it (the first argument delta, or the block close), so the deltas before that simply carry no name, which downstream consumers already tolerate. Both real shapes are handled: a server that repeats the complete name on every delta extends rather than double-concatenates, and one that genuinely splits it concatenates — a naive join turns three repeats of `read` into `readreadread`, and a naive replacement keeps only the last fragment of a split name. |
| 🫀 **A keepalive cannot keep a dead turn alive** | A comment frame (`: ping`) is something SSE says to ignore, so it must not wind the idle clock either. When a per-read timer reset on every byte, a gateway pinging every 10-15s held a wedged, token-less turn open indefinitely: the request never timed out, it just held a connection until the gateway itself gave up. The clock is now a rolling deadline that only real content re-arms — including a large body or a half-arrived `data:` line still accumulating in the buffer, which is progress even though nothing has been dispatched yet. |
| 🧩 **Only a *truncated* tool call kills the turn** | Arguments that do not parse split in two, and conflating them costs every recovery path. An *incomplete* value — unclosed string, unbalanced bracket, the shape a ceiling cut or a dropped frame leaves — is a broken turn. A *complete but invalid* one (a bare value with every bracket closed) is an ordinary call whose schema violation belongs back with the model as a fixable error; flagging it as broken marks the turn `max-tokens`, and the harness then prunes the call instead of executing it, so the model never learns what was wrong. Unbalanced counts in either direction, so a lost-prefix fragment (`"p.txt"}`) stays on the retry path. |
| 🩺 **An empty 5xx body is told apart from a hiccup** | `HTTP 502` with no envelope reads identically whether the gateway stumbled or refused this exact request. Since the lane answers a share of image requests with a bare 5xx and an empty body, that case now names the hop that failed and says the request carried images — matched across all three wire spellings (`image_url`, `input_image`, `image`) — while keeping the retryability a 5xx implies. A 4xx with an empty body still classifies from its status. |
| 👁 **`-vl` is the vendor's own vision marker** | `nemotron-3.5-super-vl` shipped that way, and a family row written before the variant existed would advertise it as text-only. A whole `vl` segment — between separators, or at either end — upgrades a row that says no vision, so the variant is not described as blind; a model that merely contains those letters (`avlantis`, `evil-free`) is not caught, and an id with its own measured row is untouched, because an exact id is the narrower claim. |
| 🧾 **Cache hits are declared as hits, not billed as misses** | The prompt side of every wire here is a total that already contains the cache hits, so `inputTokens` counts only the uncached remainder and the hits are reported separately. A stamp that folds them together is not a rounding error: the ledger prices a cached input at a fraction of a miss, so it reads as a 0% hit rate and bills every token at the miss rate. Four spellings of the same fact are accepted — Messages' `cache_read_input_tokens` / `cache_creation_input_tokens`, the OpenAI shape's `prompt_tokens_details.cached_tokens`, the Responses shape's `input_tokens_details.cached_tokens`, and `prompt_cache_hit_tokens`. Anthropic's own frame is honoured as the one shape whose `input_tokens` is *already* the uncached remainder, so it is declared rather than subtracted a second time — which would charge a fully-cached turn as zero input. |

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
        endpointStyle: family      # family | flat | zen — the inference path table (see below)
        laneBreaker: true          # refuse turns locally while a real 429's window is open
        freeLane:                  # the exit this lane dials from; empty means direct
          proxyUrl: ''             # http | https | socks5 | socks5h, credentials allowed
          fromEnvironment: false   # follow HTTPS_PROXY/HTTP_PROXY and honour NO_PROXY
        # wireOverrides:           # pin a model to a wire if the upstream moves it
        #   some-model-free: chat
        # baseUrl: https://opencode.ai
```

A key with the wrong shape is ignored with a warning rather than failing the
plugin — a plugin that refuses to load is far worse than one running with a
default.

The four newer keys each answer a question the lane's own behaviour raised:

| Key | Default | Why it exists |
|---|---|---|
| `endpointStyle` | `family` | Which prefix the inference paths ride. `family` is the official 2.2.x client's provider-family split (`/inference/openai/v1/*`, `/inference/anthropic/v1/messages?beta=true`), `flat` is the protocol-path form (`/inference/v1/*`), and `zen` restores the pre-2.1 `/zen/v1/*` paths byte-for-byte. Both fallbacks exist so a gateway that disagrees with the default costs one config key, not a release. |
| `laneBreaker` | `true` | Whether a real `429` becomes "every request is refused locally until the window ends". The refusal is local — the upstream never asked for it — so an operator debugging a model that stopped answering needs to be able to switch it off. Turning it off still records the passive verdicts behind it. |
| `freeLane.proxyUrl` | `''` | The exit address, since quota is counted per egress IP. `http`, `https`, `socks5` and `socks5h` are accepted (credentials included); empty means direct. Nothing rotates it automatically. |
| `freeLane.fromEnvironment` | `false` | Whether the lane may follow `HTTPS_PROXY`/`HTTP_PROXY` and honour `NO_PROXY`. Off by default on purpose: a machine that exports a proxy for corporate traffic must not silently reroute a lane whose quota is counted per IP. |

The environment's `HTTPS_PROXY` is only ever read when `fromEnvironment` is
`true`, and an explicit `proxyUrl` always wins over it. A configured address that
does not parse is reported once and the lane goes direct, which is where it was
before the fields existed — a typo costs a warning, not the mount.

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
| **Outbound hosts** | `opencode.ai` — inference and model listing, the only destination your prompts reach — plus `api.ipify.org` / `ipinfo.io` / `ipapi.co`, which are read once to learn this machine's public IP and country so the plugin knows whether a re-probe is needed. When `freeLane.proxyUrl` is set (or `freeLane.fromEnvironment` is on), those inference and listing requests go through the address you configured instead. Details in [Upstream](#upstream). |
| **Telemetry** | None. Nothing is reported anywhere except the request itself. |
| **Category** | Models & Reasoning. |

## What it looks like

The picker groups, exactly as the plugin advertises them (alphabetical, as
described under [Routes](#routes)):

```
OpenCode Free                   12 models
  Beam
  Big Pickle
  DeepSeek V4.1 Flash
  Flint 40B
  GLM 5.3 Flash
  Iceman
  Inkling 2 Small
  LongCat 2.5
  MiMo V2.6 Flash
  MiniMax M3.1 Flash
  Nemotron 3.5 Lightning
  Nemotron 3.5 Super VL
```

That is the roster as of 2026-11-16: twelve free ids on the listing. `union-alpha`
and the `-contributor-free` Muse Spark ids are retired from it — their wire
mappings still stand for when they return, which is why the protocol row above
still names them. `Jev 1.13` is on the upstream listing but serves no wire — every
protocol answers `400 ModelProtocolUnsupported` — so it is left out of the seed
and the first probe round removes it. `LongCat 2.5 Preview` and `Space Bunny` are
no longer on the listing at all, so they have left the roster too; their display
names stay in the table, which is only ever consulted for an id the gateway
actually named.

And one real streamed turn, captured against the live lane — note the disjoint
token accounting:

```
finish {"kind":"stop"}
usage  {"inputTokens":34,"outputTokens":16,"totalTokens":50,"reasoningTokens":14}
tools  0
answer "OK"
```

`inputTokens` is uncached input only — the provider's `prompt_tokens` minus any
cached prefix — which is what the harness expects and what the raw
`prompt_tokens` does not give you. This capture had no cache hit, so the field is
absent rather than zero.

A stamp is only metered when it can be true. The harness soft-budgets from the
last sample it saw, so a prompt count larger than the model's own window is not
merely wrong — it is what fail-closes a tiny conversation with
`CONTEXT_WINDOW_EXCEEDED`: the plugin drops the input side instead of forwarding
it, keeps the output and reasoning counts, and stops summing input for that turn.

## Layout

```
dsh-opencode-free-model/
├── cordis.patch.yml   the loader injection row
├── package.json       dsh.bundle.patch declaration (with the files allow-list)
├── icon.svg
├── LICENSE
├── README.md          this file
├── README.zh.md       Chinese
└── lib/               the plugin, 14 modules
    index.js     Host half: apply, registration, catalog refresh, probe loop (stamps verdict start time, egress generation), membership, config merge, quota breaker, passive verdicts
    adapter.js   OcFreeModelAdapter: providerInfo/listModels/resolveModel/prepareCall/stream (clamped usage, `upstreamFinish`, lane gate)
    upstream.js  upstream vocabulary: base URL, endpoint style tables, the tool gate (+ avoidance aliases, title exempt, history repair), session/request ids, headers (trace pair, stable project id)
    proxy.js     the lane's egress: proxy parsing/validation, CONNECT and SOCKS5 dials, `NO_PROXY` handling
    http.js      outbound HTTP: deadlines, content-gated SSE idle clock, byte sniffing, SSE framing, failure classification
    stream.js    three-wire SSE -> host StreamChunk (block allocation, cache-aware usage accounting + stamp clamp, buffered tool names, truncated-call detection, terminal frames, error frames)
    messages.js  tool-pairing repair + three-wire message projection (incl. a verbatim `reasoning_content` echo)
    effort.js    per-model thinking levels -> reasoning_effort
    recovery.js  checkpoint-continuation policy
    catalog.js   capability baseline + exact-id override layer + free-lane filter + listing parser + membership split
    probe.js     availability probing (concurrency 2, per-model session, failure classification, egress detection, start time)
    store.js     JsonStore (atomic writes, coalesced writes, corrupt files preserved)
    channel.js   single-producer / single-consumer async channel
    kernel.js    the only seam allowed to import @deepseek-ai/* (attribution UA)
```

`kernel.js` is the only file that names `@deepseek-ai/*`; every other module
depends on the structural `ctx` contract alone, so the plugin pins no kernel
version and the rule is checkable with one grep.

Two details there are easy to miss. `stream.js`'s clamp is applied by
`adapter.js`, not by the decoder, because whether a stamp is *impossible* depends
on the window the catalog claims for that id — an exact-id override or a family
row, never the conservative fallback. And a finish chunk carries
`upstreamFinish: <provider token>` only when the harness's fallback mapped an
abnormal ending onto `stop`, so a strict consumer (a manual probe, a post-mortem)
can decline to certify a turn that merely looks clean.

## Upstream

One source, and it is not a relay: `https://opencode.ai/inference/*`.

| Purpose | Target | Credential |
|---|---|---|
| Inference | `POST …/inference/openai/v1/chat/completions`, `…/inference/openai/v1/responses`, `…/inference/anthropic/v1/messages?beta=true` (per model) | `Authorization: Bearer public` — a public, key-free allowance; the plugin holds no user secret |
| Model listing | `GET …/inference/v1/models` | same |
| Egress IP | `api.ipify.org` / `ipinfo.io` / `ipapi.co` (reads back this machine's public IP and country code, only to decide whether a re-probe is needed) | none |

The inference paths are the official 2.2.x client's provider-family split, and the
listing path is style-independent: every style answers `/inference/v1/models`, so
a listing can never be the thing that tells you which inference path a gateway
serves. The two fallbacks are `endpointStyle: flat`, which puts the three
protocols back on one prefix (`/inference/v1/{chat/completions,responses,messages}`),
and `endpointStyle: zen`, which restores the pre-2.1 `/zen/v1/…` paths
byte-for-byte. Measured today (2026-11-16): all three families' `/models` answer
`200` with the same 104821-byte document, so the listing alone cannot distinguish
them; the inference paths themselves could not be compared, because this egress's
free allowance is exhausted and every `POST` answered `429 FreeUsageLimitError`.
The new default is therefore justified by matching the official client, not by a
measured win — and it is one config key away from reverting.

### The User-Agent conflict, explicitly

The harness's provider contract requires every request to carry an attribution
User-Agent, and states that nothing can suppress it. That string is
`deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)`.
This lane answers that exact product token with 403 `FreeTierError` — measured
case-insensitively, and regardless of anything else in the header — while a bare
`deepseek-harness` with no version, the same words inside a parenthesised URL,
and `deepseek_harness/…` all pass.

The plugin therefore sends
`opencode/1.18.31 dsh/<version> (+https://github.com/deepseek-ai/deepseek-harness)`:
the client token the lane identifies, plus the attribution with only its product
name respelled. This is a deliberate, documented deviation — the alternative is a
lane that answers 403 to every turn. `lib/http.js` (`userAgentWith`) is the single
place that does it, and `lib/kernel.js` still reports the harness's own string
unchanged, so the seam stays honest.

Nothing else on the wire is gated: every path style answers (`/inference/v1`,
`/inference/openai/v1`, `/inference/anthropic/v1` and `/zen/v1`), and
`x-opencode-client` / `x-opencode-request` / `x-opencode-session-id` /
`x-opencode-project` are all individually dispensable. The two checks that
actually decide the outcome are the session id's decoded shape and the
User-Agent token above — fixing one alone still returns 403.

### The trace pair, and why one conversation wants one bucket

Two more header facts come from the same "look like the official client" rule.

Every request carries a W3C trace pair: `traceparent` and the Zipkin single-header
`b3`, both well-formed (W3C version `00`, sampled flag `01`), with ids minted
fresh per request. A span is one request's work, so reusing a trace across
requests is the fingerprint of a broken instrumented client rather than of a real
one. The default `accept` moves with it and is now the `*/*` wildcard the official
client's fetch stack emits, rather than a type that tracks the wire.

The project header is the interesting one. Free-tier quota is ledged per project
id × egress, so the identity in `x-opencode-project` decides which bucket a
request draws from. A per-request id — what a reference gateway mints — scatters
one conversation's usage across identities the upstream cannot correlate, and a
shared literal (this plugin used to send `global`) arrives pre-burned: every
install behind it competes for one bucket. So the value is now a stable 40-hex id
derived from the conversation's own session. One conversation's retries,
continuations and refreshes share one quota bucket for its whole life, which is
what the per-project accounting is for; a genuinely different conversation gets a
different bucket because it is a different conversation. The gate checks the
shape of the value (40 lowercase hex), not the value itself, so a derived id is
exactly as acceptable as a minted one.

## Known limitations

- **`GenerateOptions` sampling is `temperature` / `maxTokens` / `stop` plus
  `reasoningEffort`**, and the lane honours the output ceiling and the thinking
  level. They are independent: the level controls how much the model thinks, the
  ceiling bounds thinking *and* answer together.
- **The thinking menu is per model**, because the gateway validates the value and
  the accepted sets genuinely differ (`big-pickle` refuses `minimal`/`xhigh`;
  `space-bunny-free`, when it returns to the roster, refuses `none`). A rung the
  model does not declare is substituted with that model's default rather than
  sent.
- **Region verdicts require probing**: the gateway does not disclose which models
  your egress may use, so the plugin has to ask — either with a probe or by
  reading the answer off a turn that already ran.
- **The new inference paths are not measured against a live turn yet**: on
  2026-11-16 all three families' `/models` answered `200` with the same
  104821-byte document, which distinguishes nothing, and every inference `POST`
  from this egress answered `429 FreeUsageLimitError`, so the paths could not be
  compared. The `family` default is justified by matching the official 2.2.x
  client, not by a measurement that it serves better; `endpointStyle: zen`
  restores the previous `/zen/v1/…` shape byte-for-byte if it turns out wrong.
- **The quota breaker is a local refusal**: with `laneBreaker` on, a real `429`
  makes the plugin refuse the lane from its own bookkeeping, so the failure you
  see is `RATE_LIMIT` with the retry time rather than the upstream's answer. Set
  `laneBreaker: false` to send the traffic anyway.
- **The probe period is read at mount time**: changing `probeIntervalMinutes`
  needs a plugin reload to take effect.
- **The lane's gate is not a published contract**: the session-id shape and the
  refused User-Agent token were established by measurement, not documentation, so
  the gateway can tighten them again without notice. When it does, every turn
  fails with `FreeTierError` surfaced as `CLIENT_ERROR` and `fingerprintRejected:
  true` — that is the signal to look for an update, not to re-authenticate.
- **The attribution User-Agent is respelled**, not omitted: see
  [The User-Agent conflict](#the-user-agent-conflict-explicitly).

## License

MIT — see [`LICENSE`](LICENSE).

The wire-protocol facts (the pooled key-free credential, the client fingerprint
headers, the per-model endpoint split, the free-tier tool-fingerprint gate, the
per-session quota accounting, and the regional gate) come from the MIT-licensed
reference implementation `dsh-our-free-model` (Copyright © 2026 zouyuxuan122) and
the `zen-gate` project. Both copyright notices are carried in `LICENSE`, which is
kept as unmodified MIT text so the license is machine-detectable.
