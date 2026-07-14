---
name: kit-parity
description: Check SvelteKit's remote-functions API for upstream changes and sync svelte-local-query with them, preserving the documented differences. Use when asked to check kit parity, sync with SvelteKit, or update the library to a new kit release.
---

# kit-parity — sync with upstream SvelteKit remote functions

This library is a port of SvelteKit's client-side remote-functions runtime with the
transport removed. **The parity rule (CLAUDE.md): behavior must match SvelteKit unless
the difference is documented in `DIFFERENCES.md`.** This skill keeps that promise over
time by diffing upstream and porting what changed.

Work on a fresh branch. Do everything below in order; do not skip the "ask the user"
gates.

## 1. Detect upstream changes

Run the helper script (from any scratch directory — it downloads into `./kit-upstream`):

```sh
.claude/skills/kit-parity/fetch-upstream.sh check
```

- It fetches every tracked upstream file from `sveltejs/kit@main` via
  `raw.githubusercontent.com` (works in sandboxed sessions; `github.com` HTML and
  `api.github.com` may be blocked) and compares content hashes against
  `baseline.json` (which records the kit version and file hashes from the last sync).
- Exit 0 → no changes: report "in sync with kit <version>", update `checked_at` by
  re-running `fetch-upstream.sh baseline`, commit that if anything changed, and stop.
- Exit 1 → it prints the `CHANGED`/`NEW`/`MISSING`/`REMOVED` files. A `MISSING` file
  means it moved or was deleted upstream — locate its replacement in the tree (fetch
  `https://raw.githubusercontent.com/sveltejs/kit/main/packages/kit/src/...` paths, or
  use WebFetch on `https://github.com/sveltejs/kit/tree/...` if reachable) and update
  the `FILES` list in `fetch-upstream.sh`.

Then gather context on _why_ things changed:

- Changelog: fetch
  `https://raw.githubusercontent.com/sveltejs/kit/main/packages/kit/CHANGELOG.md` and
  read the entries between `baseline.json`'s `kit_version` and the latest version,
  looking for anything mentioning remote functions, `query`, `command`, `form`,
  `prerender`, or validation.
- Docs: the tracked `documentation/docs/20-core-concepts/60-remote-functions.md` is
  downloaded by the script — diff it against your local copy of the previous version if
  behavior questions arise (WebFetch `https://svelte.dev/docs/kit/remote-functions` for
  the rendered version).
- For each changed source file, read the upstream copy in `./kit-upstream/` next to our
  port (mapping table below) and identify the actual behavioral delta. Changes to
  `packages/kit/types/index.d.ts` are only relevant if they touch the `Remote*` types
  or the `$app/server` `query`/`command`/`form` declarations — the file churns for
  unrelated reasons.

## 2. Classify each change — and ask when in doubt

For every behavioral delta, decide which bucket it belongs to:

- **Transport/server-only** (fetch, devalue, SSR hydration, `requested()`, headers,
  redirect-over-HTTP plumbing, prerender build machinery, SSE internals): no code
  change needed. If it alters semantics we emulate (e.g. new invalidation defaults),
  treat as behavioral.
- **Covered by a documented difference** (`DIFFERENCES.md`): no port needed, but check
  whether the difference's description is still accurate and update it if kit's side of
  the story changed.
- **Behavioral/API change that applies locally**: must be ported (step 4/5).
- **Unclear, or the local equivalent is not obvious** (e.g. a new feature that relies
  on the server, a semantic change that interacts with one of our differences): **stop
  and ask the user with AskUserQuestion** before implementing — present the upstream
  change, the options for local behavior, and a recommendation. New divergences must
  never be decided silently.

## 3. Diff the codebases

For each upstream file that changed, compare against our port with special attention to
the documented differences (the ported files deliberately drop transport code — don't
"fix" that):

| Upstream (`packages/kit/src/…`)                                 | Local                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `runtime/client/remote-functions/query/instance.svelte.js`      | `src/lib/query/instance.svelte.ts`                                                    |
| `runtime/client/remote-functions/query/proxy.js`                | `src/lib/query/proxy.ts`                                                              |
| `runtime/client/remote-functions/query/index.js`                | `src/lib/query/index.ts` (factory)                                                    |
| `runtime/client/remote-functions/query-batch.svelte.js`         | `src/lib/query/index.ts` (`create_query_batch`)                                       |
| `runtime/client/remote-functions/query-live/instance.svelte.js` | `src/lib/query-live/instance.svelte.ts`                                               |
| `runtime/client/remote-functions/query-live/proxy.js`           | `src/lib/query-live/proxy.ts`                                                         |
| `runtime/client/remote-functions/query-live/index.js`           | `src/lib/query-live/index.ts`                                                         |
| `runtime/client/remote-functions/command.svelte.js`             | `src/lib/command.svelte.ts`                                                           |
| `runtime/client/remote-functions/form.svelte.js`                | `src/lib/form/index.svelte.ts`                                                        |
| `runtime/form-utils.js`                                         | `src/lib/form/form-utils.ts`                                                          |
| `runtime/client/remote-functions/shared.svelte.js`              | `src/lib/internal/shared.svelte.ts`                                                   |
| `runtime/client/remote-functions/cache.svelte.js`               | `src/lib/internal/cache.svelte.ts`                                                    |
| `utils/shared-iterator.js`                                      | `src/lib/internal/shared-iterator.ts`                                                 |
| `runtime/shared.js` (`stringify_remote_arg`, keys)              | `src/lib/internal/stringify.ts` (stable JSON instead of devalue)                      |
| `types/index.d.ts` (`Remote*` types, `$app/server` overloads)   | `src/lib/types.ts` (`Local*`), factory overloads                                      |
| `runtime/client/remote-functions/query-live/iterator.js`        | no direct port — local `AsyncIterable` consumption in `query-live/instance.svelte.ts` |
| `runtime/client/remote-functions/prerender.svelte.js`           | intentionally not ported (DIFFERENCES.md)                                             |

Local-only machinery with no upstream counterpart (upstream changes may still affect
it): `refresh_keys`/`refresh_all` + the mutation epoch in
`src/lib/internal/shared.svelte.ts` (our replacement for kit's single-flight server
round-trip and `invalidateAll()`), `src/lib/config.ts` (`init`/`redirect`/`onerror`),
`src/lib/validation.ts` (argument validation + the TS-inferred bare-handler
declaration, a documented local extension).

Invariants that any port must preserve (there are regression tests for each):

- resource factories passed to `cache.ensure_entry` must **never close over the proxy**
  (`this`) — GC-based eviction breaks otherwise;
- no code path may create an unhandled promise rejection (`promise.catch(noop)` on
  every stored rejected promise);
- rune-containing files keep the `.svelte.ts` suffix; public types stay structural
  ports of kit's `Remote*` types renamed `Local*`.

## 4. Port relevant new tests

The upstream spec files are tracked and downloaded alongside the sources
(`*.spec.js` in `./kit-upstream/.../remote-functions/`). For every upstream test that
covers client-side behavior we emulate, add/adapt an equivalent in our suites:

| Upstream spec                       | Local suite                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `query/proxy.svelte.spec.js`        | `src/lib/query/query.svelte.test.ts`                                                 |
| `cache.svelte.spec.js`              | `src/lib/internal/cache.svelte.test.ts`                                              |
| `instance.unhandled.svelte.spec.js` | unhandled-rejection tests in `query.svelte.test.ts` / `live.svelte.test.ts`          |
| `shared.transport.spec.js`          | `src/lib/internal/shared.svelte.test.ts` + `stringify.test.ts` (transport parts N/A) |
| `query-live/proxy.svelte.spec.js`   | `src/lib/query-live/live.svelte.test.ts`                                             |

Conventions: colocated `*.test.ts` / `*.svelte.test.ts`, GC-dependent tests gated on
`has_gc` from `src/tests/helpers.ts`, timing helpers `flush`/`wait_for`/`until` from the
same module. Skip tests that only exercise transport (fetch mocking, SSR payloads,
devalue) — note them as skipped in the PR description instead of porting.

## 5. Implement

Port the behavioral changes following the existing style (snake_case internals,
comments preserved from upstream where they explain subtle reactivity). For every
deliberate divergence introduced or touched, update `DIFFERENCES.md` in the same
commit. Update README examples if the public API surface changed.

## 6. Verify and finish

1. `npm run check` — 0 errors; `npm test` — all green; `npm run build` — publint clean;
   `npm run lint` — formatted.
2. If runtime behavior changed, run the e2e suite:
   `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e` (see the
   `verify` skill) — and extend `e2e/playground.spec.ts` + the playground page when the
   ported change isn't covered yet.
3. Update the baseline so the next run starts from this sync:
   `.claude/skills/kit-parity/fetch-upstream.sh baseline` (commit `baseline.json`).
4. Commit and open a PR that lists, per upstream change: what changed in kit, how it
   was classified (ported / transport-only / covered by difference), and which tests
   cover it.
