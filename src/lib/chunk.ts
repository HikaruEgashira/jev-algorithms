/** Split `items` into consecutive groups of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
	if (!Number.isInteger(size) || size < 1) {
		throw new Error(`chunk size must be a positive integer, got ${size}`);
	}
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}
