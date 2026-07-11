import { describe, expect, test } from 'vitest';
import { create_key, split_key, stringify_arg } from './stringify.js';

describe('stringify_arg', () => {
	test('undefined becomes the empty payload', () => {
		expect(stringify_arg(undefined)).toBe('');
	});

	test('primitives serialize to JSON', () => {
		expect(stringify_arg('a')).toBe('"a"');
		expect(stringify_arg(1)).toBe('1');
		expect(stringify_arg(null)).toBe('null');
		expect(stringify_arg(true)).toBe('true');
	});

	test('object property order does not affect the payload', () => {
		expect(stringify_arg({ limit: 10, offset: 5 })).toBe(stringify_arg({ offset: 5, limit: 10 }));
	});

	test('nested objects are sorted recursively', () => {
		expect(stringify_arg({ a: { z: 1, b: 2 }, c: 3 })).toBe(
			stringify_arg({ c: 3, a: { b: 2, z: 1 } })
		);
	});

	test('array order matters', () => {
		expect(stringify_arg([1, 2])).not.toBe(stringify_arg([2, 1]));
	});

	test('dates serialize via toJSON', () => {
		const date = new Date('2026-01-01T00:00:00.000Z');
		expect(stringify_arg(date)).toBe('"2026-01-01T00:00:00.000Z"');
	});

	test('Map and Set arguments are rejected', () => {
		expect(() => stringify_arg(new Map())).toThrowError(/JSON-serializable/);
		expect(() => stringify_arg({ nested: new Set() })).toThrowError(/JSON-serializable/);
	});
});

describe('create_key / split_key', () => {
	test('round-trips id and payload', () => {
		const key = create_key('query:1', '{"a":"b/c"}');
		expect(split_key(key)).toEqual({ id: 'query:1', payload: '{"a":"b/c"}' });
	});

	test('split_key throws on invalid keys', () => {
		expect(() => split_key('nope')).toThrowError(/Invalid cache key/);
	});
});
