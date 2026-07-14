---
name: verify
description: Verify changes to svelte-local-query end-to-end — run the full test suite, type checking, package build, and (for behavioral changes) exercise the playground in a browser.
---

# Verifying changes

Run these in order; all must pass before committing:

1. `npm run check` — svelte-check, strict TS, zero errors expected.
2. `npm test` — full vitest suite. GC/lifecycle tests need `--expose-gc`, which
   `vite.config.ts` already sets via `test.execArgv`. If lifecycle tests are skipped,
   check that this flag still reaches the worker processes.
3. `npm run build` — `svelte-package` must emit `dist/` with `.d.ts` files and `publint`
   must report "All good!".
4. `npm run test:e2e` — the Playwright suite in `e2e/` drives the vite playground
   (query dedup + refresh, command with optimistic `.updates()`, form
   fields/issues/validation with refresh-all, live query) in a real Chromium. It starts
   the dev server itself. In sandboxed remote sessions, don't download browsers — use
   the preinstalled one: `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e`.

## Behavioral changes

For changes to query/command/form runtime behavior not covered by `e2e/playground.spec.ts`,
extend the playground page (`playground/App.svelte` + `playground/data.ts`) and the e2e
suite rather than verifying by hand — CI runs the suite on every push.

## Parity check

If the change alters public API surface or semantics, cross-check against SvelteKit's
remote functions (docs: https://svelte.dev/docs/kit/remote-functions). Any deliberate
divergence must be added to `DIFFERENCES.md` in the same commit.
