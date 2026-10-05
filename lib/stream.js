/**
 * Provider SSE -> harness `StreamChunk` projection, for all three wire shapes
 * this lane answers on.
 *
 * The harness contract is a flat, indexed block protocol: every block is opened
 * with `block-start`, fed with deltas, and closed with `block-end` carrying the
 * assembled block. Block indices are allocated in arrival order, which is what
 * the provider does with reasoning-then-text on this lane anyway.
 *
 * The three shapes are not variations of one API, so each gets its own feeder:
 *
 * | wire        | provider events                                              |
 * | ----------- | ------------------------------------------------------------ |
 * | `chat`      | OpenAI Chat Completions `choices[].delta`                     |
 * | `responses` | OpenAI Responses `response.output_text.delta` & friends       |
 * | `messages`  | Anthropic Messages `content_block_delta` & friends            |
 *
 * Token accounting follows the harness's disjoint-count rule: `inputTokens` is
 * uncached input only, so the provider's prompt total has its cache hits
 * subtracted back out.
 *
 * @module lib/stream.js
 */

import crypto from 'node:crypto'
import { classifyFailure } from './http.js'
import { restoreToolName } from './upstream.js'

/** The wire names this decoder understands. */
export const WIRES = ['chat', 'responses', 'messages']

/** Mint a tool-call id for providers that stream arguments without one. */
function mintToolCallId() {
  return `call_${crypto.randomBytes(12).toString('hex')}`
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Turn one provider `usage` object into the harness's disjoint `TokenUsage`.
 *
 * `prompt_tokens_details` is optional in the OpenAI schema, and the harness's
 * durable session log rejects a non-finite number outright — so an absent cache
 * count has to default to zero before the subtraction, not after it. Reading
 * `undefined` off the optional field turned `inputTokens` into `NaN`, which any
 * gateway omitting the details block would hand the kernel on every call.
 *
 * @param {object|undefined} usage
 * @returns {object|undefined}
 */
export function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const prompt = number(usage.prompt_tokens ?? usage.input_tokens)
  const completion = number(usage.completion_tokens ?? usage.output_tokens)
  const cached = number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens) ?? 0
  const cacheWrite = number(usage.prompt_tokens_details?.cache_write_tokens)
  const reasoning = number(
    usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens,
  )
  if (prompt === undefined && completion === undefined) return undefined
  const out = {
    inputTokens: Math.max(0, (prompt ?? 0) - cached),
    outputTokens: completion ?? 0,
  }
  if (cached > 0) out.cacheReadTokens = cached
  if (cacheWrite > 0) out.cacheWriteTokens = cacheWrite
  if (reasoning > 0) out.reasoningTokens = reasoning
  out.totalTokens = (prompt ?? 0) + (completion ?? 0)
  return out
}

/**
 * Map a provider finish token onto the harness finish reason.
 * @param {string|undefined} token
 * @returns {{kind: 'stop'|'tool-calls'|'max-tokens'}}
 */
export function finishReason(token) {
  if (token === 'tool_calls' || token === 'tool_use' || token === 'function_call') return { kind: 'tool-calls' }
  if (token === 'length' || token === 'max_tokens' || token === 'max_output_tokens' || token === 'incomplete') {
    return { kind: 'max-tokens' }
  }
  return { kind: 'stop' }
}

/**
 * Output tokens that can honestly be divided by a measured decode window.
 *
 * Some models on this lane are billed for reasoning they never stream: measured
 * live, one call reported 422 output tokens of which 291 were reasoning, while
 * zero reasoning frames arrived. Those 291 were produced before the first frame
 * the window starts at, so counting them attributes a whole thinking phase to
 * the seconds the answer text took. When reasoning did stream, the window covers
 * it and the full count is the right numerator.
 *
 * @param {object|undefined} usage
 * @param {boolean} sawReasoning
 * @returns {number}
 */
export function windowTokens(usage, sawReasoning) {
  const output = number(usage?.outputTokens) ?? 0
  if (sawReasoning) return output
  return Math.max(0, output - (number(usage?.reasoningTokens) ?? 0))
}

/**
 * Accumulates wire deltas into harness blocks and emits `StreamChunk`s.
 *
 * Emission is synchronous inside one parsed payload; the caller drains its
 * outbox after each frame, so the generator needs no racing or polling to keep
 * deltas flowing.
 */
export class BlockSink {
  /**
   * @param {(chunk: object) => void} emit - receives chunks in order
   * @param {number} [startIndex] - first block index to allocate
   * @param {number} [checkpointLimit] - max characters retained as reasoning checkpoint
   */
  constructor(emit, startIndex = 0, checkpointLimit = 131_072) {
    this.emit = emit
    this.next = startIndex
    /** @type {Map<string, {index:number, kind:string, text:string, id:string, name:string, args:string}>} */
    this.open = new Map()
    this.usage = undefined
    this.sawText = false
    this.sawReasoning = false
    this.sawToolCall = false
    this.reasoningText = ''
    this.checkpointLimit = checkpointLimit
    this.checkpointTruncated = false
    this.brokenToolCall = false
    this.lastToolKey = undefined
  }

  /**
   * Resolve the block a Chat tool delta belongs to.
   *
   * `tool_calls[].index` is the wire's accumulator key and is what real servers
   * send; keying calls without one to a constant merged every parallel call into
   * a single block with the ids overwriting each other. The call id — present on
   * exactly the shapes that omit the index — separates them, and a bare
   * arguments continuation continues the call in front of it.
   */
  toolKey(call) {
    if (call.index !== undefined && call.index !== null) {
      this.lastToolKey = `c${call.index}`
      return this.lastToolKey
    }
    if (typeof call.id === 'string' && call.id !== '') {
      for (const [key, block] of this.open) {
        if (block.kind === 'tool-call' && block.id === call.id) {
          this.lastToolKey = key
          return key
        }
      }
      this.lastToolKey = `cid:${call.id}`
      return this.lastToolKey
    }
    return this.lastToolKey ?? 'c0'
  }

  /** Open, or fetch, the block a given stream slot maps to. */
  slot(key, kind) {
    if (kind === 'tool-call') this.sawToolCall = true
    const existing = this.open.get(key)
    if (existing !== undefined) return existing
    // A tool call without a provider id would come back next turn with an empty
    // toolCallId, which the pairing repair then drops on both sides — the model
    // never sees its own result and re-issues the call forever. Mint a stable
    // stand-in; a provider id arriving later still overrides it.
    const block = {
      index: this.next++,
      kind,
      text: '',
      args: '',
      id: kind === 'tool-call' ? mintToolCallId() : '',
      name: '',
    }
    this.open.set(key, block)
    this.emit({
      type: 'block-start',
      index: block.index,
      blockType: kind === 'tool-call' ? 'tool-call' : kind === 'reasoning' ? 'reasoning' : 'text',
    })
    return block
  }

  text(key, delta) {
    if (delta === undefined || delta === null || delta === '') return
    this.sawText = true
    const block = this.slot(key, 'text')
    block.text += delta
    this.emit({ type: 'text-delta', index: block.index, text: delta })
  }

  reasoning(key, delta) {
    if (delta === undefined || delta === null || delta === '') return
    this.sawReasoning = true
    const text = String(delta)
    const remaining = this.checkpointLimit - this.reasoningText.length
    if (text.length > remaining) this.checkpointTruncated = true
    this.reasoningText += text.slice(0, Math.max(0, remaining))
    const block = this.slot(key, 'reasoning')
    block.text += delta
    this.emit({ type: 'reasoning-delta', index: block.index, text: delta })
  }

  toolStart(key, id, name) {
    const block = this.slot(key, 'tool-call')
    if (id) block.id = id
    if (name) block.name = name
  }

  toolArgs(key, delta) {
    this.sawToolCall = true
    if (!delta) return
    const block = this.slot(key, 'tool-call')
    block.args += delta
    this.emit({
      type: 'tool-call-delta',
      index: block.index,
      id: block.id,
      name: block.name === '' ? undefined : block.name,
      argumentsDelta: delta,
    })
  }

  /** Close every open block, in allocation order. */
  closeAll() {
    for (const block of this.open.values()) {
      if (block.kind === 'text') {
        if (block.text !== '') this.emit({ type: 'block-end', index: block.index, block: { type: 'text', text: block.text } })
      } else if (block.kind === 'reasoning') {
        if (block.text !== '') {
          this.emit({ type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } })
        }
      } else {
        // Arguments that never parse are an unexecutable call. The gateway
        // reports finish `tool_calls` even when the output ceiling cut the JSON
        // mid-string, so the finish token alone cannot be trusted; the adapter
        // downgrades such a turn to `max-tokens`, which makes the harness's
        // assembler prune the call instead of executing it and looping on the
        // model's retry.
        try {
          JSON.parse(block.args === '' ? '{}' : block.args)
        } catch {
          this.brokenToolCall = true
        }
        this.emit({
          type: 'block-end',
          index: block.index,
          block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.args === '' ? '{}' : block.args },
        })
      }
    }
    this.open.clear()
  }

  /** The accumulated outcome, without consuming it. */
  snapshot() {
    return {
      usage: this.usage,
      finish: this.finish,
      sawFinish: this.sawFinish,
      sawUsage: this.sawUsage,
      sawText: this.sawText,
      sawReasoning: this.sawReasoning,
      sawToolCall: this.sawToolCall,
      firstDeltaAt: this.firstDeltaAt,
      nextIndex: this.next,
      reasoningText: this.reasoningText,
      checkpointTruncated: this.checkpointTruncated,
      brokenToolCall: this.brokenToolCall,
    }
  }
}

/**
 * Consume one parsed Chat Completions payload.
 * @param {BlockSink} sink
 * @param {object} payload
 * @param {Map<string,string>|undefined} renameMap
 * @param {(usage: object|undefined, kind: 'usage'|'finish', token?: string) => void} onFinish
 */
export function feedChat(sink, payload, renameMap, onFinish) {
  if (payload.usage) onFinish(mapUsage(payload.usage), 'usage')
  for (const choice of payload.choices ?? []) {
    const delta = choice.delta ?? {}
    // Two spellings of the same thing are both in the wild: a plain string, and
    // a `reasoning_details` array. Reading only the first drops every thinking
    // frame from providers that use the second.
    if (typeof delta.reasoning === 'string') sink.reasoning('r', delta.reasoning)
    else if (Array.isArray(delta.reasoning_details)) {
      for (const part of delta.reasoning_details) if (typeof part?.text === 'string') sink.reasoning('r', part.text)
    }
    if (typeof delta.content === 'string') sink.text('t', delta.content)
    for (const call of delta.tool_calls ?? []) {
      sink.sawToolCall = true
      const key = sink.toolKey(call)
      const name = call.function?.name
      if (typeof name === 'string' && name !== '') sink.toolStart(key, call.id ?? '', restoreToolName(name, renameMap))
      else if (call.id) sink.toolStart(key, call.id, '')
      if (call.function?.arguments) sink.toolArgs(key, call.function.arguments)
    }
    if (choice.finish_reason) onFinish(undefined, 'finish', choice.finish_reason)
  }
}

/**
 * Consume one parsed Anthropic Messages SSE event.
 * @param {BlockSink} sink
 * @param {object} event
 * @param {Map<string,string>|undefined} renameMap
 * @param {(usage: object|undefined, kind: 'usage'|'finish', token?: string) => void} onFinish
 */
export function feedMessages(sink, event, renameMap, onFinish) {
  switch (event.type) {
    case 'content_block_start': {
      const block = event.content_block
      if (block?.type === 'tool_use') {
        sink.toolStart(`b${event.index}`, block.id ?? '', restoreToolName(block.name ?? '', renameMap))
      }
      return
    }
    case 'content_block_delta': {
      const part = event.delta
      if (part?.type === 'text_delta') sink.text(`b${event.index}`, part.text)
      else if (part?.type === 'thinking_delta') sink.reasoning(`b${event.index}`, part.thinking)
      else if (part?.type === 'input_json_delta') sink.toolArgs(`b${event.index}`, part.partial_json)
      return
    }
    case 'message_start': {
      const usage = event.message?.usage
      if (usage) {
        const mapped = mapUsage({
          prompt_tokens: number(usage.input_tokens),
          completion_tokens: number(usage.output_tokens),
          prompt_tokens_details: {
            cached_tokens: number(usage.cache_read_input_tokens),
            cache_write_tokens: number(usage.cache_creation_input_tokens),
          },
        })
        if (mapped) onFinish(mapped, 'usage')
      }
      return
    }
    case 'message_delta': {
      const usage = event.usage
      if (usage && number(usage.output_tokens) !== undefined) {
        onFinish({ outputTokens: number(usage.output_tokens) }, 'usage')
      }
      const stop = event.delta?.stop_reason
      if (stop) onFinish(undefined, 'finish', stop)
      return
    }
    // `message_stop` is this wire's own end-of-turn frame. A stream that carried
    // it was closed on purpose, so it must not be read as a cut one even in the
    // rare case where the `stop_reason` frame was the one that went missing.
    case 'message_stop':
      onFinish(undefined, 'finish', undefined)
      return
    default:
  }
}

/**
 * Consume one parsed OpenAI Responses SSE event.
 * @param {BlockSink} sink
 * @param {object} event
 * @param {Map<string,string>|undefined} renameMap
 * @param {(usage: object|undefined, kind: 'usage'|'finish', token?: string) => void} onFinish
 */
export function feedResponses(sink, event, renameMap, onFinish) {
  switch (event.type) {
    case 'response.output_item.added': {
      const item = event.item
      if (item?.type === 'function_call') {
        sink.toolStart(
          `i${event.output_index}`,
          item.call_id ?? item.id ?? '',
          restoreToolName(item.name ?? '', renameMap),
        )
      }
      return
    }
    case 'response.output_text.delta':
      sink.text(`t${event.output_index}`, event.delta)
      return
    case 'response.reasoning_summary_text.delta':
    case 'response.output_reasoning.text.delta':
      sink.reasoning(`r${event.item_id ?? 'r'}`, event.delta)
      return
    case 'response.function_call_arguments.delta':
      sink.toolArgs(`i${event.output_index}`, event.delta)
      return
    // Every deliberate ending this wire has, not only the happy one. Reading
    // just `response.completed` as terminal made `response.incomplete` — the
    // frame a turn that hit the output ceiling ends on — look like a stream the
    // gateway cut, so a finished turn got retried and then failed. The status
    // still decides the finish token, so each ending maps to its own reason; a
    // bare sentinel frame carries none and only marks the end.
    case 'response.completed':
    case 'response.incomplete':
    case 'response.failed':
    case 'response.done': {
      const response = event.response
      if (response?.usage) {
        const mapped = mapUsage({
          prompt_tokens: number(response.usage.input_tokens),
          completion_tokens: number(response.usage.output_tokens),
          prompt_tokens_details: { cached_tokens: number(response.usage.input_tokens_details?.cached_tokens) },
          completion_tokens_details: { reasoning_tokens: number(response.usage.output_tokens_details?.reasoning_tokens) },
        })
        if (mapped) onFinish(mapped, 'usage')
      }
      const status = response?.status ?? (event.type === 'response.failed'
        ? 'failed'
        : event.type === 'response.incomplete'
          ? 'incomplete'
          : event.type === 'response.completed' ? 'completed' : undefined)
      const incomplete = response?.incomplete_details?.reason
      onFinish(
        undefined,
        'finish',
        incomplete === 'max_output_tokens' ? 'length' : status === 'completed' ? 'stop' : status,
      )
      return
    }
    default:
  }
}

/** Feeders by wire name. */
const FEEDERS = { chat: feedChat, messages: feedMessages, responses: feedResponses }

/** Does this payload carry a first token, for the decode-window start? */
export function carriesDelta(payload, wire) {
  if (wire === 'chat') {
    return (payload.choices ?? []).some(choice => {
      const delta = choice.delta ?? {}
      return (typeof delta.content === 'string' && delta.content !== '')
        || (typeof delta.reasoning === 'string' && delta.reasoning !== '')
        || (Array.isArray(delta.reasoning_details)
          && delta.reasoning_details.some(part => typeof part?.text === 'string' && part.text !== ''))
        || (delta.tool_calls ?? []).length > 0
    })
  }
  if (wire === 'responses') {
    return (typeof payload.delta === 'string' && payload.delta !== '') || payload.type === 'response.output_item.added'
  }
  return payload.type === 'content_block_delta' || payload.type === 'content_block_start'
}

/**
 * Read one streamed response, yielding harness chunks as they are produced.
 *
 * An in-stream refusal is classified exactly as an error *envelope* would be,
 * because everything downstream routes on `code`: reporting it as `TRANSPORT`
 * (a retryable code) would re-send a turn whose partial answer had already been
 * streamed, and a mid-turn geography refusal would never reach the re-probe that
 * watches for `REGION_BLOCKED`.
 *
 * @param {AsyncIterable<string>} lines - decoded `data:` payloads
 * @param {'chat'|'responses'|'messages'} wire
 * @param {Map<string, string>} [renameMap] - fingerprint spelling -> caller spelling
 * @param {() => number} [now] - clock stamping the first delivered delta
 * @param {object} [options]
 * @param {number} [options.startIndex=0] - first block index to allocate
 * @param {number} [options.checkpointLimit=131072] - reasoning checkpoint cap
 * @param {(snapshot: object) => void} [options.onState] - publishes progress
 * @yields {object} harness StreamChunk
 * @returns {Promise<object>} the final snapshot
 */
export async function* readStream(lines, wire, renameMap = new Map(), now = () => Date.now(), options = {}) {
  if (!WIRES.includes(wire)) throw new Error(`opencode-free-model: unknown wire "${wire}"`)
  const outbox = []
  const startIndex = Number.isSafeInteger(options?.startIndex) && options.startIndex >= 0 ? options.startIndex : 0
  const checkpointLimit = Number.isSafeInteger(options?.checkpointLimit) && options.checkpointLimit >= 0
    ? options.checkpointLimit
    : 131_072
  const sink = new BlockSink(chunk => outbox.push(chunk), startIndex, checkpointLimit)
  const feed = FEEDERS[wire]
  const state = {
    usage: undefined,
    finish: undefined,
    sawFinish: false,
    sawUsage: false,
    sawToolCall: false,
    sawText: false,
    sawReasoning: false,
    firstDeltaAt: undefined,
  }
  const snapshot = () => ({
    ...sink.snapshot(),
    usage: state.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    finish: state.finish,
    sawFinish: state.sawFinish,
    sawUsage: state.sawUsage,
    firstDeltaAt: state.firstDeltaAt,
  })
  const publish = () => {
    if (typeof options?.onState === 'function') options.onState(snapshot())
  }

  const onFinish = (usage, kind, token) => {
    if (kind === 'usage' && usage !== undefined) {
      state.sawUsage = true
      const carried = state.usage
      // A usage report that names no input side is `message_delta` on the
      // Messages wire: it carries only the output count, and taking it whole
      // dropped the prompt counts `message_start` had already given for every
      // turn on that wire.
      state.usage = carried !== undefined && usage.inputTokens === undefined
        ? {
            ...carried,
            ...usage,
            totalTokens: Math.max(0, (carried.totalTokens ?? 0) - (carried.outputTokens ?? 0)) + (usage.outputTokens ?? 0),
          }
        : usage
    }
    // Which frame said so, not what it said: a stream that reached any of the
    // three wires' terminal events was closed by the model running out, while
    // one that never did was closed by something else, and only the second is a
    // fault.
    if (kind !== 'finish') return
    state.sawFinish = true
    // A terminal frame that names no reason (`message_stop`, a `response.done`
    // carrying no response) marks the end but must not erase the finish token a
    // status-carrying frame already gave — losing it turned `length` into
    // `stop`.
    if (token !== undefined) state.finish = token
  }

  try {
    for await (const raw of lines) {
      if (typeof raw !== 'string') continue
      const text = raw.trim()
      if (!text.startsWith('{')) continue
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        continue
      }
      if (payload.type === 'error' || payload.error) {
        const failure = payload.error ?? payload
        const classified = classifyFailure(undefined, payload)
        if (typeof failure.message !== 'string') classified.message = 'upstream error'
        throw Object.assign(classified, { upstream: payload })
      }
      if (state.firstDeltaAt === undefined && carriesDelta(payload, wire)) state.firstDeltaAt = now()
      feed(sink, payload, renameMap, onFinish)
      publish()
      while (outbox.length > 0) yield outbox.shift()
    }

    sink.closeAll()
    publish()
    while (outbox.length > 0) yield outbox.shift()
    return snapshot()
  } catch (error) {
    publish()
    throw error
  }
}
