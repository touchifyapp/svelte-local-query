import { describe, expect, test } from 'vitest';
import { convert_formdata, deep_set, flatten_issues, normalize_issue } from './form-utils.js';

describe('convert_formdata', () => {
	test('builds nested objects from path names', () => {
		const data = new FormData();
		data.set('title', 'hello');
		data.set('author.name', 'jo');
		data.set('tags[0]', 'a');
		data.set('tags[1]', 'b');

		expect(convert_formdata(data)).toEqual({
			title: 'hello',
			author: { name: 'jo' },
			tags: ['a', 'b']
		});
	});

	test('coerces n: and b: prefixed names', () => {
		const data = new FormData();
		data.set('n:qty', '2');
		data.set('b:accepted', 'on');

		expect(convert_formdata(data)).toEqual({ qty: 2, accepted: true });
	});

	test('collects [] suffixed names into arrays', () => {
		const data = new FormData();
		data.append('items[]', 'a');
		data.append('items[]', 'b');

		expect(convert_formdata(data)).toEqual({ items: ['a', 'b'] });
	});

	test('empty non-array values are dropped, duplicated keys throw', () => {
		const empty = new FormData();
		expect(convert_formdata(empty)).toEqual({});

		const duplicated = new FormData();
		duplicated.append('x', 'a');
		duplicated.append('x', 'b');
		expect(() => convert_formdata(duplicated)).toThrowError(/duplicated keys/);
	});
});

describe('deep_set', () => {
	test('rejects prototype-polluting keys', () => {
		expect(() => deep_set({}, ['__proto__', 'polluted'], true)).toThrowError(/Invalid key/);
		expect(() => deep_set({}, ['constructor', 'prototype', 'x'], true)).toThrowError(/Invalid key/);
	});

	test('mismatched array/object nesting throws', () => {
		expect(() => deep_set({ a: { b: 1 } }, ['a', '0'], 'x')).toThrowError(/Invalid array key/);
	});
});

describe('issues', () => {
	test('normalize_issue builds path string names', () => {
		const issue = normalize_issue({ message: 'bad', path: ['items', 0, 'name'] }, true);
		expect(issue).toEqual({
			message: 'bad',
			name: 'items[0].name',
			path: ['items', 0, 'name'],
			server: true
		});
	});

	test('flatten_issues indexes issues by every path prefix plus $', () => {
		const issue = normalize_issue({ message: 'bad', path: ['a', 'b'] });
		const flattened = flatten_issues([issue]);

		expect(Object.keys(flattened).sort()).toEqual(['$', 'a', 'a.b']);
		expect(flattened['a.b']).toEqual([issue]);
	});
});
