import { afterEach, describe, expect, test, vi } from 'vitest';
import * as v from 'valibot';
import { form } from './index.svelte.js';
import { query } from '../query/index.js';
import { init, redirect } from '../config.js';
import { invalid } from '../validation.js';
import { flush } from '../../tests/helpers.js';
import type { LocalForm } from '../types.js';

/**
 * Manually run the attachment (what `<form {...instance}>` does in a component)
 * and register cleanup.
 */
const teardowns: Array<() => void> = [];

function attach(instance: LocalForm<any, any>, fields: Record<string, string> = {}) {
	const element = document.createElement('form');
	element.setAttribute('method', instance.method);
	element.setAttribute('action', instance.action);

	for (const [name, value] of Object.entries(fields)) {
		const input = document.createElement('input');
		input.name = name;
		input.value = value;
		element.appendChild(input);
	}

	const button = document.createElement('button');
	button.type = 'submit';
	element.appendChild(button);

	document.body.appendChild(element);

	const attachment_key = Object.getOwnPropertySymbols(instance).find(
		(symbol) => typeof (instance as any)[symbol] === 'function'
	)!;
	const teardown = (instance as any)[attachment_key](element) as () => void;

	teardowns.push(() => {
		teardown();
		element.remove();
	});

	return element;
}

function submit_event(element: HTMLFormElement): void {
	element.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
}

async function until(predicate: () => boolean, timeout = 1000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeout) throw new Error('Timed out waiting for predicate');
		await flush();
	}
}

afterEach(() => {
	init({});
	teardowns.splice(0).forEach((teardown) => teardown());
});

describe('form', () => {
	test('spreadable props identify the form', () => {
		const my_form = form(async () => 'done');

		expect(my_form.method).toBe('POST');
		expect(my_form.action).toMatch(/^\?\/local=/);
		expect(Object.getOwnPropertySymbols(my_form).length).toBeGreaterThan(0);
	});

	test('submitting runs the handler with coerced data and stores the result', async () => {
		let received: unknown;
		const my_form = form('unchecked', async (data: { title: string; qty: number }) => {
			received = data;
			return 'created';
		});

		const element = attach(my_form, { title: 'hello', 'n:qty': '2' });
		submit_event(element);

		await until(() => my_form.result !== undefined);

		expect(received).toEqual({ title: 'hello', qty: 2 });
		expect(my_form.result).toBe('created');
		expect(my_form.submitted).toBe(true);
		expect(my_form.pending).toBe(0);
	});

	test('schema failures skip the handler and populate field issues', async () => {
		const handler = vi.fn();
		const my_form = form(
			v.object({ title: v.pipe(v.string(), v.minLength(5, 'too short')) }),
			handler
		);

		const element = attach(my_form, { title: 'hi' });
		submit_event(element);

		await until(() => (my_form.fields as any).title.issues() !== undefined);

		expect(handler).not.toHaveBeenCalled();
		expect((my_form.fields as any).title.issues()).toEqual([
			{ message: 'too short', path: ['title'] }
		]);
		expect((my_form.fields as any).title.as('text')['aria-invalid']).toBe('true');
		expect(my_form.result).toBeUndefined();
	});

	test('invalid() with the issue proxy produces field issues', async () => {
		const my_form = form(
			v.object({ qty: v.pipe(v.string(), v.transform(Number)) }),
			async (data, issue) => {
				if (data.qty > 3) invalid(issue.qty('too many'), 'form-wide problem');
				return 'ok';
			}
		);

		const element = attach(my_form, { qty: '5' });
		submit_event(element);

		await until(() => (my_form.fields as any).qty.issues() !== undefined);

		expect((my_form.fields as any).qty.issues()).toEqual([{ message: 'too many', path: ['qty'] }]);
		// form-wide (path-less) issues only surface via allIssues()
		expect((my_form.fields as any).allIssues()).toHaveLength(2);
	});

	test('a successful submission refreshes all active queries by default', async () => {
		let count = 0;
		const get_count = query(async () => count);
		const q = get_count();
		await expect(q).resolves.toBe(0);

		const my_form = form(async () => {
			count++;
		});

		const element = attach(my_form);
		submit_event(element);

		await until(() => q.current === 1);
		expect(q.current).toBe(1);
	});

	test('refreshing a query inside the handler disables the default refresh-all', async () => {
		let a = 0;
		let b = 0;
		const get_a = query(async () => a);
		const get_b = query(async () => b);
		const qa = get_a();
		const qb = get_b();
		await Promise.all([qa, qb]);

		const my_form = form(async () => {
			a++;
			b++;
			void get_a().refresh();
		});

		const element = attach(my_form);
		submit_event(element);

		await until(() => qa.current === 1);
		await flush();

		// only the explicitly refreshed query updated
		expect(qa.current).toBe(1);
		expect(qb.current).toBe(0);
	});

	test('enhance with submit().updates() takes control of invalidation', async () => {
		let items = ['a'];
		const get_items = query(async () => items);
		const q = get_items();
		await q;

		let other = 0;
		const get_other = query(async () => other);
		const q_other = get_other();
		await q_other;

		const my_form = form('unchecked', async (data: { item: string }) => {
			items = [...items, data.item];
			other++;
		});

		let optimistic: string[] | undefined;

		my_form.enhance(async (instance) => {
			const submission = instance.submit().updates(q.withOverride((current) => [...current, 'b']));
			optimistic = q.current;
			await submission;
		});

		const element = attach(my_form, { item: 'b' });
		submit_event(element);

		await until(() => q.current?.length === 2 && my_form.pending === 0);

		expect(optimistic).toEqual(['a', 'b']);
		expect(q.current).toEqual(['a', 'b']);
		// untargeted queries must not have been refreshed
		expect(q_other.current).toBe(0);
	});

	test('programmatic submit() resolves with the submission outcome', async () => {
		const my_form = form(
			v.object({ title: v.pipe(v.string(), v.minLength(5)) }),
			async () => 'yay'
		);

		expect(() => my_form.submit()).toThrowError(/before the form is attached/);

		const element = attach(my_form, { title: 'long enough' });
		void element;

		await expect(my_form.submit()).resolves.toBe(true);
		expect(my_form.result).toBe('yay');
	});

	test('preflight schema blocks submission client-side', async () => {
		const handler = vi.fn();
		const my_form = form('unchecked', handler);
		my_form.preflight(v.object({ title: v.pipe(v.string(), v.minLength(5, 'nope')) }));

		attach(my_form, { title: 'hi' });

		await expect(my_form.submit()).resolves.toBe(false);
		expect(handler).not.toHaveBeenCalled();
		expect((my_form.fields as any).title.issues()).toEqual([{ message: 'nope', path: ['title'] }]);
	});

	test('validate() runs the schema and respects touched state', async () => {
		const my_form = form(
			v.object({ title: v.pipe(v.string(), v.minLength(5, 'too short')) }),
			async () => 'ok'
		);

		const element = attach(my_form, { title: 'hi' });

		// nothing touched, not submitted -> no issues reported
		await my_form.validate();
		expect((my_form.fields as any).title.issues()).toBeUndefined();

		await my_form.validate({ includeUntouched: true });
		expect((my_form.fields as any).title.issues()).toEqual([
			{ message: 'too short', path: ['title'] }
		]);
		void element;
	});

	test('fields.value()/set() read and write the reactive input', async () => {
		const my_form = form('unchecked', async () => 'ok');
		attach(my_form, { title: 'initial' });

		const fields = my_form.fields as any;

		expect(fields.title.value()).toBeUndefined(); // nothing typed yet

		fields.title.set('typed');
		expect(fields.title.value()).toBe('typed');
		expect(fields.value()).toEqual({ title: 'typed' });
	});

	test('input events sync the DOM into fields.value()', async () => {
		const my_form = form('unchecked', async () => 'ok');
		const element = attach(my_form, { title: '' });

		const input = element.querySelector<HTMLInputElement>('[name="title"]')!;
		input.value = 'typed by user';
		input.dispatchEvent(new Event('input', { bubbles: true }));

		expect((my_form.fields as any).title.value()).toBe('typed by user');
	});

	test('for(key) creates isolated instances and injects the key as data.id', async () => {
		const seen: unknown[] = [];
		const my_form = form('unchecked', async (data: { id?: string; note: string }) => {
			seen.push(data);
			return data.note;
		});

		const first = my_form.for('todo-1');
		const second = my_form.for('todo-2');
		expect(first).not.toBe(second);

		attach(first as LocalForm<any, any>, { note: 'first' });
		await expect(first.submit()).resolves.toBe(true);

		expect(seen).toEqual([{ id: 'todo-1', note: 'first' }]);
		expect(first.result).toBe('first');
		expect(second.result).toBeUndefined();
	});

	test('for(key) reuses instances while referenced from an effect (kit parity)', () => {
		const my_form = form('unchecked', async () => 'ok');

		let a: unknown;
		let b: unknown;

		const destroy = $effect.root(() => {
			$effect.pre(() => {
				a = my_form.for('todo-1');
				b = my_form.for('todo-1');
			});
		});

		// flushing the pre-effect happens synchronously on root creation in this setup;
		// the second call within the same effect must reuse the first instance
		expect(a).toBeDefined();
		expect(a).toBe(b);

		destroy();
	});

	test('redirect() in the handler invokes the configured hook and counts as success', async () => {
		const redirects: string[] = [];
		init({ redirect: (location) => redirects.push(location) });

		const my_form = form(async () => {
			redirect('/after');
		});

		attach(my_form);
		await expect(my_form.submit()).resolves.toBe(true);
		expect(redirects).toEqual(['/after']);
	});

	test('handler errors surface through the onerror hook', async () => {
		const errors: unknown[] = [];
		init({ onerror: (error) => errors.push(error) });

		const my_form = form(async () => {
			throw new Error('boom');
		});

		const element = attach(my_form);
		submit_event(element);

		await until(() => errors.length === 1);
		expect((errors[0] as Error).message).toBe('boom');
	});

	test('attaching one instance to two forms throws', () => {
		const my_form = form(async () => 'ok');
		attach(my_form);

		const second = document.createElement('form');
		const attachment_key = Object.getOwnPropertySymbols(my_form).find(
			(symbol) => typeof (my_form as any)[symbol] === 'function'
		)!;

		expect(() => (my_form as any)[attachment_key](second)).toThrowError(/single `<form>` element/);
	});
});
