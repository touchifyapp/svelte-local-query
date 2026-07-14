import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: process.env.CI ? 'github' : 'list',
	use: {
		baseURL: 'http://localhost:4173',
		// In sandboxed environments with a preinstalled Chromium (e.g. Claude Code
		// remote sessions), point PLAYWRIGHT_CHROMIUM_PATH at the binary instead of
		// downloading a browser: PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium
		...(process.env.PLAYWRIGHT_CHROMIUM_PATH
			? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
			: {})
	},
	webServer: {
		command: 'npm run dev -- --port 4173 --strictPort',
		port: 4173,
		reuseExistingServer: !process.env.CI
	}
});
