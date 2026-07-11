import { CacheController, type CacheEntry } from './cache.svelte.js';
import { create_key, split_key } from './stringify.js';
import { noop } from './utils.js';
import type { LocalQueryUpdate } from '../types.js';

/*
 * Partially ported from SvelteKit (MIT) —
 * packages/kit/src/runtime/client/remote-functions/shared.svelte.js
 */

/** Indicates a query function, as opposed to a query instance */
export const QUERY_FUNCTION_ID = Symbol('local-query.function_id');
/** Indicates a query override release callback, used to release the override */
export const QUERY_OVERRIDE_KEY = Symbol('local-query.override_key');
/** Indicates a query instance */
export const QUERY_RESOURCE_KEY = Symbol('local-query.resource_key');

interface QueryResource {
	refresh(): Promise<void>;
	set(value: unknown): void;
}

interface LiveQueryResource {
	reconnect(): Promise<void>;
	destroy(): void;
}

export const query_map = new Map<string, Map<string, CacheEntry<QueryResource>>>();
export const live_query_map = new Map<string, Map<string, CacheEntry<LiveQueryResource>>>();

export const query_cache = new CacheController<QueryResource>(query_map);
export const live_query_cache = new CacheController<LiveQueryResource>(live_query_map, (resource) =>
	resource.destroy()
);

/**
 * Monotonic counter bumped whenever a query is refreshed or set. A `form` handler
 * samples it before/after running: if it changed, the developer took control of
 * invalidation inside the handler (the local equivalent of SvelteKit's server-driven
 * single-flight refreshes) and the form skips its default refresh-all behavior.
 */
let mutation_epoch = 0;

export function bump_epoch(): void {
	mutation_epoch++;
}

export function get_epoch(): number {
	return mutation_epoch;
}

/**
 * If we're inside a reactive context, pin a cache entry for as long as the
 * surrounding effect is alive. Without this, a transiently-referenced proxy
 * (e.g. one produced by `{await fn()}` in a template) would be eligible for GC
 * as soon as the awaited value has been read, after which the
 * FinalizationRegistry would evict the cache entry — even though the consuming
 * effect is still alive and may rely on the entry being refreshed.
 */
export function pin_in_effect<R>(
	cache_map: Map<string, Map<string, CacheEntry<R>>>,
	cache: CacheController<R>,
	id: string,
	payload: string
): void {
	try {
		$effect.pre(() => {
			const entry = cache_map.get(id)?.get(payload);
			if (!entry) return;
			return cache.manual_ref(entry, id, payload);
		});
	} catch {
		// not in an effect context — nothing to pin
	}
}

/**
 * Wrap a proxy's `then`/`catch`/`finally` function so that the underlying cache
 * entry stays pinned for the lifetime of the awaited promise. Without this, a
 * proxy awaited outside any effect (e.g. in an event handler) could be GC'd
 * between the `.then` getter returning the thenable and the underlying promise
 * settling, causing the cache entry to be evicted mid-flight.
 */
export function pin_while_resolving<R, TThen extends (...args: any[]) => Promise<any>>(
	cache_map: Map<string, Map<string, CacheEntry<R>>>,
	cache: CacheController<R>,
	id: string,
	payload: string,
	then: TThen
): TThen {
	return ((...a: unknown[]) => {
		const entry = cache_map.get(id)?.get(payload);
		const release = entry ? cache.manual_ref(entry, id, payload) : undefined;
		const promise = then(...a);
		if (release) {
			promise.then(release, release);
		}
		return promise;
	}) as TThen;
}

/**
 * Given an array of updates, which could be query instances, query functions, or query
 * override release functions, categorize them into overrides (which need to be released
 * after the command completes), refreshes (which need to be refreshed after the command
 * completes), or both.
 */
export function categorize_updates(updates: LocalQueryUpdate[]): {
	overrides: Array<() => void>;
	refreshes: Set<string>;
} {
	const override_keys = new Set<string>();
	const overrides: Array<() => void> = [];
	const refreshes = new Set<string>();

	for (const update of updates) {
		if (typeof update === 'function') {
			if (Object.hasOwn(update, QUERY_FUNCTION_ID)) {
				// this is a query function (not instance), so we need to find all active
				// instances of this function and refresh/reconnect them
				const id = (update as unknown as Record<symbol, string>)[QUERY_FUNCTION_ID] as string;
				const entries = query_map.get(id) ?? live_query_map.get(id);

				if (entries) {
					for (const payload of entries.keys()) {
						refreshes.add(create_key(id, payload));
					}
				}

				continue;
			}

			if (Object.hasOwn(update, QUERY_OVERRIDE_KEY)) {
				// this is a query override release function, so we need to both refresh the
				// query instance _and_ stash the release function so we can release the
				// override after the command completes
				const key = (update as unknown as Record<symbol, string>)[QUERY_OVERRIDE_KEY] as string;
				refreshes.add(key);

				if (override_keys.has(key)) {
					throw new Error(
						'Multiple overrides for the same query are not allowed in a single updates() invocation'
					);
				}

				override_keys.add(key);
				overrides.push(update as () => void);
				continue;
			}

			// this is just a regular function provided by some user integration,
			// so we can just stash it in the overrides array
			overrides.push(update as () => void);
			continue;
		}

		if (
			typeof update === 'object' &&
			update !== null &&
			Object.hasOwn(update, QUERY_RESOURCE_KEY)
		) {
			// this is a query instance, so we just need to refresh it
			refreshes.add((update as unknown as Record<symbol, string>)[QUERY_RESOURCE_KEY] as string);
			continue;
		}

		throw new Error(
			'updates() expects a query or live query function, query resource, or query override'
		);
	}

	return { overrides, refreshes };
}

/**
 * Re-run the queries behind the given cache keys. This is the local equivalent of
 * SvelteKit's single-flight mutations: where kit sends the `refreshes` keys to the
 * server and applies the returned data, we simply re-execute the local functions.
 *
 * Individual refresh errors do not reject — they are captured as the corresponding
 * query's `error` state, exactly like a failed single-flight refresh in kit.
 */
export function refresh_keys(keys: Iterable<string>): Promise<void> {
	const promises: Array<Promise<unknown>> = [];

	for (const key of keys) {
		const { id, payload } = split_key(key);

		const query_entry = query_map.get(id)?.get(payload);
		if (query_entry) {
			promises.push(query_entry.resource.refresh().catch(noop));
			continue;
		}

		const live_entry = live_query_map.get(id)?.get(payload);
		if (live_entry) {
			promises.push(live_entry.resource.reconnect().catch(noop));
		}
	}

	return Promise.all(promises).then(noop);
}

/**
 * Refresh every active query and reconnect every active live query. This is the local
 * equivalent of the `invalidateAll()` a successful SvelteKit form submission performs.
 */
export function refresh_all(): Promise<void> {
	const promises: Array<Promise<unknown>> = [];

	for (const entries of query_map.values()) {
		for (const entry of entries.values()) {
			promises.push(entry.resource.refresh().catch(noop));
		}
	}

	for (const entries of live_query_map.values()) {
		for (const entry of entries.values()) {
			promises.push(entry.resource.reconnect().catch(noop));
		}
	}

	return Promise.all(promises).then(noop);
}
