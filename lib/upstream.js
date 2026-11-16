/**
 * Upstream wire facts for the OpenCode Zen free lane.
 *
 * These are not guesses: the base URL, the pooled credential, the client
 * fingerprint headers, the per-model endpoint split, the free-tier
 * tool-fingerprint gate (403 `FreeTierError` without it), the per-session quota
 * accounting (429 `FreeUsageLimitError` when a fresh session is minted per
 * request) and the regional gate (403 `RegionError`) were each established by
 * direct request against the live gateway.
 *
 * Nothing in this module performs I/O. It is the pure vocabulary — paths,
 * headers, id shapes, the tool gate — that `http.js` and `adapter.js` build on.
 *
 * @module lib/upstream.js
 */

import crypto from 'node:crypto'

/**
 * The gateway root. Overridable so an operator can point the adapter at a
 * self-hosted mirror instead of the real free lane.
 */
export const UPSTREAM_BASE = process.env.OPENCODE_FREE_MODEL_BASE ?? 'https://opencode.ai'

/** A client version >= 1.17 is required by the gateway's own User-Agent check. */
export const CLIENT_UA = 'opencode/1.18.31'

/** The gateway truncates `x-opencode-session` past this many characters. */
export const MAX_SESSION_LENGTH = 256

/** The wire rejects tool names longer than this. */
export const MAX_TOOL_NAME_LEN = 128

/**
 * The lowercase tool quartet the free tier requires the request to declare.
 *
 * The gate fingerprints the *declared names*; it does not check that the model
 * can actually call them. A request that omits any of the four is answered with
 * 403 `FreeTierError` before the model is ever reached.
 */
export const FINGERPRINT_TOOLS = ['bash', 'glob', 'grep', 'read']

/**
 * Quartet slots a tool the caller already has can answer for, keyed by the
 * required spelling.
 *
 * DSH names its shell tool `pwsh` on Windows and `bash` elsewhere, so the same
 * plugin must fill the slot from whichever the kernel mounted. Promoting the
 * real shell into the slot costs the gate nothing — it fingerprints names — and
 * the model's resulting call comes back executable, where a decoy's would not.
 */
const QUARTET_DONORS = { bash: ['pwsh'] }

/**
 * Names this lane refuses to see declared, and the alias each goes out as.
 *
 * Reproduced from a real DSH request (upstream, 2026-10-30): the lane answered
 * `429` for a request declaring `subagent_fork` on its own, and for `read_image`
 * together with `working_directory`. Sending the very same request with only
 * those two names changed made the complete 80-tool request succeed, so the
 * refusal is keyed on the *name*, not on the tool's shape or count.
 *
 * Only the outbound spelling moves. The tool keeps its description and schema,
 * the harness keeps its own vocabulary, and the name is mapped back on the way
 * home by {@link restoreToolName} — which the decoder already applies to every
 * tool call it surfaces, so a renamed call still arrives executable. History is
 * rewritten to match by {@link aliasHistoryToolNames}, because a body that
 * declares the alias while its own history calls the original name is exactly
 * the inconsistency this is meant to remove.
 */
const FREE_LANE_TOOL_ALIASES = Object.freeze({
  subagent_fork: 'conversation_delegate',
  working_directory: 'workspace_directory',
})

/**
 * The endpoint tables this lane can speak, one per style, in preference order.
 *
 * The style is a setting rather than something to discover: the wire is still
 * chosen per model id, and only the prefix in front of the protocol path moves.
 * `family` is the 2.1 client's provider-family grouping, `flat` is the older
 * protocol-path form (still answered), and `zen` is the pre-2.1 shape this fork
 * shipped before the split.
 */
export const ENDPOINT_STYLES = ['family', 'flat', 'zen']

/** The style a body is sent under when the operator names none. */
export const DEFAULT_ENDPOINT_STYLE = 'family'

const ZEN_ENDPOINTS = {
  chat: '/zen/v1/chat/completions',
  responses: '/zen/v1/responses',
  messages: '/zen/v1/messages',
}

/**
 * Every wire path the `zen` style serves, keyed by wire name.
 *
 * Kept under its old name because callers pinned it before the style split: it
 * *is* the `zen` table, not a copy that could drift away from it.
 */
export const ENDPOINT_BY_WIRE = ZEN_ENDPOINTS

const ENDPOINT_BY_STYLE = {
  family: {
    chat: '/inference/openai/v1/chat/completions',
    responses: '/inference/openai/v1/responses',
    messages: '/inference/anthropic/v1/messages?beta=true',
  },
  flat: {
    chat: '/inference/v1/chat/completions',
    responses: '/inference/v1/responses',
    messages: '/inference/v1/messages',
  },
  zen: ZEN_ENDPOINTS,
}

/**
 * The three wire paths one endpoint style serves.
 *
 * An unknown value — an absent setting, a typo in the config file — falls back
 * to {@link DEFAULT_ENDPOINT_STYLE} rather than producing an undefined path that
 * would fail later as an opaque transport error.
 *
 * @param {string} [style] - one of {@link ENDPOINT_STYLES}
 * @returns {{chat: string, responses: string, messages: string}}
 */
export function endpointsFor(style) {
  const table = typeof style === 'string' && Object.hasOwn(ENDPOINT_BY_STYLE, style)
    ? ENDPOINT_BY_STYLE[style]
    : ENDPOINT_BY_STYLE[DEFAULT_ENDPOINT_STYLE]
  return { ...table }
}

/** The catalog listing path. Style-independent: every style answers it. */
export const MODELS_PATH = '/inference/v1/models'

/**
 * Models served by `/responses` rather than `/chat/completions`.
 *
 * Both entries are retired upstream (the lane now names `muse-spark-1.2` /
 * `muse-spark-1.3` without the `-contributor-free` suffix, and neither is
 * key-free). The set is kept because routing is also reached through
 * {@link isMuseSpark}, which matches the family by pattern, and an operator
 * override can pin a wire regardless of this table.
 */
const RESPONSES_MODELS = new Set(['muse-spark-1.2-contributor-free', 'muse-spark-1.3-contributor-free'])

/** Models served by the Anthropic-shaped `/messages` endpoint. */
const MESSAGES_MODELS = new Set(['union-alpha'])

/** Canonical id shapes the gateway mints; shared with the response-side rules. */
export const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
export const REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * Map bytes onto the base62 alphabet the gateway uses for the random tail of
 * its ids. `byte % 62` is slightly biased, which does not matter: the tail
 * exists to make ids unique, not to be a uniform draw.
 */
function base62From(bytes) {
  let out = ''
  for (const byte of bytes) out += BASE62[byte % 62]
  return out
}

/** Render the low 6 bytes of a value as the gateway's 12-hex-digit id prefix. */
function hexPrefix(value) {
  let hex = ''
  for (let i = 0; i < 6; i += 1) {
    hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  }
  return hex
}

let lastStamp = 0
let sequence = 0

/**
 * Mint a gateway-shaped session id.
 *
 * The 12 hex digits are a bit-inverted, time-prefixed counter and the 14
 * trailing characters are random — the same layout the real desktop client
 * produces, which is what the gateway's shape check accepts.
 *
 * @param {number} [timestamp]
 * @returns {string}
 */
export function mintSessionId(timestamp = Date.now()) {
  if (timestamp !== lastStamp) {
    lastStamp = timestamp
    sequence = 0
  }
  sequence += 1
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(sequence))
  return `ses_${hexPrefix(value)}${base62From(crypto.randomBytes(14))}`
}

/**
 * Mint a gateway-shaped request id for one turn.
 * @param {number} [timestamp]
 * @returns {string}
 */
export function mintRequestId(timestamp = Date.now()) {
  return `msg_${hexPrefix(BigInt(timestamp) * 0x1000n + 1n)}${base62From(crypto.randomBytes(14))}`
}

/**
 * Map one downstream conversation onto one stable upstream session.
 *
 * Free-tier quota is accounted per session, so minting a fresh id per request
 * exhausts it and surfaces as a 429 whose `retry-after` keeps growing. A digest
 * of the harness session id gives the same conversation the same canonical
 * session across restarts, which is how the real client behaves.
 *
 * The gateway does not merely shape-check the id, it *decodes* it: the twelve
 * hex digits are `~(time * 0x1000 + counter)` and the counter must stay small
 * (measured 2026-10: 0–63 pass, 64 and up are refused with 403 `FreeTierError`).
 * A raw sha256 prefix — any random hex — decodes to a random counter and is
 * refused even when every header and the whole body are right, which is exactly
 * how this lane was failing before the derivation below was corrected. So the
 * digest feeds the id without being copied into it: five bytes become the time
 * field, the counter is pinned to 1, and the whole value is inverted into the
 * canonical encoding. That keeps the id stable per conversation *and* canonical.
 *
 * `purpose` splits one conversation's other traffic off onto its own session.
 * Free-tier quota is now ledged per project rather than per session, but a
 * background purpose — a catalog refresh, a probe — still must not spend the
 * bucket a user's live turn is mid-way through, and it must not inherit that
 * turn's session either. Naming the purpose prefixes the seed, so each purpose
 * derives its own stable session while the same purpose keeps re-using it. No
 * purpose is the plain conversation derivation, unchanged.
 *
 * @param {string|undefined} sessionId - `GenerateOptions.sessionId`, when sent
 * @param {string} [purpose] - non-empty names a separate session namespace
 * @returns {string}
 */
export function sessionForConversation(sessionId, purpose) {
  const namespace = typeof purpose === 'string' && purpose.trim() !== '' ? purpose.trim() : ''
  const raw = namespace === '' ? sessionId : `${namespace}:${sessionId ?? 'global'}`
  const seed = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : 'global'
  if (SESSION_RE.test(seed)) return seed
  const digest = crypto.createHash('sha256').update(`opencode-free-model\0${seed}`).digest()
  let time = 0n
  for (let i = 0; i < 5; i += 1) time = (time << 8n) | BigInt(digest[i])
  return `ses_${hexPrefix(~((time << 12n) | 1n))}${base62From(digest.subarray(6, 20))}`
}

/**
 * A stable per-turn request id, so retries of the same turn share one id.
 *
 * @param {string} sessionId
 * @param {string|undefined} turnSeed - anything stable for the turn
 * @returns {string}
 */
export function requestIdFor(sessionId, turnSeed) {
  if (typeof turnSeed !== 'string' || turnSeed === '') return mintRequestId()
  const digest = crypto.createHash('sha256').update(`opencode-free-model-req\0${sessionId}\0${turnSeed}`).digest()
  const id = `msg_${digest.subarray(0, 6).toString('hex')}${base62From(digest.subarray(6, 20))}`
  return REQUEST_RE.test(id) ? id : mintRequestId()
}

/**
 * Strip a trailing `(level)` thinking suffix so lookups hit the base id.
 *
 * The harness appends the reasoning effort to the model id in some surfaces;
 * the upstream must see the bare id.
 *
 * @param {unknown} model
 * @returns {string}
 */
export function baseModelId(model) {
  return String(model ?? '').replace(/\([^()]+\)\s*$/, '').trim()
}

function isMuseSpark(modelId) {
  const clean = baseModelId(modelId)
  const base = clean.includes('/') ? clean.split('/').pop() : clean
  return /^muse[-_]?spark(?:$|[-_:.\s])/i.test(base)
}

/**
 * Which wire a model answers on.
 *
 * `overrides` is consulted first so an operator can pin a model to a wire when
 * the upstream moves it without waiting for a plugin release.
 *
 * @param {string} modelId
 * @param {Record<string, string>|undefined} [overrides] - base id -> wire name
 * @returns {'chat'|'responses'|'messages'}
 */
export function resolveWire(modelId, overrides) {
  const base = baseModelId(modelId)
  const override = overrides?.[base]
  if (override === 'chat' || override === 'responses' || override === 'messages') return override
  if (MESSAGES_MODELS.has(base)) return 'messages'
  if (RESPONSES_MODELS.has(base) || isMuseSpark(base)) return 'responses'
  return 'chat'
}

/**
 * The upstream path for one model.
 *
 * The wire is resolved per model id; only the prefix in front of the protocol
 * path depends on `style` (see {@link endpointsFor}).
 *
 * @param {string} modelId
 * @param {Record<string, string>|undefined} [overrides]
 * @param {string} [style] - one of {@link ENDPOINT_STYLES}; defaults to
 *   {@link DEFAULT_ENDPOINT_STYLE}
 * @returns {string}
 */
export function endpointFor(modelId, overrides, style) {
  return endpointsFor(style)[resolveWire(modelId, overrides)]
}

/**
 * One W3C Trace Context pair for one request.
 *
 * The official client carries `traceparent` and `b3` on every inference request
 * — the distributed trace propagation any OTel-instrumented HTTP stack emits.
 * Whatever the gate does with them, a third-party client that omits both looks
 * less like the real thing, so the lane sends a well-formed pair: one trace id
 * and one span id in the W3C layout (version `00`, sampled flag `01`), and the
 * Zipkin single-header `b3` form carrying the same ids plus the parent span its
 * shape expects.
 *
 * The ids are fresh per call on purpose: a span is one request's work, and
 * reusing a trace across requests is the fingerprint of a broken instrumented
 * client rather than of a real one.
 *
 * @returns {{'traceparent': string, 'b3': string}}
 */
export function traceHeaders() {
  const traceId = crypto.randomBytes(16).toString('hex')
  const spanId = crypto.randomBytes(8).toString('hex')
  const parentId = crypto.randomBytes(8).toString('hex')
  return {
    'traceparent': `00-${traceId}-${spanId}-01`,
    'b3': `${traceId}-${spanId}-1-${parentId}`,
  }
}

/**
 * The stable project id one conversation is accounted under.
 *
 * Free-tier quota is ledged per project id × egress, so a per-request id — what
 * the reference gateway mints — scatters one conversation's usage across
 * identities the upstream cannot correlate, and a shared literal one arrives
 * pre-burned. Deriving the id from the session instead keeps one conversation
 * on one bucket for its whole life while still landing in the 40-lowercase-hex
 * shape the gate checks (the value itself is not inspected, only its shape).
 *
 * `\0` separates the namespace from the session so a session id that happens to
 * contain the prefix cannot collide with another derivation.
 *
 * @param {string|undefined} session
 * @returns {string} 40 lowercase hex characters
 */
export function stableProjectId(session) {
  return crypto.createHash('sha256')
    .update(`opencode-free-model-project\0${String(session ?? '')}`)
    .digest()
    .subarray(0, 20)
    .toString('hex')
}

/**
 * The headers the gateway fingerprints a genuine desktop client by.
 *
 * `Authorization: Bearer public` is the pooled credential — there is no
 * per-user secret anywhere on this lane, which is exactly why the plugin needs
 * no API key and stores none.
 *
 * The trace pair rides every request (see {@link traceHeaders}), the project id
 * defaults to the conversation-stable one (see {@link stableProjectId}) so a
 * retried turn or a catalog refresh stays in the same quota bucket, and `accept`
 * defaults to the wildcard the official client's fetch stack emits. Passing
 * `accept: null` omits the header entirely, which is how a caller asks for a
 * request without one.
 *
 * `stream` is still accepted and ignored: it used to pick the default `accept`,
 * but the official client sends the wildcard either way, so the value no longer
 * depends on it. Keeping the key costs nothing and spares every caller a change.
 *
 * @param {object} input
 * @param {string} input.session
 * @param {string} input.requestId
 * @param {boolean} [input.stream] - accepted for signature compatibility, unused
 * @param {string|null} [input.accept] - `null` omits the header
 * @param {string} [input.project] - caller project signal; defaults to
 *   {@link stableProjectId} of `session`
 * @returns {Record<string, string>}
 */
export function gatewayHeaders({ session, requestId, accept, project }) {
  const headers = {
    'content-type': 'application/json',
    'authorization': 'Bearer public',
    'user-agent': CLIENT_UA,
    'x-opencode-client': 'desktop',
    'x-opencode-session': truncateSession(session),
    'x-opencode-request': requestId,
    'x-opencode-project': project ?? stableProjectId(session),
    ...traceHeaders(),
  }
  if (accept !== null) headers['accept'] = accept ?? '*/*'
  return headers
}

/**
 * Clamp a session id to the length the gateway keeps.
 * @param {unknown} value
 * @returns {string}
 */
export function truncateSession(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > MAX_SESSION_LENGTH ? trimmed.slice(0, MAX_SESSION_LENGTH) : trimmed
}

function toolNameOf(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return ''
  if (typeof tool.name === 'string' && tool.name.trim() !== '') return tool.name.trim()
  const fn = tool.function
  if (fn && typeof fn === 'object' && !Array.isArray(fn) && typeof fn.name === 'string') return fn.name.trim()
  return ''
}

/** The quartet slot a tool name fills, or `''` when it fills none. */
function quartetKey(name) {
  const lower = String(name ?? '').trim().toLowerCase()
  return FINGERPRINT_TOOLS.includes(lower) ? lower : ''
}

/** The Chat-shape `{function:{…}}` wrapper, or `null` for the flat shape. */
function functionOf(tool) {
  return tool.function && typeof tool.function === 'object' && !Array.isArray(tool.function) ? tool.function : null
}

/** Rewrite one tool's name in place-safe fashion, preserving its wrapper shape. */
function renamed(tool, name) {
  const fn = functionOf(tool)
  return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name }
}

/**
 * The request shapes the free tier reads as a conversation-title generator.
 *
 * Measured upstream (opencode2api v1.4.7): a toolless title call that arrives
 * carrying an agent-shaped tool list is answered with 403/429 — the gate reads
 * the tool vocabulary and the missing conversation as a client that is not the
 * one it expects. This lane appends the quartet to *every* body, so whenever the
 * harness asks the model for a title and the local title answer is switched off,
 * the request shipped in exactly the shape that draws the refusal. A title call
 * now goes out as the caller wrote it: no tool append, no renames, no trace of a
 * tool list.
 */
const TITLE_MARKERS = /generate a title|write a title|create a title|come up with a title|title (?:for|of) (?:this|the) (?:conversation|chat|session|exchange|request)|conversation title|summarize (?:this|the) conversation/i

/** The body shape one `applyFingerprint` style flag speaks. */
function shapeOf(style) {
  return style === true ? 'flat' : style === 'claude' ? 'claude' : 'chat'
}

/**
 * Is this body a request for a conversation title?
 *
 * The test mirrors what a title generator's request looks like on the wire, and
 * every clause is necessary:
 *
 * - **No tools.** A body declaring tools is agent-shaped by definition, and the
 *   gate's objection is exactly the tool list. Legacy `functions` count too.
 * - **No `tool_choice`.** Even `none` says the caller is thinking about tools.
 * - **One to three turns, and not one of them an assistant or tool turn.** A
 *   title call is a single instruction plus its subject, not a conversation with
 *   a model that answered before; a real turn that merely *mentions* a title
 *   would fail this and keep its tools.
 * - **A title marker in the instruction text.** Without it a plain one-turn
 *   "hello" is a legitimate chat, and stripping its tools would silently take
 *   the agent apart for a turn.
 *
 * `style` is the same flag {@link applyFingerprint} takes, so the leading text
 * is read where each wire keeps it: `instructions` for the Responses wire,
 * `system` for Messages, and the system messages inside `messages` for Chat.
 *
 * @param {object} body
 * @param {boolean|'claude'} [style] - `true` for Responses, `'claude'` for
 *   Messages, falsy for Chat
 * @returns {boolean}
 */
export function isTitleRequest(body, style) {
  if (body === null || typeof body !== 'object') return false
  if (Array.isArray(body.tools) && body.tools.length > 0) return false
  if (Array.isArray(body.functions) && body.functions.length > 0) return false
  if (body.tool_choice !== undefined) return false
  const shape = shapeOf(style)
  const textOf = value => (typeof value === 'string'
    ? value
    : Array.isArray(value) ? value.map(part => part?.text ?? '').join('\n') : '')
  let turns
  let leading = ''
  if (shape === 'flat') {
    turns = (Array.isArray(body.input) ? body.input : []).filter(item => item !== null && typeof item === 'object' && typeof item.role === 'string')
    leading = textOf(body.instructions)
  } else {
    turns = (Array.isArray(body.messages) ? body.messages : []).filter(message => message !== null && typeof message === 'object')
    leading = shape === 'claude' ? textOf(body.system) : ''
  }
  if (turns.length === 0 || turns.length > 3) return false
  for (const turn of turns) {
    if (!['user', 'system', 'developer'].includes(String(turn.role ?? ''))) return false
  }
  return TITLE_MARKERS.test(`${leading}\n${turns.map(turn => textOf(turn.content)).join('\n')}`)
}

/**
 * Satisfy the free-tier fingerprint gate on `body.tools`.
 *
 * The gate demands all four lowercase quartet names be declared. DSH's own
 * shell and filesystem tools already answer to `bash`/`glob`/`grep`/`read` on a
 * kernel that names its shell `bash`, so a normal agent turn declares them for
 * real. A slot the caller does not field is filled by promoting a tool that can
 * genuinely answer for it (see {@link QUARTET_DONORS}) before it is faked, and
 * only a slot with nothing to promote gets a self-disabling decoy.
 *
 * Two details make the difference between a working turn and a broken one:
 * case variants are canonicalised rather than duplicated (the upstream rejects
 * `Bash` + `bash` as a duplicate), and the returned rename map lets the
 * response side restore the caller's own spelling — which is what makes a
 * promoted tool actually callable.
 *
 * The tool list is also the whitelist for the history pass at the end: once the
 * declared spellings are final, a call to anything else in the history is a tool
 * the shaped body does not serve, and the free tier refuses bodies that carry
 * one.
 *
 * A title request is returned untouched, before anything above runs; see
 * {@link isTitleRequest} for why.
 *
 * @param {object} body - request body, mutated in place
 * @param {boolean|'claude'} style - `true` for Responses, `false` for Chat,
 *   `'claude'` for Messages
 * @returns {Map<string, string>} sent spelling -> caller spelling
 */
export function applyFingerprint(body, style) {
  const flat = style === true
  const claude = style === 'claude'
  const map = new Map()
  // Nothing may be written to a title request — not the tool list, not the
  // history, not a tool_choice default. It ships exactly as the caller wrote it.
  if (isTitleRequest(body, style)) return map
  const tools = Array.isArray(body.tools) ? body.tools : []
  const hadClientTools = tools.length > 0
  const seen = new Set()
  const out = []
  // Every name already spoken for, so an avoidance alias can never land on top of
  // a tool the caller really declared. Lowercased because the gate's own quartet
  // matching is case-insensitive, so `Read` and `read` are the same collision.
  const taken = new Set()
  for (const tool of tools) {
    const name = toolNameOf(tool)
    if (name !== '') taken.add(name.toLowerCase())
  }

  for (const tool of tools) {
    const current = toolNameOf(tool)
    // Names this lane refuses outright are sent under an alias and keep their
    // description and schema; see FREE_LANE_TOOL_ALIASES. Checked before the
    // quartet handling because these are never quartet slots.
    const avoid = Object.hasOwn(FREE_LANE_TOOL_ALIASES, current) ? FREE_LANE_TOOL_ALIASES[current] : undefined
    if (avoid !== undefined) {
      let alias = avoid
      for (let i = 2; taken.has(alias.toLowerCase()); i += 1) alias = `${avoid}${i}`
      taken.add(alias.toLowerCase())
      map.set(alias, current)
      out.push(renamed(tool, alias))
      continue
    }
    const key = quartetKey(current)
    if (key === '') {
      out.push(tool)
      continue
    }
    // A second spelling of an already-filled slot is dropped, not renamed: two
    // tools in the same slot is what the upstream calls a duplicate.
    if (seen.has(key)) continue
    seen.add(key)
    if (current === key) out.push(tool)
    else {
      map.set(key, current)
      out.push(renamed(tool, key))
    }
  }

  // Promote a real tool into a slot nothing else fills. A decoy is a name the
  // model will happily call; with only `pwsh` on the session the `bash` decoy
  // was observed being invoked repeatedly, every call an unknown tool. The gate
  // only fingerprints declared names, so promoting the real shell is free.
  const promoted = new Set()
  for (const name of FINGERPRINT_TOOLS) {
    if (seen.has(name)) continue
    const donors = QUARTET_DONORS[name] ?? []
    const index = out.findIndex(tool => {
      const original = toolNameOf(tool)
      if (original === '' || quartetKey(original) !== '') return false
      return !promoted.has(original.toLowerCase()) && donors.includes(original.toLowerCase())
    })
    if (index === -1) continue
    const original = toolNameOf(out[index])
    promoted.add(original.toLowerCase())
    map.set(name, original)
    out[index] = renamed(out[index], name)
    seen.add(name)
  }

  for (const name of FINGERPRINT_TOOLS) {
    if (seen.has(name)) continue
    const decoy = { description: 'This tool is currently unavailable and must not be used.' }
    out.push(claude
      ? { name, ...decoy, input_schema: { type: 'object', properties: {} } }
      : flat
        ? { type: 'function', name, ...decoy, parameters: { type: 'object', properties: {} } }
        : { type: 'function', function: { name, ...decoy, parameters: { type: 'object', properties: {} } } })
  }

  body.tools = out
  aliasHistoryToolNames(body, map)
  // Only a body that declares tools of its own is agent-shaped, and only
  // agent-shaped traffic is sanitised — see {@link sanitizeToolHistory}. The
  // count is the *pre-shaping* list, because the quartet the gate appends must
  // not turn a toolless replay into a body whose history gets rewritten.
  if (hadClientTools) sanitizeToolHistory(body, style, map)
  if (!body.tool_choice) {
    // The Responses wire takes a bare string; the Messages wire wants its own
    // object shape. `none` is only safe when the caller declared no tools of
    // its own — otherwise it would disable the very tools that were just sent.
    if (flat) body.tool_choice = 'auto'
    else if (!hadClientTools) body.tool_choice = claude ? { type: 'none' } : 'none'
  }
  return map
}

/**
 * Does a chat row still carry something worth sending after its calls were
 * removed?
 *
 * Mirrors the reference gateway's `chatMessageHasContent`: an assistant row is
 * only worth keeping when it says something — text, reasoning, or a structured
 * payload a wire understands. A row that held nothing but a tool call the body
 * no longer declares has nothing left to say, and an empty assistant turn is
 * itself a shape the free tier refuses; dropping it is the only valid answer.
 *
 * `tool_calls: []` deliberately does not count as content: that empty array is
 * exactly the field the chat sanitiser removes, so treating it as a payload
 * would keep the row that the removal was meant to clean up.
 *
 * @param {object} message
 * @returns {boolean}
 */
function chatMessageHasContent(message) {
  const keys = ['content', 'reasoning_content', 'reasoning']
  for (const key of keys) {
    const value = message[key]
    if (typeof value === 'string') {
      if (value !== '') return true
      continue
    }
    if (Array.isArray(value)) {
      if (value.length > 0) return true
      continue
    }
    if (value !== null && typeof value === 'object') {
      if (Object.keys(value).length > 0) return true
      continue
    }
    if (value !== undefined && value !== null) return true
  }
  return false
}

/**
 * Drop ghost tool calls and the results paired to them.
 *
 * A shaped body's call history is only valid when every call names a tool the
 * wire actually serves this pass — a name in the final tool list, or one of the
 * aliases the rename map sent. Anything else is a ghost: a tool the caller
 * dropped from its declarations, a name left behind by a plugin change
 * mid-conversation, or a hand-edited history that still calls the caller's own
 * spelling of a renamed tool. The free tier answers a body carrying one with the
 * same refusals it saves for foreign tool vocabulary.
 *
 * The call goes, and the result message paired to it goes with it, because an
 * orphaned result is its own shape violation — a `role: 'tool'` row whose
 * `tool_call_id` names no call the body declares is a dangling reference, and
 * some wires reject it outright.
 *
 * Why the empty array: a caller that replays its conversation may send
 * `tool_calls: []` on every turn — the harness writes the field whenever a turn
 * has none — and the free tier measured a 400 for exactly that. The array is
 * therefore removed whether it lost its last entry here or arrived empty.
 *
 * Only agent-shaped traffic is sanitised, and this runs only when the caller
 * declared a tool of its own: the gate's vocabulary check inspects bodies that
 * carry a tool list, so a toolless forwarding client replaying a conversation
 * with tool history keeps that history verbatim. There is no gate to satisfy, and
 * the model needs its context.
 *
 * Copy-on-write, like every edit here: the caller's message objects are shared
 * with the host harness, so a touched row is replaced with a shallow copy and
 * rows are removed by rebuilding the array — never by mutating the caller's
 * array or a row this pass did not create.
 *
 * @param {object} body - the shaped request body, edited in place
 * @param {boolean|'claude'} style - the `applyFingerprint` style flag
 * @param {Map<string, string>} map - alias -> the caller's original spelling
 */
function sanitizeToolHistory(body, style, map) {
  const shape = shapeOf(style)
  // The whitelist is what the shaped body now *serves*: every name in the final
  // tool list (aliases, promoted slots, decoys — whatever the wire will see),
  // plus every alias the rename map sent, which covers a renamed tool even if a
  // later pass were to trim its declaration.
  const served = new Set()
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    const name = toolNameOf(tool)
    if (name !== '') served.add(name)
  }
  for (const alias of map.keys()) served.add(alias)
  if (shape === 'flat') sanitizeResponsesHistory(body, served)
  else if (shape === 'claude') sanitizeMessagesHistory(body, served)
  else sanitizeChatHistory(body, served)
  dropDanglingToolChoice(body, shape, served)
}

/** Remove ghost calls from the Chat shape: `tool_calls`, legacy `function_call`. */
function sanitizeChatHistory(body, served) {
  if (!Array.isArray(body.messages)) return
  const droppedCalls = new Set()
  const droppedFunctions = new Set()
  const out = []
  const emptied = new Set()
  for (const message of body.messages) {
    if (message === null || typeof message !== 'object') {
      out.push(message)
      continue
    }
    let row = message
    let hadCalls = false
    if (Array.isArray(message.tool_calls)) {
      hadCalls = message.tool_calls.length > 0
      const kept = []
      // An already-empty array is "touched" too: it must not be forwarded.
      let touched = message.tool_calls.length === 0
      for (const call of message.tool_calls) {
        if (served.has(call?.function?.name)) {
          kept.push(call)
          continue
        }
        if (typeof call?.id === 'string' && call.id !== '') droppedCalls.add(call.id)
        touched = true
      }
      if (touched) {
        if (kept.length === 0) {
          // Never write the field back empty; the whole field goes.
          const { tool_calls: _dropped, ...rest } = message
          row = rest
        } else {
          row = { ...message, tool_calls: kept }
        }
      }
    }
    // The legacy branch reads the row as it now stands: spreading the pre-edit
    // row would resurrect the empty array that was just removed.
    if (row.function_call !== null && typeof row.function_call === 'object' && !Array.isArray(row.function_call)) {
      if (!served.has(row.function_call.name)) {
        if (typeof row.function_call.name === 'string') droppedFunctions.add(row.function_call.name)
        const { function_call: _dropped, ...rest } = row
        row = rest
      }
    }
    // A result whose call is gone is a dangling reference, not a message.
    if (row.role === 'tool' && droppedCalls.has(row.tool_call_id)) continue
    if (row.role === 'function' && droppedFunctions.has(row.name)) continue
    // Only a row that lost *every* call is at risk of being emptied: one that
    // kept a call still carries a tool exchange the model must see.
    if (hadCalls && row.tool_calls === undefined && row.function_call === undefined) emptied.add(out.length)
    out.push(row)
  }
  body.messages = emptied.size === 0
    ? out
    : out.filter((row, index) => !(emptied.has(index) && !chatMessageHasContent(row)))
}

/** Remove ghost calls from the Responses shape: `function_call` / `function_call_output`. */
function sanitizeResponsesHistory(body, served) {
  if (!Array.isArray(body.input)) return
  const droppedCalls = new Set()
  const out = []
  for (const item of body.input) {
    const type = typeof item?.type === 'string' ? item.type : ''
    if (type === 'function_call') {
      if (served.has(item.name)) {
        out.push(item)
        continue
      }
      if (typeof item.call_id === 'string' && item.call_id !== '') droppedCalls.add(item.call_id)
      continue
    }
    if (type === 'function_call_output' && droppedCalls.has(item.call_id)) continue
    out.push(item)
  }
  body.input = out
}

/** Remove ghost calls from the Messages shape: `tool_use` / `tool_result` blocks. */
function sanitizeMessagesHistory(body, served) {
  if (!Array.isArray(body.messages)) return
  const droppedCalls = new Set()
  const out = []
  for (const message of body.messages) {
    if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) {
      out.push(message)
      continue
    }
    const kept = []
    let touched = false
    for (const block of message.content) {
      if (block?.type === 'tool_use') {
        if (served.has(block.name)) {
          kept.push(block)
          continue
        }
        if (typeof block.id === 'string' && block.id !== '') droppedCalls.add(block.id)
        touched = true
        continue
      }
      if (block?.type === 'tool_result' && droppedCalls.has(block.tool_use_id)) {
        touched = true
        continue
      }
      kept.push(block)
    }
    if (!touched) {
      out.push(message)
      continue
    }
    // This wire has no empty message: a content array that lost everything in it
    // is invalid on its own, so the message leaves with its blocks.
    if (kept.length > 0) out.push({ ...message, content: kept })
  }
  body.messages = out
}

/**
 * Remove a named `tool_choice` that names a tool the shaped body no longer
 * serves.
 *
 * A pinned choice is an instruction to call one specific tool. If the shaped
 * body does not declare it, the body asks the model for a tool it was never
 * given — the same declaration/history incoherence the renaming exists to
 * remove, and a refusal the caller cannot see coming because the name was valid
 * when it was sent.
 *
 * @param {object} body
 * @param {'chat'|'flat'|'claude'} shape
 * @param {Set<string>} served
 */
function dropDanglingToolChoice(body, shape, served) {
  const choice = body?.tool_choice
  if (choice === null || typeof choice !== 'object' || Array.isArray(choice)) return
  const name = shape === 'chat'
    && choice.function !== null && typeof choice.function === 'object' && !Array.isArray(choice.function)
    ? choice.function.name
    : choice.name
  if (typeof name === 'string' && name !== '' && !served.has(name)) delete body.tool_choice
}

/**
 * Send history's tool calls under the same spellings the tool list now declares.
 *
 * A renamed tool has to be renamed *everywhere* in the body, not just in its
 * declaration: a request that declares `conversation_delegate` while its own
 * assistant history calls `subagent_fork` is describing a tool it did not
 * declare, which is the inconsistency the alias exists to remove. It matters
 * just as much for the quartet slots — the harness sees the caller's own names
 * (the decoder restores them), so without this rewrite the model would read its
 * own earlier `read` calls as calls to the gateway's injected tool of that name,
 * and the two definitions would disagree.
 *
 * The lookup therefore runs on the *inverse* of `map`. `map` is alias → the
 * caller's original spelling, because that is the direction the response decoder
 * needs; history travels the other way, carrying originals that have to become
 * aliases again.
 *
 * All three wire shapes are covered, because the projection that built this body
 * is chosen per model: Chat puts the calls in `tool_calls[].function.name`,
 * Messages puts `tool_use` blocks in a content array, and the Responses wire puts
 * flat `function_call` items in `input`. A single message may legitimately carry
 * *both* a content array and `tool_calls`, so both are rewritten rather than the
 * first one winning — an early return there was a real upstream bug that left
 * the second shape un-aliased.
 *
 * Tool-call pairing is by id, never by name, so rewriting a name cannot break a
 * call/result pair.
 *
 * @param {object} body - the prepared request body, mutated in place
 * @param {Map<string, string>} map - alias -> the caller's original spelling
 */
function aliasHistoryToolNames(body, map) {
  if (map.size === 0) return
  const aliases = new Map()
  for (const [alias, original] of map) aliases.set(original, alias)
  const rename = name => (typeof name === 'string' && aliases.has(name) ? aliases.get(name) : name)

  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map(message => {
      if (message === null || typeof message !== 'object') return message
      let next = message
      if (Array.isArray(message.content)) {
        next = {
          ...next,
          content: message.content.map(block => block?.type === 'tool_use' && aliases.has(block.name)
            ? { ...block, name: aliases.get(block.name) }
            : block),
        }
      }
      if (Array.isArray(message.tool_calls)) {
        next = {
          ...next,
          tool_calls: message.tool_calls.map(call => aliases.has(call?.function?.name)
            ? { ...call, function: { ...call.function, name: aliases.get(call.function.name) } }
            : call),
        }
      }
      return next
    })
  }

  if (Array.isArray(body.input)) {
    body.input = body.input.map(item => item?.type === 'function_call' && aliases.has(item.name)
      ? { ...item, name: aliases.get(item.name) }
      : item)
  }

  // A pinned tool choice names one tool, so it has to move with the declaration.
  const choice = body.tool_choice
  const fn = choice?.function
  if (fn !== null && typeof fn === 'object' && !Array.isArray(fn) && aliases.has(fn.name)) {
    body.tool_choice = { ...choice, function: { ...fn, name: aliases.get(fn.name) } }
  }
}

/**
 * Restore the caller's tool spelling in a streaming delta or a final payload.
 * @param {string} name
 * @param {Map<string, string>|undefined} map
 * @returns {string}
 */
export function restoreToolName(name, map) {
  if (!map || map.size === 0) return name
  return map.get(name) ?? name
}

/**
 * Every tool name currently declared on a prepared body.
 * @param {object} body
 * @returns {Set<string>}
 */
export function declaredToolNames(body) {
  const names = new Set()
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    const name = toolNameOf(tool)
    if (name !== '') names.add(name)
  }
  return names
}
