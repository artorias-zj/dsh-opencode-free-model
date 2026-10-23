/**
 * Model catalog for the free lane.
 *
 * Three sources, deliberately layered so none alone can break the plugin:
 *
 * 1. the upstream listing (`GET /zen/v1/models`) — the authoritative set of ids
 *    the gateway will currently name;
 * 2. a vetted local capability table (context window / vision / reasoning),
 *    because the listing discloses an id and nothing else;
 * 3. exact-id overrides for the ids that table's family patterns mis-state,
 *    consulted first because an exact id is the narrower claim.
 *
 * The tables below are the *observed* baseline: `contextWindow` / `maxOutput`
 * start from the provider's published capacities, and `vision` is what this lane
 * actually accepted under a direct image-input probe rather than what a model
 * card claims. Where the published figure and a direct measurement disagree, the
 * measurement is what an override row carries — the published number is a floor,
 * not the served window. An id nothing matches gets the conservative fallback at
 * the bottom of {@link CAPABILITIES}, not an invented row.
 *
 * @module lib/catalog.js
 */

import { baseModelId, resolveWire } from './upstream.js'

/**
 * Ids that are on the free lane without carrying the `-free` marker.
 *
 * `big-pickle` is the one the listing names today; `space-bunny-free` and
 * `union-alpha` are retained because both have been on this lane historically and
 * a stale admission costs one failed turn, while a wrong exclusion removes a
 * model from the picker. Everything else must earn its place with the `-free`
 * token, because the listing mixes paid ids in and offering one produces a
 * `MISSING_CREDENTIAL` failure the user cannot resolve.
 */
const ALWAYS_FREE = new Set(['union-alpha', 'big-pickle', 'space-bunny-free'])

/**
 * Local capability baseline: family-wide defaults, matched in order against the
 * base id.
 *
 * A family row answers "what is a `nemotron`-shaped id like", not "what does
 * this exact id serve" — where the two differ, {@link FREE_ID_OVERRIDES} is
 * consulted first and this row stays as the family default.
 */
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

/**
 * Per-exact-id corrections for the ids this lane actually serves today, where
 * the family row in {@link CAPABILITIES} would mis-state the model.
 *
 * Why a second table at all: the gateway's listing discloses an id and nothing
 * else — no window, no output ceiling, no modality flag — so every number here
 * is either probed or published. The `CAPABILITIES` patterns answer a
 * family-shaped question ("what is a `nemotron` like?") and must stay that way,
 * because they also catch ids that have not been probed yet and a pattern bent
 * to fit one id silently mis-states its siblings. An exact id is a different
 * claim: this model, measured. So `capabilitiesFor` resolves the base id, tries
 * this table, and only then walks the patterns — an override row is narrower
 * than any pattern and therefore wins, which is exactly why a pattern can stay
 * family-wide instead of being narrowed until it no longer describes the
 * family.
 *
 * Why the numbers are not models.dev's: models.dev publishes `200000` for the
 * `-free` ids and, on the two flags it gets wrong here, disagrees with a direct
 * probe. That published figure behaves as a *floor* — the same lane accepted a
 * 1025229-token prompt on `deepseek-v4.1-flash-free` and a 900694-token prompt
 * on `glm-5.3-flash-free`, both 200 — so the served window is what this table
 * carries. Where no such measurement exists (`beam-free`, `flint-40b-free`)
 * there is no row: they keep the fallback, and a guess would be worse than an
 * honest floor.
 */
const FREE_ID_OVERRIDES = {
  // Upstream's measured prompt: 1025229 tokens, 200. The published 200000 is a
  // floor, not the wire's limit; 1048576 is the window the paid sibling serves
  // and 384000 the output ceiling the gateway accepts on this id. Vision comes
  // from upstream's image probe, where the `/^deepseek/` row says false.
  'deepseek-v4.1-flash-free': { vision: true, contextWindow: 1_048_576, maxOutput: 384_000 },
  // Upstream's measured prompt: 900694 tokens, 200 — again above the published
  // 200000 floor. Vision true per the same probe; no pattern matches this id.
  'glm-5.3-flash-free': { vision: true, contextWindow: 1_048_576, maxOutput: 131_072 },
  // The id is a vision-language model: the `/^nemotron/` row's `vision: false`
  // is a family default that this id visibly contradicts, so the vision flag is
  // corrected here rather than by weakening the pattern for
  // `nemotron-3.5-lightning-free`, which really is text-only. Window/output are
  // upstream's for the served id, not the family row's floor.
  'nemotron-3.5-super-vl-free': { vision: true, contextWindow: 1_048_576, maxOutput: 131_072 },
  // No family row matches, so this id would otherwise land on the conservative
  // fallback. Upstream measured a 265360-token prompt accepted (200), which puts
  // the window above that; the output ceiling and vision flag are upstream's for
  // this id. Nothing here is inferred from a published floor.
  'big-pickle': { vision: true, contextWindow: 262_144, maxOutput: 131_072 },
  // Both rows below name ids the listing does not carry today. They are kept
  // because the tables that admit an id without the `-free` marker still keep
  // it, and a model that returns to the roster should not return with the
  // fallback's numbers attached. Nothing here is invented either: the window and
  // output ceiling are upstream's measured values for these ids, and
  // `longcat`'s `vision: false` follows a probe where an image request 500'd.
  'space-bunny-free': { vision: true, contextWindow: 1_048_576, maxOutput: 524_288 },
  'longcat-2.5-preview-free': { vision: false, contextWindow: 1_048_576, maxOutput: 131_072 },
}

/**
 * The thinking menu each live id actually accepts, keyed by exact base id.
 *
 * The upstream *validates* `reasoning_effort` and answers 400 for a value the
 * model does not declare, so a menu that is not this model's own is a control
 * that fails the turn. These sets were measured on 2026-10-18 by sending every
 * rung of `none…max` to every live free id and recording which answered 200;
 * they are deliberately not taken from a published table, because the published
 * ones are narrower than the wire (models.dev lists three rungs for
 * `deepseek-v4.1-flash-free` and `glm-5.3-flash-free`, while both accept all
 * seven).
 *
 * An id absent from this table gets the full seven-rung ladder: that is the set
 * the gateway documents, and it is what a brand-new id most likely declares.
 */
export const EFFORT_MENUS = {
  // All seven rungs answered 200 on every sample.
  'deepseek-v4.1-flash-free': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'glm-5.3-flash-free': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'mimo-v2.6-flash-free': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'longcat-2.5-preview-free': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'nemotron-3.5-super-vl-free': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  // The gateway itself names this set: "reasoning_effort must be one of
  // 'none', 'low', 'medium' or 'high'" — plus `max`, which also answered 200.
  // `minimal` and `xhigh` are refused.
  'big-pickle': ['none', 'low', 'medium', 'high', 'max'],
  // `none` is refused outright here, so the menu has no Off rung.
  'space-bunny-free': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
}

/**
 * The default rung for an id whose middle-of-menu rung is not what a user means
 * by "no preference".
 *
 * Only ids where the plain middle would be wrong are listed; everything else
 * takes the middle of its own menu (see `defaultLevelFor`).
 */
export const EFFORT_DEFAULTS = {
  // `medium` sits between "thinking off" and "maximum deliberation", which is
  // what an unanswered picker should mean.
  'deepseek-v4.1-flash-free': 'medium',
  'glm-5.3-flash-free': 'medium',
  'mimo-v2.6-flash-free': 'medium',
  'longcat-2.5-preview-free': 'medium',
  'nemotron-3.5-super-vl-free': 'medium',
  'big-pickle': 'medium',
  // No Off rung: the middle of six is `high`, but `low` is the honest default
  // for a model whose cheapest rung is already real thinking.
  'space-bunny-free': 'low',
}

/** The row every unmatched id falls back to. */
export const FALLBACK_CAPABILITY = Object.freeze({
  vision: false, reasoning: true, contextWindow: 131_072, maxOutput: 32_768,
})

/**
 * Human-facing display names, so a raw upstream id never reaches the picker.
 *
 * Every id on the live listing (2026-10) has a row here; a name the table does
 * not know would otherwise be printed as a title-cased raw id, which is why
 * `flint-40b-free` gained one. Rows for ids that have left the roster are kept:
 * this table is only ever consulted for an id the gateway actually named, so a
 * leftover row is unreachable, and deleting a name costs a picker regression if
 * the id returns.
 */
export const DISPLAY_NAMES = {
  'big-pickle': 'Big Pickle',
  'beam-free': 'Beam',
  'flint-40b-free': 'Flint 40B',
  'mimo-v2.6-flash-free': 'MiMo V2.6 Flash',
  'mimo-v2.5-free': 'MiMo V2.5',
  'muse-spark-1.3-contributor-free': 'Muse Spark 1.3',
  'muse-spark-1.2-contributor-free': 'Muse Spark 1.2',
  'nemotron-3-ultra-free': 'Nemotron 3 Ultra',
  'ling-3.0-flash-fin-free': 'Ling 3.0 Flash Fin',
  'deepseek-v4-flash-free': 'DeepSeek V4 Flash',
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
 * Kept in sync with the live listing (2026-10): exactly the free ids the listing
 * names today, minus the ones below that it lists but will not serve. A seed id
 * the lane has retired is not harmless — `buildCatalog` admits seeds without a
 * listing to check them, so a stale row is advertised in the picker and fails on
 * its first turn. `longcat-2.5-preview-free` and `space-bunny-free` were seeded
 * under an earlier roster and are not on the listing today, so they are gone;
 * `flint-40b-free` is on it and was missing.
 *
 * `jev-1.13-free` is deliberately absent even though the listing still names it:
 * measured 2026-10-18, every wire (`chat`, `responses`, `messages`) answers
 * `400 ModelProtocolUnsupported`, so it is a model the gateway lists but will not
 * serve. The probe removes it on the first round; keeping it out of the seed
 * means a fresh install never offers it in the first place.
 */
export const SEED_MODEL_IDS = [
  'big-pickle',
  'beam-free',
  'flint-40b-free',
  'mimo-v2.6-flash-free',
  'nemotron-3.5-super-vl-free',
  'nemotron-3.5-lightning-free',
  'deepseek-v4.1-flash-free',
  'glm-5.3-flash-free',
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
 *
 * An exact id in {@link FREE_ID_OVERRIDES} wins over the family patterns: it is
 * a statement about the id the lane serves now, resolved after the same
 * `baseModelId` normalisation the patterns see, so a `(level)`-suffixed id hits
 * the same row.
 *
 * @param {unknown} modelId
 * @returns {object}
 */
export function capabilitiesFor(modelId) {
  const base = baseModelId(modelId)
  const override = FREE_ID_OVERRIDES[base]
  if (override !== undefined) return { reasoning: true, ...override }
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
    const menu = EFFORT_MENUS[base]
    entries.push({
      id: base,
      name: displayModelName(base),
      wire: resolveWire(base, wireOverrides),
      vision: caps.vision === true,
      reasoning: caps.reasoning !== false,
      contextWindow: positive(caps.contextWindow) ?? FALLBACK_CAPABILITY.contextWindow,
      maxOutput: positive(caps.maxOutput) ?? FALLBACK_CAPABILITY.maxOutput,
      // An Off rung exists only where the model accepts `none`: the upstream
      // validates the value, so claiming switchable thinking on a model that
      // refuses `none` (space-bunny-free) is a menu entry that fails the turn.
      canDisableThinking: caps.canDisableThinking !== false && (menu === undefined || menu.includes('none')),
      regionSensitive: isRegionSensitive(base),
      // Absent means "not measured": `levelsFor` then offers the full ladder.
      ...menu === undefined ? {} : { efforts: [...menu] },
      ...EFFORT_DEFAULTS[base] === undefined ? {} : { effortDefault: EFFORT_DEFAULTS[base] },
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
