/*
 * Public types, ported from SvelteKit's remote-functions types (MIT) with
 * `Remote*` renamed to `Local*`. Kept as close to the originals as possible so
 * that code written against SvelteKit remote functions type-checks the same way.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';

export type MaybePromise<T> = T | Promise<T>;

type MaybeArray<T> = T | T[];

type ImageInputValue = { x: number; y: number };

type IsImageInputValue<T> = T extends ImageInputValue
	? Exclude<keyof T, keyof ImageInputValue> extends never
		? true
		: false
	: false;

type IsAny<T> = 0 extends 1 & T ? true : false;

// If T is unknown or has an index signature, the types below will recurse indefinitely
// and create giant unions that TS can't handle
type WillRecurseIndefinitely<T> = unknown extends T ? true : string extends keyof T ? true : false;

type DeepPartial<T> = T extends Record<PropertyKey, unknown> | unknown[]
	? {
			[K in keyof T]?: DeepPartial<T[K]>;
		}
	: T;

// These two types use "T extends unknown ? .. : .." to distribute over unions.
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type ValueOfUnionKey<T, K extends PropertyKey> = T extends unknown
	? K extends keyof T
		? T[K]
		: never
	: never;

/**
 * Compile-time guard: boolean fields in form schemas that accept `false` must be
 * optional, because checkbox inputs do not send a value when unchecked. A required
 * `true` property is allowed, because leaving its checkbox unchecked should fail.
 */
export type HasNonOptionalBoolean<T> =
	IsAny<T> extends true
		? never
		: [T] extends [boolean]
			? true
			: T extends Array<infer U>
				? HasNonOptionalBoolean<U>
				: T extends Record<string, any>
					? { [K in keyof T]: [T[K]] extends [true] ? never : HasNonOptionalBoolean<T[K]> }[keyof T]
					: never;

// Input type mappings for form fields
type InputTypeMap = {
	text: string;
	email: string;
	password: string;
	url: string;
	tel: string;
	search: string;
	number: number;
	range: number;
	date: string;
	'datetime-local': string;
	time: string;
	month: string;
	week: string;
	color: string;
	checkbox: boolean | string[];
	radio: string;
	file: File;
	hidden: string | number | boolean;
	submit: string | number | boolean;
	button: string;
	reset: string;
	image: ImageInputValue;
	select: string;
	'select multiple': string[];
	'file multiple': File[];
};

/** Valid input types for a given value type */
export type LocalFormFieldType<T> = {
	[K in keyof InputTypeMap]: T extends InputTypeMap[K] ? K : never;
}[keyof InputTypeMap];

// Input element properties based on type
type InputElementProps<T extends keyof InputTypeMap, Value> = T extends 'checkbox' | 'radio'
	? {
			name: string;
			type: T;
			value?: string;
			'aria-invalid': boolean | 'false' | 'true' | undefined;
			get checked(): boolean;
			set checked(value: boolean);
			readonly defaultChecked?: boolean;
		}
	: T extends 'image'
		? {
				name: string;
				type: 'image';
				'aria-invalid': boolean | 'false' | 'true' | undefined;
			}
		: T extends 'file'
			? {
					name: string;
					type: 'file';
					'aria-invalid': boolean | 'false' | 'true' | undefined;
					get files(): FileList | null;
					set files(v: FileList | null);
				}
			: T extends 'select'
				? {
						name: string;
						'aria-invalid': boolean | 'false' | 'true' | undefined;
						get value(): string;
						set value(v: string);
					}
				: T extends 'select multiple'
					? {
							name: string;
							multiple: true;
							'aria-invalid': boolean | 'false' | 'true' | undefined;
							get value(): string[];
							set value(v: string[]);
						}
					: T extends 'text'
						? {
								name: string;
								'aria-invalid': boolean | 'false' | 'true' | undefined;
								get value(): Value extends string ? string : string | number;
								set value(v: Value extends string ? string : string | number);
								readonly defaultValue?: Value extends string ? string : string | number;
							}
						: {
								name: string;
								type: T;
								'aria-invalid': boolean | 'false' | 'true' | undefined;
								get value(): string | number;
								set value(v: string | number);
								readonly defaultValue?: string | number;
							};

type LocalFormFieldMethods<T> = {
	/** The values that will be submitted */
	value(): DeepPartial<T>;
	/** Set the values that will be submitted */
	set(input: DeepPartial<T>): DeepPartial<T>;
	/** Whether the field or any nested field has been interacted with since the form was mounted */
	touched(): boolean;
	/** Whether the field or any nested field has been edited since the form was mounted */
	dirty(): boolean;
	/** Validation issues, if any */
	issues(): LocalFormIssue[] | undefined;
};

export type LocalFormFieldValue =
	string | string[] | number | boolean | File | File[] | ImageInputValue;

type AsArgs<Type extends keyof InputTypeMap, Value> = Type extends 'checkbox'
	? Value extends string[]
		? [type: Type, value: Value[number] | (string & {}), checked?: boolean]
		: Value extends boolean
			? [type: Type, value?: boolean]
			: [type: Type, value?: Value]
	: Type extends 'image'
		? [type: Type]
		: Type extends 'submit' | 'hidden'
			? Value extends string
				? [type: Type, value: Value | (string & {})]
				: [type: Type, value: Value]
			: Type extends 'radio'
				? [type: Type, value: Value | (string & {}), checked?: boolean]
				: Type extends 'file' | 'file multiple'
					? [type: Type]
					: [type: Type, value?: Value];

type WidenLiteralString<T> = T extends string ? (string extends T ? T : string) : T;

/**
 * Form field accessor type that provides `value()`, `set()`, `issues()` and `as()` methods
 */
export type LocalFormField<Value extends LocalFormFieldValue> = LocalFormFieldMethods<Value> & {
	/**
	 * Returns an object that can be spread onto an input element with the correct type
	 * attribute, aria-invalid attribute if the field is invalid, and appropriate
	 * value/checked property getters/setters.
	 * @example
	 * ```svelte
	 * <input {...myForm.fields.myString.as('text')} />
	 * <input {...myForm.fields.myNumber.as('number')} />
	 * <input {...myForm.fields.myBoolean.as('checkbox')} />
	 * ```
	 */
	as<T extends LocalFormFieldType<Value>>(
		...args: AsArgs<T, Value>
	): InputElementProps<T, WidenLiteralString<Value>>;
};

type LocalFormFieldContainer<Value> = LocalFormFieldMethods<Value> & {
	/** Validation issues belonging to this or any of the fields that belong to it, if any */
	allIssues(): LocalFormIssue[] | undefined;
};

type UnknownField<Value> = LocalFormFieldMethods<Value> & {
	/** Validation issues belonging to this or any of the fields that belong to it, if any */
	allIssues(): LocalFormIssue[] | undefined;
	as<T extends LocalFormFieldType<Value>>(...args: AsArgs<T, Value>): InputElementProps<T, Value>;
} & {
	[key: string | number]: UnknownField<any>;
};

type LocalFormFieldsRoot<
	Input extends LocalFormInput | void,
	Original extends [LocalFormInput | void] = [Input]
> =
	IsAny<Input> extends true
		? RecursiveFormFields
		: Input extends void
			? {
					/** Validation issues, if any */
					issues(): LocalFormIssue[] | undefined;
					/** Validation issues belonging to this or any of the fields that belong to it, if any */
					allIssues(): LocalFormIssue[] | undefined;
				}
			: WillRecurseIndefinitely<Input> extends true
				? RecursiveFormFields
				: LocalFormFieldContainer<Original[0]> & {
						[K in KeysOfUnion<Original[0]>]-?: LocalFormFields<ValueOfUnionKey<Original[0], K>>;
					};

/**
 * Recursive type to build form fields structure with proxy access
 */
export type LocalFormFields<T> =
	WillRecurseIndefinitely<T> extends true
		? RecursiveFormFields
		: NonNullable<T> extends string | number | boolean | File
			? LocalFormField<NonNullable<T>>
			: IsImageInputValue<NonNullable<T>> extends true
				? LocalFormField<NonNullable<T> & ImageInputValue> &
						Pick<LocalFormFieldContainer<T>, 'allIssues'> & {
							[K in KeysOfUnion<T>]-?: LocalFormFields<ValueOfUnionKey<T, K>>;
						}
				: // [NonNullable<T>] is used to prevent distributing over union while still allowing
					// nullable wrappers (e.g. `string[] | undefined` from a schema with `.default([])`)
					// to be treated as arrays; only the last condition should distribute over unions
					[NonNullable<T>] extends [string[] | File[]]
					? LocalFormField<NonNullable<T>> & {
							[K in number]: LocalFormField<NonNullable<T>[number]>;
						}
					: [NonNullable<T>] extends [Array<infer U>]
						? LocalFormFieldContainer<NonNullable<T>> & {
								[K in number]: LocalFormFields<U>;
							}
						: LocalFormFieldContainer<T> & {
								[K in KeysOfUnion<T>]-?: LocalFormFields<ValueOfUnionKey<T, K>>;
							};

// By breaking this out into its own type, we avoid the TS recursion depth limit
type RecursiveFormFields = LocalFormFieldContainer<any> & {
	[key: string | number]: UnknownField<any>;
};

export interface LocalFormInput {
	// arrays can contain `undefined` where an indexed control submitted nothing,
	// such as an unchecked checkbox or an unselected radio button
	[key: string]: MaybeArray<string | number | boolean | File | LocalFormInput | undefined>;
}

export interface LocalFormIssue {
	message: string;
	path: Array<string | number>;
}

// If the schema specifies `id` as a string or number, ensure that `for(...)`
// only accepts that type. Otherwise, accept `string | number`
type ExtractId<Input> = Input extends { id: infer Id }
	? Id extends string | number
		? Id
		: string | number
	: string | number;

/**
 * A function and proxy object used to imperatively create validation errors in form
 * handlers. Access properties to create field-specific issues: `issue.fieldName('message')`.
 * Call `invalid(issue.foo(...), issue.nested.bar(...))` to throw a validation error.
 */
export type LocalFormInvalidField<T> =
	WillRecurseIndefinitely<T> extends true
		? Record<string | number, any>
		: NonNullable<T> extends string | number | boolean | File
			? (message: string) => StandardSchemaV1.Issue
			: NonNullable<T> extends Array<infer U>
				? {
						[K in number]: LocalFormInvalidField<U>;
					} & ((message: string) => StandardSchemaV1.Issue)
				: NonNullable<T> extends LocalFormInput
					? {
							[K in keyof T]-?: LocalFormInvalidField<T[K]>;
						} & ((message: string) => StandardSchemaV1.Issue)
					: Record<string, never>;

/**
 * The form instance as received inside an `enhance` callback.
 */
export type LocalFormEnhanceInstance<
	Input extends LocalFormInput | void = LocalFormInput | void,
	Output = any
> = Omit<LocalForm<Input, Output>, 'enhance' | 'element'> & {
	readonly element: HTMLFormElement;
};

/**
 * The callback passed to a local form's `enhance` method.
 */
export type LocalFormEnhanceCallback<
	Input extends LocalFormInput | void = LocalFormInput | void,
	Output = any
> = (form: LocalFormEnhanceInstance<Input, Output>) => MaybePromise<void>;

/**
 * The type of a local `form` function. Mirrors SvelteKit's `RemoteForm`.
 */
export type LocalForm<Input extends LocalFormInput | void, Output> = LocalForm_<
	Input,
	Output,
	[Input]
>;

type LocalForm_<
	Input extends LocalFormInput | void,
	Output,
	Original extends [LocalFormInput | void]
> = {
	/** Attachment that sets up an event handler that intercepts the form submission */
	[attachment: symbol]: (node: HTMLFormElement) => void;
	method: 'POST';
	/** Kept for SvelteKit API parity — identifies the form instance; there is no endpoint behind it. */
	action: string;
	/** The `<form>` element this instance is currently attached to, if any. */
	get element(): HTMLFormElement | null;
	/** Submit the currently attached form programmatically. */
	submit(): Promise<boolean> & {
		updates: (...updates: LocalQueryUpdate[]) => Promise<boolean>;
	};
	/** Use the `enhance` method to influence what happens when the form is submitted. */
	enhance(callback: LocalFormEnhanceCallback<Input, Output>): {
		method: 'POST';
		action: string;
		[attachment: symbol]: (node: HTMLFormElement) => void;
	};
	/**
	 * Create an instance of the form for the given `id`. The `id` is stringified and used
	 * for deduplication to potentially reuse existing instances. Useful when you have
	 * multiple forms that use the same form function, for example in a loop.
	 */
	for(id: ExtractId<Input>): Omit<LocalForm<Input, Output>, 'for'>;
	/** Register a client-side validation schema that runs before the handler. */
	preflight(schema: StandardSchemaV1<Input, any>): LocalForm<Input, Output>;
	/** Validate the form contents programmatically */
	validate(options?: {
		/**
		 * Set this to `true` to also show validation issues of fields that haven't yet been
		 * edited and blurred. This option is ignored for forms that have previously been
		 * submitted, in which case all fields are always subject to validation
		 * (unless the form is reset, at which point it is treated as pristine)
		 */
		all?: boolean;
		/** Set this to `true` to only run the `preflight` validation. */
		preflightOnly?: boolean;
	}): Promise<void>;
	/** The result of the form submission */
	get result(): Output | undefined;
	/** The number of pending submissions */
	get pending(): number;
	/** True if the form has been submitted at least once, and hasn't been reset since */
	get submitted(): boolean;
	/** Access form fields using object notation */
	fields: LocalFormFieldsRoot<Input, Original>;
};

/**
 * The type of a local `command` function. Mirrors SvelteKit's `RemoteCommand`.
 */
export type LocalCommand<Input, Output> = {
	(arg: undefined extends Input ? Input | void : Input): Promise<Output> & {
		updates(...updates: LocalQueryUpdate[]): Promise<Output>;
	};
	/** The number of pending command executions */
	get pending(): number;
};

export type LocalQueryUpdate =
	| LocalQuery<any>
	| LocalLiveQuery<any>
	| LocalQueryFunction<any, any>
	| LocalLiveQueryFunction<any, any>
	| LocalQueryOverride;

/**
 * The reactive, awaitable resource shared by queries and live queries.
 * Mirrors SvelteKit's `RemoteResource`.
 */
export type LocalResource<T> = Promise<T> & {
	/** The error in case the query fails. */
	get error(): any;
	/** `true` before the first result is available and during refreshes */
	get loading(): boolean;
} & (
		| {
				/** The current value of the query. Undefined until `ready` is `true` */
				get current(): undefined;
				ready: false;
		  }
		| {
				/** The current value of the query. Undefined until `ready` is `true` */
				get current(): T;
				ready: true;
		  }
	);

/**
 * The return value of calling a local `query` function. Mirrors SvelteKit's `RemoteQuery`.
 */
export type LocalQuery<T> = LocalResource<T> & {
	/** Update the value of the query without re-running it. */
	set(value: T): void;
	/** Re-run the query function and update the value. */
	refresh(): Promise<void>;
	/**
	 * Temporarily override a query's value while a mutation is in flight, to provide
	 * optimistic updates. Pass the returned override to a command's or form submission's
	 * `.updates(...)`.
	 *
	 * ```svelte
	 * <form {...addTodo.enhance(async (form) => {
	 *   await form.submit().updates(
	 *     todos.withOverride((todos) => [...todos, { text: form.fields.text.value() }])
	 *   );
	 * })}>
	 * ```
	 */
	withOverride(update: (current: T) => T): LocalQueryOverride;
};

/**
 * The return value of calling a local `query.live` function. Mirrors SvelteKit's `RemoteLiveQuery`.
 */
export type LocalLiveQuery<T> = LocalResource<T> &
	AsyncIterable<T> & {
		/** `true` if the live stream is currently running. */
		readonly connected: boolean;
		/** `true` once the current live stream iterator is done. */
		readonly done: boolean;
		/** Restarts the live stream immediately (re-invokes the handler). */
		reconnect(): Promise<void>;
	};

export type LocalQueryOverride = () => void;

/**
 * The type of a local `query` function. Mirrors SvelteKit's `RemoteQueryFunction`.
 *
 * The optional `Validated` generic represents the argument type *after* the query's
 * schema has validated and (optionally) transformed it.
 */
export type LocalQueryFunction<Input, Output, _Validated = Input> = (
	arg: undefined extends Input ? Input | void : Input
) => LocalQuery<Output>;

/**
 * The type of a local `query.live` function. Mirrors SvelteKit's `RemoteLiveQueryFunction`.
 */
export type LocalLiveQueryFunction<Input, Output, _Validated = Input> = (
	arg: undefined extends Input ? Input | void : Input
) => LocalLiveQuery<Output>;

/**
 * What a `query.live` handler must return: anything async-iterable (most commonly an
 * async generator). In SvelteKit this is streamed over the network; locally the
 * iterable is consumed directly.
 */
export type LiveQueryHandlerResult<Output> = MaybePromise<AsyncIterable<Output>>;
