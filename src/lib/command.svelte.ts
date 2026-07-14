import type { StandardSchemaV1 } from '@standard-schema/spec';
import { isRedirect } from './config.js';
import { categorize_updates, refresh_keys } from './internal/shared.svelte.js';
import { next_id } from './internal/stringify.js';
import type { LocalCommand, LocalQueryUpdate, MaybePromise } from './types.js';
import { parse_declaration, validate_arg, type Validator } from './validation.js';

/*
 * Ported from SvelteKit (MIT) —
 * packages/kit/src/runtime/client/remote-functions/command.svelte.js
 *
 * Local differences: the handler runs in-process instead of via a POST request, and
 * the single-flight `refreshes` are applied by re-running the affected queries
 * locally after the handler resolves (instead of the server returning fresh data in
 * the same response).
 */

function create_command(
	validate_or_fn: Validator | ((arg?: any) => unknown),
	maybe_fn?: (arg?: any) => unknown
): LocalCommand<any, any> {
	const { validate, fn } = parse_declaration(validate_or_fn, maybe_fn);
	const id = next_id('command');
	void id;

	let pending_count = $state(0);

	// Careful: This function MUST be synchronous (can't use the async keyword) because
	// the return type has to be a promise with an updates() method. If we make it async,
	// the return type will be a promise that resolves to a promise with an updates()
	// method, which is not what we want.
	const command_function = ((arg: unknown) => {
		// stored on a mutable holder because the assignments happen in the `updates`
		// closure after the async body below has already started
		const updates_state: {
			overrides: Array<() => void> | null;
			refreshes: Set<string> | null;
			error: Error | undefined;
		} = { overrides: null, refreshes: null, error: undefined };

		// Increment pending count when command starts
		pending_count++;

		const promise = (async () => {
			try {
				// Wait a tick to give room for the `updates` method to be called
				await Promise.resolve();

				if (updates_state.error) {
					throw updates_state.error;
				}

				let result;

				try {
					result = await fn(await validate_arg(validate, arg));
				} catch (e) {
					if (isRedirect(e)) {
						throw new Error(
							'Redirects are not allowed in commands. Return a result instead and navigate on the caller side'
						);
					}
					throw e;
				}

				// single-flight mutation: re-run the requested queries before resolving,
				// so that awaiting `command(...).updates(...)` guarantees fresh data
				if (updates_state.refreshes !== null) {
					await refresh_keys(updates_state.refreshes);
				}

				return result;
			} finally {
				updates_state.overrides?.forEach((fn) => fn());

				// Decrement pending count when command completes
				pending_count--;
			}
		})() as Promise<any> & { updates: (...args: LocalQueryUpdate[]) => Promise<any> };

		let updates_called = false;
		promise.updates = (...args) => {
			if (updates_called) {
				console.warn(
					'Updates can only be applied once per command invocation. Ignoring additional updates.'
				);
				return promise;
			}
			updates_called = true;

			try {
				const { refreshes, overrides } = categorize_updates(args);
				updates_state.refreshes = refreshes;
				updates_state.overrides = overrides;
			} catch (error) {
				updates_state.error = error as Error;
			}

			return promise;
		};

		return promise;
	}) as LocalCommand<any, any>;

	Object.defineProperty(command_function, 'pending', {
		get: () => pending_count
	});

	return command_function;
}

type InferOutput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferOutput<Schema>;
type InferInput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferInput<Schema>;

/**
 * Define a command — the local equivalent of SvelteKit's `command` remote function.
 * Call it from anywhere (except during render) to perform a mutation:
 *
 * ```ts
 * export const addLike = command(v.string(), async (id) => {
 * 	await db.addLike(id);
 * 	getLikes(id).refresh(); // or: addLike(id).updates(getLikes(id)) at the call site
 * });
 * ```
 */
export function command<Output>(fn: () => MaybePromise<Output>): LocalCommand<void, Output>;
/**
 * Define a command whose argument type is inferred from the handler's parameter —
 * no runtime validation, TypeScript only (see DIFFERENCES.md).
 */
export function command<Input, Output>(
	fn: (arg: Input) => MaybePromise<Output>
): LocalCommand<Input, Output>;
export function command<Input, Output>(
	validate: 'unchecked',
	fn: (arg: Input) => MaybePromise<Output>
): LocalCommand<Input, Output>;
export function command<Schema extends StandardSchemaV1, Output>(
	validate: Schema,
	fn: (arg: InferOutput<Schema>) => MaybePromise<Output>
): LocalCommand<InferInput<Schema>, Output>;
export function command(
	validate_or_fn: Validator | ((arg?: any) => unknown),
	maybe_fn?: (arg?: any) => unknown
): LocalCommand<any, any> {
	return create_command(validate_or_fn, maybe_fn);
}
