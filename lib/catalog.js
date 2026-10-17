/**
 * Model catalog for the free lane.
 *
 * Two sources, deliberately layered so neither alone can break the plugin:
 *
 * 1. the upstream listing (`GET /zen/v1/models`) — the authoritative set of ids
 *    the gateway will currently name;
 * 2. a vetted local capability table (context window / vision / reasoning),
 *    because the listing discloses an id and nothing else.
 *
 * The table below is the *observed* baseline: `contextWindow` / `maxOutput` are
 * the provider's published capacities, and `vision` is what this lane actually
 * accepted under a direct image-input probe rather than what a model card
 * claims. An id the table does not match gets the conservative fallback at the
 * bottom of {@link CAPABILITIES}, not an invented row.
 *
 * @module lib/catalog.js
 */

import { baseModelId, resolveWire } from './upstream.js'

/**
 * Ids that are on the free lane without carrying the `-free` marker.
 *
 * `big-pickle` and `space-bunny-free` are the two the listing names today;
 * `union-alpha` is retained because it has been on this lane historically and a
 * stale admission costs one failed turn, while a wrong exclusion removes a model
 * from the picker. Everything else must earn its place with the `-free` token,
 * because the listing mixes paid ids in and offering one produces a
 * `MISSING_CREDENTIAL` failure the user cannot resolve.
 */
const ALWAYS_FREE = new Set(['union-alpha', 'big-pickle', 'space-bunny-free'])

/** Local capability baseline, matched in order against the base id. */
export const CAPABILITIES = [
  { match: /^mimo.*v2\.6/, vision: true, reasoning: true, contextWindow: 1_048_576, maxOutput: 131_072, canDisableThinking: false },
  { match: /^mimo.*v2\.5/, vision: true, reasoning: true, contextWindow: 1_048_576, maxOutput: 131_072, canDisableThinking: false },
  { match: /^mimo/, vision: true, reasoning: true, contextWindow: 262_144, maxOutput: 131_072 },
  { match: /^muse.?spark/, vision: true, reasoning: true, contextWindow: 1_048_576, maxOutput: 131_072 },
  { match: /^nemotron/, vision: false, reasoning: true, contextWindow: 128_000, maxOutput: 32_768 },
  { match: /^ling/, vision: false, reasoning: true, contextWindow: 128_000, maxOutput: 32_768 },
  { match: /^space.?bunny/, vision: true, reasoning: true, contextWindow: 262_144, maxOutput: 65_536 },
  { match: /^union/, vision: true, reasoning: false, contextWindow: 262_144, maxOutput: 131_072 },
  { match: /^deepseek/, vision: false, reasoning: true, contextWindow: 128_000, maxOutput: 64_000 },
  { match: /^jev/, vision: false, reasoning: false, contextWindow: 32_768, maxOutput: 4096 },
]

/** The row every unmatched id falls back to. */
export const FALLBACK_CAPABILITY = Object.freeze({
  vision: false, reasoning: true, contextWindow: 131_072, maxOutput: 32_768,
})

/**
 * Human-facing display names, so a raw upstream id never reaches the picker.
 *
 * Matched against the live listing (2026-10). An id that leaves the lane has its
 * row dropped rather than kept "just in case": this table is only ever consulted
 * for an id the gateway actually named, so a stale row is dead weight that hides
 * which models the plugin really knows about.
 */
export const DISPLAY_NAMES = {
  'big-pickle': 'Big Pickle',
  'beam-free': 'Beam',
  'mimo-v2.6-flash-free': 'MiMo V2.6 Flash',
  'nemotron-3.5-super-vl-free': 'Nemotron 3.5 Super VL',
  'nemotron-3.5-lightning-free': 'Nemotron 3.5 Lightning',
  'jev-1.13-free': 'Jev 1.13',
  'longcat-2.5-preview-free': 'LongCat 2.5 Preview',
  'deepseek-v4.1-flash-free': 'DeepSeek V4.1 Flash',
  'glm-5.3-flash-free': 'GLM 5.3 Flash',
  'space-bunny-free': 'Space Bunny',
  'union-alpha': 'Union Alpha',
}

/** Ids whose regional availability is known to be egress-dependent. */
const REGION_SENSITIVE = [/^muse.?spark/]

/**
 * Ids shipped as the cold-start catalog, so a fresh install with no network
 * still lists the lane's models.
 *
 * Kept in sync with the live listing (2026-10). A seed id the lane has retired is
 * not harmless: `buildCatalog` admits seeds without a listing to check them, so a
 * stale row is advertised in the picker and fails on its first turn.
 */
export const SEED_MODEL_IDS = [
  'big-pickle',
  'beam-free',
  'mimo-v2.6-flash-free',
  'nemotron-3.5-super-vl-free',
  'nemotron-3.5-lightning-free',
  'jev-1.13-free',
  'longcat-2.5-preview-free',
  'deepseek-v4.1-flash-free',
  'glm-5.3-flash-free',
  'space-bunny-free',
]

/**
 * Is this id on the key-free lane?
 *
 * The gateway's listing mixes paid and free ids; only these answer without a
 * per-user key, and offering a paid id in the picker would produce a
 * `MISSING_CREDENTIAL` failure the user cannot resolve.
 *
 * @param {unknown} modelId
 * @returns {boolean}
 */
export function isFreeLane(modelId) {
  const base = baseModelId(modelId)
  if (ALWAYS_FREE.has(base)) return true
  return /(?:^|[-_])free(?:$|[-_.])/.test(base)
}

/**
 * Baseline capacities for one model id.
 * @param {unknown} modelId
 * @returns {object}
 */
export function capabilitiesFor(modelId) {
  const base = baseModelId(modelId)
  for (const entry of CAPABILITIES) if (entry.match.test(base)) return entry
  return FALLBACK_CAPABILITY
}

/**
 * Is this model's availability known to depend on the egress country?
 * @param {unknown} modelId
 * @returns {boolean}
 */
export function isRegionSensitive(modelId) {
  const base = baseModelId(modelId)
  return REGION_SENSITIVE.some(pattern => pattern.test(base))
}

/**
 * Title-case a bare upstream id into something a picker can show.
 * @param {unknown} modelId
 * @returns {string}
 */
export function displayModelName(modelId) {
  const base = baseModelId(modelId)
  const known = DISPLAY_NAMES[base]
  if (known !== undefined) return known
  return base
    // Separators become spaces, but a dot between digits does not: it is the
    // version the model is known by, and "Brand New 2 0" is not a name.
    .replace(/[-_\s]+/g, ' ')
    .trim()
    .split(' ')
    .map(word => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
}

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

/**
 * Merge an upstream id listing with the local capability table.
 *
 * @param {Iterable<string>} ids - raw upstream model ids
 * @param {Record<string, string>} [wireOverrides] - base id -> wire name
 * @returns {Array<object>} catalog entries, in listing order
 */
export function buildCatalog(ids, wireOverrides) {
  const seen = new Set()
  const entries = []
  for (const raw of ids ?? []) {
    const id = String(raw ?? '').trim()
    if (id === '' || !isFreeLane(id)) continue
    const base = baseModelId(id)
    if (seen.has(base)) continue
    seen.add(base)
    const caps = capabilitiesFor(base)
    entries.push({
      id: base,
      name: displayModelName(base),
      wire: resolveWire(base, wireOverrides),
      vision: caps.vision === true,
      reasoning: caps.reasoning !== false,
      contextWindow: positive(caps.contextWindow) ?? FALLBACK_CAPABILITY.contextWindow,
      maxOutput: positive(caps.maxOutput) ?? FALLBACK_CAPABILITY.maxOutput,
      canDisableThinking: caps.canDisableThinking !== false,
      regionSensitive: isRegionSensitive(base),
    })
  }
  return entries
}

/**
 * Parse the gateway's model listing.
 *
 * Documented shape is `{"data":[{"id":…}]}`; a bare array and a `models` key are
 * accepted too because the lane has served all three at different times.
 *
 * @param {unknown} payload
 * @returns {string[]}
 */
export function parseListing(payload) {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : []
  return rows
    .map(row => (typeof row === 'string' ? row : row?.id))
    .filter(id => typeof id === 'string' && id !== '')
}

/**
 * Rebuild a catalog from previously persisted ids.
 * @param {Iterable<string>} ids
 * @param {Record<string, string>} [wireOverrides]
 * @returns {Array<object>}
 */
export function materializeCatalog(ids, wireOverrides) {
  return buildCatalog(ids, wireOverrides)
}

/**
 * Which provider route each catalog entry belongs on, given probe verdicts.
 *
 * A route with no models is dropped from the picker, so this splits rather than
 * duplicates: a model is advertised on exactly one route, and `region-limited`
 * only ever holds models the probe found blocked *here*. A model whose verdict is
 * `unknown` stays on the main route — the asymmetry is deliberate, because a
 * stale entry costs one failed turn the user can retry, while a model removed on
 * a hiccup costs a reprobe-and-wait cycle the user cannot see.
 *
 * @param {Array<object>} catalog
 * @param {Record<string, {state: string}>} verdicts
 * @param {{exposeRegionModels?: boolean}} settings
 * @returns {Record<string, string[]>} route -> model ids
 */
export function computeMembership(catalog, verdicts, settings) {
  const main = []
  const region = []
  for (const entry of catalog) {
    const state = verdicts?.[entry.id]?.state
    if (state === 'unavailable') continue
    if (state === 'region-blocked') region.push(entry.id)
    else main.push(entry.id)
  }
  // Every model refused this round says nothing about any individual model —
  // likely a quota wall or the gateway's own trouble. Keeping the roster
  // advertised is what stops a bad round from emptying the picker.
  if (main.length === 0 && region.length === 0) return { main: catalog.map(entry => entry.id), region: [] }
  return { main, region: settings?.exposeRegionModels === false ? [] : region }
}
