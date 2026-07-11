import { describe, expect, test } from 'vitest';
import * as v from 'valibot';
import { query } from '../query/index.js';
import { command } from '../command.svelte.js';
import { isValidationError } from '../validation.js';
import { flush, track_unhandled } from '../../tests/helpers.js';
import { with_resolvers, type PromiseWithResolvers } from '../internal/utils.js';

/** An async generator we can push values into from the outside. */
function create_source<T>() {
	let deferred = with_resolvers<{ value?: T; done?: boolean; error?: unknown }>();
	let runs = 0;

	return {
		get runs() {
			return runs;
		},
		push(value: T) {
			const previous = deferred;
			deferred = with_resolvers();
			previous.resolve({ value });
		},
		end() {
			const previous = deferred;
			deferred = with_resolvers();
			previous.resolve({ done: true });
		},
		fail(error: unknown) {
			const previous = deferred;
			deferred = with_resolvers();
			previous.resolve({ error });
		},
		async *stream(): AsyncGenerator<T> {
			runs++;
			while (true) {
				const next = await deferred.promise;
				if (next.error) throw next.error;
				if (next.done) return;
				yield next.value as T;
			}
		}
	};
}

describe('query.live', () => {
	test('each yielded value becomes the current value', async () => {
		const source = create_source<number>();
		const live = query.live(() => source.stream());

		const q = live();
		expect(q.loading).toBe(true);
		await flush();
		expect(q.connected).toBe(true);

		source.push(1);
		await flush();
		expect(q.ready).toBe(true);
		expect(q.current).toBe(1);
		expect(q.loading).toBe(false);

		source.push(2);
		await flush();
		expect(q.current).toBe(2);
		expect(q.done).toBe(false);
	});

	test('awaiting resolves to the first value', async () => {
		const source = create_source<string>();
		const live = query.live(() => source.stream());

		const q = live();
		const promise = q.then((value) => value);
		await flush();
		source.push('first');

		await expect(promise).resolves.toBe('first');
	});

	test('completion marks the query as done and keeps the last value', async () => {
		const source = create_source<number>();
		const live = query.live(() => source.stream());

		const q = live();
		void q.current;
		await flush();

		source.push(42);
		await flush();
		source.end();
		await flush();

		expect(q.done).toBe(true);
		expect(q.connected).toBe(false);
		expect(q.current).toBe(42);
	});

	test('completing without a value is an error', async () => {
		const live = query.live(async function* () {
			// yields nothing
		});

		const q = live();
		void q.current;
		await flush();

		expect(q.error).toBeInstanceOf(Error);
		expect((q.error as Error).message).toMatch(/completed before yielding/);
	});

	test('a stream error before the first value rejects awaiting consumers', async () => {
		const tracker = track_unhandled();
		try {
			const oops = new Error('stream failed');
			const live = query.live(async function* (): AsyncGenerator<number> {
				throw oops;
			});

			const q = live();
			void q.current; // reactive-only consumer
			await flush();

			expect(q.error).toBe(oops);
			expect(q.done).toBe(true);
			expect(tracker.unhandled).toEqual([]);
		} finally {
			tracker.stop();
		}
	});

	test('for await iterates values, seeded with the current one', async () => {
		const source = create_source<number>();
		const live = query.live(() => source.stream());

		const q = live();
		void q.current;
		await flush();
		source.push(1);
		await flush();

		const seen: number[] = [];
		const iteration = (async () => {
			for await (const value of q) {
				seen.push(value);
				if (seen.length === 3) break;
			}
		})();

		await flush();
		source.push(2);
		await flush();
		source.push(3);
		await iteration;

		expect(seen).toEqual([1, 2, 3]);
	});

	test('reconnect() re-invokes the handler', async () => {
		const source = create_source<number>();
		const live = query.live(() => source.stream());

		const q = live();
		void q.current;
		await flush();
		source.push(1);
		await flush();
		source.end();
		await flush();
		expect(q.done).toBe(true);
		expect(source.runs).toBe(1);

		const reconnected = q.reconnect();
		await flush();
		expect(source.runs).toBe(2);
		source.push(10);
		await reconnected;
		await flush();

		expect(q.done).toBe(false);
		expect(q.current).toBe(10);
	});

	test('arguments are validated with the schema', async () => {
		const live = query.live(v.string(), async function* (room) {
			yield `joined ${room}`;
		});

		await expect(live('a')).resolves.toBe('joined a');

		const q = live(1 as unknown as string);
		await expect(q).rejects.toSatisfy(isValidationError);
	});

	test('a command updates() targeting a live query reconnects it', async () => {
		let value = 0;
		const live = query.live(async function* () {
			yield value;
			// keep the stream open
			await new Promise(() => {});
		});

		const q = live();
		await expect(q).resolves.toBe(0);

		const bump = command(async () => {
			value = 7;
		});

		await bump().updates(q);
		await flush();

		expect(q.current).toBe(7);
	});

	test('identical arguments share one stream', async () => {
		const source = create_source<number>();
		const live = query.live('unchecked', (_room: string) => source.stream());

		const a = live('lobby');
		const b = live('lobby');

		void a.current;
		void b.current;
		await flush();

		expect(source.runs).toBe(1);

		source.push(5);
		await flush();

		expect(a.current).toBe(5);
		expect(b.current).toBe(5);
	});
});

describe('live source cleanup', () => {
	test('interrupting via reconnect() runs the generator finally block', async () => {
		let cleaned = 0;

		const live = query.live(async function* () {
			let i = 0;
			try {
				while (true) {
					yield i++;
					// suspend briefly; interruption is queued behind this pending await
					// and processed as soon as it settles
					await new Promise((resolve) => setTimeout(resolve, 1));
				}
			} finally {
				cleaned++;
			}
		});

		const q = live();
		await expect(q).resolves.toBe(0);

		await q.reconnect();
		await until(() => cleaned >= 1);

		// the first generator was cleaned up; the reconnected one is still running
		expect(cleaned).toBe(1);
	});
});

async function until(predicate: () => boolean, timeout = 1000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeout) throw new Error('Timed out waiting for predicate');
		await flush();
	}
}
