import { tick, untrack } from 'svelte';
import { bump_epoch, QUERY_OVERRIDE_KEY } from '../internal/shared.svelte.js';
import { noop, with_resolvers } from '../internal/utils.js';

/*
 * Ported from SvelteKit (MIT) —
 * packages/kit/src/runtime/client/remote-functions/query/instance.svelte.js
 * (minus the SSR `query_responses` seeding and HTTP error handling, which do not
 * apply to local functions).
 */

/**
 * The actual query instance. There should only ever be one active query instance per key.
 */
export class Query<T> {
	#key: string;
	#fn: () => Promise<T>;

	#loading = $state(true);
	#latest: Array<(value: undefined) => void> = [];

	#ready = $state(false);
	#raw = $state.raw<T | undefined>();
	#promise = $state.raw<Promise<void> | null>(null);
	#overrides = $state<Array<(old: T) => T>>([]);

	#current: T | undefined = $derived.by(() => {
		// don't reduce undefined value
		if (!this.#ready) return undefined;

		return this.#overrides.reduce((v, r) => r(v), this.#raw as T);
	});

	#error = $state.raw<unknown>(undefined);

	#then: Promise<T>['then'] = $derived.by(() => {
		const p = this.#get_promise();
		void this.#overrides.length;

		return ((resolve, reject) => {
			const result = p.then(tick).then(() => this.#current as T);

			if (resolve || reject) {
				return result.then(resolve, reject);
			}

			return result;
		}) as Promise<T>['then'];
	});

	constructor(key: string, fn: () => Promise<T>) {
		this.#key = key;
		this.#fn = fn;
	}

	#get_promise(): Promise<void> {
		void untrack(() => (this.#promise ??= this.#run()));
		return this.#promise as Promise<void>;
	}

	start(): void {
		// there is a really weird bug with untrack and writes and initializations
		// every time you see this comment, try removing the `tick.then` here and see
		// if all the tests still pass with the latest svelte version
		// if they do, congrats, you can remove tick.then
		void tick()
			.then(() => this.#get_promise())
			.catch(noop);
	}

	#clear_pending(): void {
		this.#latest.forEach((r) => r(undefined));
		this.#latest.length = 0;
	}

	#run(): Promise<void> {
		this.#loading = true;

		const { promise, resolve, reject } = with_resolvers<undefined>();

		// the rejection is surfaced via `.error` / the `then` getter for awaiting
		// consumers — a purely reactive consumer (`.current`) attaches no handler,
		// so make sure the stored promise can never become an unhandled rejection
		promise.catch(noop);

		this.#latest.push(resolve);

		Promise.resolve(this.#fn())
			.then((value) => {
				// Skip the response if the resource was refreshed with a later promise
				// while we were waiting for this one to resolve
				const idx = this.#latest.indexOf(resolve);
				if (idx === -1) return;

				// Untrack this to not trigger mutation validation errors which can occur
				// if you do e.g. $derived({ a: await queryA(), b: await queryB() })
				untrack(() => {
					this.#latest.splice(0, idx).forEach((r) => r(undefined));
					this.#ready = true;
					this.#loading = false;
					this.#raw = value;
					this.#error = undefined;
				});

				resolve(undefined);
			})
			.catch((e) => {
				const idx = this.#latest.indexOf(resolve);
				if (idx === -1) return;

				untrack(() => {
					this.#latest.splice(0, idx).forEach((r) => r(undefined));
					this.#error = e;
					this.#loading = false;
				});

				reject(e);
			});

		return promise;
	}

	get then(): Promise<T>['then'] {
		// TODO this should be unnecessary but due to the bug described
		// in #start, we need to do this in some circumstances
		this.start();
		return this.#then;
	}

	get catch(): Promise<T>['catch'] {
		this.start();
		void this.#then;
		return (reject) => {
			return this.#then(undefined, reject);
		};
	}

	get finally(): Promise<T>['finally'] {
		this.start();
		void this.#then;
		return (fn) => {
			return this.#then(
				(value) => {
					fn?.();
					return value;
				},
				(error) => {
					fn?.();
					throw error;
				}
			) as Promise<T>;
		};
	}

	get current(): T | undefined {
		this.start();
		return this.#current;
	}

	get error(): unknown {
		this.start();
		return this.#error;
	}

	/**
	 * Returns true if the resource is loading or reloading.
	 */
	get loading(): boolean {
		this.start();
		return this.#loading;
	}

	/**
	 * Returns true once the resource has been loaded for the first time.
	 */
	get ready(): boolean {
		this.start();
		return this.#ready;
	}

	refresh(): Promise<void> {
		bump_epoch();
		return (this.#promise = this.#run());
	}

	set(value: T): void {
		bump_epoch();
		this.#clear_pending();
		this.#ready = true;
		this.#loading = false;
		this.#error = undefined;
		this.#raw = value;
		this.#promise = Promise.resolve();
	}

	fail(error: unknown): void {
		this.#clear_pending();
		this.#loading = false;
		this.#error = error;

		const promise = Promise.reject(error);

		promise.catch(noop);
		this.#promise = promise as unknown as Promise<void>;
	}

	withOverride(fn: (old: T) => T): (() => void) & { [QUERY_OVERRIDE_KEY]: string } {
		this.#overrides.push(fn);

		const release = (() => {
			const i = this.#overrides.indexOf(fn);

			if (i !== -1) {
				this.#overrides.splice(i, 1);
			}
		}) as (() => void) & { [QUERY_OVERRIDE_KEY]: string };

		Object.defineProperty(release, QUERY_OVERRIDE_KEY, { value: this.#key });

		return release;
	}

	get [Symbol.toStringTag](): string {
		return 'Query';
	}
}
