import { DEV } from 'esm-env';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/*
 * Ported from SvelteKit (MIT) — packages/kit/src/runtime/form-utils.js
 * (minus the binary form serialization, which only exists for the HTTP transport).
 */

export interface InternalFormIssue {
	name: string;
	path: Array<string | number>;
	message: string;
	/** Whether this issue came from the form's own schema / handler ("server" validation in kit terms) */
	server: boolean;
}

/**
 * Sets a value in a nested object using a path string, mutating the original object
 */
export function set_nested_value(
	object: Record<string, any>,
	path_string: string,
	value: any
): void {
	if (path_string.startsWith('n:')) {
		path_string = path_string.slice(2);
		value = value === '' ? undefined : parseFloat(value);
	} else if (path_string.startsWith('b:')) {
		path_string = path_string.slice(2);
		value = value === 'on';
	}

	deep_set(object, split_path(path_string), value);
}

/** Pass this to set_nested_value to delete the last part of the given path */
export const DELETE_KEY = {};

/**
 * Convert `FormData` into a POJO
 */
export function convert_formdata(data: FormData): Record<string, any> {
	const result: Record<string, any> = {};

	for (let key of data.keys()) {
		const is_array = key.endsWith('[]');
		let values: any[] = data.getAll(key);

		if (is_array) key = key.slice(0, -2);

		// an empty `<input type="file">` will submit a non-existent file, bizarrely
		values = values.filter(
			(entry) => typeof entry === 'string' || entry.name !== '' || entry.size > 0
		);
		if (values.length === 0 && !is_array) continue;

		if (key.startsWith('n:')) {
			key = key.slice(2);
			values = values.map((v) => (v === '' ? undefined : parseFloat(v)));
		} else if (key.startsWith('b:')) {
			key = key.slice(2);
			values = values.map((v) => v === 'on');
		}

		if (values.length > 1 && !is_array) {
			throw new Error(`Form cannot contain duplicated keys — "${key}" has ${values.length} values`);
		}

		set_nested_value(result, key, is_array ? values : values[0]);
	}

	return result;
}

const path_regex = /^[a-zA-Z_$]\w*(\.[a-zA-Z_$]\w*|\[\d+\])*$/;

export function split_path(path: string): string[] {
	if (!path_regex.test(path)) {
		throw new Error(`Invalid path ${path}`);
	}

	return path.split(/\.|\[|\]/).filter(Boolean);
}

/**
 * Check if a property key is dangerous and could lead to prototype pollution
 */
function check_prototype_pollution(key: string): void {
	if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
		throw new Error(
			`Invalid key "${key}"` +
				(DEV ? ': This key is not allowed to prevent prototype pollution.' : '')
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
			throw new Error(`Invalid array key ${keys[i + 1]}`);
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

export function flatten_issues(issues: InternalFormIssue[]): Record<string, InternalFormIssue[]> {
	const result: Record<string, InternalFormIssue[]> = {};

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
		if (current == null || typeof current !== 'object') {
			return current;
		}
		current = current[key];
	}
	return current;
}

function get_type_prefix(field_type: string, is_array: boolean, input_value: unknown): string {
	if (field_type === 'number' || field_type === 'range') return 'n:';
	if (field_type === 'checkbox' && !is_array) return 'b:';
	if (field_type === 'hidden' || field_type === 'submit') {
		const input_type = typeof input_value;
		if (input_type === 'number') return 'n:';
		if (input_type === 'boolean') return 'b:';
	}
	return '';
}

/**
 * A deep-clone implementation specifically for form data, where
 * we don't need to worry about cycles and whatnot
 */
function deep_clone(value: any): any {
	if (value !== null && typeof value === 'object') {
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

/**
 * Creates a proxy-based field accessor for form data
 * @param target - Function or empty POJO
 * @param get_input - Function to get current input data
 * @param set_input - Function to set input data
 * @param get_issues - Function to get current issues
 * @param path - Current access path
 */
export function create_field_proxy(
	target: any,
	get_input: () => Record<string, any>,
	set_input: (path: Array<string | number>, value: any) => void,
	get_issues: (path?: Array<string | number>, all?: boolean) => Record<string, InternalFormIssue[]>,
	path: Array<string | number> = []
): any {
	const get_value = () => {
		const value = deep_get(get_input(), path);
		return deep_clone(value);
	};

	return new Proxy(target, {
		get(target, prop) {
			if (typeof prop === 'symbol') return target[prop];

			// Handle array access like jobs[0]
			if (/^\d+$/.test(prop)) {
				return create_field_proxy({}, get_input, set_input, get_issues, [
					...path,
					parseInt(prop, 10)
				]);
			}

			const key = build_path_string(path);

			if (prop === 'set') {
				const set_func = function (newValue: any) {
					set_input(path, newValue);
					return newValue;
				};
				return create_field_proxy(set_func, get_input, set_input, get_issues, [...path, prop]);
			}

			if (prop === 'value') {
				return create_field_proxy(get_value, get_input, set_input, get_issues, [...path, prop]);
			}

			if (prop === 'issues' || prop === 'allIssues') {
				const issues_func = () => {
					const all_issues = get_issues(path, prop === 'allIssues')[key === '' ? '$' : key];

					if (prop === 'allIssues') {
						return all_issues?.map((issue) => ({
							path: issue.path,
							message: issue.message
						}));
					}

					const issues = all_issues
						?.filter((issue) => issue.name === key)
						?.map((issue) => ({
							path: issue.path,
							message: issue.message
						}));

					return issues?.length ? issues : undefined;
				};

				return create_field_proxy(issues_func, get_input, set_input, get_issues, [...path, prop]);
			}

			if (prop === 'as') {
				const as_func = (type: string, input_value?: unknown) => {
					const is_array =
						type === 'file multiple' ||
						type === 'select multiple' ||
						(type === 'checkbox' && typeof input_value === 'string');

					const prefix = get_type_prefix(type, is_array, input_value);

					// Base properties for all input types
					const base_props: Record<string, any> = {
						name: prefix + key + (is_array ? '[]' : ''),
						get 'aria-invalid'() {
							const issues = get_issues();
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

						const value =
							typeof input_value === 'boolean' ? (input_value ? 'on' : 'off') : input_value;

						return Object.defineProperties(base_props, {
							value: { value, enumerable: true }
						});
					}

					// Handle select inputs
					if (type === 'select' || type === 'select multiple') {
						return Object.defineProperties(base_props, {
							multiple: { value: is_array, enumerable: true },
							value: {
								enumerable: true,
								get() {
									return get_value() ?? input_value;
								}
							}
						});
					}

					// Handle checkbox inputs
					if (type === 'checkbox' || type === 'radio') {
						if (DEV) {
							if (type === 'radio' && !input_value) {
								throw new Error('Radio inputs must have a value');
							}

							if (type === 'checkbox' && is_array && !input_value) {
								throw new Error('Checkbox array inputs must have a value');
							}
						}

						if (type === 'checkbox' && !is_array) {
							return Object.defineProperties(base_props, {
								defaultChecked: {
									enumerable: true,
									get() {
										return input_value;
									}
								},
								checked: {
									enumerable: true,
									get() {
										return get_value() ?? input_value;
									}
								}
							});
						}

						return Object.defineProperties(base_props, {
							value: { value: input_value ?? 'on', enumerable: true },
							checked: {
								enumerable: true,
								get() {
									const value = get_value();

									if (type === 'radio') {
										return value === input_value;
									}

									return (value ?? []).includes(input_value);
								}
							}
						});
					}

					// Handle file inputs
					if (type === 'file' || type === 'file multiple') {
						return Object.defineProperties(base_props, {
							multiple: { value: is_array, enumerable: true },
							files: {
								enumerable: true,
								get() {
									const value = get_value();

									// Convert File/File[] to FileList-like object
									if (value instanceof File) {
										// In browsers, we can create a proper FileList using DataTransfer
										if (typeof DataTransfer !== 'undefined') {
											const fileList = new DataTransfer();
											fileList.items.add(value);
											return fileList.files;
										}
										// Fallback for environments without DataTransfer
										return { 0: value, length: 1 };
									}

									if (Array.isArray(value) && value.every((f) => f instanceof File)) {
										if (typeof DataTransfer !== 'undefined') {
											const fileList = new DataTransfer();
											value.forEach((file) => fileList.items.add(file));
											return fileList.files;
										}
										// Fallback for environments without DataTransfer
										const fileListLike: any = { length: value.length };
										value.forEach((file, index) => {
											fileListLike[index] = file;
										});
										return fileListLike;
									}

									return null;
								}
							}
						});
					}

					// Handle all other input types (text, number, etc.)
					return Object.defineProperties(base_props, {
						defaultValue: {
							enumerable: true,
							get() {
								return input_value;
							}
						},
						value: {
							enumerable: true,
							get() {
								const value = get_value() ?? input_value;
								return value != null ? String(value) : '';
							}
						}
					});
				};

				return create_field_proxy(as_func, get_input, set_input, get_issues, [...path, 'as']);
			}

			// Handle property access (nested fields)
			return create_field_proxy({}, get_input, set_input, get_issues, [...path, prop]);
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
