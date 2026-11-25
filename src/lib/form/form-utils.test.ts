import { describe, expect, test } from 'vitest';
import {
	coerce_form_value,
	convert_formdata,
	create_field_proxy,
	deep_get,
	deep_set,
	flatten_issues,
	normalize_issue,
	parse_form_key,
	split_path
} from './form-utils.js';

const ID = 'form_1';
const field = (name: string) => `${name}/${ID}`;

describe('convert_formdata', () => {
	test('builds nested objects from path names', () => {
		const data = new FormData();
		data.set(field('title'), 'hello');
		data.set(field('author.name'), 'jo');
		data.set(field('tags[0]'), 'a');
		data.set(field('tags[1]'), 'b');

		expect(convert_formdata(ID, data)).toEqual({
			title: 'hello',
			author: { name: 'jo' },
			tags: ['a', 'b']
		});
	});

	test('coerces n: and b: prefixed names', () => {
		const data = new FormData();
		data.set(field('n:qty'), '2');
		data.set(field('b:accepted'), 'on');

		expect(convert_formdata(ID, data)).toEqual({ qty: 2, accepted: true });
	});

	test('collects [] suffixed names into arrays', () => {
		const data = new FormData();
		data.append(field('items[]'), 'a');
		data.append(field('items[]'), 'b');

		expect(convert_formdata(ID, data)).toEqual({ items: ['a', 'b'] });
	});

	test('empty non-array values are dropped, duplicated keys throw', () => {
		const empty = new FormData();
		expect(convert_formdata(ID, empty)).toEqual({});

		const duplicated = new FormData();
		duplicated.append(field('x'), 'a');
		duplicated.append(field('x'), 'b');
		expect(() => convert_formdata(ID, duplicated)).toThrowError(/duplicated keys/);
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

describe('parse_form_key', () => {
	test('strips the form id suffix and type prefixes', () => {
		expect(parse_form_key(ID, field('title'))).toEqual({
			name: 'title',
			type: null,
			is_array: false
		});
		expect(parse_form_key(ID, field('n:qty'))).toEqual({
			name: 'qty',
			type: 'number',
			is_array: false
		});
		expect(parse_form_key(ID, field('b:tags[]'))).toEqual({
			name: 'tags',
			type: 'boolean',
			is_array: true
		});
	});

	test('maps image input coordinates to numeric x/y subfields', () => {
		expect(parse_form_key(ID, `i:pos/${ID}.x`)).toEqual({
			name: 'pos.x',
			type: 'number',
			is_array: false
		});
	});

	test('rejects fields that were not created with `.as()`', () => {
		expect(() => parse_form_key(ID, 'title')).toThrowError(/wasn't created with/);
		expect(() => parse_form_key(ID, field('title').replace(ID, 'form_2'))).toThrowError(
			/wasn't created with/
		);
	});
});

describe('coerce_form_value', () => {
	test('coerces scalars and arrays by type', () => {
		expect(coerce_form_value('number', '2.5')).toBe(2.5);
		expect(coerce_form_value('number', '')).toBeUndefined();
		expect(coerce_form_value('boolean', 'on')).toBe(true);
		expect(coerce_form_value('number', ['1', '2'])).toEqual([1, 2]);
		expect(coerce_form_value(null, 'x')).toBe('x');
	});
});

describe('split_path / deep_get', () => {
	test('rejects non-canonical and out-of-range array indexes', () => {
		expect(split_path('items[0].name')).toEqual(['items', '0', 'name']);
		expect(() => split_path('items[01]')).toThrowError(/Invalid field name/);
		expect(() => split_path(`items[${2 ** 32}]`)).toThrowError(/Invalid field name/);
	});

	test('deep_get only reads own properties', () => {
		expect(deep_get({ a: { b: 1 } }, ['a', 'b'])).toBe(1);
		expect(deep_get({ a: 'str' }, ['a', 'length'])).toBeUndefined();
		expect(deep_get({}, ['toString'])).toBeUndefined();
	});
});

describe('create_field_proxy', () => {
	function context(input: Record<string, any> = {}, dirty: Record<string, boolean> = {}) {
		return {
			form_id: ID,
			get: () => input,
			set: () => {},
			get_issues: () => ({}),
			get_touched: () => ({ 'author.name': true }),
			get_dirty: () => dirty
		};
	}

	test('generated names carry the form id suffix', () => {
		const fields = create_field_proxy(context());
		expect(fields.title.as('text').name).toBe(field('title'));
		expect(fields.qty.as('number').name).toBe(field('n:qty'));
		expect(fields.tags.as('checkbox', 'a').name).toBe(field('tags[]'));
	});

	test('radio and checkbox options take `checked` as a third argument', () => {
		const fields = create_field_proxy(context());
		expect(fields.visibility.as('radio', 'public', true).checked).toBe(true);
		expect(fields.visibility.as('radio', 'private', false).checked).toBe(false);
		expect(fields.tags.as('checkbox', 'a', true).checked).toBe(true);
		expect(fields.agree.as('checkbox', true).checked).toBe(true);
	});

	test('the `.as()` fallback stops applying once the field has been edited', () => {
		expect(create_field_proxy(context()).title.as('text', 'default').value).toBe('default');
		expect(create_field_proxy(context({}, { title: true })).title.as('text', 'default').value).toBe(
			''
		);
	});

	test('touched() covers nested fields', () => {
		const fields = create_field_proxy(context());
		expect(fields.author.touched()).toBe(true);
		expect(fields.author.name.touched()).toBe(true);
		expect(fields.title.touched()).toBe(false);
		expect(fields.touched()).toBe(true);
	});

	test('value() clones dates', () => {
		const date = new Date(0);
		const fields = create_field_proxy(context({ when: date }));
		const value = fields.when.value();
		expect(value).toEqual(date);
		expect(value).not.toBe(date);
	});
});
