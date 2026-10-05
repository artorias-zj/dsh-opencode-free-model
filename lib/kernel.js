/**
 * The kernel seam.
 *
 * This file is the only module in the package allowed to name an
 * `@deepseek-ai/*` module — the ecosystem packaging rule, checkable in one line
 * of grep. Everything the plugin takes from the harness kernel crosses here, so
 * the rest of the source stays a pure consumer of the structural `ctx`
 * contract and can mount on any kernel line that supplies it.
 *
 * Today the seam carries one thing: the harness attribution User-Agent, which
 * every provider request must send. It is imported lazily because the plugin
 * must not pin a kernel version — the package is supplied by whichever
 * installation resolves the bundle — and if a composition cannot supply it, a
 * literal keeps attribution present, which is what the adapter contract
 * requires.
 *
 * @module lib/kernel.js
 */

// @ts-check

/**
 * The slice of the kernel module this seam is allowed to depend on. The real
 * declaration lives beside this file (`adapter/dsh-llm.d.ts`); it is deliberately
 * narrower than the kernel's own surface.
 *
 * @typedef {object} KernelAttribution
 * @property {() => Record<string, string> | undefined} [attributionHeaders]
 */

/** The attribution this plugin sends when the kernel's helper is unavailable. */
export const FALLBACK_USER_AGENT = 'deepseek-harness/0.1.7 (+https://github.com/deepseek-ai/deepseek-harness)'

/**
 * Resolve the harness attribution User-Agent.
 *
 * A missing module or an unexpected shape degrades to {@link FALLBACK_USER_AGENT}
 * — attribution must be present even when the kernel's helper is not.
 *
 * @param {{ debug?: (message: string) => void }} [logger]
 * @returns {Promise<string>}
 */
export async function resolveAttributionUserAgent(logger) {
  try {
    const kernel = /** @type {KernelAttribution} */ (await import('@deepseek-ai/dsh-llm'))
    const headers = typeof kernel.attributionHeaders === 'function' ? kernel.attributionHeaders() : undefined
    const agent = headers?.['user-agent'] ?? headers?.['User-Agent']
    if (typeof agent === 'string' && agent !== '') return agent
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger?.debug?.(`opencode-free-model: attribution module unavailable (${message})`)
  }
  return FALLBACK_USER_AGENT
}
