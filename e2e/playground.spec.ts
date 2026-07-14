import { expect, test } from '@playwright/test';

/**
 * End-to-end regression suite: drives the vite playground (playground/) in a real
 * browser. Each test navigates fresh, so the playground's in-memory "database"
 * resets per test.
 */

test.beforeEach(async ({ page }) => {
	await page.goto('/');
});

test.describe('query', () => {
	test('loads lazily and renders the data', async ({ page }) => {
		await expect(page.getByTestId('todos').locator('li')).toHaveCount(2);
	});

	test('identical calls share a single instance', async ({ page }) => {
		await expect(page.getByTestId('dedup')).toHaveText(/shared: true/);
	});

	test('refresh() re-runs the query', async ({ page }) => {
		await expect(page.getByTestId('todos')).toBeVisible();
		await page.getByTestId('refresh').click();
		// data is unchanged, but the list must still be there after the round-trip
		await expect(page.getByTestId('todos').locator('li')).toHaveCount(2);
	});
});

test.describe('command', () => {
	test('optimistic override is visible while the command is pending, and survives the refresh', async ({
		page
	}) => {
		const like = page.getByTestId('like-1');
		const pending = page.getByTestId('like-pending');

		await expect(like).toHaveText(/❤️ 0/);

		await like.click();

		// the withOverride value must be visible *while* the command is still running
		await expect(pending).toHaveText('like pending: 1');
		await expect(like).toHaveText(/❤️ 1/);

		// once the command settles, the override is released and the refreshed
		// (committed) value takes over seamlessly
		await expect(pending).toHaveText('like pending: 0');
		await expect(like).toHaveText(/❤️ 1/);

		// a manual refresh still shows the committed value
		await page.getByTestId('refresh').click();
		await expect(like).toHaveText(/❤️ 1/);
	});
});

test.describe('form', () => {
	test('invalid submission populates field issues and skips the mutation', async ({ page }) => {
		await page.getByTestId('new-todo').fill('ab');
		await page.getByTestId('submit').click();

		await expect(page.getByTestId('issue')).toHaveText(/at least 3 characters/);
		await expect(page.getByTestId('todos').locator('li')).toHaveCount(2);
	});

	test('successful submission stores the result, clears issues and refreshes active queries', async ({
		page
	}) => {
		// first produce an issue, to prove it gets cleared
		await page.getByTestId('new-todo').fill('ab');
		await page.getByTestId('submit').click();
		await expect(page.getByTestId('issue')).toBeVisible();

		await page.getByTestId('new-todo').fill('a brand new todo');
		await page.getByTestId('submit').click();

		await expect(page.getByTestId('result')).toHaveText(/added: a brand new todo/);
		await expect(page.getByTestId('issue')).toHaveCount(0);
		// the default refresh-all picked up the new todo in the query section
		await expect(page.getByTestId('todos').locator('li')).toHaveCount(3);
	});
});

test.describe('query.live', () => {
	test('streams values and reports connection state', async ({ page }) => {
		const ticks = page.getByTestId('ticks');

		await expect(page.getByTestId('connected')).toHaveText('connected: true');
		await expect(ticks).not.toHaveText(/…/);

		const first = await ticks.textContent();
		await expect(ticks).not.toHaveText(first!);
	});
});

test('the page produces no errors', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(String(error)));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});

	await page.goto('/');
	await expect(page.getByTestId('todos')).toBeVisible();
	await page.getByTestId('like-1').click();
	await expect(page.getByTestId('like-pending')).toHaveText('like pending: 0');

	expect(errors).toEqual([]);
});
