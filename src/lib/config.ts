export interface LocalQueryConfig {
	/**
	 * Called when `redirect(location)` is thrown inside a `query` or `form` handler.
	 * Wire this up to your router once at app startup, e.g.
	 *
	 * ```ts
	 * import { init } from 'svelte-local-query';
	 * import { goto } from '$app/navigation'; // or any router
	 *
	 * init({ redirect: (location) => goto(location) });
	 * ```
	 *
	 * If not configured, the thrown {@link Redirect} propagates as an error.
	 */
	redirect?: (location: string) => void;
	/**
	 * Called when a form submission handler throws an unexpected error (anything that
	 * is not a validation error or a redirect). This is the local replacement for
	 * SvelteKit rendering the nearest `+error.svelte` page.
	 *
	 * If not configured, the error is rethrown (surfacing as an unhandled rejection).
	 */
	onerror?: (error: unknown) => void;
}

let config: LocalQueryConfig = {};

/**
 * Configure global behavior of svelte-local-query. Call once at app startup.
 * Subsequent calls replace the previous configuration.
 */
export function init(options: LocalQueryConfig): void {
	config = { ...options };
}

export function get_config(): LocalQueryConfig {
	return config;
}

const REDIRECT = Symbol('local-query.redirect');

/**
 * The object thrown by {@link redirect}.
 */
export class Redirect {
	/** The [HTTP status code](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status#redirection_messages), in the range 300-308. Informational only — there is no HTTP response locally. */
	readonly status: 300 | 301 | 302 | 303 | 304 | 305 | 306 | 307 | 308;
	/** The location to redirect to. */
	readonly location: string;

	// used by is_redirect so that the check works across duplicated copies of the module
	declare [REDIRECT]: true;

	constructor(status: Redirect['status'], location: string) {
		this.status = status;
		this.location = location;
		Object.defineProperty(this, REDIRECT, { value: true });
	}
}

/**
 * Redirect a request. When called during a `query` or `form` handler, the registered
 * `init({ redirect })` hook is invoked with the target location; without a hook the
 * `Redirect` object propagates as the query's `error` / the submission's failure.
 *
 * Like in SvelteKit, redirects are not allowed inside `command` handlers.
 *
 * @param status ignored locally (kept for SvelteKit API parity); pass a location
 *   directly or a status + location pair
 * @throws Redirect this error instructs svelte-local-query to redirect to the specified location
 */
export function redirect(location: string | URL): never;
export function redirect(status: Redirect['status'], location: string | URL): never;
export function redirect(
	status_or_location: Redirect['status'] | string | URL,
	maybe_location?: string | URL
): never {
	if (typeof status_or_location === 'number') {
		if (isNaN(status_or_location) || status_or_location < 300 || status_or_location > 308) {
			throw new Error('Invalid status code');
		}

		throw new Redirect(status_or_location, String(maybe_location));
	}

	throw new Redirect(303, String(status_or_location));
}

/**
 * Checks whether this is a redirect thrown by {@link redirect}.
 */
export function isRedirect(e: unknown): e is Redirect {
	return typeof e === 'object' && e !== null && REDIRECT in e;
}

/**
 * Invoke the configured redirect hook for a caught {@link Redirect}, if any.
 * Returns `true` if a hook was configured and called.
 */
export function apply_redirect(redirect: Redirect): boolean {
	const hook = config.redirect;
	if (!hook) return false;
	hook(redirect.location);
	return true;
}
