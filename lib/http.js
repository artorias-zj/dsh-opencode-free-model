/**
 * Outbound HTTP for the free lane: request posting, SSE frame extraction, and
 * the classification of gateway failures into the harness's provider-neutral
 * failure codes.
 *
 * The gateway reports a refusal as a JSON error envelope whose `type` is the
 * machine-readable discriminator. Three of them matter operationally and are
 * distinguished here because they need different handling:
 *
 * - `RegionError` — the model exists but this egress country is excluded. Not a
 *   credential or capacity problem, and it clears the moment the egress
 *   changes, so it feeds the availability probe instead of a retry.
 * - `FreeUsageLimitError` / 429 — the per-request budget is spent. Retrying is
 *   why the session id is held stable, and re-sending the same turn three times
 *   just pays for the same wall three times, so `RATE_LIMIT` is deliberately not
 *   in the adapter's retryable set.
 * - `ModelError` / "Model is unavailable" — the pooled account no longer routes
 *   that id at all, which is the probe's business, not the turn's.
 *
 * How a 2xx body is read is decided by the body, not by `Content-Type`: this
 * gateway is observed answering 200 with a JSON content type over an SSE frame
 * stream, and believing the header loses the whole turn. The head is sniffed and
 * then replayed into the stream reader, so no token is buffered.
 *
 * @module lib/http.js
 */

import { CLIENT_UA, UPSTREAM_BASE, gatewayHeaders, truncateSession } from './upstream.js'

/** Provider-neutral failure codes from the harness `llm` vocabulary. */
export const CODE = {
  region: 'REGION_BLOCKED',
  quota: 'RATE_LIMIT',
  credential: 'INVALID_CREDENTIAL',
  transport: 'TRANSPORT',
  timeout: 'TIMEOUT',
  server: 'SERVER',
  empty: 'EMPTY_RESPONSE',
  aborted: 'ABORTED',
}

/** An upstream failure carrying a harness failure code. */
export class UpstreamError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {object} [details] - extra failure fields (`status`, `type`, …)
   */
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    Object.assign(this, details)
  }
}

/**
 * Refusals that name the *model* rather than the caller's standing.
 *
 * Kept tight on purpose: "not supported" on its own is something a credential
 * failure can say too, so only the model-naming phrasings count.
 */
const MODEL_REFUSAL = /model is unavailable|no such model|unknown model|invalid model|model [^.]* is not supported/

/**
 * Turn a gateway JSON error envelope into a classified failure.
 *
 * @param {number|undefined} status
 * @param {unknown} payload
 * @param {number|undefined} [retryAfterMs]
 * @returns {UpstreamError}
 */
export function classifyFailure(status, payload, retryAfterMs) {
  const error = payload?.error ?? payload ?? {}
  const type = typeof error.type === 'string' ? error.type : ''
  const message = typeof error.message === 'string' ? error.message : `upstream HTTP ${status}`
  const flat = message.toLowerCase()
  if (type === 'RegionError' || /not available in your country|region/i.test(flat)) {
    return new UpstreamError(message, CODE.region, { status, type })
  }
  if (status === 429 || type === 'FreeUsageLimitError' || /usage limit|rate limit/i.test(flat)) {
    return new UpstreamError(message, CODE.quota, { status, type, providerRetryAfterMs: retryAfterMs })
  }
  // A refusal that names the model is about the model, even when it arrives
  // carrying a 401 or 403. The pooled credential is shared and demonstrably
  // working for other models in the same breath, so reporting it as
  // INVALID_CREDENTIAL sends the operator to look at a credential that is fine
  // (observed live: `union-alpha` answers 401 "Model union-alpha is not
  // supported" long after the lane stopped routing it). `unavailable` is what
  // the probe routes on to drop the model.
  if (type === 'ModelError' || MODEL_REFUSAL.test(flat)) {
    return new UpstreamError(message, CODE.server, { status, type, unavailable: true })
  }
  if (status === 401 || status === 403) return new UpstreamError(message, CODE.credential, { status, type })
  return new UpstreamError(message, CODE.server, { status, type })
}

/** Parse `Retry-After` into milliseconds, when the header carries a number. */
function retryAfter(header) {
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds * 1000) : undefined
}

/**
 * Resolve the upstream root for one call.
 *
 * A blank or non-string value means "use the built-in default" rather than "use
 * nothing": settings carry an empty string for "not configured", and passing
 * that straight to `fetch` builds a *relative* URL, which fails as an opaque
 * transport error. Every caller goes through here so the rule lives once.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function resolveBaseUrl(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : UPSTREAM_BASE
}

/**
 * How many bytes to look at before deciding what the body is.
 *
 * The gateway is known to answer 200 with a `Content-Type` that is not
 * `text/event-stream` while the body underneath is a perfectly normal SSE
 * stream. Trusting the header threw the whole turn away, so the body's own shape
 * decides — and the bytes spent looking at it are replayed into the reader
 * rather than swallowed by a `response.text()`, which would buffer a live stream
 * to the end before yielding a single token.
 */
export const SNIFF_BYTES = 4096

/**
 * Classify the beginning of a response body by shape.
 *
 * @param {string} text - the decoded head, possibly a partial stream
 * @returns {'sse'|'json'|'empty'|'unknown'}
 */
export function sniffBody(text) {
  const head = String(text ?? '').replace(/^\ufeff/, '').trimStart()
  if (head === '') return 'empty'
  if (head.startsWith(':') || /^(?:data|event|id|retry)[ \t]*:/m.test(head.slice(0, 64))) return 'sse'
  if (head.startsWith('{') || head.startsWith('[')) return 'json'
  return 'unknown'
}

/**
 * Normalize anything a body read can throw into an `UpstreamError`.
 *
 * This matters beyond tidiness: aborting a request rejects the pending
 * `reader.read()` with the signal's own `DOMException`, whose `code` is the
 * numeric legacy `20`. The adapter only carries string codes, so anything
 * unrecognized is reported as `TRANSPORT` — which is retryable, and would have
 * the harness retry a turn the user deliberately cancelled.
 *
 * @param {unknown} error
 * @param {AbortSignal|undefined} signal
 * @returns {UpstreamError}
 */
export function classifyStreamFailure(error, signal) {
  if (error instanceof UpstreamError) return error
  if (signal?.aborted === true || error?.name === 'AbortError') {
    return new UpstreamError('request aborted', CODE.aborted)
  }
  return new UpstreamError(`opencode-free-model: upstream stream read failed: ${error?.message ?? error}`, CODE.transport)
}

/**
 * Compose the request User-Agent.
 *
 * Two independent requirements meet in one header: the harness mandates an
 * attribution User-Agent on every provider request, and the gateway identifies a
 * desktop client by an `opencode/<version>` token. The gateway tests with a
 * substring search rather than an anchored match, so one value satisfies both.
 *
 * @param {string|undefined} attribution
 * @returns {string}
 */
export function userAgentWith(attribution) {
  if (typeof attribution !== 'string' || attribution === '') return CLIENT_UA
  return attribution.includes('opencode/') ? attribution : `${attribution} ${CLIENT_UA}`
}

/**
 * Take the first `limit` bytes of a body without losing the rest of it.
 *
 * Stops as soon as the head has said it is a stream: a short answer whose server
 * keeps the connection open would otherwise sit here until the deadline, and the
 * cancel on the way out discards everything already read — a complete turn,
 * reported as a retryable timeout.
 */
async function readHead(stream, limit, { signal, timeoutMs }) {
  const reader = stream.getReader()
  const chunks = []
  // One decoder for the whole body: flushing here would corrupt a multi-byte
  // character whose tail arrives in the next chunk.
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  let done = false
  try {
    while (size < limit) {
      const row = await headRead(reader, signal, Date.now() + timeoutMs)
      if (row.done) {
        done = true
        break
      }
      if (row.value === undefined) continue
      chunks.push(row.value)
      size += row.value.byteLength ?? 0
      text += decoder.decode(row.value, { stream: true })
      if (sniffBody(text) === 'sse') break
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    try {
      reader.releaseLock?.()
    } catch { /* mid-teardown */ }
    throw classifyStreamFailure(error, signal)
  }
  return { reader, chunks, done, text, decoder }
}

/**
 * One read off the body while deciding what it is, bounded by the same deadline
 * and abort signal `readSse` would have honoured. Without this, a connection
 * that accepts the request and then never sends a byte would hang the turn in
 * the few lines that run before any watchdog exists.
 */
async function headRead(reader, signal, deadline) {
  if (signal?.aborted) throw new UpstreamError('request aborted', CODE.aborted)
  let timer
  let onAbort
  const pending = reader.read()
  const halted = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new UpstreamError('opencode-free-model: upstream sent no bytes before its deadline', CODE.timeout)),
      Math.max(0, deadline - Date.now()),
    )
    timer.unref?.()
    onAbort = () => {
      void reader.cancel().catch(() => {})
      reject(new UpstreamError('request aborted', CODE.aborted))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([pending, halted])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    // The losing read settles once the reader is cancelled or closed; nothing
    // waits on it, so its outcome must not surface as an unhandled rejection.
    pending.catch(() => {})
  }
}

/** Turn a head that was already read, plus the reader that follows it, back into one byte stream. */
function replayStream(head) {
  const stream = (async function* () {
    try {
      for (const chunk of head.chunks) yield chunk
      if (head.done) return
      while (true) {
        const row = await head.reader.read()
        if (row.done) return
        if (row.value !== undefined) yield row.value
      }
    } finally {
      if (!head.done) await head.reader.cancel().catch(() => {})
      head.reader.releaseLock?.()
    }
  })()
  // An async generator's `return()` waits behind an already pending `next()`;
  // expose a direct cancel so `readSse` can close the response immediately.
  stream.cancel = () => (head.done ? undefined : head.reader.cancel())
  return stream
}

/**
 * Read the rest of a body that is not a stream, as text, continuing on the
 * decoder the head used so a character split across the sniff boundary decodes.
 */
async function readRemainder(head, signal) {
  let text = head.text
  try {
    if (!head.done) {
      while (true) {
        const row = await head.reader.read()
        if (row.done) break
        if (row.value !== undefined) text += head.decoder.decode(row.value, { stream: true })
      }
    }
  } catch (error) {
    await head.reader.cancel().catch(() => {})
    throw classifyStreamFailure(error, signal)
  }
  return text + head.decoder.decode()
}

/**
 * POST one request and stream back decoded SSE `data:` payloads.
 *
 * @param {object} options
 * @param {string} options.path - gateway path
 * @param {object} options.body - JSON request body
 * @param {string} options.session - canonical upstream session id
 * @param {string} options.requestId - per-turn request id
 * @param {string} [options.attributionUserAgent] - harness User-Agent, merged in
 * @param {string} [options.baseUrl] - overrides {@link UPSTREAM_BASE}
 * @param {AbortSignal} [options.signal]
 * @param {(payload: string) => void} options.onData - one `data:` payload, in order
 * @param {number} [options.timeoutMs] - deadline for the response headers, and
 *   the idle deadline for every body read after them
 * @returns {Promise<{status:number, headers:Headers}>}
 */
export async function postStreamed({
  path,
  body,
  session,
  requestId,
  attributionUserAgent,
  baseUrl,
  signal,
  onData,
  timeoutMs = 300_000,
}) {
  const root = resolveBaseUrl(baseUrl)
  const headers = gatewayHeaders({ session: truncateSession(session), requestId, stream: true })
  headers['user-agent'] = userAgentWith(attributionUserAgent)
  // The deadline is enforced through its own controller, because `fetch` does not
  // resolve until the response *headers* arrive: a server that accepts the
  // connection and then says nothing would otherwise hang the turn before any
  // body-level watchdog exists. It is cleared as soon as headers land, so the
  // body keeps the caller's own abort semantics.
  const deadline = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    deadline.abort()
  }, Math.max(1, timeoutMs))
  timer.unref?.()
  const onCallerAbort = () => deadline.abort()
  signal?.addEventListener('abort', onCallerAbort, { once: true })
  let response
  try {
    response = await fetch(`${root}${path}`, {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: deadline.signal,
    })
  } catch (error) {
    // The signal's own reason is what fetch rejects with, and Node's is a
    // `TimeoutError`/user Error rather than `AbortError` — testing the name
    // alone reported a cancelled turn as `TRANSPORT`, which is retryable.
    if (signal?.aborted === true) throw new UpstreamError('request aborted', CODE.aborted)
    if (expired) throw new UpstreamError('opencode-free-model: upstream sent no response headers before its deadline', CODE.timeout)
    if (error?.name === 'AbortError') throw new UpstreamError('request aborted', CODE.aborted)
    throw new UpstreamError(`opencode-free-model: upstream request failed: ${error?.message ?? error}`, CODE.transport)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onCallerAbort)
  }

  const setRetry = retryAfter(response.headers.get('retry-after'))
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { error: { message: text.slice(0, 300) || `HTTP ${response.status}` } }
    }
    throw classifyFailure(response.status, payload, setRetry)
  }
  if (response.body === null) throw new UpstreamError('opencode-free-model: upstream returned no body', CODE.empty)

  const head = await readHead(response.body, SNIFF_BYTES, { signal, timeoutMs })
  const shape = sniffBody(head.text)
  if (shape === 'empty') throw new UpstreamError('opencode-free-model: upstream returned no body', CODE.empty)
  if (shape === 'sse') {
    await readSse(replayStream(head), onData, signal, timeoutMs)
    return { status: response.status, headers: response.headers }
  }

  const text = head.done ? head.text : await readRemainder(head, signal)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new UpstreamError(
      `opencode-free-model: unexpected non-SSE response: ${text.slice(0, 200)}`, CODE.server, { status: response.status },
    )
  }
  if (payload.error) throw classifyFailure(response.status, payload, setRetry)
  // A one-shot JSON body is a legitimate (non-streaming) answer; hand it to the
  // same reader so the caller has exactly one code path.
  onData(JSON.stringify(payload))
  return { status: response.status, headers: response.headers }
}

/**
 * Split an SSE byte stream into `data:` payload strings; comment lines ignored.
 *
 * The source is anything that yields byte chunks: a `ReadableStream` (Node's own
 * response body) or an async iterable, which is what lets a head that was
 * already sniffed be replayed in front of the live reader.
 *
 * @param {ReadableStream|AsyncIterable<Uint8Array>} source
 * @param {(payload: string) => void} onData
 * @param {AbortSignal} [signal]
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
export async function readSse(source, onData, signal, timeoutMs = 300_000) {
  // Two source flavours meet here: a web `ReadableStream` (Node's own response
  // body) steps with `reader.read()`, while the replayed head and any async
  // iterable step with `iterator.next()`. Treating a reader as an iterator is a
  // `TypeError` at the first read, so the two are kept apart rather than unified.
  const reader = typeof source?.getReader === 'function' ? source.getReader() : null
  const iterator = reader !== null
    ? null
    : (typeof source?.[Symbol.asyncIterator] === 'function' ? source[Symbol.asyncIterator]() : source)
  const step = () => (reader !== null ? reader.read() : iterator.next())
  const decoder = new TextDecoder()
  let buffer = ''
  let stopped = false
  const hasSignal = signal !== undefined && signal !== null
  const stop = () => {
    if (stopped) return
    stopped = true
    try {
      if (reader !== null) {
        void Promise.resolve(reader.cancel()).catch(() => {})
      } else {
        void Promise.resolve(iterator?.cancel?.()).catch(() => {})
        void Promise.resolve(iterator?.return?.()).catch(() => {})
      }
    } catch { /* already closed */ }
  }
  // Two things can end a wait, and they mean different things. The caller's
  // abort is not a failure at all; a stream that goes quiet past its deadline is
  // a retryable timeout. Both have to be raced against the read itself, because
  // cancelling a reader is best effort — undici can leave an already pending
  // `next()` unresolved until the peer closes, so a held response would
  // otherwise keep the adapter waiting forever.
  const next = async () => {
    if (signal?.aborted) throw new UpstreamError('request aborted', CODE.aborted)
    let onAbort
    let idleTimer
    const halted = new Promise((_, reject) => {
      onAbort = () => {
        stop()
        reject(new UpstreamError('request aborted', CODE.aborted))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    const idle = new Promise((_, reject) => {
      idleTimer = setTimeout(() => {
        stop()
        reject(new UpstreamError('opencode-free-model: upstream stream idle past its deadline', CODE.timeout))
      }, Math.max(1, timeoutMs))
      idleTimer.unref?.()
    })
    const pending = Promise.resolve().then(step)
    try {
      return await Promise.race(hasSignal ? [pending, halted, idle] : [pending, idle])
    } finally {
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(idleTimer)
      pending.catch(() => {})
    }
  }
  try {
    while (true) {
      const { value, done } = await next()
      if (done) break
      if (value !== undefined) buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        emit(buffer.slice(0, newline), onData)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    }
    // Flush the decoder so a multi-byte character split over the last two chunks
    // is not silently dropped from the final payload, and emit whatever is left
    // in a body that ended without a trailing newline.
    buffer += decoder.decode()
    emit(buffer, onData)
  } catch (error) {
    throw classifyStreamFailure(error, signal)
  } finally {
    stop()
    if (reader !== null) {
      try {
        reader.releaseLock?.()
      } catch { /* a pending read is still unwinding */ }
    }
  }
}

function emit(line, onData) {
  const text = line.trim()
  if (text === '' || text.startsWith(':')) return
  if (!text.startsWith('data:')) return
  const payload = text.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return
  onData(payload)
}

/**
 * Fetch a small JSON document from the gateway with the fingerprint headers.
 *
 * @param {string} path
 * @param {object} [options]
 * @param {string} [options.session]
 * @param {string} [options.requestId]
 * @param {string} [options.attributionUserAgent]
 * @param {string} [options.baseUrl] - overrides {@link UPSTREAM_BASE}; blank
 *   means the default
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<unknown>}
 */
export async function getJson(path, {
  session, requestId, attributionUserAgent, baseUrl, signal, timeoutMs = 15_000,
} = {}) {
  const root = resolveBaseUrl(baseUrl)
  const headers = gatewayHeaders({
    session: truncateSession(session ?? ''), requestId: requestId ?? '', stream: false, accept: 'application/json',
  })
  headers['user-agent'] = userAgentWith(attributionUserAgent)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  // Which of the two aborted decides the code: this call's own deadline is a
  // retryable timeout, the caller ending the request is not a failure at all.
  let callerAborted = false
  const onCallerAbort = () => {
    callerAborted = true
    controller.abort()
  }
  signal?.addEventListener('abort', onCallerAbort, { once: true })
  try {
    const response = await fetch(`${root}${path}`, { headers, redirect: 'error', signal: controller.signal })
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { error: { message: text.slice(0, 200) } }
    }
    if (!response.ok) throw classifyFailure(response.status, payload)
    return payload
  } catch (error) {
    if (error instanceof UpstreamError) throw error
    if (callerAborted || signal?.aborted === true) throw new UpstreamError('request aborted', CODE.aborted)
    if (error?.name === 'AbortError') throw new UpstreamError('opencode-free-model: upstream GET timed out', CODE.timeout)
    throw new UpstreamError(`opencode-free-model: upstream GET failed: ${error?.message ?? error}`, CODE.transport)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onCallerAbort)
  }
}
