/*
 * Ported from SvelteKit (MIT) — packages/kit/src/utils/shared-iterator.js
 */

interface Subscriber<T> {
	pending: { value: T } | null;
	pending_error: { error: unknown } | null;
	finished: boolean;
	waiting_resolve: ((result: IteratorResult<T, void>) => void) | null;
	waiting_reject: ((reason: unknown) => void) | null;
}

/**
 * A pull-style async iterator that fans out a single stream of values to multiple
 * `for await (...)` consumers. Each subscriber gets its own `AsyncGenerator` whose
 * `.next()` resolves whenever a value is pushed via `push(value)`.
 *
 * Backpressure is **latest-wins**: if values arrive faster than a particular consumer
 * drains its iterator, only the most-recently-pushed value is kept pending for that
 * subscriber. Earlier undrained values are dropped.
 *
 * The owner is responsible for calling `push(value)` to broadcast values, `done()` to
 * signal natural completion, and `fail(error)` to broadcast a terminal error.
 */
export class SharedIterator<T> {
	#subscribers = new Set<Subscriber<T>>();

	#start: ((instance: SharedIterator<T>) => () => void) | undefined = undefined;

	#stop: (() => void) | undefined = undefined;

	/** Once `done()` or `fail()` has been broadcast, no new values are accepted. */
	#closed = false;

	#terminal_error: unknown = undefined;

	/** Whether `done()` or `fail()` has been broadcast. */
	get closed(): boolean {
		return this.#closed;
	}

	constructor(start?: (instance: SharedIterator<T>) => () => void) {
		this.#start = start;
	}

	push(value: T): void {
		if (this.#closed) return;
		for (const subscriber of this.#subscribers) {
			if (subscriber.waiting_resolve) {
				const resolve = subscriber.waiting_resolve;
				subscriber.waiting_resolve = null;
				subscriber.waiting_reject = null;
				resolve({ value, done: false });
			} else {
				subscriber.pending = { value };
			}
		}
	}

	/**
	 * Signal natural completion to all current subscribers, and to any future
	 * subscriber (which will receive an immediately-done iterator).
	 */
	done(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const subscriber of this.#subscribers) {
			subscriber.finished = true;
			if (subscriber.waiting_resolve) {
				const resolve = subscriber.waiting_resolve;
				subscriber.waiting_resolve = null;
				subscriber.waiting_reject = null;
				resolve({ value: undefined, done: true });
			}
		}
		this.#subscribers.clear();
	}

	/**
	 * Broadcast a terminal error. All current subscribers will reject their next
	 * `.next()` call with `error`. Future subscribers will also reject their first `.next()`.
	 */
	fail(error: unknown): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#terminal_error = error;
		for (const subscriber of this.#subscribers) {
			subscriber.finished = true;
			if (subscriber.waiting_reject) {
				const reject = subscriber.waiting_reject;
				subscriber.waiting_resolve = null;
				subscriber.waiting_reject = null;
				reject(error);
			} else {
				subscriber.pending_error = { error };
			}
		}
		this.#subscribers.clear();
	}

	/**
	 * Subscribe to the shared stream. Returns an `AsyncGenerator<T>` that yields every
	 * value pushed after this call (and, if `initial_value` is provided, that value as
	 * the first yield).
	 */
	subscribe(options?: { initial_value?: { value: T } }): AsyncGenerator<T, void, void> {
		const subscriber: Subscriber<T> = {
			pending: options?.initial_value ? { value: options.initial_value.value } : null,
			pending_error:
				this.#closed && this.#terminal_error !== undefined
					? { error: this.#terminal_error }
					: null,
			finished: this.#closed && this.#terminal_error === undefined,
			waiting_resolve: null,
			waiting_reject: null
		};

		if (!subscriber.finished && subscriber.pending_error === null) {
			this.#subscribers.add(subscriber);
		}

		if (!this.#closed) {
			this.#stop ??= this.#start?.(this);
		}

		const unsubscribe = () => {
			subscriber.finished = true;
			const was_present = this.#subscribers.delete(subscriber);

			if (was_present && this.#subscribers.size === 0) {
				this.#stop?.();
			}
		};

		const iterator = {
			next() {
				if (subscriber.pending_error) {
					const { error } = subscriber.pending_error;
					subscriber.pending_error = null;
					unsubscribe();
					return Promise.reject(error);
				}

				if (subscriber.pending) {
					const { value } = subscriber.pending;
					subscriber.pending = null;
					return Promise.resolve({ value, done: false });
				}

				if (subscriber.finished) {
					return Promise.resolve({ value: undefined, done: true });
				}

				return new Promise((resolve, reject) => {
					subscriber.waiting_resolve = resolve;
					subscriber.waiting_reject = reject;
				});
			},
			return(value) {
				unsubscribe();
				if (subscriber.waiting_resolve) {
					const resolve = subscriber.waiting_resolve;
					subscriber.waiting_resolve = null;
					subscriber.waiting_reject = null;
					resolve({ value: undefined, done: true });
				}
				return Promise.resolve({ value: value as void, done: true });
			},
			throw(error) {
				unsubscribe();
				if (subscriber.waiting_reject) {
					const reject = subscriber.waiting_reject;
					subscriber.waiting_resolve = null;
					subscriber.waiting_reject = null;
					reject(error);
				}
				return Promise.reject(error);
			},
			[Symbol.asyncIterator]() {
				return iterator;
			}
		} as AsyncGenerator<T, void, void>;

		// `await using` support where the runtime provides the symbol
		if (Symbol.asyncDispose) {
			(iterator as unknown as Record<symbol, unknown>)[Symbol.asyncDispose] = () =>
				iterator.return(undefined);
		}

		return iterator;
	}
}
