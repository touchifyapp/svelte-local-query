import { QUERY_FUNCTION_ID } from '../internal/shared.svelte.js';
import { next_id } from '../internal/stringify.js';
import type { LocalLiveQuery, LocalLiveQueryFunction } from '../types.js';
import { parse_declaration, validate_arg, type Validator } from '../validation.js';
import { LiveQueryProxy } from './proxy.js';

export function create_query_live(
	validate_or_fn: Validator | ((arg?: any) => AsyncIterable<unknown>),
	maybe_fn?: (arg?: any) => AsyncIterable<unknown>
): LocalLiveQueryFunction<any, any> {
	const { validate, fn } = parse_declaration(validate_or_fn, maybe_fn);
	const id = next_id('query.live');

	const wrapper = (arg: unknown) => {
		return new LiveQueryProxy(id, arg, async () =>
			fn(await validate_arg(validate, arg))
		) as unknown as LocalLiveQuery<any>;
	};

	Object.defineProperty(wrapper, QUERY_FUNCTION_ID, { value: id });

	return wrapper;
}
