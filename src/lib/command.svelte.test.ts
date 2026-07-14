import { describe, expect, test, vi } from 'vitest';
import * as v from 'valibot';
import { command } from './command.svelte.js';
import { query } from './query/index.js';
import { redirect } from './config.js';
import { isValidationError } from './validation.js';
import { flush } from '../tests/helpers.js';
import { with_resolvers, type PromiseWithResolvers } from './internal/utils.js';

describe('command', () => {
	test('runs the handler and resolves with its result', async () => {
		const add = command('unchecked', async (n: number) => n + 1);
		await expect(add(1)).resolves.toBe(2);
	});

	test('validates the argument with the schema', async () => {
		const add = command(v.number(), async (n) => n + 1);

		await expect(add(1)).resolves.toBe(2);
		await expect(add('nope' as unknown as number)).rejects.toSatisfy(isValidationError);
	});

	test('pending reflects the number of in-flight executions', async () => {
		const deferreds: PromiseWithResolvers<void>[] = [];
		const run = command(() => {
			const deferred = with_resolvers<void>();
			deferreds.push(deferred);
			return deferred.promise;
		});

		expect(run.pending).toBe(0);

		const first = run();
		const second = run();

		expect(run.pending).toBe(2);

		// the handlers start a microtask later (room for `.updates()` registration)
		await flush();
		expect(run.pending).toBe(2);

		deferreds.forEach((deferred) => deferred.resolve());
		await Promise.all([first, second]);

		expect(run.pending).toBe(0);
	});

	test('updates(query instance) refreshes that instance before the command resolves', async () => {
		let value = 0;
		const get = query(async () => value);
		const q = get();
		await expect(q).resolves.toBe(0);

		const increment = command(async () => {
			value++;
		});

		await increment().updates(q);

		expect(q.current).toBe(1);
	});

	test('updates(query function) refreshes all active instances', async () => {
		const values: Record<string, number> = { a: 0, b: 0 };
		const get = query('unchecked', async (key: string) => values[key]);

		const qa = get('a');
		const qb = get('b');
		await Promise.all([qa, qb]);

		const bump = command(async () => {
			values.a! += 1;
			values.b! += 10;
		});

		await bump().updates(get);

		expect(qa.current).toBe(1);
		expect(qb.current).toBe(10);
	});

	test('withOverride applies optimistically and is released after the refresh', async () => {
		let list = ['a'];
		const get = query(async () => list);
		const q = get();
		await q;

		let observed_during: string[] | undefined;

		const add = command('unchecked', async (item: string) => {
			list = [...list, item];
			observed_during = q.current;
		});

		await add('b').updates(q.withOverride((items) => [...items, 'b']));

		// during the command, the optimistic value was visible
		expect(observed_during).toEqual(['a', 'b']);
		// after the command, the refreshed real value is in place and the override released
		expect(q.current).toEqual(['a', 'b']);

		await q.refresh();
		expect(q.current).toEqual(['a', 'b']);
	});

	test('a failing command still releases optimistic overrides', async () => {
		const get = query(async () => ['a']);
		const q = get();
		await q;

		const fail = command(async () => {
			throw new Error('nope');
		});

		const promise = fail().updates(q.withOverride((items) => [...items, 'b']));
		expect(q.current).toEqual(['a', 'b']);

		await expect(promise).rejects.toThrowError('nope');
		await flush();

		expect(q.current).toEqual(['a']);
	});

	test('updates() can only be applied once', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const get = query(async () => 1);
			const q = get();
			await q;

			const run = command(async () => {});
			const promise = run();
			promise.updates(q);
			promise.updates(q);

			expect(warn).toHaveBeenCalledOnce();
			await promise;
		} finally {
			warn.mockRestore();
		}
	});

	test('updates() with an invalid argument rejects the command', async () => {
		const run = command(async () => {});
		await expect(run().updates({ not: 'a query' } as never)).rejects.toThrowError(
			/updates\(\) expects/
		);
	});

	test('a bare handler with a parameter accepts an argument without validation', async () => {
		const add = command(({ a, b }: { a: number; b: number }) => a + b);

		await expect(add({ a: 1, b: 2 })).resolves.toBe(3);

		// runtime lies are allowed — TypeScript is the only guard
		const typeof_arg = command((n: number) => typeof n);
		await expect(typeof_arg('42' as unknown as number)).resolves.toBe('string');

		// @ts-expect-error string is not assignable to { a: number; b: number }
		void add('nope');
	});

	test('redirects are not allowed in commands', async () => {
		const run = command(async () => {
			redirect('/somewhere');
		});

		await expect(run()).rejects.toThrowError(/Redirects are not allowed in commands/);
	});
});
