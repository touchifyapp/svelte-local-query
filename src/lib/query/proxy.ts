import {
	pin_in_effect,
	pin_while_resolving,
	query_cache as cache,
	query_map,
	QUERY_OVERRIDE_KEY,
	QUERY_RESOURCE_KEY
} from '../internal/shared.svelte.js';
import { create_key, stringify_arg } from '../internal/stringify.js';
import { Query } from './instance.svelte.js';

/*
 * Ported from SvelteKit (MIT) —
 * packages/kit/src/runtime/client/remote-functions/query/proxy.js
 */

/**
 * Manages the caching layer between the user and the actual {@link Query} instance.
 * This is the thing the developer actually gets to interact with in their application code.
 */
export class QueryProxy<T> {
	#id: string;
	#key: string;
	#payload: string;
	#fn: () => Promise<T>;

	constructor(id: string, arg: unknown, fn: () => Promise<T>) {
		this.#id = id;
		this.#payload = stringify_arg(arg);
		this.#key = create_key(id, this.#payload);
		Object.defineProperty(this, QUERY_RESOURCE_KEY, { value: this.#key });
		this.#fn = fn;

		const key = this.#key;
		const entry = cache.ensure_entry(
			this.#id,
			this.#payload,
			// IMPORTANT: This cannot close over `this` or it becomes impossible to
			// garbage collect the QueryProxy and thus impossible to evict cache entries.
			() => new Query(key, fn)
		);

		cache.ref(this, entry, this.#id, this.#payload);
	}

	#get_cached_query(): Query<T> {
		const cached = query_map.get(this.#id)?.get(this.#payload);

		if (!cached) {
			// Sanity check: a live proxy should always keep its cache entry alive via
			// `proxy_count`, and the invalidation paths never locally evict entries.
			throw new Error(
				'No cached query found. This should be impossible. Please file a bug report.'
			);
		}

		return cached.resource as unknown as Query<T>;
	}

	get current(): T | undefined {
		return this.#get_cached_query().current;
	}

	get error(): unknown {
		return this.#get_cached_query().error;
	}

	get loading(): boolean {
		return this.#get_cached_query().loading;
	}

	get ready(): boolean {
		return this.#get_cached_query().ready;
	}

	refresh(): Promise<void> {
		return this.#get_cached_query().refresh();
	}

	set(value: T): void {
		this.#get_cached_query().set(value);
	}

	withOverride(fn: (old: T) => T): () => void {
		const fn_ref = this.#fn;
		const key_ref = this.#key;
		// The override increments `proxy_count` to keep the cache entry alive until the
		// release function is called.
		const entry = cache.ensure_entry(
			this.#id,
			this.#payload,
			// IMPORTANT: This cannot close over `this` or it becomes impossible to
			// garbage collect the QueryProxy and thus impossible to evict cache entries.
			() => new Query(key_ref, fn_ref)
		);

		const deref = cache.manual_ref(entry, this.#id, this.#payload);

		const override = (entry.resource as unknown as Query<T>).withOverride(fn);

		const release = (() => {
			override();
			deref();
		}) as (() => void) & { [QUERY_OVERRIDE_KEY]: string };

		Object.defineProperty(release, QUERY_OVERRIDE_KEY, { value: override[QUERY_OVERRIDE_KEY] });

		return release;
	}

	get then(): Promise<T>['then'] {
		pin_in_effect(query_map, cache, this.#id, this.#payload);
		const cached = this.#get_cached_query();
		return pin_while_resolving(
			query_map,
			cache,
			this.#id,
			this.#payload,
			cached.then.bind(cached)
		);
	}

	get catch(): Promise<T>['catch'] {
		pin_in_effect(query_map, cache, this.#id, this.#payload);
		const cached = this.#get_cached_query();
		return pin_while_resolving(
			query_map,
			cache,
			this.#id,
			this.#payload,
			cached.catch.bind(cached)
		);
	}

	get finally(): Promise<T>['finally'] {
		pin_in_effect(query_map, cache, this.#id, this.#payload);
		const cached = this.#get_cached_query();
		return pin_while_resolving(
			query_map,
			cache,
			this.#id,
			this.#payload,
			cached.finally.bind(cached)
		);
	}

	get [Symbol.toStringTag](): string {
		return 'QueryProxy';
	}
}
