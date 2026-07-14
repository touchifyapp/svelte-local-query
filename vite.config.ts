import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [svelte()],
	// `npm run dev` serves the manual end-to-end playground page
	root: process.env.VITEST ? undefined : 'playground',
	resolve: process.env.VITEST
		? {
				// vitest runs in jsdom; resolve svelte to its client (browser) build
				conditions: ['browser']
			}
		: undefined,
	test: {
		environment: 'jsdom',
		include: ['src/**/*.{test,spec}.{js,ts}'],
		setupFiles: ['./src/tests/setup.ts'],
		// allow tests to trigger garbage collection to exercise the
		// FinalizationRegistry-based cache eviction
		execArgv: ['--expose-gc']
	}
});
