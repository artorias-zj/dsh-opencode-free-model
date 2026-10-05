/**
 * Availability probing.
 *
 * The gateway does not disclose which models this egress may use: the model
 * listing is a flat id list, and exclusion only appears when a request is
 * refused with a `RegionError`. Availability is therefore established by asking,
 * with the smallest request that can produce a verdict.
 *
 * Egress is watched alongside it because the answer is a property of the network
 * path, not of the account: turning a VPN on changes which models exist for the
 * user, and the picker has to follow without a restart. The cheapest reliable
 * signal is the public address the gateway itself sees.
 *
 * @module lib/probe.js
 */

import { applyFingerprint, endpointFor, mintRequestId, resolveWire, sessionForConversation } from './upstream.js'
import { CODE, postStreamed } from './http.js'

/** Public-echo sources, tried in order; any one answering is enough. */
const ECHO_SOURCES = [
  { url: 'https://api.ipify.org?format=json', pick: payload => payload?.ip },
  { url: 'https://ipinfo.io/json', pick: payload => payload?.ip, extra: payload => payload?.country },
  { url: 'https://ipapi.co/json/', pick: payload => payload?.ip, extra: payload => payload?.country_code },
]

/** Verdicts the probe can return, and how each maps to picker membership. */
export const STATE = {
  available: 'available',
  regionBlocked: 'region-blocked',
  unavailable: 'unavailable',
  throttled: 'throttled',
  unknown: 'unknown',
}

/** The prompt a probe sends: the shortest thing that yields a first token. */
export const PING_PROMPT = 'ping'

/** The narrowest body each wire accepts. */
export function buildPing(modelId, wire, overrides) {
  if (wire === 'responses') {
    return {
      model: modelId,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: PING_PROMPT }] }],
      stream: true,
      store: false,
      max_output_tokens: 16,
    }
  }
  if (wire === 'messages') {
    return { model: modelId, messages: [{ role: 'user', content: PING_PROMPT }], stream: true, max_tokens: 16 }
  }
  void overrides
  return { model: modelId, messages: [{ role: 'user', content: PING_PROMPT }], stream: true, max_tokens: 16 }
}

/** The `applyFingerprint` style flag for one wire. */
export function fingerprintStyle(wire) {
  if (wire === 'responses') return true
  if (wire === 'messages') return 'claude'
  return false
}

/**
 * Ask the gateway for one model, once.
 *
 * @param {object} model - catalog entry
 * @param {object} [options]
 * @param {string} [options.attributionUserAgent]
 * @param {string} [options.baseUrl]
 * @param {Record<string,string>} [options.wireOverrides]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{state: string, detail?: string, latencyMs: number, ttftMs?: number}>}
 */
export async function probeModel(model, {
  attributionUserAgent, baseUrl, wireOverrides, signal, timeoutMs = 45_000,
} = {}) {
  const started = Date.now()
  const wire = resolveWire(model.id, wireOverrides)
  const body = buildPing(model.id, wire, wireOverrides)
  // The Messages wire wants its own tool shape. Fingerprinting it with the Chat
  // shape would make the gateway reject the probe with a 400 over the tool
  // schema, and a 400 is indistinguishable from "this model is not routed" —
  // which would take a working model out of the picker for good.
  applyFingerprint(body, fingerprintStyle(wire))

  let firstDelta
  let streamError
  try {
    await postStreamed({
      path: endpointFor(model.id, wireOverrides),
      body,
      session: sessionForConversation('probe:opencode-free-model'),
      requestId: mintRequestId(),
      attributionUserAgent,
      baseUrl,
      signal,
      timeoutMs,
      onData: payload => {
        // The lane answers some refusals inside a 200 stream — a `{"type":
        // "error"}` frame arrives where the deltas were expected. Reading only
        // "did a delta look like a delta" called such a stream available, and a
        // model that fails every honest turn sat in the picker with a green
        // badge.
        if (streamError === undefined && /"(?:type"\s*:\s*"error"|"error"\s*:)/.test(payload)) {
          try {
            const parsed = JSON.parse(payload)
            const failure = parsed?.error ?? (parsed?.type === 'error' ? parsed : undefined)
            if (failure !== undefined && failure !== null) {
              streamError = typeof failure.message === 'string' ? failure.message : 'upstream error'
              return
            }
          } catch { /* not JSON the lane emits; the delta test below still runs */ }
        }
        if (firstDelta !== undefined) return
        if (/"(delta|content|text|output_item)"|response\.(output_item|output_text|function_call)/.test(payload)) {
          firstDelta = Date.now()
        }
      },
    })
    if (streamError !== undefined) {
      return { state: STATE.unknown, detail: streamError.slice(0, 200), latencyMs: Date.now() - started }
    }
    return {
      state: STATE.available,
      latencyMs: Date.now() - started,
      ttftMs: firstDelta === undefined ? undefined : firstDelta - started,
    }
  } catch (error) {
    return {
      state: stateOf(error),
      detail: typeof error?.message === 'string' ? error.message.slice(0, 200) : String(error),
      latencyMs: Date.now() - started,
    }
  }
}

/**
 * Statuses whose whole meaning is the model identifier in the body we sent:
 * 400 for a model the gateway rejects, 404 for one it no longer has, 422 for a
 * route that refuses the pair.
 */
const ROUTING_REFUSAL_STATUS = new Set([400, 404, 422])

/**
 * Map one probe failure onto a verdict.
 *
 * The line that matters is whether the gateway *named this model as something it
 * will not route*. Everything else says nothing about the model and must not
 * move it:
 *
 * - 5xx, including 503, is the gateway's own trouble — the single most common
 *   thing an overloaded pooled account says, and this lane's history has it
 *   returning 5xx for reasons that had nothing to do with the model. Its *words*
 *   must not be read as a verdict either: a reverse proxy answers a 503 with the
 *   reason phrase "Service Unavailable", and matching that text took a working
 *   model out of the picker.
 * - 401/403/407 is the pooled credential, and 408/425/429 is capacity or
 *   transport — the next window can answer.
 * - no status at all (transport, abort, timeout, a stream that died before any
 *   header) means no answer was received.
 *
 * The asymmetry is deliberate: a stale entry costs the user one failed turn they
 * can retry, while a model that vanished on a hiccup costs an invisible
 * reprobe-and-wait cycle.
 *
 * @param {unknown} error
 * @returns {string} a {@link STATE} value
 */
export function stateOf(error) {
  if (error?.code === CODE.region) return STATE.regionBlocked
  if (error?.code === CODE.quota) return STATE.throttled
  const message = String(error?.message ?? '')
  const gatewayTrouble = Number.isInteger(error?.status) && error.status >= 500
  const named = error?.unavailable === true
    || (!gatewayTrouble && /unavailable|not supported|no such model|unknown model|invalid model/i.test(message))
  if (named) return STATE.unavailable
  if (Number.isInteger(error?.status) && ROUTING_REFUSAL_STATUS.has(error.status)) return STATE.unavailable
  return STATE.unknown
}

/**
 * Resolve the public address the gateway will see, plus its country when an echo
 * discloses one. Fail-open: an absent answer simply means "no egress signal".
 *
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ip: string, country?: string}|undefined>}
 */
export async function detectEgress({ signal, timeoutMs = 8000, fetchImpl = fetch } = {}) {
  for (const source of ECHO_SOURCES) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetchImpl(source.url, {
        signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' },
      })
      if (!response.ok) continue
      const payload = await response.json()
      const ip = source.pick(payload)
      if (typeof ip !== 'string' || ip === '') continue
      const country = source.extra?.(payload)
      return { ip, ...(country === undefined ? {} : { country: String(country) }) }
    } catch {
      // try the next echo
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
  }
  return undefined
}

/**
 * Probe a whole catalog with a bounded fan-out.
 *
 * Concurrency stays low on purpose: this lane accounts quota per session and
 * answers 429 with a growing `retry-after`, so a wide burst would throttle the
 * very user whose availability we are establishing. A round probes every model —
 * partial rounds leave verdicts stale and the picker half-explained — and the
 * periodic loop holds *whole rounds* off while a quota-backoff window is open
 * instead of truncating one.
 *
 * @param {Array<object>} models
 * @param {object} [options] - forwarded to {@link probeModel}
 * @param {(id: string, result: object) => void} [onResult]
 * @param {number} [concurrency]
 * @returns {Promise<Record<string, object>>}
 */
export async function probeCatalog(models, options = {}, onResult = () => {}, concurrency = 2) {
  const results = {}
  let cursor = 0
  const width = Math.max(1, Math.min(concurrency, Math.max(1, models.length)))
  const workers = Array.from({ length: width }, async () => {
    while (cursor < models.length) {
      const model = models[cursor++]
      const result = await probeModel(model, options)
      results[model.id] = result
      onResult(model.id, result)
    }
  })
  await Promise.all(workers)
  return results
}
