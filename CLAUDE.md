# svelte-local-query

A Svelte 5 (runes-only) + TypeScript library that mimics the SvelteKit **remote
functions** API (`query`, `query.batch`, `query.live`, `command`, `form`) but runs the
functions **locally in the browser** — for SPA projects without a backend, with or
without SvelteKit.

## Commands

- `npm test` — run the vitest suite (jsdom, `--expose-gc` for FinalizationRegistry tests)
- `npm run check` — svelte-check with strict TypeScript
- `npm run build` — `svelte-package` into `dist/` + `publint`
- `npm run lint` / `npm run format` — prettier check / write
- `npm run dev` — vite playground (`playground/`), a manual end-to-end page

## The kit-parity rule

**Behavior must match SvelteKit remote functions unless the difference is listed in
`DIFFERENCES.md`.** When changing behavior, check the upstream implementation first
(`sveltejs/kit` → `packages/kit/src/runtime/client/remote-functions/`) and either match
it or document the divergence in `DIFFERENCES.md`. Public types in `src/lib/types.ts`
are ports of kit's `Remote*` types renamed to `Local*` — keep them in sync structurally.

## Architecture (3-layer split, ported from kit)

1. **Factory** (`query()`, `command()`, `form()` in `src/lib/query/index.ts`,
   `src/lib/command.svelte.ts`, `src/lib/form/index.svelte.ts`) — created once per
   user-defined function; holds the function id (`QUERY_FUNCTION_ID` tag) and shared
   state (command `pending` count, form `.for()` instance map).
2. **Proxy** (`src/lib/query/proxy.ts`, `src/lib/query-live/proxy.ts`) — a lightweight
   handle created on every call, keyed by stable-JSON-stringified argument. It refs the
   cache entry and forwards all getters. **The resource factory closure must never
   capture the proxy (`this`)** or GC-based eviction breaks — there are tests for this.
3. **Resource** (`src/lib/query/instance.svelte.ts`, `src/lib/query-live/instance.svelte.ts`)
   — the single long-lived reactive object per `(id, payload)`; all runes live here.

Supporting machinery in `src/lib/internal/`:

- `cache.svelte.ts` — `CacheController`: ref-counting, `FinalizationRegistry` eviction,
  resources owned by an `$effect.root`.
- `shared.svelte.ts` — tag symbols, the query/live-query cache maps,
  `categorize_updates()` (routes `.updates(...)` args), `refresh_keys()`/`refresh_all()`
  (the local replacement for kit's server round-trip), effect/await pinning helpers,
  and the mutation epoch used by `form` to detect handler-driven refreshes.
- `stringify.ts` — stable JSON cache keys (sorted object keys; Map/Set rejected).

## Conventions

- Svelte 5 **runes only** ($state, $derived, $effect); files containing runes use the
  `.svelte.ts` suffix. No legacy stores or `$:` reactivity.
- snake_case for internal helpers (matching the ported kit code), camelCase for public API.
- Tests are colocated `*.test.ts` / `*.svelte.test.ts` (runes allowed in the latter),
  mirroring kit's own `.svelte.spec.js` suites. GC-dependent tests are gated on
  `has_gc` from `src/tests/helpers.ts` and rely on `--expose-gc` (configured in
  `vite.config.ts`).
- Reactive resources must never produce unhandled promise rejections — every stored
  rejected promise gets a `.catch(noop)`; there are regression tests for this.

## Recommended Claude Code plugins

`.claude/settings.json` enables `typescript-lsp` and `svelte` from the
`anthropics/claude-code-plugins` marketplace. If the marketplace is unreachable in a
sandboxed session (external git is blocked), the plugins simply won't load — the
project works fine without them; `npm run check` covers typechecking.
