import { DEV } from 'esm-env';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { InvalidField } from './types.js';

const VALIDATION_ERROR = Symbol('local-query.validation_error');

/**
 * A validation error thrown by {@link invalid} or by a failing argument schema.
 */
export class ValidationError extends Error {
	/** The validation issues */
	readonly issues: readonly StandardSchemaV1.Issue[];

	declare [VALIDATION_ERROR]: true;

	constructor(issues: readonly StandardSchemaV1.Issue[]) {
		super(issues[0]?.message ?? 'Validation failed');
		this.name = 'ValidationError';
		this.issues = issues;
		Object.defineProperty(this, VALIDATION_ERROR, { value: true });
	}
}

/**
 * Checks whether this is a validation error thrown by {@link invalid} or a failing schema.
 */
export function isValidationError(e: unknown): e is ValidationError {
	return typeof e === 'object' && e !== null && VALIDATION_ERROR in e;
}

/**
 * Imperatively create a validation error inside a `form` handler. Pass strings for
 * form-wide issues (only surfaced via `fields.allIssues()`) or field-specific issues
 * built with the handler's `issue` parameter:
 *
 * ```ts
 * const buy = form(schema, (data, issue) => {
 * 	if (data.qty > available) {
 * 		invalid(issue.qty(`Only ${available} left in stock`));
 * 	}
 * });
 * ```
 */
export function invalid(...issues: Array<string | StandardSchemaV1.Issue>): never {
	throw new ValidationError(
		issues.map((issue) => (typeof issue === 'string' ? { message: issue, path: [] } : issue))
	);
}

/**
 * Create the type-safe `issue` proxy passed as second argument to `form` handlers.
 * Property/index access builds up a path; calling the proxy produces a
 * Standard Schema issue for that path.
 */
export function create_issue_proxy(path: Array<string | number> = []): InvalidField<any> {
	const fn = (message: string): StandardSchemaV1.Issue => ({ message, path: [...path] });

	return new Proxy(fn, {
		get(target, prop) {
			if (typeof prop === 'symbol') return (target as any)[prop];
			if (/^\d+$/.test(prop)) return create_issue_proxy([...path, parseInt(prop, 10)]);
			return create_issue_proxy([...path, prop]);
		}
	}) as InvalidField<any>;
}

export type Validator = StandardSchemaV1 | 'unchecked' | undefined;

/**
 * Validate a query/command argument. SvelteKit performs this on the server and
 * responds with a generic 400; locally the {@link ValidationError} (carrying the
 * schema issues) is surfaced directly as the query's `error` / the command's rejection.
 */
export async function validate_arg<T>(validate: Validator, arg: unknown): Promise<T> {
	if (validate === undefined) {
		if (DEV && arg !== undefined) {
			throw new Error(
				'This function does not take an argument. ' +
					'To accept one, declare the handler with a parameter (its TypeScript type ' +
					'becomes the argument type), or use a schema or `"unchecked"`. Note that ' +
					'handlers with only default/rest parameters are treated as argument-less.'
			);
		}
		return undefined as T;
	}

	if (validate === 'unchecked') {
		return arg as T;
	}

	const result = await validate['~standard'].validate(arg);

	if (result.issues) {
		throw new ValidationError(result.issues);
	}

	return result.value as T;
}

/**
 * Split the `(validate, fn)` / `(fn)` overloaded arguments used by
 * `query`/`command`/`form`/`query.batch`/`query.live`.
 *
 * When declared as a bare handler, the handler's arity decides the semantics
 * (unlike SvelteKit, where `query(fn)` is strictly argument-less — see
 * DIFFERENCES.md): a handler with at least one declared parameter accepts an
 * argument typed by TypeScript alone, so the value passes through unvalidated
 * (same as `'unchecked'`). A zero-parameter handler stays argument-less.
 *
 * Caveat: handlers with only default/rest parameters (`(arg = {}) => ...`)
 * have `fn.length === 0` and are therefore treated as argument-less.
 */
export function parse_declaration<F>(
	validate_or_fn: Validator | F,
	maybe_fn: F | undefined
): { validate: Validator; fn: F } {
	if (maybe_fn === undefined) {
		const fn = validate_or_fn as F;
		return {
			validate: (fn as (...args: never[]) => unknown).length >= 1 ? 'unchecked' : undefined,
			fn
		};
	}

	return { validate: validate_or_fn as Validator, fn: maybe_fn };
}
