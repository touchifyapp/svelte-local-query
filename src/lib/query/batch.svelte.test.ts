import { describe, expect, test } from 'vitest';
import * as v from 'valibot';
import { query } from './index.js';
import { isValidationError } from '../validation.js';

describe('query.batch', () => {
	test('calls within the same macrotask are batched into one handler invocation', async () => {
		const batches: number[][] = [];
		const get = query.batch('unchecked', async (ids: number[]) => {
			batches.push(ids);
			return (id: number) => id * 2;
		});

		const [a, b, c] = await Promise.all([get(1), get(2), get(3)]);

		expect(batches).toEqual([[1, 2, 3]]);
		expect([a, b, c]).toEqual([2, 4, 6]);
	});

	test('identical arguments are deduplicated within a batch', async () => {
		const batches: number[][] = [];
		const get = query.batch('unchecked', async (ids: number[]) => {
			batches.push(ids);
			return (id: number) => id;
		});

		await Promise.all([get(7), get(7)]);

		expect(batches).toEqual([[7]]);
	});

	test('calls in a later macrotask start a new batch', async () => {
		const batches: number[][] = [];
		const get = query.batch('unchecked', async (ids: number[]) => {
			batches.push(ids);
			return (id: number) => id;
		});

		await get(1);
		await get(2).refresh();

		expect(batches).toEqual([[1], [2]]);
	});

	test('the resolver receives the validated argument and its index', async () => {
		const seen: Array<[number, number]> = [];
		const get = query.batch(v.number(), async () => {
			return (id: number, idx: number) => {
				seen.push([id, idx]);
				return id;
			};
		});

		await Promise.all([get(10), get(20)]);

		expect(seen).toEqual([
			[10, 0],
			[20, 1]
		]);
	});

	test('a handler error rejects every query in the batch', async () => {
		const get = query.batch('unchecked', async () => {
			throw new Error('batch failed');
		});

		const a = get(1);
		const b = get(2);

		await expect(a).rejects.toThrowError('batch failed');
		await expect(b).rejects.toThrowError('batch failed');
	});

	test('a resolver error only rejects the affected query', async () => {
		const get = query.batch('unchecked', async () => {
			return (id: number) => {
				if (id === 2) throw new Error('no 2');
				return id;
			};
		});

		const a = get(1);
		const b = get(2);

		await expect(a).resolves.toBe(1);
		await expect(b).rejects.toThrowError('no 2');
	});

	test('a bare handler infers the argument type and skips validation', async () => {
		const batches: number[][] = [];
		const get = query.batch((ids: number[]) => {
			batches.push(ids);
			return (id: number) => id * 10;
		});

		const [a, b] = await Promise.all([get(1), get(2)]);

		expect(batches).toEqual([[1, 2]]);
		expect([a, b]).toEqual([10, 20]);

		// @ts-expect-error string is not assignable to number
		void get('nope');
	});

	test('an argument failing validation only rejects its own query', async () => {
		const batches: number[][] = [];
		const get = query.batch(v.number(), async (ids) => {
			batches.push(ids);
			return (id: number) => id;
		});

		const good = get(1);
		const bad = get('nope' as unknown as number);

		await expect(good).resolves.toBe(1);
		await expect(bad).rejects.toSatisfy(isValidationError);
		expect(batches).toEqual([[1]]);
	});
});
