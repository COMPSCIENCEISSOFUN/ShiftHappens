/**
 * Type declaration for Vite's `import.meta.glob`.
 *
 * `tests/api/contract.test.ts` and `tests/api/manifest-completeness.test.ts`
 * enumerate route modules with it — that filesystem enumeration is what makes
 * the manifest completeness check possible, and what removes the need for 62
 * hand-written imports.
 *
 * It is a Vite extension, not standard TypeScript, so `tsc` does not know it.
 * This matters more than an editor squiggle: `tsconfig.json` includes
 * `**\/*.ts`, so `npm run build` type-checks the tests directory and would fail
 * without this.
 *
 * Declared narrowly rather than via `/// <reference types="vite/client" />`
 * for two reasons: it introduces no dependency on vite's own types resolving,
 * and it avoids pulling in vite's asset module declarations (`*.svg`, `*.css`
 * and friends) alongside the ones Next already provides in `next-env.d.ts`.
 *
 * The value type is deliberately `| undefined`: an arbitrary key lookup can
 * miss, and both call sites guard for it. Typing it as always-defined would
 * make `if (!loader)` a TS2774 error ("this condition will always return
 * true").
 *
 * No top-level import or export in this file — that is what keeps the interface
 * merging with the global `ImportMeta` rather than becoming module-scoped.
 */
interface ImportMeta {
  /**
   * Eagerly matches files against a glob pattern, returning a map of path to
   * lazy loader.
   *
   * @see https://vite.dev/guide/features#glob-import
   */
  glob(pattern: string): Record<string, (() => Promise<unknown>) | undefined>;
}
