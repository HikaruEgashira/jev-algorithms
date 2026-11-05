import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const workflowsDir = new URL("../.github/workflows/", import.meta.url).pathname;

// These actions gained a Node.js 24 runtime in their next major version.
// Using the Node.js 20 majors makes GitHub Actions emit a deprecation warning
// and force the action onto the Node.js 24 runtime.
const node24Actions = new Map([
	["actions/checkout", 5],
	["actions/setup-node", 5],
	["pnpm/action-setup", 5],
]);

function actionReferences() {
	const references = [];
	for (const file of readdirSync(workflowsDir)) {
		if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
		const source = readFileSync(join(workflowsDir, file), "utf8");
		for (const line of source.split("\n")) {
			const match = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/);
			if (match) references.push({ file, uses: match[1] });
		}
	}
	return references;
}

test("workflows use Node.js 24 action releases", () => {
	for (const { file, uses } of actionReferences()) {
		const [action, ref] = uses.split("@");
		const minimum = node24Actions.get(action);
		if (minimum === undefined) continue;
		const major = Number.parseInt(ref.replace(/^v/, ""), 10);
		assert.ok(
			Number.isInteger(major) && major >= minimum,
			`${file} uses ${uses}; expected ${action}@v${minimum} or newer for Node.js 24`,
		);
	}
});

test("publish workflow uses npm trusted publishing on a GitHub-hosted runner", () => {
	const source = readFileSync(join(workflowsDir, "publish.yml"), "utf8");
	const runners = [...source.matchAll(/^\s*runs-on:\s*(\S+)/gm)].map((m) => m[1]);
	assert.ok(runners.length > 0, "publish.yml declares no runner");
	for (const runner of runners) {
		assert.match(
			runner,
			/^ubuntu-(?:latest|\d{2}\.\d{2})$/,
			`publish.yml runs on ${runner}; npm trusted publishing requires a GitHub-hosted runner`,
		);
	}
	assert.match(source, /id-token:\s*write/);
	assert.match(source, /GITHUB_REF_NAME, "v" \+ pkg\.version/);
	assert.doesNotMatch(source, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
});
