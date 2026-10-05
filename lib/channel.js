/**
 * A single-producer / single-consumer channel bridging a callback source (the
 * SSE reader hands over one payload per invocation) to an async-iterable
 * consumer (the chunk parser).
 *
 * `push` never blocks the producer: unclaimed values queue, which is safe here
 * because a provider stream is bounded by its own turn. `next` suspends the
 * consumer instead of polling, so an idle stream costs nothing.
 *
 * @module lib/channel.js
 */

/**
 * @returns {{push: (value: string|undefined|Error) => void, read: () => AsyncGenerator<string>}}
 */
export function createChannel() {
  /** @type {Array<string|undefined|Error>} */
  const queue = []
  /** @type {Array<(value: string|undefined|Error) => void>} */
  const waiting = []
  let ended = false

  return {
    /**
     * @param {string|undefined|Error} value - payload; `undefined` ends the
     *   stream cleanly, an `Error` fails it.
     */
    push(value) {
      if (ended) return
      const resolve = waiting.shift()
      if (resolve !== undefined) resolve(value)
      else queue.push(value)
      if (value === undefined || value instanceof Error) ended = true
    },
    async * read() {
      while (true) {
        const next = queue.length > 0 ? queue.shift() : await new Promise(resolve => waiting.push(resolve))
        if (next instanceof Error) throw next
        if (next === undefined) return
        yield next
      }
    },
  }
}
