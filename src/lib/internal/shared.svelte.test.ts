import { describe, expect, test } from 'vitest';
import { categorize_updates, QUERY_OVERRIDE_KEY, QUERY_RESOURCE_KEY } from './shared.svelte.js';
import { query } from '../query/index.js';

describe('categorize_updates', () => {
	test('a query instance is categorized as a refresh', () => {
		const get = query(async () => 1);
		const q = get();

		const { refreshes, overrides } = categorize_updates([q]);

		expect(refreshes.size).toBe(1);
		expect(refreshes.has((q as any)[QUERY_RESOURCE_KEY])).toBe(true);
		expect(overrides).toHaveLength(0);
	});

	test('a query function refreshes all its active instances', () => {
		const get = query('unchecked', async (n: number) => n);
		const a = get(1);
		const b = get(2);

		const { refreshes } = categorize_updates([get]);

		expect(refreshes.size).toBe(2);
		expect(refreshes.has((a as any)[QUERY_RESOURCE_KEY])).toBe(true);
		expect(refreshes.has((b as any)[QUERY_RESOURCE_KEY])).toBe(true);
	});

	test('an override release is both a refresh and an override', () => {
		const get = query(async () => 1);
		const q = get();
		const release = q.withOverride((n) => n + 1);

		const { refreshes, overrides } = categorize_updates([release]);

		expect(refreshes.size).toBe(1);
		expect(refreshes.has((release as any)[QUERY_OVERRIDE_KEY])).toBe(true);
		expect(overrides).toEqual([release]);

		release();
	});

	test('two overrides for the same query throw', () => {
		const get = query(async () => 1);
		const q = get();
		const release_a = q.withOverride((n) => n + 1);
		const release_b = q.withOverride((n) => n + 2);

		expect(() => categorize_updates([release_a, release_b])).toThrowError(/Multiple overrides/);

		release_a();
		release_b();
	});

	test('plain functions are treated as user cleanup callbacks', () => {
		const cleanup = () => {};
		const { refreshes, overrides } = categorize_updates([cleanup as never]);

		expect(refreshes.size).toBe(0);
		expect(overrides).toEqual([cleanup]);
	});

	test('anything else is rejected', () => {
		expect(() => categorize_updates([{} as never])).toThrowError(/updates\(\) expects/);
		expect(() => categorize_updates([null as never])).toThrowError(/updates\(\) expects/);
	});
});
