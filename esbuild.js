const esbuild = require("esbuild");

/** @type {import('esbuild').BuildOptions} */
const base = {
	bundle: true,
	sourcemap: true,
	logLevel: "info",
	target: "node20",
	platform: "node",
	external: ["vscode"],
};

async function main() {
	const watch = process.argv.includes("--watch");

	// Extension host entry
	const ctxExt = await esbuild.context({
		...base,
		entryPoints: ["src/extension.ts"],
		outfile: "dist/extension.js",
		format: "cjs",
	});

	// Integration test entry (not bundled with the extension)
	await esbuild.build({
		...base,
		entryPoints: ["src/test/integration-test.ts"],
		outdir: "dist/test",
		external: ["vscode", "ws", "@types/ws"],
		format: "cjs",
	});

	if (watch) {
		await ctxExt.watch();
	} else {
		await ctxExt.rebuild();
		await ctxExt.dispose();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
