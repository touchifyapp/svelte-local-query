import { DEV } from 'esm-env';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/*
 * Ported from SvelteKit (MIT) — packages/kit/src/runtime/form-utils.js
 * (minus the binary form serialization and the server-side deserialization guards,
 * which only exist for the HTTP transport).
 */

export interface InternalFormIssue {
	name: string;
	path: Array<string | number>;
	message: string;
	/** Whether this issue came from the form's own schema / handler ("server" validation in kit terms) */
	server: boolean;
}

export type FieldValueType = 'number' | 'boolean' | null;

export interface ParsedFormKey {
	name: string;
	type: FieldValueType;
	is_array: boolean;
}

/**
 * Sets a parsed form field value in a nested object, mutating the original object.
 */
export function set_nested_value(
	object: Record<string, any>,
	field: { name: string; type: FieldValueType },
	value: any
): void {
	deep_set(object, split_path(field.name), value);
}

/**
 * Separates a form field's path from the metadata encoded in its name.
 */
export function parse_form_key(form_id: string, key: string): ParsedFormKey {
	const suffix = '/' + form_id;
	let name = key;
	let image_coordinate = '';

	if (name.startsWith('i:') && (name.endsWith(suffix + '.x') || name.endsWith(suffix + '.y'))) {
		image_coordinate = name[name.length - 1] as string;
		name = name.slice(0, -2);
	}

	if (!name.endsWith(suffix)) {
		throw new Error(
			`Form contained a field that wasn't created with \`form.fields.as(...)\`: \`${name}\``
		);
	}

	name = name.slice(0, -suffix.length);

	let type: FieldValueType = null;

	if (name.startsWith('n:')) {
		name = name.slice(2);
		type = 'number';
	} else if (name.startsWith('b:')) {
		name = name.slice(2);
		type = 'boolean';
	} else if (name.startsWith('i:')) {
		name = name.slice(2);
		type = 'number';
	}

	const is_array = name.endsWith('[]');
	if (is_array) name = name.slice(0, -2);
	if (image_coordinate) name += '.' + image_coordinate;

	return { name, type, is_array };
}

export function coerce_form_value(type: FieldValueType, value: any): any {
	if (Array.isArray(value)) return value.map((value) => coerce_form_value(type, value));
	if (type === 'number') return value === '' ? undefined : parseFloat(value);
	if (type === 'boolean') return value === 'on';
	return value;
}

/** Pass this to set_nested_value to delete the last part of the given path */
export const DELETE_KEY = {};

/**
 * Groups `FormData` entries by name in a single pass. Calling `data.getAll(name)`
 * for each name is O(n²) in the number of entries.
 */
export function group_formdata(data: FormData): Map<string, FormDataEntryValue[]> {
	const grouped = new Map<string, FormDataEntryValue[]>();

	for (const [name, value] of data) {
		const values = grouped.get(name);
		if (values) {
			values.push(value);
		} else {
			grouped.set(name, [value]);
		}
	}

	return grouped;
}

/**
 * Convert `FormData` into a POJO
 */
export function convert_formdata(form_id: string, data: FormData): Record<string, any> {
	const result: Record<string, any> = {};

	for (const [field_name, values] of group_formdata(data)) {
		const field = parse_form_key(form_id, field_name);

		// an empty `<input type="file">` will submit a non-existent file, bizarrely
		const entries = values.filter(
			(entry) => typeof entry === 'string' || entry.name !== '' || entry.size > 0
		);
		if (entries.length === 0 && !field.is_array) continue;

		if (entries.length > 1 && !field.is_array) {
			throw new Error(
				`Form cannot contain duplicated keys — \`${field.name}\` has ${entries.length} values`
			);
		}

		set_nested_value(
			result,
			field,
			coerce_form_value(field.type, field.is_array ? entries : entries[0])
		);
	}

	return result;
}

const path_regex = /^[a-zA-Z_$]\w*(\.[a-zA-Z_$]\w*|\[(?:0|[1-9]\d*)\])*$/;

/** The largest valid array index */
const MAX_ARRAY_INDEX = 2 ** 32 - 2;

function invalid_name(name: string): never {
	throw new Error(
		`Invalid field name \`${name}\`: field names are written in JS object notation, so keys that would need quoting are not supported.`
	);
}

export function split_path(path: string): string[] {
	if (!path_regex.test(path)) {
		invalid_name(path);
	}

	const keys = path.split(/\.|\[|\]/).filter(Boolean);

	// larger numbers are not array indexes, but would still be treated as such
	if (keys.some((key) => /^\d/.test(key) && Number(key) > MAX_ARRAY_INDEX)) {
		invalid_name(path);
	}

	return keys;
}

/**
 * Check if a property key is dangerous and could lead to prototype pollution
 */
function check_prototype_pollution(key: string): void {
	if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
		throw new Error(
			`Invalid key \`${key}\`: This key is not allowed to prevent prototype pollution.`
		);
	}
}

/**
 * Sets a value in a nested object using an array of keys, mutating the original object.
 */
export function deep_set(object: Record<string, any>, keys: string[], value: any): void {
	let current = object;

	for (let i = 0; i < keys.length - 1; i += 1) {
		const key = keys[i] as string;

		check_prototype_pollution(key);

		const is_array = /^\d+$/.test(keys[i + 1] as string);
		const inner = Object.hasOwn(current, key) ? current[key] : undefined;
		const exists = inner != null;

		if (exists && is_array !== Array.isArray(inner)) {
			throw new Error(`Invalid array key \`${keys[i + 1]}\``);
		}

		if (!exists) {
			if (value === DELETE_KEY) {
				// don't create the nested structure if we want to delete the key anyway
				return;
			}
			current[key] = is_array ? [] : {};
		}

		current = current[key];
	}

	const final_key = keys[keys.length - 1] as string;
	check_prototype_pollution(final_key);

	if (value === DELETE_KEY) {
		delete current[final_key];
	} else {
		current[final_key] = value;
	}
}

/**
 * @param issue a standard-schema issue
 * @param server whether this issue came from the form's schema/handler validation
 */
export function normalize_issue(issue: StandardSchemaV1.Issue, server = false): InternalFormIssue {
	const normalized: InternalFormIssue = { name: '', path: [], message: issue.message, server };

	if (issue.path !== undefined) {
		let name = '';

		for (const segment of issue.path) {
			const key = (typeof segment === 'object' ? segment.key : segment) as string | number;

			normalized.path.push(key);

			if (typeof key === 'number') {
				name += `[${key}]`;
			} else if (typeof key === 'string') {
				name += name === '' ? key : '.' + key;
			}
		}

		normalized.name = name;
	}

	return normalized;
}

const flattened_issues = new WeakMap<InternalFormIssue[], Record<string, InternalFormIssue[]>>();

export function flatten_issues(issues: InternalFormIssue[]): Record<string, InternalFormIssue[]> {
	const cached = flattened_issues.get(issues);
	if (cached) return cached;

	const result: Record<string, InternalFormIssue[]> = Object.create(null);
	flattened_issues.set(issues, result);

	for (const issue of issues) {
		(result.$ ??= []).push(issue);

		let name = '';

		if (issue.path !== undefined) {
			for (const key of issue.path) {
				if (typeof key === 'number') {
					name += `[${key}]`;
				} else if (typeof key === 'string') {
					name += name === '' ? key : '.' + key;
				}

				(result[name] ??= []).push(issue);
			}
		}
	}

	return result;
}

/**
 * Gets a nested value from an object using a path array
 */
export function deep_get(object: Record<string, any>, path: Array<string | number>): any {
	let current: any = object;
	for (const key of path) {
		if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) {
			return undefined;
		}

		current = current[key];
	}
	return current;
}

/** name prefixes that tell the handler which type to coerce a submitted string to */
const type_prefixes: Record<string, string | undefined> = {
	number: 'n:',
	boolean: 'b:'
};

/**
 * adds props; a function becomes a getter that is computed each time it is read
 */
function add_props(base_props: Record<string, any>, props: Record<string, unknown>) {
	for (const prop in props) {
		const value = props[prop];
		if (typeof value === 'function') {
			Object.defineProperty(base_props, prop, {
				enumerable: true,
				get: value as () => unknown
			});
		} else {
			base_props[prop] = value;
		}
	}
	return base_props;
}

function get_type_prefix(type: string, is_array: boolean, input_value: unknown): string {
	if (type === 'number' || type === 'range') return 'n:';
	if (type === 'image') return 'i:';
	if (type === 'checkbox' && !is_array) return 'b:';
	if (type === 'hidden' || type === 'submit') return type_prefixes[typeof input_value] ?? '';
	return '';
}

/**
 * A deep-clone implementation specifically for form data, where
 * we don't need to worry about cycles and whatnot
 */
function deep_clone(value: any): any {
	if (value !== null && typeof value === 'object') {
		if (value instanceof Date) {
			return new Date(value.getTime());
		}

		if (value instanceof File) {
			return value;
		}

		if (Array.isArray(value)) {
			return value.map(deep_clone);
		}

		const clone: Record<string, any> = {};
		for (const key of Object.keys(value)) {
			clone[key] = deep_clone(value[key]);
		}

		return clone;
	}

	return value;
}

const warned_sites = new Set<string | undefined>();

// keyed by the stack, so every place that enumerates warns once with its call site
const warn_no_keys = () => {
	const error = new Error();
	if (warned_sites.has(error.stack)) return;
	warned_sites.add(error.stack);
	console.warn(
		'The properties of `form.fields` are virtual, so operators like `in` and `Object.keys` are meaningless. ' +
			'If you need the current value of a form field, use `form.fields.x.value()`'
	);
};

// fields are created as they are accessed, so there is nothing to enumerate
const dev_traps: ProxyHandler<object> | null = DEV
	? {
			has(target, prop) {
				if (typeof prop !== 'symbol') warn_no_keys();
				return prop in target;
			},
			ownKeys(target) {
				warn_no_keys();
				return Reflect.ownKeys(target);
			}
		}
	: null;

const public_issue = (issue: InternalFormIssue) => ({ path: issue.path, message: issue.message });

export interface FieldContext {
	form_id: string;
	get: () => Record<string, any>;
	set: (path: Array<string | number>, value: any) => void;
	get_issues: (path?: Array<string | number>, all?: boolean) => Record<string, InternalFormIssue[]>;
	get_touched: () => Record<string, boolean>;
	get_dirty: () => Record<string, boolean>;
}

/**
 * @returns a method of the field at `path`, or undefined for a nested field
 */
function create_field_method(
	context: FieldContext,
	path: Array<string | number>,
	prop: string
): any {
	switch (prop) {
		case 'set':
			return (value: any) => {
				context.set(path, value);
				return value;
			};
		case 'value':
			return () => deep_clone(deep_get(context.get(), path));
		case 'issues':
		case 'allIssues': {
			const key = build_path_string(path);
			const all = prop === 'allIssues';

			return () => {
				const issues = context.get_issues(path, all)[key === '' ? '$' : key];
				if (all) return issues?.map(public_issue);
				const own = issues?.filter((issue) => issue.name === key).map(public_issue);
				return own?.length ? own : undefined;
			};
		}
		case 'touched':
		case 'dirty': {
			const key = build_path_string(path);

			return () => {
				const object = prop === 'dirty' ? context.get_dirty() : context.get_touched();
				if (Object.hasOwn(object, key)) return true;
				for (const candidate in object) {
					if (!Object.hasOwn(object, candidate)) continue;
					if (key === '') return true;
					if (!candidate.startsWith(key)) continue;
					const next = candidate[key.length];
					if (next === '.' || next === '[') return true;
				}
				return false;
			};
		}
		case 'as': {
			const key = build_path_string(path);

			/**
			 * the field's value, or `fallback` until the field has been edited
			 * (without a fallback there is nothing to suppress, so `dirty` is not read)
			 */
			const read = (fallback?: unknown) =>
				deep_get(context.get(), path) ??
				(fallback !== undefined && Object.hasOwn(context.get_dirty(), key) ? undefined : fallback);

			return (type: string, input_value?: unknown, checked?: boolean) => {
				const is_array =
					type === 'file multiple' ||
					type === 'select multiple' ||
					(type === 'checkbox' && typeof input_value === 'string');

				const type_prefix = get_type_prefix(type, is_array, input_value);

				// Base properties for all input types
				const base_props: Record<string, any> = {
					name: type_prefix + key + (is_array ? '[]' : '') + '/' + context.form_id,
					get 'aria-invalid'() {
						const issues = context.get_issues();
						return key in issues ? 'true' : undefined;
					}
				};

				// Add type attribute only for non-text inputs and non-select elements
				if (type !== 'text' && type !== 'select' && type !== 'select multiple') {
					base_props.type = type === 'file multiple' ? 'file' : type;
				}

				// Handle submit and hidden inputs
				if (type === 'submit' || type === 'hidden') {
					if (DEV) {
						if (input_value === null || input_value === undefined) {
							throw new Error(`\`${type}\` inputs must have a value`);
						}
					}

					return add_props(base_props, {
						value: typeof input_value === 'boolean' ? (input_value ? 'on' : 'off') : input_value
					});
				}

				// Handle select inputs
				if (type === 'select' || type === 'select multiple') {
					return add_props(base_props, {
						multiple: is_array,
						value: () => {
							const value = read(input_value);
							// copied, so the state array can't be edited through the props
							return Array.isArray(value) ? [...value] : value;
						}
					});
				}

				// Handle checkbox inputs
				if (type === 'checkbox' || type === 'radio') {
					// radio and checkbox array inputs take their option as the second argument
					// and whether it is checked as the third, a single checkbox only the latter
					const has_option = type === 'radio' || is_array;

					if (DEV && has_option && !input_value) {
						throw new Error(
							`${type === 'radio' ? 'Radio' : 'Checkbox array'} inputs must have a value`
						);
					}

					if (has_option) {
						base_props.value = input_value ?? 'on';
					} else {
						checked = input_value as boolean | undefined;
					}

					return add_props(base_props, {
						defaultChecked: checked,
						checked: () => {
							const value = read();
							if (value == null) return read(checked);
							if (type === 'radio') return value === input_value;
							if (is_array) return (value as unknown[]).includes(input_value);
							return value;
						}
					});
				}

				// Handle file inputs
				if (type === 'file' || type === 'file multiple') {
					return add_props(base_props, {
						multiple: is_array,
						files: () => {
							const value = read();
							const files = value instanceof File ? [value] : value;
							if (!Array.isArray(files) || !files.every((f) => f instanceof File)) return null;

							// a FileList-like object where DataTransfer does not exist
							if (typeof DataTransfer === 'undefined') {
								return Object.assign({ length: files.length }, files);
							}

							const transfer = new DataTransfer();
							for (const file of files) transfer.items.add(file);
							return transfer.files;
						}
					});
				}

				if (type === 'image') return base_props;

				// Handle all other input types (text, number, etc.)
				return add_props(base_props, {
					defaultValue: input_value,
					value: () => String(read(input_value) ?? '')
				});
			};
		}
	}
}

/**
 * Creates a proxy-based field accessor for form data
 * @param target - Function or empty POJO
 * @param path - Current access path
 */
export function create_field_proxy(
	context: FieldContext,
	target: any = {},
	path: Array<string | number> = []
): any {
	return new Proxy(target, {
		...dev_traps,
		get(target, prop) {
			if (typeof prop === 'symbol') return target[prop];

			// array access like jobs[0]
			const next = [...path, /^\d+$/.test(prop) ? parseInt(prop, 10) : prop];

			return create_field_proxy(context, create_field_method(context, path, prop) ?? {}, next);
		}
	});
}

/**
 * Builds a path string from an array of path segments
 */
export function build_path_string(path: Array<string | number>): string {
	let result = '';

	for (const segment of path) {
		if (typeof segment === 'number') {
			result += `[${segment}]`;
		} else {
			result += result === '' ? segment : '.' + segment;
		}
	}

	return result;
}
