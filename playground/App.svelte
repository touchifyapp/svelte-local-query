<script lang="ts">
	import { addLike, addTodo, clock, getTodos } from './data.js';

	const todos = getTodos();
	// identical argument -> same underlying instance as `todos`
	const todos_again = getTodos();
	const ticks = clock();

	async function like(id: string) {
		await addLike(id).updates(
			todos.withOverride((current) =>
				current.map((todo) => (todo.id === id ? { ...todo, likes: todo.likes + 1 } : todo))
			)
		);
	}
</script>

<section data-testid="query">
	<h2>query</h2>
	{#if todos.error}
		<p class="error">failed</p>
	{:else if !todos.ready}
		<p data-testid="loading">loading…</p>
	{:else}
		<ul data-testid="todos">
			{#each todos.current as todo (todo.id)}
				<li>
					{todo.text}
					<button data-testid="like-{todo.id}" onclick={() => like(todo.id)}>
						❤️ {todo.likes}
					</button>
				</li>
			{/each}
		</ul>
		<p data-testid="dedup">shared: {todos.current === todos_again.current}</p>
		<p data-testid="like-pending">like pending: {addLike.pending}</p>
		<button data-testid="refresh" onclick={() => todos.refresh()}>refresh</button>
	{/if}
</section>

<section data-testid="form">
	<h2>form</h2>
	<form {...addTodo}>
		<input data-testid="new-todo" {...addTodo.fields.text.as('text')} />
		<button data-testid="submit" disabled={!!addTodo.pending}>add</button>
		{#each addTodo.fields.text.issues() ?? [] as issue}
			<p class="error" data-testid="issue">{issue.message}</p>
		{/each}
		{#if addTodo.result}
			<p data-testid="result">added: {addTodo.result.added}</p>
		{/if}
	</form>
</section>

<section data-testid="live">
	<h2>query.live</h2>
	<p data-testid="ticks">ticks: {ticks.current ?? '…'}</p>
	<p data-testid="connected">connected: {ticks.connected}</p>
</section>
