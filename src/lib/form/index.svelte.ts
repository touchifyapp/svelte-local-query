import type { StandardSchemaV1 } from '@standard-schema/spec';
import { DEV } from 'esm-env';
import { tick } from 'svelte';
import { createAttachmentKey } from 'svelte/attachments';
import { apply_redirect, get_config, isRedirect } from '../config.js';
import {
	categorize_updates,
	get_epoch,
	refresh_all,
	refresh_keys
} from '../internal/shared.svelte.js';
import { next_id } from '../internal/stringify.js';
import type {
	HasNonOptionalBoolean,
	LocalForm,
	LocalFormEnhanceInstance,
	LocalFormInput,
	LocalQueryUpdate,
	InvalidField,
	MaybePromise
} from '../types.js';
import {
	create_issue_proxy,
	isValidationError,
	parse_declaration,
	type Validator
} from '../validation.js';
import {
	convert_formdata,
	create_field_proxy,
	deep_set,
	build_path_string,
	flatten_issues,
	normalize_issue,
	set_nested_value,
	DELETE_KEY,
	type InternalFormIssue
} from './form-utils.js';

/*
 * Ported from SvelteKit (MIT) —
 * packages/kit/src/runtime/client/remote-functions/form.svelte.js
 *
 * Local differences:
 * - the handler and its schema run in-process instead of on the server, so a
 *   submission never leaves the page (there is no non-JS fallback);
 * - on success the default behavior refreshes all active local queries (the
 *   equivalent of kit's `invalidateAll()`), unless the developer takes control via
 *   `.updates(...)` or by refreshing/setting queries inside the handler;
 * - errors thrown by the handler go to the `init({ onerror })` hook (or are rethrown)
 *   instead of rendering the nearest `+error.svelte` page.
 */

/**
 * Merge client (preflight) issues into handler/schema issues. Schema issues are
 * persisted unless a client issue exists for the same path, in which case the client
 * issue overrides it.
 */
function merge_with_server_issues(
	form_data: FormData,
	current_issues: InternalFormIssue[],
	client_issues: InternalFormIssue[]
): InternalFormIssue[] {
	const merged = [
		...current_issues.filter(
			(issue) => issue.server && !client_issues.some((i) => i.name === issue.name)
		),
		...client_issues
	];

	const keys = Array.from(form_data.keys());

	return merged.sort((a, b) => keys.indexOf(a.name) - keys.indexOf(b.name));
}

function create_form(
	validate_or_fn: Validator | ((data?: any, issue?: any) => unknown),
	maybe_fn?: (data?: any, issue?: any) => unknown
): LocalForm<any, any> {
	const { validate, fn } = parse_declaration(validate_or_fn, maybe_fn);
	const schema = validate === 'unchecked' || validate === undefined ? null : validate;
	const id = next_id('form');

	const instances = new Map<any, { count: number; instance: LocalForm<any, any> }>();

	let shared_preflight_schema: StandardSchemaV1 | null = null;

	function create_instance(key?: string | number | boolean): LocalForm<any, any> {
		const action_id = id + (key != undefined ? `/${JSON.stringify(key)}` : '');
		const action = '?/local=' + encodeURIComponent(action_id);

		let input = $state<Record<string, any>>({});

		let raw_issues = $state.raw<InternalFormIssue[]>([]);

		const issues = $derived(flatten_issues(raw_issues));

		let result = $state.raw<any>(undefined);

		let pending_count = $state(0);

		let preflight_schema: StandardSchemaV1 | undefined = undefined;

		let enhance_callback: (instance: LocalFormEnhanceInstance<any, any>) => unknown = async (
			instance
		) => {
			if (await instance.submit()) {
				await tick();
				// We call reset from the prototype to avoid DOM clobbering
				HTMLFormElement.prototype.reset.call(instance.element);
			}
		};

		let element: HTMLFormElement | null = null;

		let touched: Record<string, boolean> = {};

		let submitted = $state(false);

		let unread_issues: InternalFormIssue[] | null = null;

		let previous_submitter_name: string | null = null;

		/**
		 * In dev, warn if there are validation issues going unread
		 */
		function warn_on_missing_issue_reads(): void {
			unread_issues = raw_issues;

			setTimeout(() => {
				if (unread_issues === null) {
					return;
				}

				if (unread_issues.length > 0) {
					const message = `Form submission had invalid data, but the validation issues were ignored:`;
					const summary = unread_issues
						.map((issue) =>
							issue.path.length === 0
								? `  - ${issue.message}`
								: `  - ${issue.path.join('.')} (${issue.message})`
						)
						.join('\n');
					const suggestion = `Make sure you provide actionable feedback to users, using e.g. \`myForm.fields.myField.issues()\` or \`myForm.fields.allIssues()\``;

					console.warn(`${message}\n\n${summary}\n\n${suggestion}`);
				}

				unread_issues = null;
			});
		}

		function convert(form_data: FormData): Record<string, any> {
			const data = convert_formdata(form_data);
			if (key !== undefined && !form_data.has('id')) {
				data.id = key;
			}
			return data;
		}

		/**
		 * The local replacement for kit's POST to the form endpoint: runs the form's
		 * schema and handler in-process and returns the issues/result/redirect outcome.
		 */
		async function execute(data: Record<string, any>): Promise<{
			issues: InternalFormIssue[];
			result: any;
			redirect: import('../config.js').Redirect | null;
			handler_refreshed: boolean;
		}> {
			const epoch_before = get_epoch();

			try {
				let validated: any = data;

				if (schema) {
					const validation = await schema['~standard'].validate(data);

					if (validation.issues) {
						return {
							issues: validation.issues.map((issue) => normalize_issue(issue, true)),
							result: undefined,
							redirect: null,
							handler_refreshed: false
						};
					}

					validated = validation.value;
				}

				const output = await fn(validated, create_issue_proxy());

				return {
					issues: [],
					result: output,
					redirect: null,
					handler_refreshed: get_epoch() !== epoch_before
				};
			} catch (e) {
				if (isValidationError(e)) {
					return {
						issues: e.issues.map((issue) => normalize_issue(issue, true)),
						result: undefined,
						redirect: null,
						handler_refreshed: get_epoch() !== epoch_before
					};
				}

				if (isRedirect(e)) {
					return {
						issues: [],
						result: undefined,
						redirect: e,
						handler_refreshed: get_epoch() !== epoch_before
					};
				}

				throw e;
			}
		}

		function submit(
			form_data: FormData,
			should_preflight: boolean
		): Promise<boolean> & { updates: (...args: LocalQueryUpdate[]) => Promise<boolean> } {
			// Store a reference to the current instance and increment the usage count for
			// the duration of the request. This ensures that the instance is not deleted in
			// case of an optimistic update (e.g. when deleting an item in a list) that fails
			// and wants to surface an error to the user afterwards.
			const entry = instances.get(key);
			if (entry) {
				entry.count++;
			}

			// stored on a mutable holder because the assignments happen in the `updates`
			// closure after the async body below has already started
			const updates_state: {
				overrides: Array<() => void> | null;
				refreshes: Set<string> | null;
				error: Error | undefined;
			} = { overrides: null, refreshes: null, error: undefined };

			const promise = (async () => {
				try {
					await Promise.resolve();

					if (updates_state.error) {
						throw updates_state.error;
					}

					if (should_preflight) {
						const valid = await preflight(form_data);
						if (!valid) return false;
					}

					const outcome = await execute(convert(form_data));

					raw_issues = outcome.issues;
					result = outcome.result;

					// if the developer took control of updates via `.updates(...)` (even with
					// no arguments), or refreshed/set queries inside the handler, don't
					// refresh everything
					const should_invalidate = updates_state.refreshes === null && !outcome.handler_refreshed;

					if (outcome.redirect !== null) {
						if (updates_state.refreshes !== null) {
							await refresh_keys(updates_state.refreshes);
						} else if (should_invalidate) {
							void refresh_all();
						}

						if (!apply_redirect(outcome.redirect) && DEV) {
							console.warn(
								`A form handler redirected to "${outcome.redirect.location}" but no redirect handler is configured. ` +
									'Register one with `init({ redirect: (location) => ... })`.'
							);
						}

						return true;
					}

					const succeeded = raw_issues.length === 0;

					if (succeeded) {
						if (updates_state.refreshes !== null) {
							await refresh_keys(updates_state.refreshes);
						} else if (should_invalidate) {
							void refresh_all();
						}
					} else {
						if (DEV) {
							warn_on_missing_issue_reads();
						}
					}

					return succeeded;
				} catch (e) {
					result = undefined;
					raw_issues = [];
					throw e;
				} finally {
					updates_state.overrides?.forEach((fn) => fn());

					void tick().then(() => {
						if (entry) {
							entry.count--;
							if (entry.count === 0) {
								instances.delete(key);
							}
						}
					});
				}
			})() as Promise<boolean> & { updates: (...args: LocalQueryUpdate[]) => Promise<boolean> };

			let updates_called = false;
			promise.updates = (...args) => {
				if (updates_called) {
					console.warn(
						'Updates can only be applied once per form submission. Ignoring additional updates.'
					);
					return promise;
				}
				updates_called = true;

				try {
					const { refreshes, overrides } = categorize_updates(args);
					updates_state.refreshes = refreshes;
					updates_state.overrides = overrides;
				} catch (error) {
					updates_state.error = error as Error;
				}

				return promise;
			};

			return promise;
		}

		function create_enhance_callback_instance(
			form: HTMLFormElement,
			form_data: FormData
		): LocalFormEnhanceInstance<any, any> {
			const { enhance: _enhance, ...descriptors } = Object.getOwnPropertyDescriptors(instance);
			void _enhance;

			return Object.defineProperties(
				{},
				{
					...descriptors,
					element: {
						value: form
					},
					submit: {
						value: () => submit(form_data, false)
					}
				}
			) as LocalFormEnhanceInstance<any, any>;
		}

		async function preflight(form_data: FormData): Promise<boolean> {
			const data = convert(form_data);
			const schema = preflight_schema ?? shared_preflight_schema;
			const validated = await schema?.['~standard'].validate(data);

			if (validated?.issues) {
				raw_issues = merge_with_server_issues(
					form_data,
					raw_issues,
					validated.issues.map((issue) => normalize_issue(issue, false))
				);

				if (DEV) {
					warn_on_missing_issue_reads();
				}

				return false;
			}

			// Preflight passed - clear stale client-side preflight issues
			if (preflight_schema) {
				raw_issues = raw_issues.filter((issue) => issue.server);
			}

			return true;
		}

		const instance = {} as LocalForm<any, any> & Record<string | symbol, any>;

		instance.method = 'POST';
		instance.action = action;

		instance[createAttachmentKey()] = (form: HTMLFormElement) => {
			if (element) {
				let message = `A form object can only be attached to a single \`<form>\` element`;
				if (DEV && !key) {
					message += `. To create multiple instances, use \`myForm.for(key)\``;
				}

				throw new Error(message);
			}

			element = form;

			touched = {};

			const handle_submit = async (event: SubmitEvent) => {
				const form = event.target as HTMLFormElement;
				const submitter = event.submitter as HTMLButtonElement | HTMLInputElement | null;

				const method = submitter?.hasAttribute('formmethod')
					? submitter.formMethod
					: clone(form).method;

				if (method !== 'post') return;

				const action = new URL(
					// We can't do submitter.formAction directly because that property is always set
					submitter?.hasAttribute('formaction') ? submitter.formAction : clone(form).action
				);

				if (action.searchParams.get('/local') !== action_id) {
					return;
				}

				const target = submitter?.hasAttribute('formtarget')
					? submitter.formTarget
					: clone(form).target;

				if (target === '_blank') {
					return;
				}

				event.preventDefault();

				const form_data = new FormData(form, event.submitter);

				if (
					previous_submitter_name !== null &&
					!Array.from(form_data.keys()).map(strip_prefix).includes(previous_submitter_name)
				) {
					// Strip any `n:`/`b:` type prefix before clearing, otherwise
					// `set_nested_value` would coerce `undefined` to `NaN`/`false`
					// instead of clearing the previously-submitted value.
					set_nested_value(input, previous_submitter_name, undefined);
				}

				if (event.submitter) {
					const name = event.submitter.getAttribute('name');
					const value = (event.submitter as HTMLButtonElement).value;

					if (name !== null && value !== undefined) {
						set_nested_value(input, name, value);
					}

					previous_submitter_name = strip_prefix(name);
				} else {
					previous_submitter_name = null;
				}

				if (DEV) {
					validate_form_data(form_data, clone(form).enctype);
				}

				submitted = true;

				try {
					// Increment pending count immediately so that `pending` reflects
					// the in-progress state during async preflight validation
					pending_count++;

					const valid = await preflight(form_data);
					if (!valid) return;

					await enhance_callback(create_enhance_callback_instance(form, form_data));
				} catch (e) {
					// kit renders the nearest +error.svelte page here; locally we hand the
					// error to the configured hook, or rethrow (-> unhandled rejection)
					const onerror = get_config().onerror;
					if (onerror) {
						onerror(e);
					} else {
						throw e;
					}
				} finally {
					pending_count--;
				}
			};

			const handle_input = (e: Event) => {
				// strictly speaking it can be an HTMLTextAreaElement or HTMLSelectElement
				// but that makes the types unnecessarily awkward
				const element = e.target as HTMLInputElement;

				let name = element.name;
				if (!name) return;

				const is_array = name.endsWith('[]');
				if (is_array) name = name.slice(0, -2);

				const is_file = element.type === 'file';

				touched[name] = true;

				if (is_array) {
					let value;

					if (element.tagName === 'SELECT') {
						value = Array.from(
							element.querySelectorAll('option:checked'),
							(e) => (e as HTMLOptionElement).value
						);
					} else {
						const elements = Array.from(
							form.querySelectorAll(`[name="${name}[]"]`)
						) as HTMLInputElement[];

						if (DEV) {
							for (const e of elements) {
								if ((e.type === 'file') !== is_file) {
									throw new Error(
										`Cannot mix and match file and non-file inputs under the same name ("${element.name}")`
									);
								}
							}
						}

						value = is_file
							? elements.map((input) => Array.from(input.files ?? [])).flat()
							: elements.map((element) => element.value);
						if (element.type === 'checkbox') {
							value = (value as string[]).filter((_, i) => elements[i]?.checked);
						}
					}

					set_nested_value(input, name, value);
				} else if (is_file) {
					if (DEV && element.multiple) {
						throw new Error(
							`Can only use the \`multiple\` attribute when \`name\` includes a \`[]\` suffix — consider changing "${name}" to "${name}[]"`
						);
					}

					const file = element.files?.[0];

					if (file) {
						set_nested_value(input, name, file);
					} else {
						set_nested_value(input, name, DELETE_KEY);
					}
				} else {
					set_nested_value(
						input,
						name,
						element.type === 'checkbox' && !element.checked ? null : element.value
					);
				}

				name = strip_prefix(name);

				touched[name] = true;
			};

			const handle_reset = async () => {
				// need to wait a moment, because the `reset` event occurs before
				// the inputs are actually updated (so that it can be cancelled)
				await tick();

				input = convert_formdata(new FormData(form));
				raw_issues = [];
				touched = {};
			};

			form.addEventListener('submit', handle_submit);
			form.addEventListener('input', handle_input);
			form.addEventListener('reset', handle_reset);

			return () => {
				form.removeEventListener('submit', handle_submit);
				form.removeEventListener('input', handle_input);
				form.removeEventListener('reset', handle_reset);
				element = null;
			};
		};

		let validate_id = 0;

		Object.defineProperties(instance, {
			element: {
				get: () => element
			},
			submit: {
				value: () => {
					if (!element) {
						throw new Error('Cannot call submit() before the form is attached');
					}

					const default_submitter = element.querySelector('button:not([type]), [type="submit"]') as
						HTMLElement | undefined;

					const form_data = new FormData(element, default_submitter);

					if (DEV) {
						validate_form_data(form_data, clone(element).enctype);
					}

					submitted = true;
					pending_count++;

					const submission = submit(form_data, true);

					const decrement = () => {
						pending_count--;
					};
					void submission.then(decrement, decrement);

					return submission;
				}
			},
			fields: {
				get: () =>
					create_field_proxy(
						{},
						() => input,
						(path, value) => {
							if (path.length === 0) {
								input = value;
							} else {
								deep_set(input, path.map(String), value);

								const key = build_path_string(path);
								touched[key] = true;
							}
						},
						(path, all) => {
							if (DEV && unread_issues !== null && path !== undefined) {
								unread_issues = unread_issues.filter((issue) => {
									return (
										(all ? issue.path.slice(0, path.length) : issue.path).join('.') !==
										path.join('.')
									);
								});
							}

							return issues;
						}
					)
			},
			result: {
				get: () => result
			},
			pending: {
				get: () => pending_count
			},
			submitted: {
				get: () => submitted
			},
			preflight: {
				value: (schema: StandardSchemaV1) => {
					preflight_schema = schema;

					if (key === undefined) {
						shared_preflight_schema = schema;
					}

					return instance;
				}
			},
			validate: {
				value: async ({ includeUntouched = false, preflightOnly = false } = {}) => {
					if (!element) return;

					const validation_id = ++validate_id;

					// wait a tick in case the user is calling validate() right after set()
					// which takes time to propagate
					await tick();

					const default_submitter = element.querySelector('button:not([type]), [type="submit"]') as
						HTMLElement | undefined;

					const form_data = new FormData(element, default_submitter);

					let array: InternalFormIssue[] = [];

					const data = convert(form_data);
					const preflight = preflight_schema ?? shared_preflight_schema;
					const validated = await preflight?.['~standard'].validate(data);

					if (validate_id !== validation_id) {
						return;
					}

					let is_schema_validation = false;

					if (validated?.issues) {
						array = validated.issues.map((issue) => normalize_issue(issue, false));
					} else if (!preflightOnly && schema) {
						// where kit does a `validate_only` server round-trip, run the form's
						// own schema locally
						const result = await schema['~standard'].validate(data);

						if (validate_id !== validation_id) {
							return;
						}

						is_schema_validation = true;

						if (result.issues) {
							array = result.issues.map((issue) => normalize_issue(issue, true));
						}
					}

					if (!includeUntouched && !submitted) {
						array = array.filter((issue) => touched[issue.name]);
					}

					raw_issues = is_schema_validation
						? array
						: merge_with_server_issues(form_data, raw_issues, array);
				}
			},
			enhance: {
				value: (callback: (instance: LocalFormEnhanceInstance<any, any>) => unknown) => {
					enhance_callback = callback;
					return instance;
				}
			}
		});

		return instance;
	}

	const instance = create_instance();

	Object.defineProperty(instance, 'for', {
		value: (key: string | number | boolean) => {
			const entry = instances.get(key) ?? { count: 0, instance: create_instance(key) };

			try {
				$effect.pre(() => {
					return () => {
						entry.count--;

						void tick().then(() => {
							if (entry.count === 0) {
								instances.delete(key);
							}
						});
					};
				});

				entry.count += 1;
				instances.set(key, entry);
			} catch {
				// not in an effect context
			}

			return entry.instance;
		}
	});

	return instance;
}

/**
 * Shallow clone an element, so that we can access e.g. `form.action` without worrying
 * that someone has added an `<input name="action">`
 */
function clone<T extends HTMLElement>(element: T): T {
	return HTMLElement.prototype.cloneNode.call(element) as T;
}

function validate_form_data(form_data: FormData, enctype: string): void {
	for (const key of form_data.keys()) {
		if (/^\$[.[]?/.test(key)) {
			throw new Error(
				'`$` is used to collect all FormData validation issues and cannot be used as the `name` of a form control'
			);
		}
	}

	if (enctype !== 'multipart/form-data') {
		for (const value of form_data.values()) {
			if (value instanceof File) {
				throw new Error(
					'Your form contains <input type="file"> fields, but is missing the necessary `enctype="multipart/form-data"` attribute.'
				);
			}
		}
	}
}

/**
 * Remove the `n:` or `b:` prefix from a field name
 */
function strip_prefix<T extends string | null>(name: T): T {
	return (name && name.replace(/^[nb]:/, '')) as T;
}

type InferOutput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferOutput<Schema>;
type InferInput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferInput<Schema>;

/**
 * Define a form — the local equivalent of SvelteKit's `form` remote function.
 * Spread the returned object onto a `<form>` element:
 *
 * ```svelte
 * <form {...createPost}>
 * 	<input {...createPost.fields.title.as('text')} />
 * 	<button>Publish</button>
 * </form>
 * ```
 */
export function form<Output>(fn: () => MaybePromise<Output>): LocalForm<void, Output>;
export function form<Input extends LocalFormInput, Output>(
	validate: 'unchecked',
	fn: (data: Input, issue: InvalidField<Input>) => MaybePromise<Output>
): LocalForm<Input, Output>;
export function form<Schema extends StandardSchemaV1<LocalFormInput, Record<string, any>>, Output>(
	validate: true extends HasNonOptionalBoolean<InferInput<Schema>>
		? 'Error: All booleans in form schemas must be optional (e.g. `v.optional(v.boolean(), false)`) because checkbox inputs do not send a false value when unchecked.'
		: Schema,
	fn: (data: InferOutput<Schema>, issue: InvalidField<InferInput<Schema>>) => MaybePromise<Output>
): LocalForm<InferInput<Schema>, Output>;
export function form(
	validate_or_fn: Validator | ((data?: any, issue?: any) => unknown),
	maybe_fn?: (data?: any, issue?: any) => unknown
): LocalForm<any, any> {
	return create_form(validate_or_fn as Validator | ((data?: any) => unknown), maybe_fn);
}
