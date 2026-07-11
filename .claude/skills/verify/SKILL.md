---
name: verify
description: Verify changes to svelte-local-query end-to-end — run the full test suite, type checking, package build, and (for behavioral changes) exercise the playground in a browser.
---

# Verifying changes

Run these in order; all must pass before committing:

1. `npm run check` — svelte-check, strict TS, zero errors expected.
2. `npm test` — full vitest suite. GC/lifecycle tests need `--expose-gc`, which
   `vite.config.ts` already sets via `poolOptions.forks.execArgv`. If lifecycle tests
   are skipped, check that the pool is `forks` (the default) and not overridden.
3. `npm run build` — `svelte-package` must emit `dist/` with `.d.ts` files and `publint`
   must report "All good!".

## Behavioral changes

For changes to query/command/form runtime behavior, also verify in a real browser:

- `npm run dev` starts the vite playground (`playground/`), which exercises a query
  (dedup + refresh), a command with `.updates()` + optimistic override, a form with
  fields/issues/validation, and a live query.
- Drive it with Playwright (Chromium is preinstalled at `/opt/pw-browsers/chromium` in
  remote sessions; use `executablePath` instead of downloading browsers).

## Parity check

If the change alters public API surface or semantics, cross-check against SvelteKit's
remote functions (docs: https://svelte.dev/docs/kit/remote-functions). Any deliberate
divergence must be added to `DIFFERENCES.md` in the same commit.
