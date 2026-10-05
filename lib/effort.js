/**
 * Reasoning-effort policy: an effort level here is a real, enforced generation
 * budget rather than a hint.
 *
 * A direct probe of this lane settled the design. The gateway *accepts*
 * `reasoning_effort`, `thinking.budget_tokens`, `enable_thinking` and
 * `thinking_budget` and then ignores all of them — three samples per spelling
 * showed `low` producing more reasoning tokens than `xhigh`, and the unknown
 * fields occasionally surfaced as an upstream 503. The single control the pooled
 * account actually enforces is `max_tokens`, and reasoning volume tracks it
 * directly (a 64-token ceiling pulled reasoning from ~397 tokens down to ~63).
 *
 * Because that ceiling is shared by thinking and the visible answer, a lower
 * level shortens both — that is the only modulation this lane offers, which is
 * why the levels are stated as token budgets rather than as vague adjectives.
 * An effort menu that does nothing would be worse to a user than no menu at all,
 * so every level declared here changes measured behaviour.
 *
 * @module lib/effort.js
 */

/** Ordered for display: the array order is the picker's order. */
export const LEVELS = [
  { id: 'light', name: 'Light', ceiling: 2048, hint: 'terse deliberation, the fastest answer here.' },
  { id: 'balanced', name: 'Balanced', ceiling: 8192, hint: 'enough to reason through a normal turn.' },
  { id: 'deep', name: 'Deep', ceiling: undefined, hint: "the model's full output capacity, extended deliberation." },
]

/** The level a caller gets when it named none. */
export const DEFAULT_LEVEL = 'balanced'

/**
 * Rungs of a model that must think are widened by this factor.
 *
 * Such a model pays for thinking out of the same ceiling before the answer
 * starts, so one rung then leaves the answer about as much room as it has on a
 * model that can think nothing at all. Measured live on `mimo-v2.6-flash-free`
 * over the 92 calls of one day: 82% of the output tokens were reasoning, so the
 * un-doubled 8192 ceiling left roughly 1500 for the answer and a long turn ended
 * in `length` about every third request.
 */
export const ALWAYS_THINKING_FACTOR = 2

/** Below this the answer itself cannot land, so no level is allowed to go. */
export const MIN_BUDGET = 512

/** Does this model expose an effort menu at all? */
export function supportsEffort(model) {
  return model?.reasoning === true
}

/**
 * The rung in force for one call, resolved the same way for the budget sent
 * upstream and the effort recorded against it.
 *
 * A model with no effort menu has no rung: its whole output window belongs to
 * the answer, and a level inherited from elsewhere must not shrink it. A model
 * with a menu that the caller did not answer with a level still gets the menu's
 * default.
 *
 * @param {string|undefined} level
 * @param {object|undefined} model - catalog entry
 * @returns {object|undefined} the declared level, or `undefined` when none applies
 */
export function resolveLevel(level, model) {
  if (!supportsEffort(model)) return undefined
  return LEVELS.find(candidate => candidate.id === level) ?? LEVELS.find(candidate => candidate.id === DEFAULT_LEVEL)
}

/** The ceiling one rung carries on one model, before capacity is applied. */
function ceilingOf(entry, model) {
  if (entry === undefined || entry.ceiling === undefined) return undefined
  return model?.canDisableThinking === false ? entry.ceiling * ALWAYS_THINKING_FACTOR : entry.ceiling
}

/** A caller-supplied token ceiling, or "none" when it is not a positive number. */
function usableTokens(value) {
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY
}

/**
 * Resolve the generation ceiling for one level against one model.
 *
 * The level ceiling is the controlling term; the model's own capacity and the
 * session's request can only lower it further, never raise it. A level with no
 * ceiling inherits the model capacity, which is why `Deep` is the top row.
 *
 * @param {string|undefined} level - the effort id the harness selected
 * @param {object|undefined} model - catalog entry, supplying `maxOutput`
 * @param {number|undefined} requested - the session's `maxTokens`, when set
 * @param {number|undefined} fallback - the plugin default ceiling
 * @returns {number} tokens
 */
export function budgetFor(level, model, requested, fallback) {
  // A ceiling that is not a positive number is *no* ceiling. Without this, a
  // cleared settings input — `Number('') || 0` — would reach the wire as
  // `min(model capacity, 0)` and clamp every turn of every model to MIN_BUDGET.
  const capacity = Math.min(
    model?.maxOutput ?? 32768,
    usableTokens(requested),
    usableTokens(fallback),
  )
  const ceiling = ceilingOf(resolveLevel(level, model), model)
  if (ceiling === undefined) return Math.max(MIN_BUDGET, Math.trunc(capacity))
  return Math.max(MIN_BUDGET, Math.trunc(Math.min(ceiling, capacity)))
}

/**
 * The whole ladder as it applies to one model right now.
 *
 * @param {object|undefined} model
 * @param {number|undefined} requested
 * @param {number|undefined} fallback
 * @returns {Array<{id: string, name: string, tokens: number, isDefault: boolean}>}
 */
export function budgetLadder(model, requested, fallback) {
  return LEVELS.map(entry => ({
    id: entry.id,
    name: entry.name,
    tokens: budgetFor(entry.id, model, requested, fallback),
    isDefault: entry.id === DEFAULT_LEVEL,
  }))
}

/** 16384 -> `16 K`, the spelling the settings surface uses. */
function kilos(tokens) {
  return `${Math.round(tokens / 1024)} K`
}

/**
 * The declared effort list for one model, in picker order.
 *
 * The description is generated from the same `budgetFor` call that will decide
 * the request, not written next to it: a rung that advertises 8K while the
 * plugin sends 16 384 on a thinking-always-on model is a number the user reads
 * and the wire does not honour.
 *
 * @param {object|undefined} model
 * @param {number|undefined} requested
 * @param {number|undefined} fallback
 * @returns {Array<{id: string, name: string, description: string}>|undefined}
 */
export function effortsFor(model, requested, fallback) {
  if (!supportsEffort(model)) return undefined
  return budgetLadder(model, requested, fallback).map(row => ({
    id: row.id,
    name: row.name,
    description: `${kilos(row.tokens)} output ceiling, shared by thinking and the answer`
      + (model.canDisableThinking === false ? ' (thinking cannot be switched off on this model)' : '')
      + `: ${LEVELS.find(level => level.id === row.id)?.hint ?? ''}`,
  }))
}
