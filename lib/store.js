/**
 * A tiny JSON file store.
 *
 * Everything this plugin remembers — settings, the catalog snapshot, probe
 * verdicts — is small, single-writer and read far more often than written, which
 * is why it is one class rather than a database. Three properties matter and are
 * the whole reason it is not `JSON.parse(readFileSync(...))`:
 *
 * - **writes are atomic** — content goes to a sibling temp file and is renamed
 *   over the target, so a crash mid-write leaves the previous good file rather
 *   than a truncated one;
 * - **writes are coalesced** — a burst of `update()` calls in one turn becomes
 *   one write, because the caller is a hot path (every streamed call records
 *   usage) and fsync-per-token would be absurd;
 * - **a corrupt file is preserved, not overwritten** — a file that does not
 *   parse is moved aside with a timestamp suffix, so a bug that writes garbage
 *   is diagnosable instead of self-erasing.
 *
 * @module lib/store.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The plugin's own directory under `$DSH_HOME`. */
export const DATA_DIR_NAME = 'opencode-free-model'

/** How long a pending write waits for company before hitting the disk. */
export const FLUSH_DELAY_MS = 800

/**
 * Resolve the harness home directory the same way the kernel does.
 * @returns {string}
 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/** A structural deep copy, so callers cannot mutate stored state by reference. */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * Read one JSON document, falling back to the initial value.
 *
 * @param {string} file
 * @param {unknown} initial
 * @param {(message: string) => void} [log]
 * @returns {unknown}
 */
function load(file, initial, log) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') log?.(`opencode-free-model: could not read ${file}: ${error?.message ?? error}`)
    return clone(initial)
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') throw new Error('not a JSON object')
    return parsed
  } catch (error) {
    const aside = `${file}.corrupt-${Date.now()}`
    try {
      fs.renameSync(file, aside)
      log?.(`opencode-free-model: ${file} did not parse (${error?.message ?? error}); kept it at ${aside} and started fresh`)
    } catch (renameError) {
      log?.(`opencode-free-model: ${file} did not parse and could not be moved aside: ${renameError?.message ?? renameError}`)
    }
    return clone(initial)
  }
}

/** One JSON document on disk, cached in memory and written atomically. */
export class JsonStore {
  /**
   * @param {string} file - absolute path
   * @param {object} initial - the shape used when the file is absent
   * @param {object} [options]
   * @param {(message: string) => void} [options.log]
   * @param {number} [options.flushDelayMs]
   */
  constructor(file, initial, { log, flushDelayMs = FLUSH_DELAY_MS } = {}) {
    this.file = file
    this.log = log
    this.flushDelayMs = flushDelayMs
    this.value = load(file, initial, log)
    this.dirty = false
    this.disposed = false
    this.timer = undefined
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
    } catch { /* the write below reports the real problem */ }
  }

  /** A detached copy of the current state. */
  get() {
    return clone(this.value)
  }

  /**
   * Shallow-merge a patch into the state.
   * @param {object} patch
   * @returns {object} the new state
   */
  update(patch) {
    this.value = { ...this.value, ...patch }
    this.schedule()
    return this.get()
  }

  /**
   * Replace the state with the result of a function.
   * @param {(current: object) => object|undefined} mutate - `undefined` keeps
   *   the current value, which lets a mutation decide to change nothing
   * @returns {object} the new state
   */
  edit(mutate) {
    const next = mutate(clone(this.value))
    if (next !== undefined) this.value = next
    this.schedule()
    return this.get()
  }

  schedule() {
    if (this.disposed || this.timer !== undefined) return
    this.dirty = true
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.flushDelayMs)
    this.timer.unref?.()
  }

  /** Write now, if anything is pending. */
  flush() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.dirty) return
    this.dirty = false
    const temp = `${this.file}.${process.pid}.tmp`
    try {
      fs.writeFileSync(temp, `${JSON.stringify(this.value, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(temp, this.file)
    } catch (error) {
      this.log?.(`opencode-free-model: could not write ${this.file}: ${error?.message ?? error}`)
      this.dirty = true
    }
  }

  /** Flush and stop accepting work. */
  dispose() {
    this.flush()
    this.disposed = true
  }
}
