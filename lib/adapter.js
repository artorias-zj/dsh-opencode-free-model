/**
 * The provider adapter.
 *
 * It satisfies the harness adapter contract structurally — `registerAdapter`
 * validates by calling the methods, not by an `instanceof` test — which is what
 * lets this plugin mount on more than one kernel line without importing a
 * version-pinned adapter base class.
 *
 * Two routes are published from one adapter instance, because the harness groups
 * the model picker strictly by provider route and offers no other grouping
 * field: `opencode-free-model` carries what this egress can use right now, and
 * `opencode-free-model-region` carries what the gateway refuses on this egress. A
 * group with no models is dropped from the picker by the client, so a user whose
 * VPN unlocks the region-gated models sees one group and a user without sees the
 * second one labelled as such.
 *
 * @module lib/adapter.js
 */

import {
  applyFingerprint, baseModelId, endpointFor, mintRequestId, resolveWire, sessionForConversation,
} from './upstream.js'
import { toChatMessages, toClaudeMessages, toResponseInput, toToolDefs, repairToolPairing } from './messages.js'
import { CODE, UpstreamError, postStreamed } from './http.js'
import { finishReason, readStream, windowTokens } from './stream.js'
import { DEFAULT_LEVEL, MIN_BUDGET, budgetFor, effortsFor, resolveLevel } from './effort.js'
import { createChannel } from './channel.js'
import {
  addUsage, canRecover, checkpointFits, createBlockTracker, recoveryMessages, recoveryPolicy,
} from './recovery.js'

/** The route that carries models usable from here right now. */
export const ROUTE_MAIN = 'opencode-free-model'

/** The route that carries models this egress is refused on. */
export const ROUTE_REGION = 'opencode-free-model-region'

/** Every route this adapter serves, in picker order. */
export const ROUTES = [ROUTE_MAIN, ROUTE_REGION]

/** Group headings — the only strings the picker shows as a section title. */
export const ROUTE_LABELS = {
  [ROUTE_MAIN]: 'OpenCode Free',
  [ROUTE_REGION]: 'OpenCode Free · region-limited',
}

/** `toToolDefs` style per wire. */
const STYLE_FOR_WIRE = { chat: 'chat', responses: 'flat', messages: 'claude' }

/** The default context window for a model the catalog does not describe. */
const UNKNOWN_CONTEXT_WINDOW = 131_072

/** The default output ceiling for a model the catalog does not describe. */
const UNKNOWN_MAX_OUTPUT = 8192

/**
 * The order the model picker shows: alphabetical by the name the user reads.
 *
 * This is the one place that decides it. The kernel does not reorder — it maps
 * `listModels()` straight into the browser catalog — and the settings client has
 * no sort of its own, so the adapter's advertised order *is* the order on screen.
 *
 * Sorted on `name` rather than `id` because `name` is the string in front of the
 * user: ordering by `id` would file "DeepSeek V4 Flash" under `d`. Case is folded
 * so `MiMo` does not sort ahead of `deepseek` merely for being capitalised, and
 * `en` is pinned so the order cannot drift with the host machine's locale. Ids
 * break ties, which makes the order total and therefore stable across refreshes.
 *
 * @param {{name: string, id: string}} a
 * @param {{name: string, id: string}} b
 * @returns {number}
 */
export function compareModels(a, b) {
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true })
    || a.id.localeCompare(b.id, 'en', { sensitivity: 'base' })
}

export class OcFreeModelAdapter {
  /**
   * @param {object} dependencies
   * @param {() => {catalog: Array<object>, routes: Record<string, string[]>, settings: object, attributionUserAgent?: string, wireOverrides?: Record<string,string>}} dependencies.state
   *   one immutable snapshot of plugin state; called once per call so a catalog
   *   refresh cannot mix one generation's capacities with another's endpoints
   * @param {(ref: object) => string|undefined} [dependencies.resolveImage]
   * @param {(record: object) => void} [dependencies.recordUsage]
   * @param {(message: string) => void} [dependencies.warn]
   * @param {(modelId: string) => void} [dependencies.onRegionBlocked]
   */
  constructor(dependencies) {
    this.deps = dependencies
  }

  /**
   * @param {string} provider
   * @returns {{id: string, name: string}}
   */
  providerInfo(provider) {
    return { id: provider, name: ROUTE_LABELS[provider] ?? provider }
  }

  /**
   * A fully resolved policy, not a configuration fragment.
   *
   * The kernel stores this object verbatim instead of running it through its
   * policy resolver, and the backoff scheduler reads the delay fields off the
   * top level. Reporting them nested under `backoff` makes every scheduled delay
   * `NaN`, which the durable session log then rejects — turning a recoverable
   * transient failure into an aborted turn.
   *
   * @returns {object}
   */
  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 2,
      // A regional refusal is a property of the egress, not a transient fault;
      // retrying it only spends quota, so it is deliberately absent here. So is
      // RATE_LIMIT: this lane's 429 carries a *growing* `retry-after`, and two
      // automatic retries turned every quota wall into three walls — the same
      // turn, paid thrice, arriving later.
      retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
      initialDelayMs: 700,
      maxDelayMs: 8000,
      jitterRatio: 0.2,
    })
  }

  /**
   * The models this route advertises right now, in picker order.
   * @param {string} provider
   * @returns {Promise<Array<object>>}
   */
  async listModels(provider) {
    const state = this.deps.state()
    const ids = new Set(state.routes?.[provider] ?? [])
    return state.catalog
      .filter(entry => ids.has(entry.id))
      .map(entry => ({
        provider,
        id: entry.id,
        name: entry.name,
        description: describe(entry, state.settings),
        inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      }))
      .sort(compareModels)
  }

  /**
   * @param {string} provider
   * @param {string} model
   * @returns {Promise<object>}
   */
  async resolveModel(provider, model) {
    return this.modelInfo(provider, model, this.deps.state())
  }

  /**
   * Resolve model metadata against one frozen state snapshot.
   * @param {string} provider
   * @param {string} model
   * @param {object} snapshot
   * @returns {object}
   */
  modelInfo(provider, model, snapshot) {
    const base = baseModelId(model)
    const entry = snapshot.catalog.find(candidate => candidate.id === base)
    if (entry === undefined) {
      return {
        provider,
        id: base,
        name: base,
        context: { contextWindow: UNKNOWN_CONTEXT_WINDOW },
        defaultMaxTokens: UNKNOWN_MAX_OUTPUT,
      }
    }
    const ceiling = Math.min(entry.maxOutput, snapshot.settings?.defaultMaxTokens ?? UNKNOWN_MAX_OUTPUT)
    const efforts = effortsFor(entry, undefined, snapshot.settings?.defaultMaxTokens)
    return {
      provider,
      id: entry.id,
      name: entry.name,
      inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: ceiling,
      ...(efforts === undefined ? {} : { reasoning: { efforts, defaultEffort: DEFAULT_LEVEL } }),
    }
  }

  /**
   * Bind model metadata and the dispatch closure to one state snapshot.
   *
   * @param {string} provider
   * @param {string} model
   * @returns {Promise<{model: object, stream: (options: object) => AsyncIterable<object>}>}
   */
  async prepareCall(provider, model) {
    const snapshot = this.deps.state()
    const entry = snapshot.catalog.find(candidate => candidate.id === baseModelId(model)) ?? null
    return {
      model: this.modelInfo(provider, model, snapshot),
      stream: options => this.streamFor(options, entry, snapshot),
    }
  }

  /**
   * The abstract stream entry point, for callers that reach the adapter
   * directly rather than through `prepareCall`.
   *
   * @param {object} options - the harness `GenerateOptions`
   * @returns {AsyncIterable<object>}
   */
  stream(options) {
    const snapshot = this.deps.state()
    const entry = snapshot.catalog.find(candidate => candidate.id === baseModelId(options.model)) ?? null
    return this.streamFor(options, entry, snapshot)
  }

  /**
   * Wrap one run so that cancelling the caller's signal cancels the upstream
   * request immediately.
   *
   * A native generator queues `return()` behind a pending `next()`, so the
   * request has to be aborted before the generator is unwound.
   *
   * @param {object} options
   * @param {object|null} pinned - catalog row frozen by `prepareCall`, if any
   * @param {object} [snapshot] - state generation frozen by `prepareCall`
   * @returns {AsyncIterable<object>}
   */
  streamFor(options, pinned, snapshot = this.deps.state()) {
    const controller = new AbortController()
    const onAbort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    const iterator = this.runStream({ ...options, signal: controller.signal }, pinned, snapshot)
    const cleanup = () => options.signal?.removeEventListener('abort', onAbort)
    const step = async (method, value) => {
      try {
        const row = await iterator[method](value)
        if (row.done) cleanup()
        return row
      } catch (error) {
        cleanup()
        throw error
      }
    }
    return {
      [Symbol.asyncIterator]() {
        return this
      },
      next: value => step('next', value),
      return: value => {
        controller.abort()
        cleanup()
        return step('return', value)
      },
      throw: error => {
        controller.abort(error)
        cleanup()
        return step('throw', error)
      },
    }
  }

  /**
   * One logical turn, including at most one reasoning-checkpoint continuation.
   *
   * @param {object} options
   * @param {object|null} pinned
   * @param {object} snapshot
   * @yields {object} harness `StreamChunk`
   */
  async * runStream(options, pinned, snapshot) {
    const settings = snapshot.settings ?? {}
    const modelId = baseModelId(options.model)
    const entry = pinned ?? snapshot.catalog.find(candidate => candidate.id === modelId) ?? null

    if (settings.enabled === false) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'the OpenCode free lane is switched off in its settings', code: 'CONFIG_DISABLED' } } }
      return
    }
    if (entry === null) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: `the OpenCode free lane does not serve "${options.model}" on this egress`, code: CODE.server },
        },
      }
      return
    }

    const overrides = snapshot.wireOverrides
    const wire = resolveWire(entry.id, overrides) ?? entry.wire
    const style = STYLE_FOR_WIRE[wire]
    const warnings = []
    const resolveImage = this.deps.resolveImage
    const messages = repairToolPairing(options.messages ?? [])
    const budget = budgetFor(options.reasoningEffort, entry, options.maxTokens, settings.defaultMaxTokens)
    const declared = toToolDefs(options.tools, style)
    const policy = recoveryPolicy(settings.streamRecovery)
    const session = sessionForConversation(options.sessionId)
    const recoveryId = mintRequestId()
    const started = Date.now()
    const blocks = createBlockTracker()
    let attemptMessages = messages
    let attemptBudget = budget
    let nextIndex = 0
    let totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

    /**
     * Build one attempt's request body.
     *
     * The discarded-content warnings are collected only by the first attempt's
     * payload: checkpoint estimation and the continuation each build their own,
     * and sharing one array would accumulate `image-dropped` once per build and
     * let an already-delivered sample keep growing with later builds.
     */
    const payloadFor = (input, ceiling, recovering, sink) => {
      const payload = buildPayload(wire, entry.id, input, options, ceiling, resolveImage, sink)
      if (declared.length > 0) payload.tools = declared
      if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) {
        payload.temperature = options.temperature
      }
      // The Responses wire has no `stop` field of its own; sending one is a 400.
      if (wire !== 'responses' && Array.isArray(options.stop) && options.stop.length > 0) payload.stop = options.stop
      if (recovering) payload.tool_choice = wire === 'messages' ? { type: 'none' } : 'none'
      return payload
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (options.signal?.aborted === true) {
        if (attempt > 0) yield { type: 'usage', usage: totalUsage }
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: CODE.aborted } } }
        return
      }
      const attemptStarted = Date.now()
      const recovering = attempt === 1
      const payload = payloadFor(attemptMessages, attemptBudget, recovering, recovering ? [] : warnings)
      const renameMap = applyFingerprint(payload, wire === 'messages' ? 'claude' : wire === 'responses')
      const controller = new AbortController()
      const onAbort = () => controller.abort(options.signal?.reason)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const remainingMs = Math.max(1, policy.totalTimeoutMs - (attemptStarted - started))
      let expired = false
      const timeoutMs = recovering ? Math.min(policy.maxContinuationMs, remainingMs) : remainingMs
      const timer = policy.enabled
        ? setTimeout(() => {
            expired = true
            controller.abort()
          }, timeoutMs)
        : undefined
      timer?.unref?.()
      const channel = createChannel()
      const request = postStreamed({
        path: endpointFor(entry.id, overrides),
        body: payload,
        session,
        requestId: attempt === 0 ? recoveryId : mintRequestId(),
        attributionUserAgent: snapshot.attributionUserAgent,
        baseUrl: settings.baseUrl,
        signal: controller.signal,
        onData: value => channel.push(value),
      }).then(() => channel.push(undefined))
        .catch(error => channel.push(error instanceof Error ? error : new Error(String(error))))

      let firstDeltaAt
      let delivered = false
      let sawAnswer = false
      let usageAdded = false
      let partialOutcome
      let recorded = false
      const record = (ok, extra = {}) => {
        if (recorded) return
        recorded = true
        this.record(snapshot, entry, options, {
          at: attemptStarted,
          started,
          firstDeltaAt,
          outcome: partialOutcome,
          ok,
          recovering,
          recoveryId,
          attempt,
          warnings,
          ...extra,
        })
      }

      try {
        const reader = readStream(channel.read(), wire, renameMap, () => Date.now(), {
          startIndex: nextIndex,
          checkpointLimit: policy.checkpointLimit,
          onState: value => {
            partialOutcome = value
          },
        })
        let outcome
        try {
          while (true) {
            const row = await reader.next()
            if (row.done) {
              outcome = row.value
              break
            }
            if (options.signal?.aborted === true) throw new UpstreamError('request aborted', CODE.aborted)
            const chunk = row.value
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.trim() !== '') sawAnswer = true
            // A continuation runs with tools disabled. If the gateway ignores
            // that, the tool block must not reach the host for execution.
            if (recovering && (chunk.blockType === 'tool-call' || chunk.type === 'tool-call-delta' || chunk.block?.type === 'tool-call')) {
              throw new UpstreamError('the continuation unexpectedly requested a tool', 'STREAM_CUT')
            }
            if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
              delivered = true
              if (firstDeltaAt === undefined) firstDeltaAt = Date.now()
            }
            blocks.accept(chunk)
            yield chunk
          }
        } finally {
          await reader.return()
        }

        nextIndex = outcome.nextIndex
        totalUsage = addUsage(totalUsage, outcome.usage, outcome.sawUsage)
        usageAdded = true

        if (options.signal?.aborted === true) {
          record(false, { aborted: true })
          yield { type: 'usage', usage: totalUsage }
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: CODE.aborted } } }
          return
        }

        if (!recovering && canRecover(outcome, policy, Date.now() - started)) {
          const remainingTokens = budget - (outcome.sawUsage ? outcome.usage.outputTokens ?? 0 : 0)
          const continuationBudget = Math.min(remainingTokens, policy.maxOutputTokens)
          const continuationMessages = recoveryMessages(messages, outcome.reasoningText)
          if (continuationBudget >= MIN_BUDGET
            && checkpointFits(payloadFor(continuationMessages, continuationBudget, true, []), entry, outcome.reasoningText, continuationBudget)) {
            record(false, { truncated: true, recoveryScheduled: true })
            this.deps.warn?.('opencode-free-model: interrupted reasoning; continuing once from its checkpoint')
            attemptMessages = continuationMessages
            attemptBudget = continuationBudget
            continue
          }
        }

        const reason = outcome.brokenToolCall === true ? { kind: 'max-tokens' } : finishReason(outcome.finish)
        const failedEnding = outcome.finish === 'failed' || outcome.finish === 'cancelled'
        const normalEnding = outcome.finish === undefined || ['stop', 'end_turn', 'stop_sequence'].includes(outcome.finish)
        if (outcome.sawFinish !== true || failedEnding || (recovering && (!sawAnswer
          || outcome.sawToolCall === true || reason.kind !== 'stop' || !normalEnding))) {
          const seconds = Math.round((Date.now() - started) / 1000)
          const code = recovering || delivered || outcome.sawToolCall === true
            ? 'STREAM_CUT'
            : failedEnding ? CODE.server : CODE.transport
          const message = recovering
            ? `the continuation ended without a complete answer after ${seconds}s; automatic recovery exhausted`
            : failedEnding
              ? `the upstream response ended with status ${outcome.finish}`
              : delivered || outcome.sawToolCall === true
                ? `the gateway closed the stream after ${seconds}s, before its finish token; automatic recovery was not safe`
                : 'the gateway closed the stream before its finish token, without answering; retrying'
          record(false, { truncated: true })
          yield { type: 'usage', usage: totalUsage }
          yield { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
          return
        }

        if (outcome.sawText !== true && outcome.sawToolCall !== true && outcome.sawReasoning !== true && reason.kind === 'stop') {
          record(false)
          yield { type: 'usage', usage: totalUsage }
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'the lane returned an empty response', code: CODE.empty } } }
          return
        }

        record(true, recovering ? { recovered: reason.kind === 'stop' } : {})
        yield { type: 'usage', usage: totalUsage }
        yield { type: 'finish', reason }
        if (warnings.length > 0) {
          this.deps.warn?.(`opencode-free-model: dropped unsupported content for ${entry.id}: ${[...new Set(warnings)].join(', ')}`)
        }
        return
      } catch (error) {
        if (error?.code === CODE.region) this.deps.onRegionBlocked?.(entry.id)
        const aborted = options.signal?.aborted === true
        let failure = toFailure(error)
        if (!aborted && (recovering || expired)) {
          failure = {
            ...failure,
            code: recovering || delivered || partialOutcome?.sawToolCall === true ? 'STREAM_CUT' : CODE.timeout,
            message: expired
              ? `the lane reached its ${Math.round(timeoutMs / 1000)}s time limit before its finish token${recovering ? ', during the continuation from its checkpoint' : ''}`
              : `the continuation failed: ${failure.message}`,
          }
        }
        if (!usageAdded) totalUsage = addUsage(totalUsage, partialOutcome?.usage, partialOutcome?.sawUsage)
        record(false, {
          ...(recovering || expired ? { truncated: true } : {}),
          ...(aborted ? { aborted: true } : {}),
        })
        for (const chunk of blocks.close()) yield chunk
        if (recovering || partialOutcome?.sawUsage === true) yield { type: 'usage', usage: totalUsage }
        yield { type: 'finish', reason: { kind: aborted ? 'aborted' : 'error', failure } }
        return
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        controller.abort()
        await request
        // A consumer that abandoned the generator mid-attempt reaches here
        // without a verdict; the turn still happened, so it is still measured.
        if (!recorded) record(false, { aborted: true })
      }
    }
  }

  /** Publish one attempt's measurements, when a consumer asked for them. */
  record(snapshot, entry, options, row) {
    if (typeof this.deps.recordUsage !== 'function') return
    const usage = row.outcome?.sawUsage === true ? row.outcome.usage : undefined
    this.deps.recordUsage({
      at: row.at,
      model: entry.id,
      effort: resolveLevel(options.reasoningEffort, entry)?.id ?? '',
      ok: row.ok,
      input: usage?.inputTokens ?? 0,
      output: usage?.outputTokens ?? 0,
      reasoning: usage?.reasoningTokens ?? 0,
      cacheRead: usage?.cacheReadTokens ?? 0,
      decodeTokens: row.ok ? windowTokens(usage, row.outcome?.sawReasoning === true) : 0,
      ttftMs: row.firstDeltaAt === undefined ? undefined : row.firstDeltaAt - row.at,
      decodeMs: row.firstDeltaAt === undefined ? 0 : Date.now() - row.firstDeltaAt,
      elapsedMs: Date.now() - row.at,
      recoveryId: row.recoveryId,
      attempt: row.attempt,
      ...(row.recovering ? { recoveryAttempt: true } : {}),
      ...(row.aborted ? { aborted: true } : {}),
      ...(row.outcome?.sawUsage === true ? {} : { noUsage: true }),
      ...(row.warnings.length === 0 ? {} : { warnings: [...new Set(row.warnings)] }),
    })
  }
}

/** The system prompt the harness passed alongside the messages, if any. */
function systemText(options) {
  return typeof options?.system === 'string' && options.system !== '' ? options.system : undefined
}

/**
 * Build the request body for one wire.
 *
 * `GenerateOptions.system` is honoured on all three wires, and never twice: on
 * the chat wire it is prepended only when the projected messages carry no system
 * turn of their own, and on the other two it fills in only when nothing was
 * hoisted out of the messages. Dropping the field — which is what one wire did —
 * silently loses an operator's system prompt.
 *
 * @param {'chat'|'responses'|'messages'} wire
 * @param {string} modelId
 * @param {Array<object>} messages
 * @param {object} options
 * @param {number} budget
 * @param {((ref: object) => string|undefined)|undefined} resolveImage
 * @param {string[]|undefined} warnings
 * @returns {object}
 */
export function buildPayload(wire, modelId, messages, options, budget, resolveImage, warnings) {
  const system = systemText(options)
  if (wire === 'responses') {
    const projected = toResponseInput(messages, resolveImage, warnings)
    // An empty input list is a 400 on this wire; the placeholder keeps a
    // degenerate turn answerable instead of failing it.
    let input = projected.length > 0
      ? projected
      : [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] }]
    if (system !== undefined && !input.some(item => item.type === 'message' && item.role === 'system')) {
      input = [{ type: 'message', role: 'system', content: [{ type: 'input_text', text: system }] }, ...input]
    }
    return { model: modelId, input, stream: true, store: false, max_output_tokens: budget }
  }
  if (wire === 'messages') {
    const shaped = toClaudeMessages(messages, resolveImage, warnings)
    const hoisted = [system, shaped.system].filter(value => value !== undefined).join('\n\n')
    return {
      model: modelId,
      messages: shaped.messages,
      stream: true,
      max_tokens: budget,
      ...(hoisted === '' ? {} : { system: hoisted }),
    }
  }
  const chat = toChatMessages(messages, resolveImage, warnings)
  const hasSystemTurn = chat.some(row => row?.role === 'system')
  return {
    model: modelId,
    messages: system !== undefined && !hasSystemTurn ? [{ role: 'system', content: system }, ...chat] : chat,
    stream: true,
    max_tokens: budget,
  }
}

/**
 * Shape one thrown error into the harness's `LlmFailure` vocabulary.
 *
 * The harness writes this object straight into a durable session event, and that
 * log rejects anything that does not survive a lossless JSON round trip — an
 * Error instance, a `NaN`, an explicit `undefined` field. A rejected append
 * aborts the whole turn, so a malformed failure is strictly worse than a sparse
 * one: only whitelisted fields are carried, each validated, and each dropped
 * rather than emitted in a degraded form.
 *
 * @param {unknown} error
 * @returns {{message: string, code: string, status?: number, providerRetryAfterMs?: number}}
 */
export function toFailure(error) {
  const message = typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : String(error ?? 'the OpenCode free lane request failed')
  const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : CODE.transport
  const status = error?.status
  const retryAfter = error?.providerRetryAfterMs
  return {
    message,
    code,
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { providerRetryAfterMs: Math.trunc(retryAfter) } : {}),
  }
}

/**
 * The `/model` popup's detail line.
 *
 * The composer renders only the model name, so the capacities that matter for
 * choosing a model — modality, window, whether an effort menu exists — have to
 * fit here. A model that cannot switch its thinking off names the shared ceiling
 * outright: on that lane the rung is not only the answer's budget, and a picker
 * that implied otherwise is how "why is it cut off at 8K when my ceiling is
 * 32K" gets asked.
 *
 * @param {object} entry
 * @param {object} [settings]
 * @returns {string}
 */
export function describe(entry, settings) {
  const parts = [
    entry.vision ? 'vision + text input' : 'text input',
    `${Math.round(entry.contextWindow / 1024)}K context`,
  ]
  if (entry.reasoning === true) {
    const rung = Math.round(budgetFor(DEFAULT_LEVEL, entry, undefined, settings?.defaultMaxTokens) / 1024)
    parts.push(entry.canDisableThinking === false
      ? `thinking always on · ${rung}K default ceiling, shared with the answer`
      : 'tunable thinking budget')
  }
  return parts.join(' · ')
}
