# Differences from SvelteKit remote functions

svelte-local-query deliberately mirrors the API and behavior of
[SvelteKit remote functions](https://svelte.dev/docs/kit/remote-functions). Anything not
listed here is intended to behave identically — if it doesn't, that's a bug. The
implementation is a direct port of kit's client-side remote-functions runtime
(`packages/kit/src/runtime/client/remote-functions/`, MIT) with the HTTP transport
removed.

## No server, no transport

| Area              | SvelteKit                                                    | svelte-local-query                                                                                               |
| ----------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Execution         | `fetch` RPC to a generated server endpoint                   | direct in-process async call                                                                                     |
| Serialization     | [devalue](https://github.com/sveltejs/devalue) over the wire | none — values are passed by reference; no cloning, no transport hooks                                            |
| File placement    | `*.remote.ts` files only, compiler-transformed               | any `.svelte`, `.svelte.ts` or `.ts` file — the factories are plain runtime functions                            |
| SSR / hydration   | query results serialized during SSR and hydrated             | N/A (client-only)                                                                                                |
| `getRequestEvent` | available inside handlers                                    | N/A — there is no request                                                                                        |
| `prerender`       | build-time snapshot served from the edge/Cache API           | **not provided** — there is no build step for local functions. Use a plain `query` (and simply never refresh it) |

Because handler results are not serialized, returned objects are shared by reference
with the cache. Treat query results as immutable — mutate via `set()`, `refresh()` or
`withOverride()` instead.

> **Note on defining functions inside components:** since there is no compile step,
> calling `query(...)`/`form(...)` inside a component creates a _new_ function (with its
> own cache) per component instance. For shared caches, declare them at module level
> (in a `.svelte.ts`/`.ts` module or in `<script module>`), exactly like kit's
> `.remote.ts` modules.

## Cache keys

Kit serializes query arguments with devalue (supporting `Date`, `Map`, `Set`, `BigInt`,
…) and normalizes object key order. svelte-local-query uses a **stable
`JSON.stringify`** with recursively sorted object keys:

- object property order does not matter (parity with kit);
- arguments must be JSON-serializable. `Date` works (via `toJSON`, i.e. keyed by its ISO
  string), but `Map`/`Set` arguments throw and `BigInt` is not supported.

## Single-flight mutations & refreshes

Kit's single-flight machinery exists to avoid a second server round-trip: refreshed
query data travels back with the mutation response, and the server must accept
client-requested refreshes via `requested(queryFn, limit)` (a DoS/bundle-size guard).

Locally there is no round-trip, so:

- **No accept-list.** `.updates(...)` on a command/form submission simply re-runs the
  targeted queries after the handler resolves — no `requested()` needed, no `limit`.
- **Handler-driven refreshes** (`getPosts().refresh()`, `getPost(id).set(result)` inside
  a `command`/`form` handler) work directly against the live cache instead of being
  encoded into the response.
- Awaiting `command(...).updates(...)` still resolves only after the refreshed queries
  have re-run, and optimistic `withOverride` values are released at the same point —
  matching kit's timing semantics.

## `form`

- **No non-JS fallback.** Kit forms work without JavaScript via a native POST;
  locally there is no server to post to, so JavaScript is required. `method="POST"` and
  `action="?/local=<id>"` are kept purely for API parity (and for the submit handler to
  recognize its own form).
- **Auto-invalidation** on success: kit calls `invalidateAll()` (queries **and** load
  functions). svelte-local-query refreshes **all active cached queries** (and reconnects
  live queries). As in kit, this is skipped when you take control via `.updates(...)` or
  refresh/set queries inside the handler.
- **Errors** thrown by a submission handler render the nearest `+error.svelte` in kit.
  Locally they are passed to the `init({ onerror })` hook, or rethrown (surfacing as an
  unhandled rejection) if none is configured.
- **`validate()`**: where kit performs a `validate_only` server round-trip, the form's
  own schema runs locally. Behavior (touched-field filtering, `includeUntouched`,
  `preflightOnly`) is otherwise identical.
- **`preflight()`** is kept for parity and for cheap as-you-type validation, but it is
  largely redundant locally — the form's main schema already runs in-process at submit.
- **Sensitive `_`-prefixed field names** exist in kit to keep values out of the
  server's echo on non-enhanced submissions. Locally nothing is echoed anywhere, so the
  prefix has no effect. The `n:`/`b:` name prefixes **are** kept — they drive
  number/boolean coercion from `FormData` strings, same as kit.

## Validation is optional for `query` and `command` (TypeScript-inferred arguments)

In kit, every remote function argument crosses a network trust boundary, so a
declaration that takes an argument **must** provide a Standard Schema or explicitly opt
out with `'unchecked'` — `query(fn)` is strictly argument-less. Locally there is no
trust boundary: the handler and its caller live in the same bundle, so the handler's
own TypeScript signature is authoritative.

svelte-local-query therefore accepts a bare handler **with a parameter** for `query`,
`query.batch`, `query.live` and `command`; the client-side callable gets the exact same
signature, and the value passes through untouched at runtime (equivalent to
`'unchecked'`):

```ts
const getPosts = query(({ filter, sort }: { filter?: string; sort?: string }) => {
	return db.find(filter, sort);
});

getPosts({ filter: 'name eq Claude' }); // type-checked against the handler's parameter
```

- The **one-argument rule** is unchanged: exactly one argument, still used as the
  stable-JSON cache key (same dedup rules as any other query).
- Schema and `'unchecked'` declarations keep working exactly as in kit — use a schema
  whenever the value comes from outside your code (user input, URL params, storage).
- **`form` is excluded**: form data originates from the DOM as strings and needs
  coercion + validation, so forms still require a schema or `'unchecked'`.
- Runtime caveat: whether a bare handler accepts an argument is detected via its arity
  (`fn.length`). Handlers with **only default or rest parameters**
  (`(arg = {}) => ...`, `(...args) => ...`) have length 0 and are treated as
  argument-less (passing an argument triggers the dev-time guard). Declare a plain
  parameter or use `'unchecked'` in that case.

## Validation errors

Kit responds with a generic **400 Bad Request** when a query/command argument fails its
schema (customizable via the `handleValidationError` server hook). Locally the
`ValidationError` (carrying the Standard Schema issues) is surfaced directly:

- for a `query`: as `query.error` / the awaited rejection;
- for a `command`: as the rejection of the returned promise.

Use the exported `isValidationError(e)` guard.

## Redirects

`redirect(location)` (or `redirect(status, location)` for signature parity) throws a
`Redirect` object, as in kit. But there is no router integration, so:

- register a navigation handler once at startup:
  `init({ redirect: (location) => goto(location) })` — works with SvelteKit's `goto` in
  SPA mode, any router, or `location.assign`;
- in a **form** handler, a redirect counts as a successful submission (kit parity) and
  invokes the hook;
- in a **query**, the hook is invoked and the `Redirect` still surfaces as
  `query.error` (kit's own client currently rejects here too);
- in a **command**, redirects are rejected with an error — same as kit.

## `query.live`

Kit streams values from the server over SSE with automatic reconnection/backoff,
online/offline handling and page lifecycle integration. Locally the handler simply
returns an `AsyncIterable<T>` (most commonly an async generator); each yielded value
becomes `current`:

```ts
export const now = query.live(async function* () {
	while (true) {
		yield new Date().toLocaleTimeString();
		await new Promise((r) => setTimeout(r, 1000));
	}
});
```

- There is no automatic retry: an error thrown by the iterable is terminal
  (`error` is set, `done` becomes `true`) until `reconnect()` is called.
- `reconnect()` re-invokes the handler (kit: re-establishes the SSE connection).
- No `online`/`offline`/`pagehide` listeners — those are network concerns.
- When a stream is interrupted (reconnect or cache eviction), the previous iterator's
  `return()` is invoked so `finally` blocks run — but per async-generator semantics this
  is queued behind any pending `await` inside the generator. Prefer short-lived awaits
  inside live handlers so cleanup runs promptly.

## Errors & retries in `query`

Kit has a TODO to retry transport-level query failures while preserving the last good
value. There are no transport failures locally: a throwing handler simply fails the
query (`error` set, `ready`/`current` preserved from the last successful run during
refreshes).

## Function ids / HMR

Kit derives stable function ids from file paths at build time and refreshes live
queries on HMR. Local ids are generated at runtime (a counter), so module-level
declarations get fresh ids — and fresh caches — when a module is hot-reloaded.
