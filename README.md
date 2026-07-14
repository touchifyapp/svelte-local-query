# svelte-local-query

The [SvelteKit remote functions](https://svelte.dev/docs/kit/remote-functions) API —
`query`, `query.batch`, `query.live`, `command`, `form` — for apps **without a
backend**. Your functions run locally in the browser (IndexedDB, SQLite-WASM,
localStorage, in-memory, …) but you keep the exact same ergonomics: reactive, cached,
awaitable queries; commands with optimistic updates; progressive form handling with
typed fields and validation.

Works in any Svelte 5 app — plain Vite SPA or SvelteKit (e.g. in SPA mode). Runes-only,
fully typed, no dependencies beyond Svelte itself.

> The implementation is a direct port of SvelteKit's client-side remote-functions
> runtime with the HTTP transport removed. Behavior intentionally matches kit;
> every divergence is documented in [DIFFERENCES.md](./DIFFERENCES.md).

## Installation

```sh
npm install svelte-local-query
```

Requires `svelte@^5.29` and a bundler that understands the `svelte` export condition
(Vite with `@sveltejs/vite-plugin-svelte`, or SvelteKit).

## Quick start

Declare your functions in any module — a `.ts`, `.svelte.ts` or `<script module>` block
(module level, so the cache is shared across components):

```ts
// data.ts
import * as v from 'valibot'; // any Standard Schema library (zod, valibot, arktype...)
import { command, form, query } from 'svelte-local-query';
import { db } from './db'; // your local storage layer

export const getPosts = query(async () => {
	return db.posts.orderBy('date').toArray();
});

export const getPost = query(v.string(), async (id) => {
	return db.posts.get(id);
});

export const addLike = command(v.string(), async (id) => {
	await db.posts.update(id, { likes: (await db.posts.get(id)).likes + 1 });
});

export const createPost = form(
	v.object({
		title: v.pipe(v.string(), v.nonEmpty('Please enter a title')),
		content: v.string()
	}),
	async (data) => {
		const id = crypto.randomUUID();
		await db.posts.add({ id, ...data });
		return { id };
	}
);
```

Use them in components:

```svelte
<script>
	import { getPosts, addLike, createPost } from './data';

	const posts = getPosts();
</script>

<!-- reactive access -->
{#if posts.error}
	<p>Something went wrong</p>
{:else if !posts.ready}
	<p>Loading...</p>
{:else}
	{#each posts.current as post}
		<article>
			<h2>{post.title}</h2>
			<button onclick={() => addLike(post.id)}>❤️ {post.likes}</button>
		</article>
	{/each}
{/if}

<!-- or await-based, with <svelte:boundary> -->
<!-- {#each await getPosts() as post} ... {/each} -->

<form {...createPost}>
	<label>
		Title
		<input {...createPost.fields.title.as('text')} />
		{#each createPost.fields.title.issues() ?? [] as issue}
			<span class="error">{issue.message}</span>
		{/each}
	</label>
	<textarea {...createPost.fields.content.as('text')}></textarea>
	<button disabled={!!createPost.pending}>Publish</button>
</form>
```

Queries with the same argument share a single cached instance, no matter where they are
called from. When nothing references a query anymore, its cache entry is released
automatically.

## API

The API mirrors SvelteKit remote functions — the
[official docs](https://svelte.dev/docs/kit/remote-functions) apply almost verbatim.
A condensed tour:

### `query`

```ts
const getTodos = query(async () => [...]);                             // no argument
const search   = query((f: { filter?: string }) => {...});             // TS-inferred argument
const getTodo  = query(v.string(), async (id) => {...});               // validated argument
const legacy   = query('unchecked', async (filters: Filters) => {...}); // typed, unvalidated
```

Since everything runs locally (no trust boundary), the argument type can be inferred
straight from the handler's parameter — no schema, no `'unchecked'` (this is a
[local-only extension](./DIFFERENCES.md#validation-is-optional-for-query-and-command-typescript-inferred-arguments)
to the kit API). Use a schema whenever the value comes from outside your code.

Calling `getTodo(id)` returns a `LocalQuery<T>`:

- `current` — latest value (`undefined` until `ready`)
- `ready` / `loading` / `error` — reactive state (`loading` is also `true` during refreshes)
- awaitable: `await getTodo(id)` resolves to the value
- `refresh()` — re-run the function
- `set(value)` — replace the value without re-running
- `withOverride(fn)` — optimistic override for use with `.updates(...)`

### `query.batch`

Solves n+1 against your local store: calls within the same macrotask are collected, the
handler receives all arguments at once and returns a resolver to fan results back out.

```ts
const getUser = query.batch(v.string(), async (ids) => {
	const users = await db.users.bulkGet(ids);
	const lookup = new Map(users.map((u) => [u.id, u]));
	return (id) => lookup.get(id);
});
```

### `query.live`

The handler returns an `AsyncIterable` (usually an async generator); every yielded value
becomes `current`. Back it with whatever emits changes — `BroadcastChannel`, storage
events, IndexedDB observers, timers:

```ts
const onlineUsers = query.live(async function* () {
	const channel = new BroadcastChannel('presence');
	try {
		yield await currentUsers();
		while (true) {
			await new Promise((resolve) => channel.addEventListener('message', resolve, { once: true }));
			yield await currentUsers();
		}
	} finally {
		channel.close();
	}
});
```

The instance additionally exposes `connected`, `done`, `reconnect()` and is
async-iterable itself (`for await (const users of onlineUsers())`).

### `command`

```ts
const addTodo = command((text: string) => db.todos.add({ text })); // TS-inferred argument
const addSafe = command(v.string(), async (text) => {
	// schema-validated
	await db.todos.add({ text });
});
```

- `addTodo.pending` — reactive count of in-flight executions.
- Refresh what changed, either inside the handler (`getTodos().refresh()`) or from the
  call site with **single-flight semantics** — the awaited promise resolves only after
  the refreshed queries have re-run:

```ts
const todos = getTodos();

await addTodo(text).updates(
	todos.withOverride((current) => [...current, { text }]) // optimistic
);
```

`.updates(...)` accepts query functions (refresh all active instances), query instances,
and `withOverride` releases.

### `form`

```ts
const updateTodo = form(v.object({ id: v.string(), text: v.string() }), async (data, issue) => {
	if (await isDuplicate(data.text)) invalid(issue.text('Already exists'));
	await db.todos.put(data);
});
```

- Spread onto a `<form>`: `<form {...updateTodo}>`.
- **`fields`** — typed accessors: `fields.text.as('text')` (spreadable input props with
  `name`, coercion prefixes, `aria-invalid`), `.value()`, `.set()`, `.issues()`,
  `fields.allIssues()`. Nested paths (`fields.user.emails[0]`) work.
- Schema failures skip the handler and populate `issues()`; `invalid()` +
  the `issue` proxy create issues imperatively.
- `result`, `pending`, `submitted`, `element`, programmatic `submit()`,
  `validate({ includeUntouched, preflightOnly })`, `preflight(schema)`.
- `for(key)` creates keyed instances for forms in a loop (`updateTodo.for(todo.id)`),
  injecting the key as `data.id`.
- `enhance(callback)` customizes submission; combine with `.updates(...)` for
  optimistic updates:

```svelte
<form
	{...updateTodo.enhance(async (form) => {
		await form.submit().updates(todos.withOverride((t) => optimistically(t)));
		form.element.reset();
	})}
>
```

By default a successful submission **refreshes all active queries** (the local
equivalent of kit's `invalidateAll()`); taking control via `.updates(...)` or by
refreshing/setting queries inside the handler disables that.

### `init` — app-level hooks

```ts
import { init } from 'svelte-local-query';
import { goto } from '$app/navigation'; // or your router

init({
	redirect: (location) => goto(location), // handles redirect(...) from query/form handlers
	onerror: (error) => showToast(error) // form submission errors (default: rethrow)
});
```

### Other exports

`redirect(location)`, `isRedirect`, `Redirect`, `invalid(...issues)`,
`isValidationError`, `ValidationError`, and the full set of types:
`LocalQuery`, `LocalQueryFunction`, `LocalCommand`, `LocalForm`, `LocalLiveQuery`,
`LocalResource`, `LocalFormIssue`, … (structural ports of kit's `Remote*` types).

## Differences from SvelteKit remote functions

Everything transport-related is gone, and a handful of behaviors necessarily change
(no `prerender`, no non-JS form fallback, JSON cache keys, direct validation errors,
pluggable redirects, …). The complete annotated list lives in
[DIFFERENCES.md](./DIFFERENCES.md).

## Development

```sh
npm test          # vitest suite (jsdom; --expose-gc for cache-eviction tests)
npm run test:e2e  # Playwright suite driving the playground in Chromium
npm run check     # svelte-check, strict TS
npm run build     # svelte-package + publint
npm run dev       # vite playground (the page the e2e suite drives)
```

## Acknowledgements

The architecture and most of the runtime are ported from
[SvelteKit](https://github.com/sveltejs/kit)'s remote-functions client (MIT License,
© the Svelte contributors). This project just removes the network.

## License

MIT
