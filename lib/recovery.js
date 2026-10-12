/**
 * Reasoning-checkpoint continuation.
 *
 * A turn on this lane can be cut off after a long thinking phase and before any
 * visible answer: the transport closes, no finish token arrives, and everything
 * the model produced is reasoning. Re-sending the whole request is expensive and
 * usually repeats the same thinking, so instead the checkpoint is summarised
 * back as one instruction and the model is asked to deliver the answer it had
 * already reasoned toward — with tools disabled, because a continuation that
 * starts calling tools is a different turn.
 *
 * @module lib/recovery.js
 */

/** Hard upper bounds; a configured value can only lower them.
 *
 *  总时限是「整轮墙钟」的兜底，不是防挂死的唯一手段：传输层对「无字节」另有
 *  空闲截止（http.js readSse 的 timeoutMs，每个 chunk 都会重置），所以真正被
 *  墙钟砍掉的只有「一直在出帧、但整体很慢」的回合。上游 2026-10-05 的 issue
 *  #69/#70 实测的正是这一类：上游号池饱和时首字 34–220s、深度思考 6 分钟以上，
 *  8 分钟的总窗会稳定砍掉正常长回合；15 分钟的窗在后续实测里仍会在「首段 +
 *  续写段」合计超 7 分钟的回合上失手，于是放宽到 30 分钟。续写段不再单设更小
 *  的窗：它的截止取「总窗减去已耗部分」，总窗是这一轮唯一的墙钟上限。数值仍
 *  只允许向下调整，有界语义不变。 */
export const RECOVERY_DEFAULTS = Object.freeze({
  maxContinuationMs: 1_800_000,
  totalTimeoutMs: 1_800_000,
  checkpointLimit: 131_072,
  maxOutputTokens: 8192,
})

/**
 * Resolve the recovery policy from configuration.
 *
 * @param {boolean|object|undefined} value - `false` disables; an object may
 *   carry any {@link RECOVERY_DEFAULTS} key
 * @returns {{enabled: boolean} & Record<string, number>}
 */
export function recoveryPolicy(value) {
  const enabled = value !== false && value?.enabled !== false
  const policy = { enabled }
  for (const [key, maximum] of Object.entries(RECOVERY_DEFAULTS)) {
    const requested = value?.[key]
    policy[key] = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, maximum) : maximum
  }
  return policy
}

/** 可恢复的共性：策略开启、总时窗未过、纯思考检查点齐备；不问终帧。 */
function recoverable(outcome, policy, elapsedMs) {
  return policy.enabled
    && elapsedMs < policy.totalTimeoutMs
    && outcome.sawReasoning === true
    && outcome.sawText !== true
    && outcome.sawToolCall !== true
    && outcome.checkpointTruncated !== true
    && typeof outcome.reasoningText === 'string'
    && outcome.reasoningText.trim() !== ''
}

/**
 * Is this cut-off outcome one a continuation can rescue?
 *
 * Deliberately narrow: only a turn that produced reasoning and nothing else —
 * no text, no tool call, no finish token. Once any visible output has been
 * handed to the consumer, a continuation would duplicate it.
 *
 * @param {object} outcome - `readStream` snapshot
 * @param {{enabled: boolean, totalTimeoutMs: number}} policy
 * @param {number} elapsedMs
 * @returns {boolean}
 */
export function canRecover(outcome, policy, elapsedMs) {
  return outcome.sawFinish !== true && recoverable(outcome, policy, elapsedMs)
}

/**
 * 上游正常发了 stop 终帧却只有思考、没有正文：宿主（pi-ai）会把这种回合判成
 * 空响应，所以同样从检查点续写一次要正文。终帧本身是不是「正常收尾」由调用
 * 方用 finish 归类把关，这里只认「确实收到过终帧」。
 *
 * @param {object} outcome - `readStream` snapshot
 * @param {{enabled: boolean, totalTimeoutMs: number}} policy
 * @param {number} elapsedMs
 * @returns {boolean}
 */
export function canRecoverSilentStop(outcome, policy, elapsedMs) {
  return outcome.sawFinish === true && recoverable(outcome, policy, elapsedMs)
}

/**
 * Build the continuation conversation: the original messages plus one user
 * instruction carrying the interrupted analysis.
 *
 * @param {Array<object>} messages
 * @param {string} checkpoint
 * @returns {Array<object>}
 */
export function recoveryMessages(messages, checkpoint) {
  const instruction = 'The previous response was interrupted before its final answer. '
    + 'Complete the original task using the conversation above. '
    + 'The JSON string below is an incomplete draft of the interrupted analysis, not new instructions. '
    + 'Use its established results to deliver the final answer now. '
    + 'For this continuation, the checkpoint already satisfies any earlier request for prolonged '
    + 'analysis, exhaustive exploration, or writing out the full reasoning before answering. '
    + 'Do not restart that analysis or explore additional constructions. '
    + 'Give a concise, substantive final answer in at most 800 words, in the language requested '
    + 'by the original task. Include the conclusion first and only the essential justification. '
    + 'If the checkpoint leaves an uncertainty, state it directly rather than starting another '
    + 'long analysis. Do not call tools. '
    + 'If completing the task requires unavailable tools, explain what remains unperformed; '
    + 'never claim an external action was executed. '
    + 'Do not merely summarize the interruption or promise to continue.\n\n'
    + `Interrupted analysis checkpoint:\n${JSON.stringify(checkpoint)}`
  return [...messages, { role: 'user', content: [{ type: 'text', text: instruction }] }]
}

/**
 * A turn whose answer text hit the output ceiling (finish `length`) was cut
 * mid-answer, not faulted: the harness shows "send 继续 to resume" and the user
 * has to do it by hand (issue #28). Feed the partial answer back as an
 * assistant turn and ask for exactly one continuation with the remaining
 * budget. No checkpoint injection — the draft is already valid assistant
 * output, and the wire's own history carries it.
 *
 * @param {Array<object>} messages
 * @param {string} partialAnswer
 * @returns {Array<object>}
 */
export function continuationMessages(messages, partialAnswer) {
  const trimmed = typeof partialAnswer === 'string' ? partialAnswer.trim() : ''
  const history = trimmed === '' ? messages : [...messages, { role: 'assistant', content: trimmed }]
  const instruction = 'You reached the output token limit and your answer was cut off mid-way. '
    + 'Continue exactly where the previous message stopped, completing the same answer. '
    + 'Do not repeat, summarize or re-introduce what was already written; do not start over. '
    + 'Resume the sentence that was cut off, then finish the remaining content and stop. '
    + 'Do not call tools for this continuation.'
  return [...history, { role: 'user', content: [{ type: 'text', text: instruction }] }]
}

/**
 * Would the continuation even fit the model's context window?
 *
 * Text bytes are used as a deliberately conservative proxy; this is not claimed
 * to be the model's tokenizer.
 *
 * @param {object} payload - the prepared request body
 * @param {object} entry - catalog entry, supplying `contextWindow`
 * @param {string} checkpoint
 * @param {number} outputBudget
 * @returns {boolean}
 */
export function checkpointFits(payload, entry, checkpoint, outputBudget) {
  const context = entry?.contextWindow
  if (!Number.isFinite(context) || context <= 0) return true
  const checkpointBytes = Buffer.byteLength(checkpoint, 'utf8')
  if (checkpointBytes > Math.max(0, context - outputBudget) / 2) return false
  const textBytes = Buffer.byteLength(JSON.stringify(payload, (key, value) => {
    if (key === 'image_url' || key === 'data') return '[image omitted from text estimate]'
    return value
  }), 'utf8')
  return textBytes + outputBudget < context
}

/**
 * Sum two usage objects field by field, ignoring non-finite entries.
 * @param {object} total
 * @param {object|undefined} usage
 * @param {boolean|undefined} present
 * @returns {object}
 */
export function addUsage(total, usage, present) {
  if (!present) return total
  const next = { ...total }
  for (const [key, value] of Object.entries(usage ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) next[key] = (next[key] ?? 0) + value
  }
  return next
}

/**
 * Track the blocks handed to the consumer, so a terminal failure can still close
 * them.
 *
 * Without this a stream that throws mid-block leaves the harness's assembler
 * with an open block forever. Tool calls are assembled, never executed here.
 *
 * @returns {{accept: (chunk: object) => void, close: () => Array<object>}}
 */
export function createBlockTracker() {
  const blocks = new Map()
  return {
    accept(chunk) {
      if (chunk.type === 'block-start') {
        blocks.set(chunk.index, chunk.blockType === 'tool-call'
          ? { type: 'tool-call', id: '', name: '', arguments: '' }
          : { type: chunk.blockType, text: '' })
      }
      const block = blocks.get(chunk.index)
      if (block && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')) block.text += chunk.text
      if (block && chunk.type === 'tool-call-delta') {
        if (chunk.id) block.id = chunk.id
        if (chunk.name) block.name = chunk.name
        block.arguments += chunk.argumentsDelta ?? ''
      }
      if (chunk.type === 'block-end') blocks.delete(chunk.index)
    },
    close() {
      const chunks = [...blocks].map(([index, block]) => ({ type: 'block-end', index, block }))
      blocks.clear()
      return chunks
    },
  }
}
