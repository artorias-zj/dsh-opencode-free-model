/**
 * Reasoning-effort policy: the level IS the control on this lane.
 *
 * ## What changed, and why this module was rewritten
 *
 * The original design was built on a probe that concluded the gateway accepted
 * `reasoning_effort` and then ignored it, leaving `max_tokens` as the only real
 * control — so an effort level here was implemented as an enforced output-token
 * budget. A re-probe on 2026-10-18 shows that conclusion no longer holds:
 *
 * - The gateway **validates** the field. An undeclared value answers 400 and
 *   names the accepted set, e.g. `literal['none','minimal','low','medium',
 *   'high','xhigh','max']` on `deepseek-v4.1-flash-free`, and
 *   `reasoning_effort: Invalid option: expected one of …` on the Nemotron ids.
 * - The level **moves reasoning volume**, measured with `max_tokens` pinned at
 *   8192 and three samples per rung (median reasoning tokens):
 *   none 0, low 793, medium ~900, high ~1000, xhigh ~1600, max ~2000 on
 *   `deepseek-v4.1-flash-free`; none 0 → max 1013 on `big-pickle`;
 *   none 7 → max 6135 on `glm-5.3-flash-free`.
 *
 * Keeping the old ladder would not merely be suboptimal, it is actively broken:
 * a 2048 ceiling now truncates the turn *before the answer starts*, because the
 * reasoning is no longer bounded by `max_tokens`. Measured on
 * `deepseek-v4.1-flash-free` with our old `light` rung: `finish=length`, 4807
 * characters of reasoning, **0 characters of answer**.
 *
 * So an effort id here is the upstream's own level name, sent verbatim as
 * `reasoning_effort`, and the token ceiling is a separate concern that no longer
 * varies with the level (see {@link budgetFor}).
 *
 * ## The menu is per model, because the accepted sets differ
 *
 * Measured 2026-10-18 by sending every rung to every live free id:
 *
 * | model | accepted |
 * |---|---|
 * | `deepseek-v4.1-flash-free` | `none…max` (all seven) |
 * | `glm-5.3-flash-free` | `none…max` (all seven) |
 * | `mimo-v2.6-flash-free` | `none…max` |
 * | `longcat-2.5-preview-free` | `none…max` |
 * | `nemotron-3.5-super-vl-free` | `none…max` |
 * | `big-pickle` | `none`, `low`, `medium`, `high`, `max` — no `minimal`, no `xhigh` |
 * | `space-bunny-free` | `minimal…max` — **`none` is rejected** |
 * | `jev-1.13-free` | none: every wire answers `ModelProtocolUnsupported` |
 *
 * A model whose set is unknown (a new id the listing just introduced) gets the
 * full seven-rung ladder, because that is the union the gateway documents, and a
 * rejected rung is a 400 the user can retry rather than a silently missing menu.
 *
 * @module lib/effort.js
 */

/** Every level the lane recognises, in the picker's order (cheapest first). */
export const LEVELS = [
  { id: 'none', name: 'Off', hint: 'thinking switched off; the answer alone.' },
  { id: 'minimal', name: 'Minimal', hint: 'the smallest amount of deliberation.' },
  { id: 'low', name: 'Low', hint: 'terse deliberation, the fastest thinking answer.' },
  { id: 'medium', name: 'Medium', hint: 'enough to reason through a normal turn.' },
  { id: 'high', name: 'High', hint: 'deeper deliberation for multi-step work.' },
  { id: 'xhigh', name: 'Extra High', hint: 'extended deliberation; slower and more expensive.' },
  { id: 'max', name: "Max", hint: 'the most deliberation this model offers.' },
]

/** Every level id, in order. */
export const LEVEL_IDS = LEVELS.map(level => level.id)

/**
 * The rung a caller gets when it named none and the model declared no default.
 *
 * `medium` rather than the cheapest rung: the harness requires a `defaultEffort`
 * that exists in the menu, and silently answering with thinking switched off
 * would change the character of a turn the user never asked to change.
 */
export const DEFAULT_LEVEL = 'medium'

/** Below this the answer itself cannot land, so the ceiling is never lowered past it. */
export const MIN_BUDGET = 512

/** Does this model expose an effort menu at all? */
export function supportsEffort(model) {
  return model?.reasoning === true
}

/**
 * The rungs this model actually accepts, in picker order.
 *
 * @param {object|undefined} model - catalog entry, optionally carrying `efforts`
 * @returns {Array<object>}
 */
export function levelsFor(model) {
  const declared = Array.isArray(model?.efforts) ? model.efforts : undefined
  if (declared === undefined || declared.length === 0) return LEVELS
  // Keep the canonical order, but only the rungs this model accepts: the
  // upstream validates the value, so offering a rung it refuses is a 400.
  return LEVELS.filter(level => declared.includes(level.id))
}

/**
 * The level a caller gets when it named none.
 *
 * The model's own declared default wins when it names one that is actually in
 * its menu; otherwise the middle rung of that model's menu, which keeps "no
 * preference" meaning "neither switched off nor maximal" on models that have no
 * `none` or no `max`.
 *
 * @param {object|undefined} model
 * @returns {string}
 */
export function defaultLevelFor(model) {
  const levels = levelsFor(model)
  if (levels.length === 0) return DEFAULT_LEVEL
  const declared = model?.effortDefault
  if (typeof declared === 'string' && levels.some(level => level.id === declared)) return declared
  if (levels.some(level => level.id === DEFAULT_LEVEL)) return DEFAULT_LEVEL
  return levels[Math.floor(levels.length / 2)].id
}

/**
 * The level in force for one call.
 *
 * A level the model does not accept is not forwarded: the upstream validates the
 * value and would answer 400, so an unsupported request falls back to the
 * model's default instead of failing the turn. A model with no effort menu has no
 * level at all, and `undefined` is what keeps `reasoning_effort` off the wire.
 *
 * @param {string|undefined} level - the effort id the harness selected
 * @param {object|undefined} model - catalog entry
 * @returns {object|undefined} the resolved level, or `undefined` when none applies
 */
export function resolveLevel(level, model) {
  if (!supportsEffort(model)) return undefined
  const levels = levelsFor(model)
  if (levels.length === 0) return undefined
  const wanted = typeof level === 'string' ? level.trim().toLowerCase() : ''
  return levels.find(candidate => candidate.id === wanted)
    ?? levels.find(candidate => candidate.id === defaultLevelFor(model))
    ?? levels[0]
}

/**
 * The generation ceiling for one call.
 *
 * This is no longer a function of the level. The level rides the wire as
 * `reasoning_effort` and is enforced there, so the ceiling only has to be big
 * enough to hold thinking *and* answer — deriving it from the level was what
 * truncated turns at 2048. The model's capacity and the caller's own `maxTokens`
 * can still lower it; nothing raises it above the model.
 *
 * @param {string|undefined} _level - kept for call-site compatibility; unused
 * @param {object|undefined} model - catalog entry, supplying `maxOutput`
 * @param {number|undefined} requested - the session's `maxTokens`, when set
 * @param {number|undefined} fallback - the plugin default ceiling
 * @returns {number} tokens
 */
export function budgetFor(_level, model, requested, fallback) {
  // A ceiling that is not a positive number is *no* ceiling. Without this, a
  // cleared settings input — `Number('') || 0` — would reach the wire as
  // `min(model capacity, 0)` and clamp every turn of every model to MIN_BUDGET.
  const capacity = Math.min(
    model?.maxOutput ?? 32768,
    usableTokens(requested),
    usableTokens(fallback),
  )
  return Math.max(MIN_BUDGET, Math.trunc(capacity))
}

/** A caller-supplied token ceiling, or "none" when it is not a positive number. */
function usableTokens(value) {
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY
}

/**
 * The request-body patch one level turns into.
 *
 * The free lane's control is the plain `reasoning_effort` field — not a nested
 * `thinking.*` object and not a budget — so this is the whole patch. `undefined`
 * means "send nothing", which is what a model with no menu gets.
 *
 * @param {string|undefined} level
 * @param {object|undefined} model
 * @returns {object|undefined}
 */
export function effortPatchFor(level, model) {
  const resolved = resolveLevel(level, model)
  if (resolved === undefined) return undefined
  return { reasoning_effort: resolved.id }
}

/**
 * The declared effort list for one model, in picker order.
 *
 * Each rung's description states what the level does on the wire, which is the
 * only claim this lane can make: the ceiling is shared and fixed, so advertising
 * a per-rung token count here would be a number the wire does not honour.
 *
 * @param {object|undefined} model
 * @returns {Array<{id: string, name: string, description: string}>|undefined}
 */
export function effortsFor(model) {
  if (!supportsEffort(model)) return undefined
  const levels = levelsFor(model)
  if (levels.length === 0) return undefined
  return levels.map(level => ({
    id: level.id,
    name: level.name,
    description: `${level.hint} Sent to the gateway as reasoning_effort.`,
  }))
}
