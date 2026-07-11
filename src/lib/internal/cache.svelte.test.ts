import { describe, expect, test, beforeEach } from 'vitest';
import { tick } from 'svelte';
import { CacheController, type CacheEntry } from './cache.svelte.js';
import { has_gc, wait_for } from '../../tests/helpers.js';

interface FakeResource {
	id: string;
	destroyed: boolean;
}

describe('CacheController', () => {
	let cache_map: Map<string, Map<string, CacheEntry<FakeResource>>>;
	let destroyed: FakeResource[];
	let cache: CacheController<FakeResource>;

	beforeEach(() => {
		cache_map = new Map();
		destroyed = [];
		cache = new CacheController(cache_map, (resource) => {
			resource.destroyed = true;
			destroyed.push(resource);
		});
	});

	test('ensure_entry creates a single entry per (id, payload)', () => {
		let constructions = 0;
		const factory = () => {
			constructions++;
			return { id: 'x', destroyed: false };
		};

		const a = cache.ensure_entry('q', 'p', factory);
		const b = cache.ensure_entry('q', 'p', factory);
		const c = cache.ensure_entry('q', 'other', factory);

		expect(constructions).toBe(2);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(cache_map.get('q')?.size).toBe(2);
	});

	test('ref increments proxy_count', () => {
		const entry = cache.ensure_entry('q', 'p', () => ({ id: 'x', destroyed: false }));
		expect(entry.proxy_count).toBe(0);

		const anchor = {};
		cache.ref(anchor, entry, 'q', 'p');

		expect(entry.proxy_count).toBe(1);
	});

	test('manual_ref increments and the returned deref decrements proxy_count', async () => {
		const entry = cache.ensure_entry('q', 'p', () => ({ id: 'x', destroyed: false }));
		const release = cache.manual_ref(entry, 'q', 'p');
		expect(entry.proxy_count).toBe(1);

		release();
		expect(entry.proxy_count).toBe(0);

		// Eviction is deferred via tick().then(...); pump microtasks
		await tick();
		await tick();

		expect(cache_map.get('q')?.get('p')).toBeUndefined();
		expect(destroyed).toHaveLength(1);
	});

	test('releasing a manual_ref twice only decrements once', async () => {
		const entry = cache.ensure_entry('q', 'p', () => ({ id: 'x', destroyed: false }));
		const release_a = cache.manual_ref(entry, 'q', 'p');
		const release_b = cache.manual_ref(entry, 'q', 'p');

		release_a();
		release_a();
		await tick();
		await tick();

		expect(entry.proxy_count).toBe(1);
		expect(cache_map.get('q')?.get('p')).toBe(entry);

		release_b();
		await tick();
		await tick();

		expect(cache_map.has('q')).toBe(false);
	});

	test('eviction calls destroy_resource and removes the entry', async () => {
		const entry = cache.ensure_entry('q', 'p', () => ({ id: 'x', destroyed: false }));
		const release = cache.manual_ref(entry, 'q', 'p');

		release();
		await tick();
		await tick();

		expect(entry.resource.destroyed).toBe(true);
		expect(cache_map.has('q')).toBe(false);
	});

	test('entry survives while at least one ref is alive', async () => {
		const entry = cache.ensure_entry('q', 'p', () => ({ id: 'x', destroyed: false }));
		const release_a = cache.manual_ref(entry, 'q', 'p');
		const release_b = cache.manual_ref(entry, 'q', 'p');

		release_a();
		await tick();
		await tick();

		expect(cache_map.get('q')?.get('p')).toBe(entry);
		expect(entry.proxy_count).toBe(1);

		release_b();
		await tick();
		await tick();

		expect(cache_map.get('q')?.get('p')).toBeUndefined();
	});

	describe.runIf(has_gc)('garbage collection', () => {
		test('FinalizationRegistry evicts the entry when the anchor is garbage collected', async () => {
			const entry = cache.ensure_entry('q', 'p', () => ({ id: 'x', destroyed: false }));

			// Create the anchor inside an IIFE so it has no name in the surrounding scope.
			(() => {
				const anchor = {};
				cache.ref(anchor, entry, 'q', 'p');
			})();

			expect(entry.proxy_count).toBe(1);
			expect(cache_map.get('q')?.get('p')).toBe(entry);

			await wait_for(() => !cache_map.get('q')?.has('p'));

			expect(cache_map.has('q')).toBe(false);
			expect(entry.resource.destroyed).toBe(true);
		});

		test('entry is retained while any anchor is reachable', async () => {
			const entry = cache.ensure_entry('q', 'p', () => ({ id: 'x', destroyed: false }));

			const live_anchor = {};
			cache.ref(live_anchor, entry, 'q', 'p');

			// A second anchor that goes out of scope immediately
			(() => {
				const ephemeral = {};
				cache.ref(ephemeral, entry, 'q', 'p');
			})();

			expect(entry.proxy_count).toBe(2);

			// The ephemeral anchor should be GC'd, dropping the count to 1
			await wait_for(() => entry.proxy_count === 1);

			expect(entry.proxy_count).toBe(1);
			expect(cache_map.get('q')?.get('p')).toBe(entry);
			expect(entry.resource.destroyed).toBe(false);

			// `live_anchor` is still in scope; entry must persist
			expect(live_anchor).toBeDefined();
		});
	});
});
