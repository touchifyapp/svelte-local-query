import { tick } from 'svelte';
import { SharedIterator } from '../internal/shared-iterator.js';
import { noop, once, with_resolvers } from '../internal/utils.js';

/*
 * Ported from SvelteKit (MIT) —
 * packages/kit/src/runtime/client/remote-functions/query-live/instance.svelte.js
 *
 * Local differences: the value stream comes from a user-provided `AsyncIterable`
 * (usually an async generator) instead of a server-sent event stream, so all
 * network-related behavior (reconnection backoff, online/offline handling,
 * pagehide/pageshow listeners) is gone. Errors from the iterable are terminal —
 * call `reconnect()` to restart the stream.
 */

export class LiveQuery<T> {
	#fn: () => Promise<AsyncIterable<T>>;

	#loading = $state(true);
	#ready = $state(false);
	/** Is the underlying iterable currently running? */
	#connected = $state(false);
	/**
	 * Has the iterable completed? When this is `true`, the only way to start
	 * live-updating again is to call `.reconnect()`.
	 */
	#done = $state(false);
	#raw = $state.raw<T | undefined>();
	#error = $state.raw<unknown>(undefined);
	#promise = $state.raw<Promise<void>>(undefined as unknown as Promise<void>);
	#resolve_first: ((value: void) => void) | null = null;
	#reject_first: ((reason?: unknown) => void) | null = null;
	/**
	 * Interrupt the main loop, causing the current iteration (if active) to be stopped.
	 * Returns a promise that resolves when the main loop has fully stopped.
	 */
	#interrupt: (() => Promise<void>) | null = null;

	/**
	 * Fan-out for `for await` consumers attached to this LiveQuery's shared stream.
	 * New subscribers see the most-recently-emitted value (if any) as their first
	 * yield. Subsequent yields fire whenever `set()` is called.
	 */
	#fan_out = new SharedIterator<T>();

	#then: Promise<T>['then'] = $derived.by(() => {
		const p = this.#promise as unknown as Promise<T>;

		return ((resolve, reject) => {
			const result = p.then(tick).then(() => this.#raw as T);

			if (resolve || reject) {
				return result.then(resolve, reject);
			}

			return result;
		}) as Promise<T>['then'];
	});

	constructor(fn: () => Promise<AsyncIterable<T>>) {
		this.#fn = fn;

		// the semantics of awaiting a live query are:
		// - it's a promise that resolves to the first value from the stream
		// - thereafter, it's a promise that immediately resolves to the current value
		const { promise, resolve, reject } = with_resolvers<void>();
		this.#promise = promise;
		this.#resolve_first = resolve;
		this.#reject_first = reject;
	}

	async #main(
		{
			on_connect,
			on_connect_failed
		}: {
			on_connect: () => void;
			on_connect_failed: (reason?: unknown) => void;
		} = { on_connect: noop, on_connect_failed: noop }
	): Promise<void> {
		// this means we're already running the main loop
		if (this.#interrupt) return;

		const { promise: stopped, resolve: on_stop } = with_resolvers<void>();
		const { promise: interruption, resolve: signal_interrupt } = with_resolvers<'interrupted'>();
		let connected = false;
		let interrupted = false;
		let iterator: AsyncIterator<T> | null = null;

		this.#interrupt = () => {
			interrupted = true;
			// Wake the loop below even if the iterable is suspended on a pending await —
			// `AsyncGenerator.return()` queues behind the pending `next()` and would
			// otherwise block the interrupt indefinitely.
			signal_interrupt('interrupted');
			// Best-effort cleanup: the generator's `finally` blocks run once its
			// current await settles (immediately, if it is suspended at a `yield`).
			void iterator?.return?.().catch(noop);
			return stopped;
		};

		try {
			const iterable = await this.#fn();

			if (!interrupted) {
				iterator = iterable[Symbol.asyncIterator]();

				this.#connected = true;
				connected = true;
				on_connect();

				while (!interrupted) {
					const next = iterator.next();
					// if the interrupt wins the race, a later rejection of this pending
					// `next()` must not become an unhandled rejection
					next.catch(noop);
					const result = await Promise.race([next, interruption]);
					if (result === 'interrupted' || interrupted || result.done) break;
					this.set(result.value);
				}

				if (!interrupted) {
					if (!this.#ready) {
						throw new Error('Live query completed before yielding a value');
					}

					this.#done = true;
					this.#fan_out.done();
				}
			}
		} catch (error) {
			if (!interrupted) {
				this.fail(error);
				on_connect_failed(error);
			}
		} finally {
			this.#connected = false;
			this.#interrupt = null;
			// If the loop exited without ever successfully connecting, settle the
			// reconnect handshake so callers never await a forever-pending promise.
			if (!connected) {
				on_connect_failed(this.#error ?? new Error('Live query was interrupted'));
			}
			on_stop();
		}
	}

	#start = once(() => {
		this.#main().catch(noop);
	});

	/** Called by the cache when this resource is evicted. */
	destroy(): void {
		this.#fan_out.done();
		void this.#interrupt?.();
	}

	/**
	 * Iterate the stream of values yielded by this live query. Multiple iterators share
	 * the underlying iterable; the most-recently emitted value (if any) is yielded first
	 * to each new iterator, mirroring the semantics of awaiting the query directly.
	 *
	 * Backpressure note: if values arrive faster than the consumer drains, only the
	 * latest pending value is kept. Live streams are not event logs.
	 */
	[Symbol.asyncIterator](): AsyncGenerator<T, void, void> {
		this.#start();

		// Seed the new iterator with the current value (if any) so the first `.next()`
		// resolves synchronously. If the query has hard-failed, `#fan_out` is already
		// closed with the terminal error.
		return this.#fan_out.subscribe(
			this.#ready && this.#error === undefined
				? { initial_value: { value: this.#raw as T } }
				: undefined
		);
	}

	get then(): Promise<T>['then'] {
		this.#start();
		return this.#then;
	}

	get catch(): Promise<T>['catch'] {
		this.#start();
		void this.#then;
		return (reject) => {
			return this.#then(undefined, reject);
		};
	}

	get finally(): Promise<T>['finally'] {
		this.#start();
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
		this.#start();
		return this.#raw;
	}

	get error(): unknown {
		this.#start();
		return this.#error;
	}

	get loading(): boolean {
		this.#start();
		return this.#loading;
	}

	get ready(): boolean {
		this.#start();
		return this.#ready;
	}

	get connected(): boolean {
		this.#start();
		return this.#connected;
	}

	get done(): boolean {
		this.#start();
		return this.#done;
	}

	async reconnect(): Promise<void> {
		await this.#interrupt?.();

		const { promise, resolve: on_connect, reject: on_connect_failed } = with_resolvers<void>();
		promise.catch(noop);

		this.#done = false;
		// Keep the existing fan-out open so active `for await` consumers continue
		// receiving values from the new run without interruption. Only replace it if it
		// was already closed by a prior `done()`/`fail()`.
		if (this.#fan_out.closed) {
			this.#fan_out = new SharedIterator();
		}

		this.#main({ on_connect, on_connect_failed }).catch(noop);
		await promise;
	}

	set(value: T): void {
		this.#ready = true;
		this.#loading = false;
		this.#error = undefined;
		this.#raw = value;

		if (this.#resolve_first) {
			this.#resolve_first();
			this.#resolve_first = null;
			this.#reject_first = null;
		} else {
			this.#promise = Promise.resolve();
		}

		this.#fan_out.push(value);
	}

	fail(error: unknown): void {
		this.#loading = false;
		this.#error = error;
		// `fail` is terminal — once a live query has hard-failed, the only way to start
		// streaming again is via `reconnect()`.
		this.#done = true;
		void this.#interrupt?.();

		if (this.#reject_first) {
			this.#promise.catch(noop);
			this.#reject_first(error);
			this.#resolve_first = null;
			this.#reject_first = null;
		} else {
			const promise = Promise.reject(error);
			promise.catch(noop);
			this.#promise = promise as unknown as Promise<void>;
		}

		this.#fan_out.fail(error);
	}

	get [Symbol.toStringTag](): string {
		return 'LiveQuery';
	}
}
