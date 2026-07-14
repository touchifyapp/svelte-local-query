import { describe, expect, test } from 'vitest';
import { tick } from 'svelte';
import * as v from 'valibot';
import { query } from './index.js';
import { query_map } from '../internal/shared.svelte.js';
import { isValidationError } from '../validation.js';
import { flush, has_gc, track_unhandled, wait_for } from '../../tests/helpers.js';
import { with_resolvers, type PromiseWithResolvers } from '../internal/utils.js';

function get_id(fn: unknown): string {
	const symbols = Object.getOwnPropertySymbols(fn);
	return (fn as Record<symbol, string>)[symbols[0] as symbol] as string;
}

describe('query', () => {
	test('is lazy: the function only runs once a property is read', async () => {
		let calls = 0;
		const get = query(() => {
			calls++;
			return 'value';
		});

		const q = get();
		expect(calls).toBe(0);

		expect(q.loading).toBe(true);
		await flush();

		expect(calls).toBe(1);
		expect(q.ready).toBe(true);
		expect(q.current).toBe('value');
		expect(q.loading).toBe(false);
		expect(q.error).toBeUndefined();
	});

	test('awaiting resolves to the value', async () => {
		const get = query(async () => 42);
		await expect(get()).resolves.toBe(42);
	});

	test('identical arguments share a single execution and state', async () => {
		let calls = 0;
		const get = query('unchecked', async (arg: { limit: number; offset: number }) => {
			calls++;
			return arg.limit;
		});

		const a = get({ limit: 10, offset: 0 });
		// property order must not matter for the cache key
		const b = get({ offset: 0, limit: 10 });

		await expect(a).resolves.toBe(10);
		await expect(b).resolves.toBe(10);
		expect(calls).toBe(1);

		// both proxies observe the same resource
		b.set(99);
		expect(a.current).toBe(99);
	});

	test('different arguments produce independent instances', async () => {
		let calls = 0;
		const get = query('unchecked', async (n: number) => {
			calls++;
			return n * 2;
		});

		await expect(get(1)).resolves.toBe(2);
		await expect(get(2)).resolves.toBe(4);
		expect(calls).toBe(2);
	});

	test('refresh() re-runs the function', async () => {
		let calls = 0;
		const get = query(async () => ++calls);

		const q = get();
		await expect(q).resolves.toBe(1);

		await q.refresh();
		expect(q.current).toBe(2);
	});

	test('set() updates the value without re-running', async () => {
		let calls = 0;
		const get = query(async () => {
			calls++;
			return 'initial';
		});

		const q = get();
		await q;

		q.set('replaced');
		expect(q.current).toBe('replaced');
		expect(calls).toBe(1);
		await expect(q).resolves.toBe('replaced');
	});

	test('loading is true during refreshes, ready stays true', async () => {
		let deferred: PromiseWithResolvers<string> | undefined;
		const get = query(() => {
			deferred = with_resolvers<string>();
			return deferred.promise;
		});

		const q = get();
		expect(q.loading).toBe(true);
		await flush();
		deferred!.resolve('first');
		await flush();

		expect(q.loading).toBe(false);
		expect(q.ready).toBe(true);

		const refreshed = q.refresh();
		expect(q.loading).toBe(true);
		expect(q.ready).toBe(true);
		expect(q.current).toBe('first');

		// the handler starts a microtask later (argument validation is async)
		await flush();
		deferred!.resolve('second');
		await refreshed;
		expect(q.loading).toBe(false);
		expect(q.current).toBe('second');
	});

	test('an older run resolving after a newer one is discarded', async () => {
		const deferreds: PromiseWithResolvers<string>[] = [];
		const get = query(() => {
			const deferred = with_resolvers<string>();
			deferreds.push(deferred);
			return deferred.promise;
		});

		const q = get();
		void q.loading;
		await flush();

		const refresh_promise = q.refresh();
		await flush();
		expect(deferreds).toHaveLength(2);

		// the newer run resolves first...
		deferreds[1]!.resolve('new');
		await refresh_promise;
		expect(q.current).toBe('new');

		// ...and the older result must not overwrite it
		deferreds[0]!.resolve('stale');
		await flush();
		expect(q.current).toBe('new');
	});

	test('errors are surfaced on `error` and reject awaiting consumers', async () => {
		const oops = new Error('nope');
		const get = query(async () => {
			throw oops;
		});

		const q = get();
		await expect(q).rejects.toBe(oops);
		expect(q.error).toBe(oops);
		expect(q.ready).toBe(false);
		expect(q.loading).toBe(false);
	});

	test('reactive consumption of a failing query never produces unhandled rejections', async () => {
		const tracker = track_unhandled();
		try {
			const get = query(async () => {
				throw new Error('nope');
			});

			const q = get();
			void q.current; // reactive read triggers start(), nobody awaits
			await flush();

			expect(q.error).toBeInstanceOf(Error);
			expect(tracker.unhandled).toEqual([]);
		} finally {
			tracker.stop();
		}
	});

	test('schema validation runs on the argument and failures surface as the error', async () => {
		const get = query(v.string(), async (s) => s.toUpperCase());

		await expect(get('ok')).resolves.toBe('OK');

		const q = get(42 as unknown as string);
		await expect(q).rejects.toSatisfy(isValidationError);
		expect(isValidationError(q.error)).toBe(true);
	});

	test('schema transforms are applied before the handler', async () => {
		const get = query(
			v.pipe(
				v.number(),
				v.transform((n) => String(n))
			),
			async (s) => typeof s
		);

		await expect(get(42)).resolves.toBe('string');
	});

	test('calling an argument-less query with an argument throws in dev', async () => {
		const get = query(async () => 'x');
		// @ts-expect-error extra argument
		await expect(get('nope')).rejects.toThrowError(/does not take an argument/);
	});

	test('withOverride layers on top of the current value and can be released', async () => {
		const get = query(async () => [1, 2]);

		const q = get();
		await q;

		const release = q.withOverride((values) => [...values, 3]);
		expect(q.current).toEqual([1, 2, 3]);

		// awaiting resolves to the overridden value
		await expect(q).resolves.toEqual([1, 2, 3]);

		release();
		expect(q.current).toEqual([1, 2]);
	});

	describe('TypeScript-inferred arguments', () => {
		test('a bare handler with a parameter accepts an argument without validation', async () => {
			const get = query(({ filter, sort }: { filter?: string; sort?: string }) => {
				return `${filter ?? ''}|${sort ?? ''}`;
			});

			await expect(get({ filter: 'name eq Claude' })).resolves.toBe('name eq Claude|');
			await expect(get({ filter: 'a', sort: 'name' })).resolves.toBe('a|name');
		});

		test('inferred arguments still deduplicate by stable cache key', async () => {
			let calls = 0;
			const get = query((arg: { limit: number; offset: number }) => {
				calls++;
				return arg.limit;
			});

			const a = get({ limit: 10, offset: 0 });
			const b = get({ offset: 0, limit: 10 });

			await expect(a).resolves.toBe(10);
			await expect(b).resolves.toBe(10);
			expect(calls).toBe(1);
		});

		test('the value is passed through untouched (no schema, no coercion)', async () => {
			const get = query((n: number) => typeof n);

			// runtime lies are allowed — TypeScript is the only guard
			await expect(get('42' as unknown as number)).resolves.toBe('string');
		});

		test('wrongly-typed arguments are rejected at compile time', () => {
			const get = query((n: number) => n + 1);
			// @ts-expect-error string is not assignable to number
			void get('nope');
		});

		test('handlers with only default parameters are treated as argument-less (documented caveat)', async () => {
			const get = query((n = 1) => n);

			// fn.length === 0, so passing an argument still triggers the dev guard
			await expect(get(5 as never)).rejects.toThrowError(/does not take an argument/);
		});
	});

	describe.runIf(has_gc)('lifecycle', () => {
		test('an unused query entry is evicted after its proxies are garbage collected', async () => {
			const get = query(async () => 'x');
			const id = get_id(get);

			await (async () => {
				await get();
			})();

			expect(query_map.has(id)).toBe(true);

			await wait_for(() => !query_map.has(id));

			expect(query_map.has(id)).toBe(false);
		});

		test('the cached Query does not retain the proxy', async () => {
			const get = query(async () => 'x');
			const id = get_id(get);

			let proxy_ref!: WeakRef<object>;

			(() => {
				const proxy = get();
				proxy_ref = new WeakRef(proxy);
			})();

			expect(query_map.has(id)).toBe(true);

			await wait_for(() => proxy_ref.deref() === undefined);
			expect(proxy_ref.deref()).toBeUndefined();
		});

		test('withOverride keeps the entry alive until released', async () => {
			const get = query(async () => 0);
			const id = get_id(get);

			let release!: () => void;

			(() => {
				const proxy = get();
				release = proxy.withOverride((n) => n + 1);
			})();

			// the proxy is gone, but the override still pins the entry
			await wait_for(() => {
				const entries = query_map.get(id);
				return entries?.values().next().value?.proxy_count === 1;
			});
			expect(query_map.has(id)).toBe(true);

			release();
			await tick();
			await tick();

			expect(query_map.has(id)).toBe(false);
		});

		test('reading `then` inside an effect pins the entry until the effect is destroyed', async () => {
			const get = query(async () => 'x');
			const id = get_id(get);

			let proxy_ref!: WeakRef<object>;

			const destroy = $effect.root(() => {
				$effect.pre(() => {
					const proxy = get();
					proxy_ref = new WeakRef(proxy);
					void proxy.then;
				});
			});

			await tick();

			await wait_for(() => proxy_ref.deref() === undefined);

			expect(query_map.has(id)).toBe(true);

			destroy();
			await tick();
			await tick();

			expect(query_map.has(id)).toBe(false);
		});

		test('reading `then` outside an effect does not pin the entry', async () => {
			const get = query(async () => 'x');
			const id = get_id(get);

			(() => {
				const proxy = get();
				void proxy.then;
			})();

			await wait_for(() => !query_map.has(id));

			expect(query_map.has(id)).toBe(false);
		});
	});
});
