import type { StandardSchemaV1 } from '@standard-schema/spec';
import { apply_redirect, isRedirect } from '../config.js';
import { QUERY_FUNCTION_ID } from '../internal/shared.svelte.js';
import { next_id, stringify_arg } from '../internal/stringify.js';
import type {
	LocalQuery,
	LocalQueryFunction,
	LiveQueryHandlerResult,
	LocalLiveQueryFunction,
	MaybePromise
} from '../types.js';
import { parse_declaration, validate_arg, type Validator } from '../validation.js';
import { QueryProxy } from './proxy.js';
import { create_query_live } from '../query-live/index.js';

/**
 * Run a query/command handler, invoking the configured redirect hook when the
 * handler throws a `redirect(...)`. The `Redirect` still propagates as the
 * resource's error so consumers can observe it.
 */
export async function run_with_redirect<T>(fn: () => MaybePromise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		if (isRedirect(e)) apply_redirect(e);
		throw e;
	}
}

function create_query(
	validate_or_fn: Validator | ((arg?: any) => unknown),
	maybe_fn?: (arg?: any) => unknown
): LocalQueryFunction<any, any> {
	const { validate, fn } = parse_declaration(validate_or_fn, maybe_fn);
	const id = next_id('query');

	const wrapper = (arg: unknown) => {
		return new QueryProxy(id, arg, () =>
			run_with_redirect(async () => fn(await validate_arg(validate, arg)))
		) as unknown as LocalQuery<any>;
	};

	Object.defineProperty(wrapper, QUERY_FUNCTION_ID, { value: id });

	return wrapper;
}

interface Batched {
	arg: unknown;
	resolvers: Array<{ resolve: (value: any) => void; reject: (error: unknown) => void }>;
}

function create_query_batch(
	validate: StandardSchemaV1 | 'unchecked',
	fn: (args: any[]) => MaybePromise<(arg: any, idx: number) => unknown>
): LocalQueryFunction<any, any> {
	const id = next_id('query.batch');

	let batching = new Map<string, Batched>();
	let scheduled = false;

	function flush(): void {
		const batched = batching;
		batching = new Map();
		scheduled = false;

		void (async () => {
			// validate each argument individually — a failing argument only rejects
			// its own query, not the whole batch (mirroring kit's per-arg validation)
			const settled = await Promise.all(
				Array.from(batched.values(), async (entry) => {
					try {
						return { entry, validated: await validate_arg(validate, entry.arg) };
					} catch (e) {
						entry.resolvers.forEach(({ reject }) => reject(e));
						return null;
					}
				})
			);

			const valid = settled.filter((v) => v !== null);
			if (valid.length === 0) return;

			try {
				const get = await run_with_redirect(() => fn(valid.map((v) => v.validated)));

				valid.forEach(({ entry, validated }, i) => {
					try {
						const value = get(validated, i);
						entry.resolvers.forEach(({ resolve }) => resolve(value));
					} catch (e) {
						entry.resolvers.forEach(({ reject }) => reject(e));
					}
				});
			} catch (e) {
				for (const { entry } of valid) {
					entry.resolvers.forEach(({ reject }) => reject(e));
				}
			}
		})();
	}

	const wrapper = (arg: unknown) => {
		return new QueryProxy(
			id,
			arg,
			() =>
				new Promise((resolve, reject) => {
					// identical calls share one cache entry, but a refresh re-invokes this
					// function with the same payload, so deduplicate here as well
					const payload = stringify_arg(arg);
					let entry = batching.get(payload);

					if (!entry) {
						batching.set(payload, (entry = { arg, resolvers: [] }));
					}

					entry.resolvers.push({ resolve, reject });

					if (!scheduled) {
						scheduled = true;
						// Wait for the next macrotask — not a microtask, as Svelte's runtime uses
						// those to collect and flush changes, and flushes could reveal more
						// queries that should join the batch.
						setTimeout(flush, 0);
					}
				})
		) as unknown as LocalQuery<any>;
	};

	Object.defineProperty(wrapper, QUERY_FUNCTION_ID, { value: id });

	return wrapper;
}

type InferOutput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferOutput<Schema>;
type InferInput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferInput<Schema>;

export interface QueryFunction {
	/**
	 * Define a query — a reactive, cached, awaitable read operation.
	 *
	 * ```ts
	 * export const getPosts = query(async () => db.getAllPosts());
	 * ```
	 */
	<Output>(fn: () => MaybePromise<Output>): LocalQueryFunction<void, Output>;
	/**
	 * Define a query taking an argument without runtime validation.
	 */
	<Input, Output>(
		validate: 'unchecked',
		fn: (arg: Input) => MaybePromise<Output>
	): LocalQueryFunction<Input, Output>;
	/**
	 * Define a query whose argument is validated with a
	 * [Standard Schema](https://standardschema.dev) (Zod, Valibot, ...).
	 */
	<Schema extends StandardSchemaV1, Output>(
		schema: Schema,
		fn: (arg: InferOutput<Schema>) => MaybePromise<Output>
	): LocalQueryFunction<InferInput<Schema>, Output, InferOutput<Schema>>;

	/**
	 * Define a batch query: calls made within the same macrotask are collected and the
	 * handler is invoked once with all arguments. It must return a resolver
	 * `(arg, index) => output` used to fan results back out to the individual queries.
	 * Useful to avoid n+1 reads against e.g. IndexedDB or SQLite-WASM.
	 */
	batch: {
		<Input, Output>(
			validate: 'unchecked',
			fn: (args: Input[]) => MaybePromise<(arg: Input, idx: number) => Output>
		): LocalQueryFunction<Input, Output>;
		<Schema extends StandardSchemaV1, Output>(
			schema: Schema,
			fn: (
				args: InferOutput<Schema>[]
			) => MaybePromise<(arg: InferOutput<Schema>, idx: number) => Output>
		): LocalQueryFunction<InferInput<Schema>, Output, InferOutput<Schema>>;
	};

	/**
	 * Define a live query: the handler returns an `AsyncIterable` (most commonly an
	 * async generator) and each yielded value becomes the query's `current` value.
	 * Where SvelteKit streams values from the server, the iterable here runs locally —
	 * back it with whatever produces change events (BroadcastChannel, IndexedDB
	 * observers, timers, ...).
	 */
	live: {
		<Output>(
			fn: (arg: void) => LiveQueryHandlerResult<Output>
		): LocalLiveQueryFunction<void, Output>;
		<Input, Output>(
			validate: 'unchecked',
			fn: (arg: Input) => LiveQueryHandlerResult<Output>
		): LocalLiveQueryFunction<Input, Output>;
		<Schema extends StandardSchemaV1, Output>(
			schema: Schema,
			fn: (arg: InferOutput<Schema>) => LiveQueryHandlerResult<Output>
		): LocalLiveQueryFunction<InferInput<Schema>, Output, InferOutput<Schema>>;
	};
}

/**
 * Define a query — the local equivalent of SvelteKit's `query` remote function.
 * Calling the returned function returns a reactive {@link LocalQuery} that can be
 * awaited or read via `current`/`error`/`loading`/`ready`. Identical arguments
 * share a single instance.
 */
export const query: QueryFunction = Object.assign(create_query, {
	batch: create_query_batch,
	live: create_query_live
}) as QueryFunction;
