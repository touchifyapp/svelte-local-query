import { command, form, invalid, query } from '../src/lib/index.js';

// a tiny in-memory "database"
interface Todo {
	id: string;
	text: string;
	likes: number;
}

let todos: Todo[] = [
	{ id: '1', text: 'port remote functions', likes: 0 },
	{ id: '2', text: 'write playground', likes: 0 }
];

const delay = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

export let query_runs = 0;

export const getTodos = query(async () => {
	query_runs++;
	await delay();
	return todos;
});

export const getLikes = query(async (id: string) => {
	await delay();
	return todos.find((todo) => todo.id === id)?.likes ?? 0;
});

export const addLike = command(async (id: string) => {
	// slow on purpose: gives the e2e suite a wide window to observe the optimistic
	// override while the command is still pending
	await delay(400);
	todos = todos.map((todo) => (todo.id === id ? { ...todo, likes: todo.likes + 1 } : todo));
});

export const addTodo = form('unchecked', async (data: { text: string }, issue) => {
	await delay();
	if (!data.text || data.text.length < 3) {
		invalid(issue.text('Todo must be at least 3 characters'));
	}
	todos = [...todos, { id: String(todos.length + 1), text: data.text, likes: 0 }];
	return { added: data.text };
});

export const clock = query.live(async function* () {
	let i = 0;
	while (true) {
		yield i++;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
});
