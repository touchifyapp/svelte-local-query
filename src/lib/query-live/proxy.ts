import {
	live_query_cache as cache,
	live_query_map,
	pin_in_effect,
	pin_while_resolving,
	QUERY_RESOURCE_KEY
} from '../internal/shared.svelte.js';
import { create_key, stringify_arg } from '../internal/stringify.js';
import { LiveQuery } from './instance.svelte.js';

/*
 * Ported from SvelteKit (MIT) —
 * packages/kit/src/runtime/client/remote-functions/query-live/proxy.js
 */

export class LiveQueryProxy<T> {
	#id: string;
	#payload: string;

	constructor(id: string, arg: unknown, fn: () => Promise<AsyncIterable<T>>) {
		this.#id = id;
		this.#payload = stringify_arg(arg);
		const key = create_key(id, this.#payload);
		Object.defineProperty(this, QUERY_RESOURCE_KEY, { value: key });

		// Capture payload in a local so the create_resource closure doesn't capture
		// `this` (the LiveQueryProxy), which would prevent the FinalizationRegistry from
		// observing the proxy as unreachable and so leak the first proxy for a given key.
		const payload = this.#payload;
		const entry = cache.ensure_entry(this.#id, payload, () => new LiveQuery(fn));

		cache.ref(this, entry, this.#id, payload);
	}

	#get_cache_entry() {
		const cached = live_query_map.get(this.#id)?.get(this.#payload);

		if (!cached) {
			throw new Error(
				'No cached query found. This should be impossible. Please file a bug report.'
			);
		}

		return cached;
	}

	#get_cached_query(): LiveQuery<T> {
		return this.#get_cache_entry().resource as unknown as LiveQuery<T>;
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

	get connected(): boolean {
		return this.#get_cached_query().connected;
	}

	get done(): boolean {
		return this.#get_cached_query().done;
	}

	reconnect(): Promise<void> {
		return this.#get_cached_query().reconnect();
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<T, void, void> {
		const entry = this.#get_cache_entry();
		const release = cache.manual_ref(entry, this.#id, this.#payload);

		try {
			yield* this.#get_cached_query();
		} finally {
			release();
		}
	}

	get then(): Promise<T>['then'] {
		pin_in_effect(live_query_map, cache, this.#id, this.#payload);
		const cached = this.#get_cached_query();
		return pin_while_resolving(
			live_query_map,
			cache,
			this.#id,
			this.#payload,
			cached.then.bind(cached)
		);
	}

	get catch(): Promise<T>['catch'] {
		pin_in_effect(live_query_map, cache, this.#id, this.#payload);
		const cached = this.#get_cached_query();
		return pin_while_resolving(
			live_query_map,
			cache,
			this.#id,
			this.#payload,
			cached.catch.bind(cached)
		);
	}

	get finally(): Promise<T>['finally'] {
		pin_in_effect(live_query_map, cache, this.#id, this.#payload);
		const cached = this.#get_cached_query();
		return pin_while_resolving(
			live_query_map,
			cache,
			this.#id,
			this.#payload,
			cached.finally.bind(cached)
		);
	}

	get [Symbol.toStringTag](): string {
		return 'LiveQueryProxy';
	}
}
