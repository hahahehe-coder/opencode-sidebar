/**
 * Integration test: boots a real `opencode serve` + the local proxy and
 * asserts injection, header passthrough, and WebSocket upgrade behavior.
 *
 * Run with: npm run build && npm test
 */
import { startOpencodeServer } from "../server";
import { startProxy } from "../proxy";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

let failures = 0;
function assert(condition: boolean, label: string): void {
	if (condition) {
		console.log(`  ok - ${label}`);
	} else {
		failures++;
		console.error(`  FAIL - ${label}`);
	}
}

async function main(): Promise<void> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-sidebar-test-"));
	const log = (line: string) => console.log(`    ${line}`);

	console.log("starting opencode serve...");
	const server = await startOpencodeServer({ cwd, log });
	assert(server.port > 0, `server bound to port ${server.port}`);

	try {
		const proxy = await startProxy({ hostname: "127.0.0.1", port: server.port }, { directory: cwd, log });

		// 1. HTML injection
		const htmlRes = await fetch(`http://127.0.0.1:${proxy.port}/`);
		const html = await htmlRes.text();
		assert(htmlRes.status === 200, "GET / through proxy returns 200");
		assert(html.includes("opencodeSidebar:theme"), "HTML contains injected theme shim");
		assert(html.includes("opencode.global.dat:server.v3"), "HTML contains injected project-seed shim");
		assert(html.includes(JSON.stringify(cwd.replaceAll("\\", "/"))), "injected shim carries the workspace directory (forward-slashed)");

		// 2. Marker params are stripped before hitting upstream (page still renders)
		const markerRes = await fetch(`http://127.0.0.1:${proxy.port}/?__ocsMode=dark`);
		assert(markerRes.status === 200, "marker params do not break routing");
		const markerHtml = await markerRes.text();
		assert(markerHtml.includes("opencodeSidebar:theme"), "injection also happens on first paint URL");

		// 3. API passthrough
		const healthRes = await fetch(`http://127.0.0.1:${proxy.port}/api/health`);
		const healthBody = await healthRes.text();
		assert(healthRes.status === 200 && healthBody.includes("healthy"), "API passthrough works (/api/health)");

		// 4. No CSP header leaks that could constrain our injected script context
		assert(!healthRes.headers.get("content-security-policy"), "CSP header stripped by proxy");

		// 5. Proxy transparently relays WebSocket upgrades (validated against a
		// local stub server that accepts the handshake — opencode itself has no
		// public generic WS endpoint to test against).
		const wsOk = await testProxyWebSocketUpgrade();
		assert(wsOk, "WebSocket upgrade round-trips through proxy");

		await proxy.stop();
	} finally {
		await server.stop().catch(() => undefined);
		// Windows may still hold the temp dir handle briefly after the child
		// process tree exits; retry so cleanup doesn't fail the run.
		try {
			fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		} catch {
			console.warn(`  warn - could not remove temp dir ${cwd}`);
		}
	}

	if (failures > 0) {
		console.error(`\n${failures} assertion(s) failed`);
		process.exitCode = 1;
	} else {
		console.log("\nall assertions passed");
	}
}

/**
 * Proves the proxy relays WebSocket upgrades and duplex traffic, using a real
 * RFC6455 server and client (the `ws` package) with the proxy in between.
 */
async function testProxyWebSocketUpgrade(): Promise<boolean> {
	const { WebSocketServer } = require("ws") as typeof import("ws");
	const stub = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	// Echo everything back so the client can prove duplex traffic.
	stub.on("connection", (ws) => {
		ws.on("message", (data) => ws.send(data));
	});
	await new Promise<void>((res, rej) => stub.once("listening", res).once("error", rej));
	const stubPort = (stub.address() as { port: number }).port;

	const proxy = await startProxy({ hostname: "127.0.0.1", port: stubPort }, { log: () => undefined });

	try {
		return await new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (ok: boolean) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(ok);
				}
			};
			const timer = setTimeout(() => finish(false), 8000);

			const { WebSocket: WsClient } = require("ws") as typeof import("ws");
			const client = new WsClient(`ws://127.0.0.1:${proxy.port}/ws`);

			client.on("open", () => client.send("ping"));
			client.on("message", (data) => {
				// Stub echoes back whatever it receives.
				finish(data.toString() === "ping");
				client.close();
			});
			client.on("error", () => finish(false));
		});
	} finally {
		await proxy.stop().catch(() => undefined);
		stub.close();
		await new Promise<void>((res) => setTimeout(res, 50));
	}
}

/**
 * Watchdog: the test drives real child processes and sockets; any leaked
 * handle would keep the event loop alive forever, so hard-exit instead.
 */
setTimeout(() => {
	console.error("WATCHDOG: test did not finish within 120s; forcing exit");
	process.exit(1);
}, 120_000).unref();

main().catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => {
		// Give pending stdout a tick to flush, then leave no doubt.
		setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref();
	});
