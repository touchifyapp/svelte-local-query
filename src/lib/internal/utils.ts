export function noop(): void {}

/** Wrap a function so it only ever runs once. */
export function once<T extends (...args: never[]) => void>(fn: T): T {
	let called = false;
	return ((...args) => {
		if (called) return;
		called = true;
		fn(...args);
	}) as T;
}

export interface PromiseWithResolvers<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
}

export function with_resolvers<T>(): PromiseWithResolvers<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;

	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});

	return { promise, resolve, reject };
}
