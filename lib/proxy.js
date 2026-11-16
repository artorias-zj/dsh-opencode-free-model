/**
 * The free lane's egress: one address to dial, one tunnel through it, exactly
 * one request on top.
 *
 * The free tier's ceiling is counted per egress IP rather than per credential —
 * the same turn sent from a second address is answered as if it had never been
 * sent (upstream issue #708). That makes the exit the one lever that actually
 * moves the counter, so the lane accepts two ways to name it: the explicit
 * `freeLane.proxyUrl` from settings, and, only when the operator opts in, the
 * `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` trio the environment already carries.
 * Nothing here rotates, scores or switches exits. An address is configured,
 * validated once, and used for every request that follows; a tunnel that starts
 * failing is a turn failure the adapter classifies like any other, not a prompt
 * to try a different exit behind the user's back.
 *
 * Deliberately not the upstream product:
 *
 *   - no relay server, no mihomo child process, no subscription parsing. A
 *     vless-REALITY URI cannot be spoken in-process, and a half-parseable
 *     "subscription" field is how a proxy setting turns into a second network
 *     stack that the plugin has to keep alive.
 *   - no Bun transport. The plugin runs on Node, and Node's own `fetch` has no
 *     per-request proxy, which is precisely why the socket is dialled here and
 *     handed to `node:http` instead of wrapped around `fetch`.
 *   - no process-wide proxy. `laneFetch` is called per request with the address
 *     that request should use, so the plugin's own echo probe and catalog
 *     fetches keep whatever routing they already had.
 *
 * Socket ownership is the whole risk in a module like this, so it is stated
 * once: `openTunnel` returns one connected socket — TLS-wrapped already when the
 * target is `https:` — and that socket is handed to a one-shot `http.Agent`, so
 * exactly one request ever frames bytes onto it. From that moment this file owns
 * it: an abort destroys it, the response's `close` destroys it, and a failed
 * dial destroys whatever it had opened so far. No path may leave a tunnel
 * half-open; a leaked socket keeps a dead turn's connection alive and the user
 * sees a request that never finishes.
 *
 * @module lib/proxy.js
 */

import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import { Readable, pipeline } from 'node:stream'
import { lookup } from 'node:dns/promises'

/**
 * The schemes an operator may name for this lane.
 *
 * `socks5h` is listed beside `socks5` because the difference is observable at
 * the exit, not cosmetic: the h variant sends the hostname and lets the proxy
 * resolve it. An exit chosen for its country must see the name — a local DNS
 * answer can point it at the wrong edge of the same CDN.
 */
export const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:'])

/**
 * One dial — TCP connect, proxy TLS, the CONNECT read, the whole SOCKS5
 * handshake, target TLS — gets this long before the socket is torn down.
 *
 * 10 s is the budget the upstream implementation settled on against real
 * proxies: long enough for a slow SOCKS handshake over a distant exit, short
 * enough that a black-holed proxy fails the turn instead of hanging the picker.
 */
export const DIAL_TIMEOUT_MS = 10_000

/**
 * Response headers never carried across the tunnel boundary.
 *
 * `transfer-encoding` is the one that matters: Node re-derives framing from the
 * stream it is handed, so forwarding the proxy's or origin's `chunked` marker
 * would double-frame the body. The rest describe the hop that no longer exists
 * once the bytes are a `Response`.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
])

/** Port assumed when an address omits it, per scheme. */
function defaultPort(protocol) {
  if (protocol === 'https:') return 443
  if (protocol === 'socks5:' || protocol === 'socks5h:') return 1080
  return 80
}

/**
 * Parse one proxy address, or `null` for "direct".
 *
 * Blank is a value, not an error: the settings field ships empty and "empty"
 * means the lane goes out direct, so an unconfigured lane must not throw on
 * every turn. Everything else is validated here, at the moment the operator
 * saves it — a typo'd address must fail at configuration time, in front of the
 * person who typed it, because the alternative is a failing turn an hour later
 * whose only evidence is "fetch failed".
 *
 * @param {unknown} text - the address; blank, `null` or `undefined` means direct
 * @returns {URL|null}
 * @throws {Error} when the text is not a URL, or its scheme is not supported
 */
export function parseProxyUrl(text) {
  if (text === null || text === undefined) return null
  const trimmed = String(text).trim()
  if (trimmed === '') return null
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch (error) {
    throw new Error(`the proxy address "${trimmed}" is not a URL: ${error?.message ?? error}`)
  }
  if (!PROXY_SCHEMES.has(parsed.protocol)) {
    throw new Error(`unsupported proxy scheme "${parsed.protocol}" — use http, https, socks5 or socks5h`)
  }
  return parsed
}

/**
 * The proxy this lane should use for `hostname`, or `null` for direct.
 *
 * Precedence is deliberate and narrow. An explicit address wins outright: it is
 * the operator's own choice and the only one they can see in the settings UI.
 * The environment is consulted only when `fromEnvironment` is `true`, because
 * the process's `HTTPS_PROXY` was configured for the whole machine — a shell
 * that exports one for corporate traffic must not silently reroute a lane whose
 * quota is counted per IP. Only when neither applies does the lane go direct.
 *
 * Nothing here reads or rotates a pool of addresses. The one lever upstream
 * measured is the exit address itself, and this function resolves it from
 * configuration; the plugin never changes it on its own.
 *
 * @param {string} hostname - the lane host, for the `NO_PROXY` match
 * @param {{freeLane?: {proxyUrl?: unknown, fromEnvironment?: unknown}}} [settings]
 * @returns {URL|null}
 * @throws {Error} when `settings.freeLane.proxyUrl` is set but invalid
 */
export function resolveLaneProxy(hostname, settings) {
  const lane = settings?.freeLane ?? {}
  const explicit = parseProxyUrl(lane.proxyUrl)
  if (explicit !== null) return explicit
  if (lane.fromEnvironment !== true) return null
  return environmentProxy(hostname)
}

/**
 * The address the environment names for this lane, minus `NO_PROXY`, or `null`.
 *
 * `HTTPS_PROXY` first because this lane's targets are https, then `HTTP_PROXY`;
 * both spellings (`SCREAMING` and lowercase) plus the no-underscore variant are
 * read, because that is what real shells and container images export. `NO_PROXY`
 * is a comma list matched case-insensitively, `*` excludes everything, and a
 * leading dot means "this domain and everything under it" — the entry is
 * normalised, so `.example.com` and `example.com` behave the same, which is what
 * operators expect from curl's rule.
 *
 * @param {string} hostname
 * @returns {URL|null}
 */
function environmentProxy(hostname) {
  const noProxy = String(process.env.NO_PROXY ?? process.env.no_proxy ?? '')
  if (noProxy.trim() === '*') return null
  const host = String(hostname ?? '').toLowerCase()
  for (const raw of noProxy.split(',')) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    const bare = entry.replace(/^\./, '')
    if (host === bare || host.endsWith(`.${bare}`)) return null
  }
  const candidates = [
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.httpsproxy,
    process.env.HTTP_PROXY ?? process.env.http_proxy ?? process.env.httpproxy,
  ]
  for (const value of candidates) {
    if (value === undefined || String(value).trim() === '') continue
    // Validated, not guessed: an exported `HTTPS_PROXY` with a typo is the same
    // configuration mistake as the settings field, and it fails the same way.
    return parseProxyUrl(value)
  }
  return null
}

/**
 * How this proxy is named to a user, without its credentials.
 *
 * The caller puts this in failure messages, and a proxy URL is a bearer
 * credential — `http://user:pass@host` is common enough that a message
 * containing it would leak the credential into logs, screenshots and issue
 * reports. So only the host and port survive, and `null` reads `direct` so a
 * message can be written without a conditional.
 *
 * @param {URL|null|undefined} proxyUrl
 * @returns {string} `'direct'` or `'proxy <hostname>:<port>'`
 */
export function proxyLabel(proxyUrl) {
  if (proxyUrl === null || proxyUrl === undefined) return 'direct'
  const port = Number(proxyUrl.port) || defaultPort(proxyUrl.protocol)
  return `proxy ${proxyUrl.hostname}:${port}`
}

/**
 * Perform one request, through `proxyUrl` when one is given.
 *
 * With no proxy this is literally `fetch(url, init)` — same globals, same
 * redirect and signal semantics, same error shapes — because the direct path is
 * the one every existing turn already takes and it must not change by a byte.
 * With a proxy, Node's `fetch` cannot help: it has no per-request proxy, so the
 * tunnel is dialled here, `node:http` frames the request onto it, and the
 * response is handed back as an ordinary web `Response`. From the caller's point
 * of view the two paths differ in exactly one thing: which socket leaves this
 * machine.
 *
 * `init.signal` is honoured on both sides of the boundary. A cancelled turn
 * must reject with a `DOMException` named `AbortError`, because the caller
 * classifies that as a cancelled turn; anything else it throws is reported as a
 * retryable transport error, and the harness would retry a turn the user had
 * already abandoned.
 *
 * @param {string|URL|Request} url
 * @param {RequestInit} [init]
 * @param {URL|null|undefined} proxyUrl - from {@link resolveLaneProxy}
 * @returns {Promise<Response>}
 */
export async function laneFetch(url, init, proxyUrl) {
  if (proxyUrl === null || proxyUrl === undefined) return fetch(url, init)
  const request = url instanceof Request ? url : null
  const target = new URL(request === null ? String(url) : request.url)
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new TypeError(`opencode-free-model: the lane proxy only carries http(s) targets, got "${target.protocol}"`)
  }
  const signal = init?.signal ?? request?.signal ?? undefined
  const abortError = () => new DOMException('The operation was aborted.', 'AbortError')
  // Checked before the first byte leaves: a turn cancelled while the previous
  // one was still settling must not open a connection nobody will read.
  if (signal?.aborted === true) throw abortError()

  // The tunnel socket and the request riding it. Both are owned here from the
  // moment they exist; `tear` is the single teardown every failure path uses, so
  // there is one place that can be wrong instead of four.
  let socket = null
  let outgoing = null
  // Set once the response has left this function: the tunnel's lifetime is then
  // the response's, so the abort listener must outlive the call.
  let handedOff = false
  const tear = () => {
    outgoing?.destroy()
    socket?.destroy()
  }
  const onAbort = () => tear()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    // `onSocket` hands every socket the dialer opens — the raw one, the proxy's
    // TLS wrap, the target's TLS wrap — to `tear`, so an abort during the
    // handshake closes the socket that actually exists at that instant rather
    // than waiting out the dial budget.
    socket = await raceAbort(
      openTunnel(target, proxyUrl, opened => { socket = opened }),
      signal,
      abortError,
    )

    // One-shot agent: `createConnection` is the only way to put this socket
    // under `http.request`, and an agent that pooled it would hand the same
    // tunnel to the next request. The agent never opens a connection itself.
    const agent = new http.Agent({ keepAlive: false })
    agent.createConnection = () => socket

    const headers = new Headers(request?.headers ?? init?.headers ?? {})
    headers.set('host', target.host)
    // Dropped so Node derives framing from what it is actually given; a foreign
    // `chunked` marker would double-frame the body.
    headers.delete('transfer-encoding')
    const body = request?.body ?? init?.body ?? null
    const buffered = typeof body === 'string' || body instanceof Uint8Array ? body : null
    if (buffered !== null && !headers.has('content-length')) {
      // A buffered body goes out with the same framing `fetch` would have used,
      // so the gateway sees an identical request on the proxied and direct
      // paths. A stream body is the caller's business and stays chunked.
      headers.set('content-length', String(Buffer.byteLength(buffered)))
    }
    const headerObject = {}
    for (const [name, value] of headers.entries()) headerObject[name] = value

    outgoing = http.request({
      method: request?.method ?? init?.method ?? 'GET',
      path: `${target.pathname}${target.search}`,
      headers: headerObject,
      agent,
    })

    const upstream = await new Promise((resolve, reject) => {
      outgoing.on('response', resolve)
      outgoing.on('error', reject)
      if (body === null || body === undefined) {
        outgoing.end()
        return
      }
      if (buffered !== null) {
        outgoing.end(buffered)
        return
      }
      // A streamed body flows through the same tunnel; backpressure belongs to
      // the two pipes. A body-stream failure destroys the request (which the
      // pending promise rejects on) and the tunnel with it.
      pipeline(body, outgoing, error => {
        if (error) {
          outgoing.destroy(error)
          socket.destroy()
        }
      })
    })

    const responseHeaders = new Headers()
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (HOP_BY_HOP.has(name) || value === undefined) continue
      for (const entry of Array.isArray(value) ? value : [value]) responseHeaders.append(name, String(entry))
    }
    const status = upstream.statusCode ?? 502
    const statusText = upstream.statusMessage
    // From here the tunnel outlives this function: the response is handed out
    // and drained by the caller. Ownership moves to the response's own lifetime,
    // so the abort listener is released when that lifetime ends — a cancelled
    // turn mid-body must still destroy the socket, which is why the listener is
    // not removed on return the way the dial stage's is.
    handedOff = true
    upstream.on('close', () => {
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
    })
    // 204/205/304 carry no body, and `Response` refuses to be constructed with
    // one — a streamed body here would throw instead of answering the turn.
    if (status === 204 || status === 205 || status === 304) {
      upstream.destroy()
      socket.destroy()
      signal?.removeEventListener('abort', onAbort)
      return new Response(null, { status, statusText, headers: responseHeaders })
    }
    const webBody = Readable.toWeb(upstream, { strategy: { highWaterMark: 64 * 1024 } })
    return new Response(webBody, { status, statusText, headers: responseHeaders })
  } catch (error) {
    tear()
    if (signal?.aborted === true || error?.name === 'AbortError') throw abortError()
    throw error
  } finally {
    if (!handedOff) signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Connect to the target through the proxy and return a socket ready for plain
 * http framing — already TLS-wrapped when the target is https.
 *
 * The caller owns the returned socket; this function owns every socket it
 * creates before returning, and destroys whatever it opened if any stage fails.
 *
 * @param {URL} target
 * @param {URL} proxy
 * @param {(socket: import('node:net').Socket) => void} [onSocket] - sees each
 *   intermediate socket, so an abort can close the one that exists
 * @returns {Promise<import('node:net').Socket>}
 */
async function openTunnel(target, proxy, onSocket) {
  const host = target.hostname
  const tlsTarget = target.protocol === 'https:'
  const port = Number(target.port) || (tlsTarget ? 443 : 80)
  let socket
  if (proxy.protocol === 'http:' || proxy.protocol === 'https:') {
    socket = await httpConnect(proxy, host, port, onSocket)
  } else if (proxy.protocol === 'socks5:' || proxy.protocol === 'socks5h:') {
    socket = await socks5Connect(proxy, host, port, proxy.protocol === 'socks5h:', onSocket)
  } else {
    throw new Error(`unsupported proxy scheme "${proxy.protocol}" — use http, https, socks5 or socks5h`)
  }
  if (!tlsTarget) return socket
  return await withTimeout(new Promise((resolve, reject) => {
    const secured = tls.connect({
      socket,
      // An IP literal has no name to assert. SNI on an address is invalid, and
      // some exits answer it with a handshake alert rather than a certificate.
      servername: net.isIP(host) === 0 ? host : undefined,
      ALPNProtocols: ['http/1.1'],
    })
    secured.once('secureConnect', () => resolve(secured))
    secured.once('error', error => {
      secured.destroy()
      reject(error)
    })
    onSocket?.(secured)
  }), DIAL_TIMEOUT_MS, 'target TLS handshake', socket)
}

/** Plain TCP with the dial budget applied. */
function netConnect(host, port, onSocket) {
  const socket = net.connect({ host, port })
  return withTimeout(new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
    onSocket?.(socket)
  }), DIAL_TIMEOUT_MS, 'tcp connect', socket)
}

/**
 * HTTP CONNECT through an http(s) proxy.
 *
 * The proxy answers `CONNECT host:port` with its own status line; anything
 * outside 2xx means the proxy refused the target, and the proxy's line is the
 * only evidence of *why* (bad credentials, blocked host, unreachable target), so
 * it is quoted in the error instead of being flattened to a generic failure.
 * `Proxy-Authorization: Basic` goes out when the address carries credentials,
 * percent-decoded first, since a password with `@` or `:` arrives escaped.
 *
 * Bytes past the header terminator are pushed back into the socket: a proxy is
 * free to send the first bytes of the tunnel in the same packet as its 200, and
 * dropping them would truncate a response that starts immediately.
 *
 * @param {URL} proxy
 * @param {string} targetHost
 * @param {number} targetPort
 * @param {(socket: import('node:net').Socket) => void} [onSocket]
 * @returns {Promise<import('node:net').Socket>}
 */
async function httpConnect(proxy, targetHost, targetPort, onSocket) {
  const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80)
  let socket = await netConnect(proxy.hostname, proxyPort, onSocket)
  try {
    if (proxy.protocol === 'https:') {
      socket = await withTimeout(new Promise((resolve, reject) => {
        const secured = tls.connect({
          socket,
          servername: net.isIP(proxy.hostname) === 0 ? proxy.hostname : undefined,
        })
        secured.once('secureConnect', () => resolve(secured))
        secured.once('error', error => {
          secured.destroy()
          reject(error)
        })
        onSocket?.(secured)
      }), DIAL_TIMEOUT_MS, 'proxy TLS handshake', socket)
    }
    const credentials = proxy.username === ''
      ? ''
      : `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n`
    socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${credentials}\r\n`)
    const { rest } = await readUntil(socket, DIAL_TIMEOUT_MS, 'CONNECT response', buffer => {
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return null
      const head = buffer.subarray(0, end).toString('latin1')
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(head)
      if (match === null) throw new Error(`the proxy answered "${head.split('\r\n')[0] ?? ''}" to CONNECT`)
      const status = Number(match[1])
      if (status < 200 || status >= 300) throw new Error(`the proxy refused CONNECT with ${match[1]}`)
      return end + 4
    })
    if (rest.length > 0) socket.unshift(rest)
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

/**
 * SOCKS5 CONNECT (RFC 1928), with optional RFC 1929 credentials.
 *
 * `socks5h` sends the hostname and lets the proxy resolve it — an exit chosen
 * for its country has to see the name, or it resolves to whatever this machine's
 * DNS decided. Plain `socks5` resolves here first and sends the address, which
 * is the scheme's definition and what a proxy listening on loopback expects.
 *
 * Every stage consumes exactly its own message and pushes the surplus back: TCP
 * coalesces, and a read that swallows the next stage's bytes leaves the
 * handshake waiting for data that already arrived.
 *
 * @param {URL} proxy
 * @param {string} targetHost
 * @param {number} targetPort
 * @param {boolean} resolveAtProxy - true for `socks5h`
 * @param {(socket: import('node:net').Socket) => void} [onSocket]
 * @returns {Promise<import('node:net').Socket>}
 */
async function socks5Connect(proxy, targetHost, targetPort, resolveAtProxy, onSocket) {
  const socket = await netConnect(proxy.hostname, Number(proxy.port) || 1080, onSocket)
  try {
    const withAuth = proxy.username !== ''
    socket.write(Buffer.from(withAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]))
    const greeting = await readUntil(socket, DIAL_TIMEOUT_MS, 'socks5 greeting', buffer => (buffer.length < 2 ? null : 2 + buffer[1]))
    if (greeting.rest.length > 0) socket.unshift(greeting.rest)
    if (greeting.head[0] !== 0x05) throw new Error(`the socks5 proxy answered version ${greeting.head[0] ?? 'nothing'}`)
    const selected = greeting.head[1]
    if (selected === 0x02) {
      if (!withAuth) throw new Error('the socks5 proxy demands credentials this outlet does not have')
      const user = Buffer.from(decodeURIComponent(proxy.username), 'utf8')
      const pass = Buffer.from(decodeURIComponent(proxy.password), 'utf8')
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
      const auth = await readUntil(socket, DIAL_TIMEOUT_MS, 'socks5 auth', buffer => (buffer.length >= 2 ? 2 : null))
      if (auth.rest.length > 0) socket.unshift(auth.rest)
      if (auth.head[0] !== 0x01 || auth.head[1] !== 0x00) throw new Error('the socks5 proxy rejected the credentials')
    } else if (selected !== 0x00) {
      throw new Error(`the socks5 proxy selected method ${selected}, expected 0 (none) or 2 (user/pass)`)
    }
    let address
    if (resolveAtProxy) {
      // RFC 1928: atyp 3 is [1-byte length][domain], unlike the raw IP forms.
      address = { type: 0x03, bytes: Buffer.concat([Buffer.from([Buffer.byteLength(targetHost)]), Buffer.from(targetHost, 'utf8')]) }
    } else {
      address = encodeAddress(await lookup(targetHost))
    }
    socket.write(Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, address.type]),
      address.bytes,
      Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
    ]))
    const reply = await readUntil(socket, DIAL_TIMEOUT_MS, 'socks5 connect reply', buffer => {
      if (buffer.length < 4) return null
      if (buffer[0] !== 0x05) throw new Error(`the socks5 reply started with ${buffer[0]}`)
      if (buffer[1] !== 0x00) throw new Error(`the socks5 proxy refused the connection (code ${buffer[1]})`)
      const atyp = buffer[3]
      if (atyp === 0x01) return buffer.length >= 10 ? 10 : null
      if (atyp === 0x04) return buffer.length >= 22 ? 22 : null
      if (atyp === 0x03) {
        if (buffer.length < 5) return null
        const full = 4 + 1 + buffer[4] + 2
        return buffer.length >= full ? full : null
      }
      throw new Error(`the socks5 reply used unknown address type ${atyp}`)
    })
    if (reply.rest.length > 0) socket.unshift(reply.rest)
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

/** DNS answer → SOCKS5 address block (type byte + encoded bytes). */
function encodeAddress(resolved) {
  if (resolved.family !== 6) {
    return { type: 0x01, bytes: Buffer.from(resolved.address.split('.').map(part => Number(part) & 0xff)) }
  }
  // Expand the `::` run before splitting: a compressed literal has empty groups
  // in the middle that must be counted, not parsed.
  const [head, tail, ...extra] = resolved.address.split('::')
  if (extra.length > 0) throw new Error(`unexpected IPv6 literal "${resolved.address}"`)
  const headGroups = head === '' ? [] : head.split(':')
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':')
  const groups = tail === undefined
    ? headGroups
    : [...headGroups, ...Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0'), ...tailGroups]
  const bytes = Buffer.alloc(16)
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16)
    bytes[index * 2] = (value >> 8) & 0xff
    bytes[index * 2 + 1] = value & 0xff
  })
  return { type: 0x04, bytes }
}

/**
 * Accumulate socket bytes until `matcher` is happy; resolve with the bytes past
 * the mark so the caller can push them back with `unshift`.
 *
 * The 16KB ceiling is the guard against a bogus peer: no CONNECT reply or SOCKS5
 * message is that large, so exceeding it means this is not the protocol the
 * address promised, and reading forever would be the wrong answer.
 *
 * @param {import('node:net').Socket} socket
 * @param {number} timeoutMs
 * @param {string} what - named in the failure, so the operator knows which stage
 * @param {(buffer: Buffer) => number|null} matcher - bytes consumed, or `null`
 * @returns {Promise<{head: Buffer, rest: Buffer}>}
 */
function readUntil(socket, timeoutMs, what, matcher) {
  if (socket.destroyed) return Promise.reject(new Error(`the proxy closed during the ${what}`))
  return withTimeout(new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const onData = chunk => {
      chunks.push(chunk)
      size += chunk.length
      const buffer = Buffer.concat(chunks, size)
      let mark
      try {
        mark = matcher(buffer)
      } catch (error) {
        cleanup()
        reject(error)
        return
      }
      if (mark === null) {
        if (size > 16 * 1024) {
          cleanup()
          reject(new Error(`the proxy sent more than 16KB without finishing the ${what}`))
        }
        return
      }
      cleanup()
      resolve({ head: buffer.subarray(0, mark), rest: buffer.subarray(mark) })
    }
    const onError = error => {
      cleanup()
      reject(error)
    }
    const onClose = () => {
      cleanup()
      reject(new Error(`the proxy closed during the ${what}`))
    }
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    // The socket was paused until now (connect-stage listeners only), so the
    // first byte arrives after this switch and nothing is lost in between.
    socket.resume()
  }), timeoutMs, what, socket)
}

/**
 * Reject after `ms`, tearing the socket down so nothing leaks half-open, and
 * reject early when the peer closes underneath us.
 *
 * The timer is unref'd: a dial in flight must not be the reason a process that
 * is otherwise done fails to exit.
 */
function withTimeout(promise, ms, what, socket) {
  let timer
  let onClose
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      onClose = () => reject(new Error(`the socket closed during the ${what}`))
      if (socket?.destroyed) onClose()
      else socket?.once('close', onClose)
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        socket?.destroy?.()
        reject(new Error(`timed out after ${ms}ms: ${what}`))
      }, ms)
      timer.unref?.()
    }),
  ]).finally(() => {
    clearTimeout(timer)
    socket?.off('close', onClose)
  })
}

/**
 * Settle with `promise`, or reject with the caller's abort error as soon as the
 * signal fires.
 *
 * A dial can take the whole 10 s budget, so waiting for it to notice would make
 * a cancelled turn look like a hung one. The dial's own rejection is still
 * consumed here, so an abort that happens to race a dial failure does not
 * surface as an unhandled rejection.
 */
function raceAbort(promise, signal, abortError) {
  if (signal === undefined || signal === null) return promise
  return new Promise((resolve, reject) => {
    const stop = () => signal.removeEventListener('abort', fail)
    const fail = () => {
      stop()
      reject(abortError())
    }
    if (signal.aborted === true) {
      fail()
      return
    }
    signal.addEventListener('abort', fail, { once: true })
    promise.then(value => {
      stop()
      resolve(value)
    }, error => {
      stop()
      reject(error)
    })
  })
}
