import { tick } from 'svelte';
import { once } from './utils.js';

/*
 * Ported from SvelteKit (MIT) — packages/kit/src/runtime/client/remote-functions/cache.svelte.js
 */

export interface CacheEntry<R> {
	/**
	 * The number of live proxy instances referencing this entry. The entry is
	 * eligible for eviction when this hits zero.
	 */
	proxy_count: number;
	/** The actual reactive resource (Query or LiveQuery). */
	resource: R;
	/** Tears down the `$effect.root` that owns the resource. Run when the entry is evicted. */
	cleanup: () => void;
}

interface ProxyFinalizerToken<R> {
	entry: CacheEntry<R>;
	id: string;
	payload: string;
}

/**
 * Cache controller bound to a specific cache map and resource teardown function. Owns the
 * eviction scheduling and FinalizationRegistry for its cache.
 *
 * Methods are defined as arrow-function class fields so they can be destructured and
 * re-exported without losing their `this` binding.
 */
export class CacheController<R> {
	#cache_map: Map<string, Map<string, CacheEntry<R>>>;

	#destroy_resource: ((resource: R) => void) | undefined;

	/**
	 * The held value points at the cache entry the proxy is contributing to. When the
	 * proxy is GC'd, we decrement that entry's `proxy_count` and schedule a deferred
	 * eviction check.
	 */
	#proxy_finalizer = new FinalizationRegistry<ProxyFinalizerToken<R>>(
		({ entry, id, payload }) => {
			this.deref(entry, id, payload);
		}
	);

	/**
	 * @param cache_map
	 * @param destroy_resource Optional teardown hook called on the resource itself before
	 *   the cache entry's `$effect.root` cleanup runs. Used by live queries to stop the
	 *   underlying iterator.
	 */
	constructor(
		cache_map: Map<string, Map<string, CacheEntry<R>>>,
		destroy_resource?: (resource: R) => void
	) {
		this.#cache_map = cache_map;
		this.#destroy_resource = destroy_resource;
	}

	/**
	 * Get-or-create the cache entry for `(id, payload)`. The resource is constructed
	 * inside an `$effect.root`, the cleanup of which is stored on the entry.
	 */
	ensure_entry = (id: string, payload: string, create_resource: () => R): CacheEntry<R> => {
		let entries = this.#cache_map.get(id);

		if (!entries) {
			entries = new Map();
			this.#cache_map.set(id, entries);
		}

		let entry = entries.get(payload);

		if (!entry) {
			const c = {
				proxy_count: 0,
				resource: null as R,
				cleanup: null as unknown as () => void
			};

			c.cleanup = $effect.root(() => {
				c.resource = create_resource();
			});

			entry = c as CacheEntry<R>;
			entries.set(payload, entry);
		}

		return entry;
	};

	/**
	 * Register a reference to a resource cache entry using an anchor object with the
	 * FinalizationRegistry. When the anchor object is garbage collected, the held value's
	 * `entry.proxy_count` is decremented and a deferred eviction check is scheduled.
	 */
	ref = (anchor: object, entry: CacheEntry<R>, id: string, payload: string): void => {
		entry.proxy_count++;
		this.#proxy_finalizer.register(anchor, { entry, id, payload });
	};

	/**
	 * Manually reference this cache entry. Danger: This entry will never be cleaned up
	 * unless the returned callback is called.
	 */
	manual_ref = (entry: CacheEntry<R>, id: string, payload: string): (() => void) => {
		entry.proxy_count++;
		return once(() => this.deref(entry, id, payload));
	};

	/**
	 * Dereference this cache entry. If the entry's `proxy_count` hits zero, schedule a
	 * deferred eviction check.
	 */
	deref = (entry: CacheEntry<R>, id: string, payload: string): void => {
		entry.proxy_count--;
		void tick().then(() => {
			const entry = this.#cache_map.get(id)?.get(payload);
			if (!entry || entry.proxy_count > 0) return;
			this.#evict(id, payload);
		});
	};

	/**
	 * Tear down the cache entry for `(id, payload)` if it exists. Runs the optional
	 * resource teardown and the entry's `$effect.root` cleanup, then removes the entry
	 * from the cache map.
	 */
	#evict = (id: string, payload: string): void => {
		const entries = this.#cache_map.get(id);
		const entry = entries?.get(payload);
		if (!entry) return;

		this.#destroy_resource?.(entry.resource);
		entry.cleanup();
		entries?.delete(payload);
		if (entries && entries.size === 0) {
			this.#cache_map.delete(id);
		}
	};
}
