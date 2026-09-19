/** Disjoint-set forest with path compression and union by size. */
export class UnionFind<T> {
	#parent = new Map<T, T>();
	#size = new Map<T, number>();

	constructor(items: Iterable<T> = []) {
		for (const item of items) this.add(item);
	}

	add(item: T): void {
		if (!this.#parent.has(item)) {
			this.#parent.set(item, item);
			this.#size.set(item, 1);
		}
	}

	find(item: T): T {
		this.add(item);
		let root = item;
		while (this.#parent.get(root) !== root) {
			root = this.#parent.get(root) as T;
		}
		// Path compression.
		let cursor = item;
		while (cursor !== root) {
			const next = this.#parent.get(cursor) as T;
			this.#parent.set(cursor, root);
			cursor = next;
		}
		return root;
	}

	union(a: T, b: T): void {
		const rootA = this.find(a);
		const rootB = this.find(b);
		if (rootA === rootB) return;
		const sizeA = this.#size.get(rootA) as number;
		const sizeB = this.#size.get(rootB) as number;
		const [small, large] = sizeA < sizeB ? [rootA, rootB] : [rootB, rootA];
		this.#parent.set(small, large);
		this.#size.set(large, sizeA + sizeB);
	}

	connected(a: T, b: T): boolean {
		return this.find(a) === this.find(b);
	}

	/** Group all items into clusters keyed by their representative. */
	groups(): T[][] {
		const out = new Map<T, T[]>();
		for (const item of this.#parent.keys()) {
			const root = this.find(item);
			const group = out.get(root);
			if (group) group.push(item);
			else out.set(root, [item]);
		}
		return [...out.values()];
	}
}
