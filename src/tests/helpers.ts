import { tick } from 'svelte';

/**
 * Run garbage collection a handful of times. V8 sometimes needs more than one pass
 * before a recently-allocated object is reclaimed. After each pass we yield to the
 * microtask queue so any FinalizationRegistry callbacks get a chance to run.
 */
export async function run_gc(): Promise<void> {
	for (let i = 0; i < 4; i++) {
		(globalThis as { gc?: () => void }).gc?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await tick();
	}
	// Flush the deferred eviction (`tick().then(...)`) inside `deref`.
	await tick();
	await tick();
}

/**
 * Wait for a GC-driven condition. We poll because GC scheduling is non-deterministic.
 */
export async function wait_for(predicate: () => boolean, timeout = 2000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		await run_gc();
		if (predicate()) return;
	}
	throw new Error('Timed out waiting for predicate');
}

/** Pump both the Svelte tick queue and the macrotask queue a couple of times. */
export async function flush(): Promise<void> {
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

export function track_unhandled(): { unhandled: unknown[]; stop: () => void } {
	const unhandled: unknown[] = [];
	const listener = (reason: unknown) => unhandled.push(reason);
	process.on('unhandledRejection', listener);
	return {
		unhandled,
		stop: () => {
			process.off('unhandledRejection', listener);
		}
	};
}

export const has_gc = typeof (globalThis as { gc?: () => void }).gc === 'function';
