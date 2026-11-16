/**
 * dsh-opencode-free-model — plugin entry (Host half).
 *
 * One adapter instance serves two provider routes: what this egress can use
 * right now, and what the gateway refuses here. Behind them sit a live catalog
 * refresh (`GET /zen/v1/models`) and an availability probe that turns "the
 * gateway would not route this id from this network" into picker membership.
 *
 * Wiring, in order:
 *
 * 1. `inject` names `llm` and nothing else — it is the one service the plugin
 *    cannot exist without. Cordis *throws* when a service that was not named in
 *    `inject` is read as a property, and keeps the fiber PENDING forever while a
 *    named one is absent, so anything optional is read per call through
 *    `ctx.get()` instead. A headless composition would rather serve models
 *    without a settings page than serve nothing.
 * 2. `registerAdapter` publishes both routes. They are never withdrawn, not even
 *    when a probe round reports nothing: a route with no models is dropped from
 *    the picker by the client, while an unregistered route strands every session
 *    that already named a model on it with `NO_ADAPTER`.
 * 3. Background work is plain unref'd timers owned by `ctx.effect`, because
 *    `ctx.interval` is a mixin over the `timer` service and reading it from a
 *    fiber that did not name `timer` throws rather than answering `undefined`.
 *
 * @module lib/index.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { OcFreeModelAdapter, ROUTES, ROUTE_MAIN, ROUTE_REGION } from './adapter.js'
import { JsonStore, DATA_DIR_NAME, resolveDshHome } from './store.js'
import { SEED_MODEL_IDS, buildCatalog, computeMembership, materializeCatalog, parseListing } from './catalog.js'
import { STATE, detectEgress, probeCatalog } from './probe.js'
import { ENDPOINT_STYLES, MODELS_PATH, UPSTREAM_BASE, mintRequestId, sessionForConversation } from './upstream.js'
import { CODE, getJson, resolveBaseUrl } from './http.js'
import { resolveLaneProxy } from './proxy.js'
import { resolveAttributionUserAgent } from './kernel.js'

/** The cordis plugin name; must match the package name for the loader row. */
export const name = 'opencode-free-model'

/** The only hard dependency: without `llm` there is nothing to register into. */
export const inject = ['llm']

/**
 * The settings defaults.
 *
 * These are *defaults*, not a persisted document: each mount computes the
 * effective settings as `defaults <- runtime state <- this mount's config`, so a
 * value the bundle patch states applies on every mount and a value it omits
 * falls back to the default rather than sticking from a previous mount. Only
 * runtime bookkeeping (`runtime.json`) is written to disk, because the plugin has
 * no settings surface of its own and an operator-facing switch belongs in the
 * composition file where it can be read.
 */
export const SETTINGS_INITIAL = {
  enabled: true,
  exposeRegionModels: true,
  probeIntervalMinutes: 15,
  defaultMaxTokens: 32768,
  streamRecovery: true,
  /** base id -> `chat` | `responses` | `messages`, to pin a moved model. */
  wireOverrides: {},
  /** Upstream root override; empty means the built-in default. */
  baseUrl: '',
  /**
   * Which path table the inference calls ride: `family`, `flat` or `zen`.
   *
   * `family` — the split the official client uses, one base path per wire — is
   * the default because that is what the lane has been verified against. The
   * other two exist for an operator whose egress reaches a gateway that only
   * publishes one of them; the names come from `upstream.js`, so the picker and
   * the lane cannot disagree about them.
   */
  endpointStyle: 'family',
  /**
   * Whether a real turn's verdict gates the lane.
   *
   * The breaker turns one `FreeUsageLimitError` into "every request is refused
   * locally until the window ends", which is what stops a burned per-IP quota
   * from being respent on every turn. It is a switch rather than always-on
   * because it is a *local* refusal the upstream never asked for: an operator
   * debugging why a model stopped answering needs to be able to turn it off.
   */
  laneBreaker: true,
  /**
   * How the lane reaches the gateway, when it must not go direct.
   *
   * The free lane counts quota per egress IP, so the exit address is the one
   * lever that changes what the user may use. Both fields are empty by default:
   * the process environment is *not* consulted unless asked, because a machine
   * that exports `HTTPS_PROXY` for corporate traffic must not silently reroute a
   * lane whose quota is counted per IP.
   */
  freeLane: { proxyUrl: '', fromEnvironment: false },
  catalogSyncedAt: 0,
}

/** The only thing this plugin writes down about itself. */
export const RUNTIME_INITIAL = {
  version: 1,
  catalogSyncedAt: 0,
}

/** The persisted catalog snapshot, so a cold start with no network still lists models. */
export const CATALOG_INITIAL = {
  version: 1,
  at: 0,
  entries: [...SEED_MODEL_IDS],
}

/** Persisted probe verdicts, plus the free lane's own quota breaker. */
export const AVAILABILITY_INITIAL = {
  version: 1,
  at: 0,
  egress: null,
  results: {},
  /**
   * The lane's verdict about the current exit, independent of any one model.
   *
   * `state`: `ok` (no verdict), `quota` (a real 429; `retryAt` is when the
   * window ends) or `locked` (the client gate: waiting cannot help). It lives
   * beside the per-model verdicts because it is the same kind of fact — an
   * answer about this network path — and is cleared the same way, when the path
   * changes.
   */
  lane: { state: 'ok', at: 0 },
}

/** Keys a bundle patch may set, and the shape each must have. */
const CONFIG_RULES = {
  enabled: value => typeof value === 'boolean',
  exposeRegionModels: value => typeof value === 'boolean',
  streamRecovery: value => typeof value === 'boolean' || (value !== null && typeof value === 'object'),
  probeIntervalMinutes: positiveInteger,
  defaultMaxTokens: positiveInteger,
  endpointStyle: value => ENDPOINT_STYLES.includes(value),
  laneBreaker: value => typeof value === 'boolean',
  freeLane: value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && (value.proxyUrl === undefined || typeof value.proxyUrl === 'string')
    && (value.fromEnvironment === undefined || typeof value.fromEnvironment === 'boolean'),
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * Validate the bundle patch's `config` object.
 *
 * Fail-open on purpose: a key with the wrong shape is dropped rather than
 * rejecting the plugin, because a plugin that refuses to load is strictly worse
 * than one running with a default. A non-positive number counts as "unset" —
 * `setTimeout(fn, NaN)` fires after 1 ms in Node, so letting one through would
 * turn a periodic probe into a busy loop.
 *
 * @param {unknown} config
 * @param {(message: string) => void} [warn]
 * @returns {object} the accepted overlay
 */
export function configOverlay(config, warn) {
  const overlay = {}
  if (config === null || typeof config !== 'object') return overlay
  for (const [key, value] of Object.entries(config)) {
    if (key === 'baseUrl') {
      if (typeof value === 'string' && value.trim() !== '') overlay.baseUrl = value.trim()
      else if (value !== undefined && value !== '') warn?.(`opencode-free-model: ignoring config.baseUrl (expected a non-empty string)`)
      continue
    }
    if (key === 'wireOverrides') {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const entries = Object.entries(value).filter(([, wire]) => ['chat', 'responses', 'messages'].includes(wire))
        if (entries.length !== Object.keys(value).length) warn?.('opencode-free-model: ignoring unknown wire name in config.wireOverrides')
        overlay.wireOverrides = Object.fromEntries(entries)
      } else {
        warn?.('opencode-free-model: ignoring config.wireOverrides (expected an object)')
      }
      continue
    }
    if (key === 'freeLane') {
      // Normalised into the full shape rather than stored as handed over: the
      // overlay *replaces* the default object, so a patch that sets only
      // `proxyUrl` would otherwise drop `fromEnvironment` and, with it, the
      // documented default. Each field is only copied when it has the right
      // type; a patch carrying one good field and one bad one keeps the good.
      if (CONFIG_RULES.freeLane(value)) {
        const lane = { ...SETTINGS_INITIAL.freeLane }
        let accepted = false
        if (typeof value.proxyUrl === 'string') {
          lane.proxyUrl = value.proxyUrl
          accepted = true
        } else if (value.proxyUrl !== undefined) {
          warn?.('opencode-free-model: ignoring config.freeLane.proxyUrl (expected a string)')
        }
        if (typeof value.fromEnvironment === 'boolean') {
          lane.fromEnvironment = value.fromEnvironment
          accepted = true
        } else if (value.fromEnvironment !== undefined) {
          warn?.('opencode-free-model: ignoring config.freeLane.fromEnvironment (expected a boolean)')
        }
        if (accepted) overlay.freeLane = lane
      } else {
        warn?.('opencode-free-model: ignoring config.freeLane (expected an object)')
      }
      continue
    }
    const rule = CONFIG_RULES[key]
    if (rule === undefined) {
      warn?.(`opencode-free-model: ignoring unknown config key "${key}"`)
      continue
    }
    if (rule(value)) overlay[key] = value
    else warn?.(`opencode-free-model: ignoring config.${key} (wrong shape)`)
  }
  return overlay
}

/** The upstream root in force, or `undefined` so the module default applies. */
export function baseUrlOf(settings) {
  return typeof settings?.baseUrl === 'string' && settings.baseUrl.trim() !== '' ? settings.baseUrl.trim() : undefined
}

/** Coerce a configured minute count into a safe period, with a floor. */
export function periodMs(minutes, floorMinutes = 1) {
  const value = Number.isFinite(minutes) && minutes >= floorMinutes ? Math.trunc(minutes) : floorMinutes
  return value * 60_000
}

/**
 * How long a quota wall is assumed to last when the lane names no window.
 *
 * The upstream counts the free tier per egress IP and answers an exhausted one
 * with `FreeUsageLimitError` plus a `Retry-After` measured in hours. When a
 * response carries no usable `Retry-After` — a proxy stripping the header, a 429
 * the classifier saw without one — the honest assumption is the whole window
 * rather than a short retry: re-asking a burned IP within minutes spends the
 * user's next turn to learn the same thing, which is exactly what the breaker
 * exists to stop.
 */
export const LANE_QUOTA_DEFAULT_MS = 6 * 60 * 60 * 1000

/**
 * Rebuild a per-model record with its keys in model-id order.
 *
 * The probe writes each verdict as it lands, and with concurrency 2 that is
 * request-completion order — which read as an arbitrary shuffle (a model with a
 * 13s first token landed after models it sorts before). This file is a record of
 * the last round, not a display order, but a persisted artifact that *looks*
 * sorted and is not is a footgun: sorting on write costs nothing and makes the
 * document scannable.
 *
 * @param {Record<string, unknown>|undefined} record
 * @returns {Record<string, unknown>}
 */
export function byModelId(record) {
  return Object.fromEntries(
    Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
  )
}

/**
 * Test handles, one per mounted context.
 *
 * A cordis plugin may return `undefined` or a disposer from `apply` and nothing
 * else — an object there is read as an invalid effect and the plugin is marked
 * FAILED — so the generation-sensitive entry points are parked here instead of
 * being handed back. Weakly keyed: a disposed context and every closure it owns
 * stay collectable, with no explicit teardown to forget.
 *
 * @type {WeakMap<object, object>}
 */
const mountHandles = new WeakMap()

/**
 * Mark every row of a verdict record as measured under a previous egress.
 *
 * The rows are *kept*, not deleted: a refusal is a property of the network path,
 * so it stays true of the path it was measured on, and the history is what
 * explains why a model is missing from the picker after a VPN was switched on.
 * What it can no longer be is an answer about the *current* path, which is what
 * `stale` says. {@link verdictOf} is where that flag is honoured, and
 * {@link liveVerdicts} is the only thing that filters on it; nothing else has to
 * know it exists.
 *
 * @param {Record<string, object>|undefined} rows
 * @returns {Record<string, object>}
 */
export function expireVerdicts(rows) {
  return Object.fromEntries(
    Object.entries(rows ?? {}).map(([id, row]) => [
      id,
      row !== null && typeof row === 'object' ? { ...row, stale: true } : row,
    ]),
  )
}

/**
 * The verdict a row is allowed to speak for right now.
 *
 * A stale row is not a verdict about this egress — it is a record of what a
 * *different* one answered — so it reads as "not measured" and the model is
 * treated the way an unprobed model is treated: advertised on the main route and
 * left to fail on its own if it must. The alternative, keeping the old state,
 * silently carries a region refusal across a network change and hides a model
 * that now works.
 *
 * @param {{state?: string, stale?: boolean}|undefined} row
 * @returns {string|undefined} a {@link STATE} value, or `undefined` for "not measured"
 */
export function verdictOf(row) {
  if (row === null || typeof row !== 'object') return undefined
  if (row.stale === true) return undefined
  return typeof row.state === 'string' ? row.state : undefined
}

/**
 * Live verdicts only, in the shape `computeMembership` expects.
 *
 * Membership is recomputed from this rather than from the stored document so the
 * `stale` rule lives in exactly one place: a stale row and an absent row have to
 * reach `computeMembership` identically, or the picker would keep honouring a
 * refusal the egress has already left behind.
 *
 * @param {Record<string, object>|undefined} rows
 * @returns {Record<string, {state: string}>}
 */
export function liveVerdicts(rows) {
  const live = {}
  for (const [id, row] of Object.entries(rows ?? {})) {
    const state = verdictOf(row)
    if (state !== undefined) live[id] = { ...row, state }
  }
  return live
}

/**
 * Mount the Host half.
 *
 * @param {object} ctx - the cordis context
 * @param {object} [config] - the bundle patch's `config` object
 */
export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const warn = message => {
    if (typeof logger.warn === 'function') logger.warn(message)
    else if (typeof logger.log === 'function') logger.log(message)
  }
  const dataDir = path.join(resolveDshHome(), DATA_DIR_NAME)
  try {
    fs.mkdirSync(dataDir, { recursive: true })
  } catch (error) {
    warn(`opencode-free-model: could not create ${dataDir} (${error?.message ?? error})`)
  }

  const overlay = configOverlay(config, warn)
  const runtime = new JsonStore(path.join(dataDir, 'runtime.json'), RUNTIME_INITIAL, { log: warn })
  const catalogStore = new JsonStore(path.join(dataDir, 'catalog.json'), CATALOG_INITIAL, { log: warn })
  const availability = new JsonStore(path.join(dataDir, 'availability.json'), AVAILABILITY_INITIAL, { log: warn })

  /** The effective settings for this mount: defaults, then runtime state, then config. */
  const settings = () => ({ ...SETTINGS_INITIAL, ...runtime.get(), ...overlay })

  let disposed = false
  let attributionUserAgent
  /** Whether the "configured lane proxy is unusable" warning has been said. */
  let laneProxyWarned = false

  /**
   * How many times the network egress has changed under this mount.
   *
   * Every verdict this plugin records is an answer about a *network path*, not
   * about an account: which models the gateway will route is a property of the
   * public address it sees. A round in flight when the path changes therefore
   * holds answers about a path that no longer exists — and the slowest models in
   * it land last, which without a generation stamp is exactly when they would
   * overwrite fresh verdicts with obsolete ones.
   *
   * So the counter is compared, not the clock: a callback that captured an older
   * value is from an older egress and is dropped. `Date.now()` cannot serve here
   * because the ordering it encodes is when a result *arrived*, and the whole
   * problem is that arrival order is not measurement order.
   */
  let egressGeneration = 0

  /** The live catalog, rebuilt by every successful refresh. */
  let catalog = materializeCatalog(catalogStore.get().entries ?? SEED_MODEL_IDS, settings().wireOverrides)
  /** The current route -> model ids mapping, recomputed with the verdicts. */
  let routes = { [ROUTE_MAIN]: [], [ROUTE_REGION]: [] }

  /** Recompute membership and publish it to the picker. */
  function recomputeRoutes({ announce = true } = {}) {
    const current = settings()
    if (current.enabled === false) {
      // Advertise nothing so the picker stops offering models that would fail;
      // the routes stay registered, so an existing session gets our adapter's
      // CONFIG_DISABLED failure rather than NO_ADAPTER.
      routes = { [ROUTE_MAIN]: [], [ROUTE_REGION]: [] }
    } else {
      const split = computeMembership(catalog, liveVerdicts(availability.get().results), current)
      routes = { [ROUTE_MAIN]: split.main, [ROUTE_REGION]: split.region }
    }
    if (announce) ctx.emit?.('llm/adapters-updated')
  }

  const state = () => {
    const current = settings()
    return {
      catalog,
      routes,
      settings: current,
      attributionUserAgent,
      wireOverrides: current.wireOverrides,
      // Two settings the turn path needs but that are resolved, not read: the
      // endpoint table this lane posts under, and the exit it dials from. They
      // travel in the snapshot because the adapter has no access to the mount's
      // closures, and resolving them per turn is what lets a config change take
      // effect without a remount.
      endpointStyle: current.endpointStyle,
      laneProxy: laneProxyFor(current),
    }
  }

  /**
   * Record one verdict about one model, from something other than a probe round.
   *
   * A mid-turn `RegionError` is a fact about *that* model on *this* network path,
   * established by a request the user had already paid for. It is therefore not a
   * reason to re-measure the roster: answering it with a full round spends a
   * probe per model — from the same quota pool as the user's turns — to learn
   * something the refusal already said about exactly one of them, and it does so
   * at the worst possible moment, when the lane has just demonstrated it is
   * refusing this network (upstream 6da81a3 is the same lesson taken further).
   *
   * The row deliberately omits `latencyMs` and `startedAt`: this path never timed
   * a first token, and a fabricated measurement would be indistinguishable from a
   * real one downstream. `at` is honest — it is when the refusal was observed —
   * and a row without `startedAt` is one a later probe result may freely replace,
   * which is what should happen.
   *
   * @param {string} modelId
   */
  function recordRegionRefusal(modelId) {
    recordPassiveResult(modelId, STATE.regionBlocked,
      'refused as unavailable in this country by a real request; not re-probed')
  }

  // ── the free lane's quota breaker and passive availability ─────────────────
  //
  // The upstream counts the free tier per egress IP, and a burned one answers
  // every request — any model, any session — with `FreeUsageLimitError` and a
  // `Retry-After` of hours. Before the breaker, the fork learned this by spending
  // probes against the wall and by failing the user's next turn for it. Now the
  // wall is recorded once, from real traffic, and every later request is refused
  // locally until the window ends — which costs nothing and tells the user
  // something true.
  //
  // It is a *local* refusal, though: the upstream never asked for it, so
  // `settings().laneBreaker === false` turns the gate off while still recording
  // the passive verdicts it describes (an operator debugging a silent model gets
  // the data without the block).

  /**
   * The lane's verdict about the current exit.
   *
   * `null` for a document written before the breaker existed, which reads exactly
   * like `{ state: 'ok' }`: an absent verdict is not a bad one.
   *
   * @returns {{state?: string, at?: number, retryAt?: number, message?: string}|null}
   */
  function laneRow() {
    const row = availability.get().lane
    return row !== null && typeof row === 'object' ? row : null
  }

  /**
   * Write the lane's state, through the egress guard.
   *
   * The guard is the same one every verdict uses, and for the same reason: a 429
   * collected on the old network path says nothing about the new one, so writing
   * it now would park a fresh exit behind a wall it never hit.
   *
   * @param {string} laneState - `ok` | `quota` | `locked`
   * @param {{retryAt?: number, message?: string}} [extra]
   */
  function setLaneState(laneState, extra = {}) {
    const generation = egressGeneration
    availability.edit(store => {
      if (disposed || generation !== egressGeneration) return undefined
      return { ...store, lane: { state: laneState, at: Date.now(), ...extra } }
    })
    availability.flush()
    recomputeRoutes()
  }

  /**
   * Record one model's verdict without asking the gateway anything.
   *
   * A real turn has already paid for this fact, and a probe would re-ask the
   * question from the same quota pool at the worst moment — right after the lane
   * demonstrated it is refusing this network.
   *
   * The existing row is carried forward so a measured `latencyMs` / `startedAt`
   * is not lost to a by-product verdict — but `stale` is dropped, because this
   * observation *is* about the current path. Leaving the flag on would make the
   * new verdict invisible: {@link verdictOf} reads a stale row as "not measured"
   * by design, so a region refusal arriving after an egress change would be
   * recorded and then ignored, and the model would stay advertised on a route
   * that refuses it.
   *
   * @param {string} modelId
   * @param {string} resultState - a {@link STATE} value
   * @param {string} [detail]
   */
  function recordPassiveResult(modelId, resultState, detail) {
    const id = typeof modelId === 'string' ? modelId.trim() : ''
    if (id === '' || disposed) return
    const generation = egressGeneration
    availability.edit(store => {
      if (disposed || generation !== egressGeneration) return undefined
      const previous = store.results?.[id]
      const carried = previous !== null && typeof previous === 'object' ? { ...previous } : {}
      delete carried.stale
      return {
        ...store,
        results: byModelId({
          ...store.results,
          [id]: {
            ...carried,
            state: resultState,
            ...(detail === undefined ? {} : { detail }),
            // Distinct from a probed row: this one is a by-product of a real
            // turn, so a later probe result may freely replace it.
            source: 'passive',
            at: Date.now(),
          },
        }),
      }
    })
    availability.flush()
    recomputeRoutes()
  }

  /**
   * Decide whether the anonymous lane may be used right now.
   *
   * Consulted before every attempt on the free lane, so it has to be cheap and
   * decisive: either the pass-through `{ok: true}` or a refusal carrying the
   * state the caller turns into a failure. A `quota` window that has already
   * elapsed reads as open — the window is a deadline, not a latch, and the next
   * real answer either confirms the lane is back or records a new window.
   *
   * @returns {{ok: true}|{ok: false, state: string, retryAt?: number, message: string}}
   */
  function laneGate() {
    if (settings().laneBreaker === false) return { ok: true }
    const lane = laneRow()
    if (lane === null || lane.state === 'ok' || lane.state === undefined) return { ok: true }
    if (lane.state === 'quota') {
      if (!Number.isFinite(lane.retryAt) || lane.retryAt <= Date.now()) return { ok: true }
      return { ok: false, state: 'quota', retryAt: lane.retryAt, message: lane.message ?? '' }
    }
    if (lane.state === 'locked') return { ok: false, state: 'locked', message: lane.message ?? '' }
    return { ok: true }
  }

  /**
   * Learn from one real turn's outcome.
   *
   * A success is the strongest evidence the lane is open — stronger than any
   * window arithmetic — so it clears the breaker rather than waiting the clock
   * out. A 429 opens the window for as long as the lane says, or
   * {@link LANE_QUOTA_DEFAULT_MS} when it says nothing usable. The lane-locked
   * refusal is the client gate (`FreeTierError`): no window, because waiting
   * cannot change what this client looks like. A regional refusal is a fact about
   * one model, not about the lane.
   *
   * @param {{entry?: object, ok?: boolean, error?: object}} [outcome]
   */
  function noteFreeLaneOutcome({ entry, ok, error } = {}) {
    if (disposed || entry === null || typeof entry !== 'object') return
    // A channel row is another producer's model: this lane's quota says nothing
    // about it, and recording a verdict would misroute it.
    if (entry.channel) return
    const entryId = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (entryId === '') return
    if (ok === true) {
      const lane = laneRow()
      if (lane !== null && lane.state !== 'ok' && lane.state !== undefined) setLaneState('ok')
      recordPassiveResult(entryId, STATE.available)
      return
    }
    const code = error?.code
    if (code === CODE.quota) {
      const retryAfter = Number(error?.providerRetryAfterMs)
      const retryAt = Number.isFinite(retryAfter) && retryAfter > 0
        ? Date.now() + retryAfter
        : Date.now() + LANE_QUOTA_DEFAULT_MS
      setLaneState('quota', {
        retryAt,
        message: String(error?.message ?? 'free usage limit reached').slice(0, 300),
      })
      recordPassiveResult(entryId, STATE.throttled)
      return
    }
    if (code === CODE.laneLocked) {
      setLaneState('locked', {
        message: String(error?.message ?? 'the free tier answers this client only').slice(0, 300),
      })
      recordPassiveResult(entryId, STATE.unavailable)
      return
    }
    if (code === CODE.region) recordPassiveResult(entryId, STATE.regionBlocked)
  }

  /**
   * The lane proxy for this mount, or `null` for direct.
   *
   * Resolved per call rather than once at mount time, because the address is a
   * setting an operator can change without a restart. The hostname comes from
   * the same `baseUrl` the request will use, so the `NO_PROXY` check matches the
   * host actually dialled instead of a hard-coded one.
   *
   * A configured address that does not parse is a configuration mistake, and it
   * must not cost the mount: warn once — the operator needs to see the typo, but
   * not on every request — and fall back to direct, which is where the lane was
   * before the field existed.
   *
   * @param {object} current - the effective settings for this call
   * @returns {URL|null}
   */
  function laneProxyFor(current) {
    let hostname = ''
    try {
      hostname = new URL(resolveBaseUrl(baseUrlOf(current))).hostname
    } catch { /* an unparsable baseUrl is the transport layer's error to report */ }
    try {
      return resolveLaneProxy(hostname, current)
    } catch (error) {
      if (laneProxyWarned === false) {
        laneProxyWarned = true
        warn(`opencode-free-model: ignoring the configured lane proxy (${error?.message ?? error}); going direct`)
      }
      return null
    }
  }

  const adapter = new OcFreeModelAdapter({
    state,
    resolveImage: imageResolver(ctx, logger),
    warn,
    onRegionBlocked: recordRegionRefusal,
    freeLaneGate: laneGate,
    onFreeLaneOutcome: noteFreeLaneOutcome,
  })

  // ── registration ────────────────────────────────────────────────────────────
  recomputeRoutes({ announce: false })
  const registration = ctx.llm.registerAdapter(ROUTES, adapter)
  ctx.effect(() => () => {
    registration()
  }, 'opencode-free-model: adapter routes')

  // ── catalog + availability ──────────────────────────────────────────────────
  async function fetchListing() {
    const current = settings()
    return getJson(MODELS_PATH, {
      session: sessionForConversation('catalog:opencode-free-model'),
      requestId: mintRequestId(),
      attributionUserAgent,
      baseUrl: baseUrlOf(current),
      laneProxy: laneProxyFor(current),
    })
  }

  /**
   * Refresh the catalog, then optionally the verdicts.
   *
   * A failed listing keeps the previous catalog: the lane's job is to serve
   * models, and dropping every model because one GET timed out is the worst
   * possible reading of the situation.
   *
   * The raw rows — not just their ids — are handed to `buildCatalog`, because
   * the listing now publishes each model's window, output ceiling, modalities
   * and thinking menu. `parseListing` still decides *whether* the fetch said
   * anything (its id list is what the empty check reads), while the rows carry
   * the per-field metadata into the catalog.
   */
  async function refreshCatalog({ probe = true, force = false } = {}) {
    let payload
    try {
      payload = await fetchListing()
    } catch (error) {
      warn(`opencode-free-model: model listing refresh failed (${error?.message ?? error}); keeping the cached catalog`)
    }
    const ids = parseListing(payload)
    const overrides = settings().wireOverrides
    if (ids.length > 0) {
      catalog = buildCatalog(payload, overrides)
      catalogStore.update({ at: Date.now(), entries: catalog.map(entry => entry.id) })
      catalogStore.flush()
      runtime.update({ catalogSyncedAt: Date.now() })
    } else {
      catalog = materializeCatalog(catalogStore.get().entries ?? SEED_MODEL_IDS, overrides)
    }
    if (probe) await refreshAvailability(force)
    recomputeRoutes()
    return catalog
  }

  let probeRound = null
  /** The egress generation the round in `probeRound` was started under. */
  let probeRoundGeneration = 0
  let probeThrottleStreak = 0
  let probeBackoffUntil = 0

  /**
   * One probe round at a time, for every caller.
   *
   * Four things start a round: the periodic loop, the egress watch, the boot
   * sequence, and a reprobe triggered by a settings change. Running whole
   * catalogs side by side against a lane whose 429 carries a growing
   * `retry-after` spends the user's own quota on the same question, so a caller
   * arriving mid-round joins the round in flight instead of starting another —
   * but only while that round is still describing the *current* egress. A round
   * that started before an egress change is asking about a network path that no
   * longer exists, and joining it would mean the new path waits for answers
   * about the old one and then adopts them. So the join is conditioned on the
   * generation, and a stale round is left to finish and discard itself.
   */
  async function refreshAvailability(force = false) {
    if (probeRound !== null && probeRoundGeneration === egressGeneration) return probeRound
    if (!force && probeBackoffUntil > Date.now()) return availability.get().results
    const generation = egressGeneration
    probeRoundGeneration = generation
    const round = (async () => {
      const current = settings()
      const options = {
        attributionUserAgent,
        baseUrl: baseUrlOf(current),
        wireOverrides: current.wireOverrides,
        endpointStyle: current.endpointStyle,
        laneProxy: laneProxyFor(current),
      }
      const results = await probeCatalog(catalog, options, (id, result) => {
        // A late result from a round that started under a previous egress. It is
        // discarded rather than persisted: the models in this round are exactly
        // the ones whose verdict the egress change just invalidated, and a slow
        // model answers last — so without this guard the slowest rows would land
        // after the invalidation and reinstate conclusions about a network path
        // that is gone. That is the failure mode that makes a user's VPN switch
        // appear not to have worked until the next full round finishes.
        if (disposed || generation !== egressGeneration) return
        availability.edit(store => ({
          ...store,
          results: byModelId({
            ...store.results,
            [id]: {
              state: result.state,
              ...(result.detail === undefined ? {} : { detail: result.detail }),
              ...(result.ttftMs === undefined ? {} : { ttftMs: result.ttftMs }),
              latencyMs: result.latencyMs,
              // When the probe *began*, not when this row was written. `at`
              // records the reply; a slow model can answer after a newer round
              // has already spoken, and only the start time lets a reader tell
              // which sample is actually fresher.
              ...(result.startedAt === undefined ? {} : { startedAt: result.startedAt }),
              at: Date.now(),
            },
          }),
        }))
      }, 2)
      // Everything below describes the round as a whole — the round stamp, the
      // quota verdict, the throttle backoff — and all of it is a statement about
      // the egress the round ran on. Under a newer generation it must not be
      // written: an all-throttled verdict from the old path would otherwise park
      // the *new* path behind a backoff it never asked for.
      if (disposed || generation !== egressGeneration) return {}
      availability.edit(store => ({ ...store, at: Date.now() }))
      availability.flush()
      const verdicts = Object.values(results)
      // Say it out loud when a round refuses everything: `computeMembership`
      // keeps the roster advertised in that case, and without this line the log
      // would read as a healthy probe while the gateway turned every model down.
      if (verdicts.length > 0 && verdicts.every(row => row.state === 'unavailable')) {
        warn(`opencode-free-model: the gateway refused all ${verdicts.length} models this round (${verdicts[0].detail ?? 'no detail'}); keeping them advertised`)
      }
      // A round the lane answered with nothing but 429s is the lane saying "this
      // egress is out of quota". The probe draws from the same pool as the
      // user's turns, so answering "how full is the pool?" by draining it again
      // every period makes the shortage permanent. Back the next periodic round
      // off (doubling, capped) and let real traffic — a manual reprobe, an
      // egress change, the boot round — through regardless.
      const allThrottled = verdicts.length > 0 && verdicts.every(row => row.state === 'throttled')
      probeThrottleStreak = allThrottled ? probeThrottleStreak + 1 : 0
      probeBackoffUntil = allThrottled
        ? Date.now() + Math.min(30 * 2 ** (probeThrottleStreak - 1), 120) * 60_000
        : 0
      if (allThrottled) {
        warn(`opencode-free-model: the probe round hit the lane's quota; availability probes pause for ${Math.round((probeBackoffUntil - Date.now()) / 60_000)} minutes (your own requests are unaffected)`)
      }
      recomputeRoutes()
      return results
    })().finally(() => {
      // Only the round that owns the slot may free it. A round started under an
      // older egress is still running after a newer one took the slot, and
      // clearing the handle unconditionally would let a third caller start a
      // parallel round over the same catalog — the exact quota duplication this
      // single-flight guard exists to prevent.
      if (probeRound === round) probeRound = null
    })
    probeRound = round
    return probeRound
  }

  /**
   * Re-probe when the public address the gateway sees changes.
   *
   * Availability is a property of the network path, not of the account, and
   * turning a VPN on changes which models exist for the user — the picker has to
   * follow without a restart.
   *
   * The change is handled in three steps, in this order, and the order is the
   * whole point:
   *
   * 1. **Invalidate** — bump {@link egressGeneration} and mark every existing row
   *    `stale`, so nothing measured on the old path is trusted as an answer about
   *    the new one. This happens *before* any re-probe is scheduled, because the
   *    alternative is a window in which the picker still hides a model that the
   *    new network can serve, and the user has no way to tell why.
   * 2. **Reset the throttle** — a backoff was the *old* egress being out of
   *    quota, and carrying it across a network change parks the new path behind
   *    a wall it never hit.
   * 3. **Re-measure** — one forced round. The fork keeps automatic probing (it
   *    has no manual reprobe surface, so disabling it would leave every model
   *    reading `unknown` and make `exposeRegionModels` inert); what it must not do
   *    is treat the old verdicts as if they still applied while that round runs.
   */
  async function watchEgress() {
    const seen = await detectEgress()
    if (disposed || seen === undefined) return
    const previous = availability.get().egress
    if (previous?.ip === seen.ip) return
    egressGeneration += 1
    // History is kept, not erased: a refusal stays true of the path it was
    // measured on, and that record is what explains a gap in the picker. It is
    // no longer a verdict about *this* path, which is all `stale` claims.
    availability.edit(store => ({
      ...store,
      egress: seen,
      // `at` is the round stamp ("when was availability last established"), and
      // nothing has been established about this path yet.
      at: 0,
      results: expireVerdicts(store.results),
      // The breaker described the *old* exit's quota, and a new exit is a new
      // bucket: the upstream counts this lane per egress IP, so a window opened
      // from one address says nothing about another. Carrying it across would
      // park a VPN switch behind a wall the new path never hit — the exact
      // failure the breaker exists to prevent, inverted.
      lane: { state: 'ok', at: Date.now() },
    }))
    availability.flush()
    probeThrottleStreak = 0
    probeBackoffUntil = 0
    // The roster itself is unchanged — same ids, same capacities — but which
    // route each belongs on just became unknown, and the picker renders routes.
    recomputeRoutes()
    warn(`opencode-free-model: egress changed to ${seen.ip}${seen.country ? ` (${seen.country})` : ''}; previous availability marked stale, re-measuring`)
    await refreshAvailability(true)
  }

  // ── boot + background loop ──────────────────────────────────────────────────
  ctx.effect(() => () => {
    runtime.dispose()
    catalogStore.dispose()
    availability.dispose()
  }, 'opencode-free-model: stores')

  ctx.effect(() => () => {
    disposed = true
  }, 'opencode-free-model: dispose flag')

  ctx.effect(() => {
    void (async () => {
      attributionUserAgent = await resolveAttributionUserAgent(logger)
      await refreshCatalog({ probe: true, force: true })
    })().catch(error => warn(`opencode-free-model: startup refresh failed (${error?.message ?? error})`))
  }, 'opencode-free-model: boot refresh')

  /**
   * Run one task every `ms` for as long as this generation lives.
   *
   * A plain unref'd timer chain, on purpose; see the module note about
   * `ctx.interval` and the `timer` service.
   */
  function every(task, ms) {
    let handle = setTimeout(function tick() {
      handle = undefined
      if (disposed) return
      task()
      handle = setTimeout(tick, ms)
      handle.unref?.()
    }, ms)
    handle.unref?.()
    ctx.effect(() => () => {
      if (handle !== undefined) clearTimeout(handle)
    }, 'opencode-free-model: interval')
  }

  every(() => {
    void (async () => {
      await watchEgress()
      await refreshCatalog({ probe: true })
    })().catch(error => warn(`opencode-free-model: periodic refresh failed (${error?.message ?? error})`))
  }, periodMs(settings().probeIntervalMinutes, 1))

  every(() => {
    void watchEgress().catch(() => {})
  }, 120_000)

  ctx.on?.('loader/volatile-update', () => {
    // Route ids never change, but the *set* they serve does; re-announcing is what
    // makes a settings edit visible without a restart.
    recomputeRoutes()
  })

  logger.info?.(`opencode-free-model: mounted ${ROUTE_MAIN} and ${ROUTE_REGION} against ${settings().baseUrl || UPSTREAM_BASE}`)

  // The two generation-sensitive entry points, parked instead of returned.
  // Nothing in the plugin's own lifecycle calls them — the timers above and the
  // adapter do — but they are the only way to exercise "an egress change
  // invalidates prior verdicts and discards late results" without waiting out a
  // 15-minute period and a real VPN flip, and a correctness rule this subtle is
  // worth being able to test. They are thin wrappers over the closures above and
  // carry no state of their own.
  //
  // Parked rather than returned on purpose: a cordis plugin's `apply` may return
  // `undefined` or a disposer, and *nothing else*. Any other object — including
  // a promise or a plain handle — reaches `_execute`, which falls through its
  // disposer / thenable / iterable checks and throws `TypeError: Invalid
  // effect`, leaving the plugin FAILED and never mounted. Verified against
  // cordis 4.0.0-rc.10 before choosing this shape.
  mountHandles.set(ctx, {
    /** The generation counter every verdict write is compared against. */
    get egressGeneration() {
      return egressGeneration
    },
    /** One watcher pass, awaited. */
    watchEgress: async () => {
      await watchEgress()
    },
    /** One probe round, forced past backoff; resolves the round's results. */
    refreshAvailability: force => refreshAvailability(force),
    /** Record a mid-turn regional refusal for exactly one model. */
    recordRegionRefusal,
    /**
     * The lane gate as the adapter sees it, so a breaker test can mount the
     * plugin and assert what a turn would be told without spending a request.
     */
    laneGate,
    /** Learn from one turn's outcome exactly as the adapter would. */
    noteFreeLaneOutcome,
    /** The lane's persisted state, for a test that asserts what was written. */
    laneRow,
  })
}

/**
 * Test-only handle for one mounted plugin instance.
 *
 * Returns `undefined` for a context that was never mounted. Weakly keyed so a
 * disposed context — and every closure hanging off it — stays collectable, and
 * re-keyed on every mount so a reload replaces the handle rather than stacking
 * a second one.
 *
 * @param {object} ctx - the cordis context the plugin was applied to
 * @returns {undefined|{egressGeneration: number, watchEgress: () => Promise<void>, refreshAvailability: (force?: boolean) => Promise<object>, recordRegionRefusal: (modelId: string) => void, laneGate: () => object, noteFreeLaneOutcome: (outcome: object) => void, laneRow: () => object|null}}
 */
export function mountHandle(ctx) {
  return mountHandles.get(ctx)
}

/**
 * Resolve an image attachment into a data URL the provider can accept.
 *
 * The attachment service exposes a host path, not bytes; reading it here keeps
 * the plugin free of a second credential path. An unresolvable image is dropped
 * and reported — the runtime has already text-projected files, and a text-only
 * model never sees an image block in the first place.
 *
 * @param {object} ctx
 * @param {{ warn?: (message: string) => void, log?: (message: string) => void }} logger
 * @returns {((ref: object) => string|undefined)|undefined}
 */
export function imageResolver(ctx, logger) {
  if (typeof ctx.get !== 'function') return undefined
  const cache = new Map()
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024
  return ref => {
    // Looked up per call, not once at apply time: a service that loads after this
    // plugin is not provided yet, and a one-shot read would silently cost the
    // whole feature with nothing in the log to say so.
    const attachments = ctx.get('attachments')
    if (attachments === undefined || typeof attachments.imageHostPath !== 'function') return undefined
    const id = String(ref?.attachmentId ?? '')
    if (id === '') return undefined
    const cached = cache.get(id)
    if (cached !== undefined) return cached
    try {
      const hostPath = attachments.imageHostPath(ref)
      if (typeof hostPath !== 'string' || hostPath === '') return undefined
      const size = fs.statSync(hostPath).size
      if (size > MAX_IMAGE_BYTES) {
        logger.warn?.(`opencode-free-model: image ${id} is ${size} bytes, above the ${MAX_IMAGE_BYTES} send limit`)
        return undefined
      }
      const media = typeof ref.mediaType === 'string' ? ref.mediaType : 'image/png'
      const url = `data:${media};base64,${fs.readFileSync(hostPath).toString('base64')}`
      if (cache.size > 48) cache.clear()
      cache.set(id, url)
      return url
    } catch (error) {
      logger.warn?.(`opencode-free-model: could not read image ${id} (${error?.message ?? error})`)
      return undefined
    }
  }
}
