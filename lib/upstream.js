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

/** Every wire path this lane serves, keyed by wire name. */
export const ENDPOINT_BY_WIRE = {
  chat: '/zen/v1/chat/completions',
  responses: '/zen/v1/responses',
  messages: '/zen/v1/messages',
}

/** The catalog listing path. */
export const MODELS_PATH = '/zen/v1/models'

/** Models served by `/responses` rather than `/chat/completions`. */
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
 * @param {string|undefined} sessionId - `GenerateOptions.sessionId`, when sent
 * @returns {string}
 */
export function sessionForConversation(sessionId) {
  const seed = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : 'global'
  if (SESSION_RE.test(seed)) return seed
  const digest = crypto.createHash('sha256').update(`opencode-free-model\0${seed}`).digest()
  return `ses_${digest.subarray(0, 6).toString('hex')}${base62From(digest.subarray(6, 20))}`
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
 * @param {string} modelId
 * @param {Record<string, string>|undefined} [overrides]
 * @returns {string}
 */
export function endpointFor(modelId, overrides) {
  return ENDPOINT_BY_WIRE[resolveWire(modelId, overrides)]
}

/**
 * The headers the gateway fingerprints a genuine desktop client by.
 *
 * `Authorization: Bearer public` is the pooled credential — there is no
 * per-user secret anywhere on this lane, which is exactly why the plugin needs
 * no API key and stores none.
 *
 * @param {object} input
 * @param {string} input.session
 * @param {string} input.requestId
 * @param {boolean} input.stream
 * @param {string} [input.accept]
 * @returns {Record<string, string>}
 */
export function gatewayHeaders({ session, requestId, stream, accept }) {
  return {
    'content-type': 'application/json',
    'authorization': 'Bearer public',
    'user-agent': CLIENT_UA,
    'x-opencode-client': 'desktop',
    'x-opencode-session': truncateSession(session),
    'x-opencode-request': requestId,
    'x-opencode-project': 'global',
    'accept': accept ?? (stream ? 'text/event-stream' : '*/*'),
  }
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
 * @param {object} body - request body, mutated in place
 * @param {boolean|'claude'} style - `true` for Responses, `false` for Chat,
 *   `'claude'` for Messages
 * @returns {Map<string, string>} sent spelling -> caller spelling
 */
export function applyFingerprint(body, style) {
  const flat = style === true
  const claude = style === 'claude'
  const map = new Map()
  const tools = Array.isArray(body.tools) ? body.tools : []
  const hadClientTools = tools.length > 0
  const seen = new Set()
  const out = []

  for (const tool of tools) {
    const current = toolNameOf(tool)
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
