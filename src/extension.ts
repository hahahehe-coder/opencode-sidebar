import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import * as vscode from "vscode";
import { getWorkspaceCwd, startOpencodeServer, resolveProjectWorktree, killTreeByPid, type OpencodeServer } from "./server";
import { startProxy, type ProxyServer } from "./proxy";
import { OpencodePanelProvider, PRIMARY_VIEW_TYPE, SECONDARY_VIEW_TYPE } from "./provider";

interface Runtime {
	server?: OpencodeServer;
	proxy?: ProxyServer;
	/** Key of the workspace folder the current server was started for. */
	workspaceKey?: string;
	starting?: Promise<void>;
}

/** Module-scope so deactivate() (which VS Code awaits) can tear the runtime down. */
const runtime: Runtime = {};

/**
 * PIDs of opencode servers we spawned, persisted across extension-host
 * restarts so a crashed host (which never got to run teardown) can be reaped
 * by the next activation. Read once per activation; written on start/stop.
 */
let trackedPidsPath: string | undefined;

function pidsFile(context: vscode.ExtensionContext): string {
	return path.join(context.globalStorageUri.fsPath, "server-pids.json");
}

function readTrackedPids(): number[] {
	if (!trackedPidsPath) {
		return [];
	}
	try {
		const raw = fs.readFileSync(trackedPidsPath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
	} catch {
		return [];
	}
}

function writeTrackedPids(pids: number[]): void {
	if (!trackedPidsPath) {
		return;
	}
	try {
		fs.mkdirSync(path.dirname(trackedPidsPath), { recursive: true });
		fs.writeFileSync(trackedPidsPath, JSON.stringify(pids));
	} catch {
		// Best-effort bookkeeping; never break the extension over it.
	}
}

function trackPid(pid: number): void {
	const pids = readTrackedPids();
	if (!pids.includes(pid)) {
		pids.push(pid);
		writeTrackedPids(pids);
	}
}

function untrackPid(pid: number): void {
	writeTrackedPids(readTrackedPids().filter((p) => p !== pid));
}

/**
 * Returns true when the given PID is currently running an `opencode serve`
 * process. Guards against PID reuse: a stale entry in the pids file may now
 * point at an unrelated process, which we must never kill.
 */
function isOpencodeServeProcess(pid: number): boolean {
	try {
		if (process.platform === "win32") {
			// wmic: `wmic process where (ProcessId=N) get CommandLine /value`
			const out = execFileSync("wmic", ["process", "where", `(ProcessId=${pid})`, "get", "CommandLine", "/value"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 3000,
				windowsHide: true,
			});
			return /CommandLine=.*opencode[^\r\n]*serve/i.test(out);
		}
		// POSIX: inspect the process's own cmdline via /proc.
		const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ");
		return /opencode[^\n]*serve/.test(cmd);
	} catch {
		// Process gone or not inspectable — nothing to reap.
		return false;
	}
}

/**
 * Kills every opencode process we recorded from a previous extension-host
 * session. Runs once at activation; the host that wrote those PIDs is gone,
 * so any survivor is an orphaned server.
 */
function reapOrphanedServers(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): void {
	trackedPidsPath = pidsFile(context);
	const pids = readTrackedPids();
	if (pids.length === 0) {
		return;
	}
	for (const pid of pids) {
		if (isOpencodeServeProcess(pid)) {
			log.info(`reaping orphaned opencode server (pid ${pid})`);
			killTreeByPid(pid);
		}
	}
	writeTrackedPids([]);
}

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel("OpenCode Sidebar", { log: true });
	context.subscriptions.push(log);

	// Claude Code pattern: contribute the view container to BOTH the activity bar
	// and the secondary sidebar, gated by a context key that is set during
	// activation based on whether this VS Code build supports contributing
	// view containers to the secondary sidebar (VS Code >= 1.106).
	const [major, minor] = vscode.version.split(".").map(Number);
	const supportsSecondarySidebar = major > 1 || (major === 1 && minor >= 106);
	void vscode.commands.executeCommand("setContext", "opencodeSidebar:secondarySidebarUnsupported", !supportsSecondarySidebar);

	const provider = new OpencodePanelProvider(log);
	const secondaryProvider = new OpencodePanelProvider(log);

	// Reap opencode servers orphaned by a previous (crashed) extension host.
	reapOrphanedServers(context, log);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(PRIMARY_VIEW_TYPE, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(SECONDARY_VIEW_TYPE, secondaryProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);
	const providers = [provider, secondaryProvider];

	const ensureRunning = (): Promise<void> => {
		if (runtime.server && runtime.proxy) {
			return Promise.resolve();
		}
		if (runtime.starting) {
			return runtime.starting;
		}
		runtime.starting = boot(runtime, context, providers, log).finally(() => {
			runtime.starting = undefined;
		});
		return runtime.starting;
	};

	const onViewDisposable = vscode.window.onDidChangeActiveColorTheme((theme) => {
		for (const p of providers) p.postTheme(theme.kind);
	});
	context.subscriptions.push(onViewDisposable);

	context.subscriptions.push(
		vscode.commands.registerCommand("opencodeSidebar.restart", async () => {
			await teardown(runtime);
			await ensureRunning();
			void vscode.window.showInformationMessage("OpenCode Sidebar: server restarted.");
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("opencodeSidebar.openInBrowser", async () => {
			if (runtime.proxy) {
				await vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${runtime.proxy.port}/`));
			} else {
				void vscode.window.showWarningMessage("OpenCode Sidebar is not running yet.");
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("opencodeSidebar.showLog", () => {
			log.show();
		}),
	);

	// Restart against the new folder when the workspace changes.
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			const key = workspaceKey();
			if (key === runtime.workspaceKey) {
				return;
			}
			log.info(`workspace changed (${runtime.workspaceKey ?? "none"} -> ${key ?? "none"}); restarting server`);
			void (async () => {
				await teardown(runtime);
				await ensureRunning().catch((err) => showBootError(err, log));
			})();
		}),
	);

	// Kick off on activation; the view shows a starting page until ready.
	void ensureRunning().catch((err) => showBootError(err, log));

	context.subscriptions.push({
		dispose: () => {
			// Fire-and-forget cleanup during shutdown.
			void teardown(runtime);
		},
	});
}

function workspaceKey(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.toString();
}

async function boot(
	runtime: Runtime,
	context: vscode.ExtensionContext,
	providers: OpencodePanelProvider[],
	log: vscode.LogOutputChannel,
): Promise<void> {
	const cwd = getWorkspaceCwd(vscode.workspace.workspaceFolders);
	if (!cwd) {
		for (const p of providers) p.clearProxy();
		void vscode.window.showInformationMessage(
			"OpenCode Sidebar: open a workspace folder to start an opencode session.",
		);
		return;
	}

	const config = vscode.workspace.getConfiguration("opencodeSidebar");
	const serverPath = config.get<string>("serverPath") ?? "";
	const proxyPort = config.get<number>("proxyPort") ?? 0;

	log.info(`starting opencode serve for ${cwd}`);
	const server = await startOpencodeServer({
		serverPath,
		cwd,
		log: (l) => log.info(l),
		onSpawned: (pid) => trackPid(pid),
	});
	log.info(`opencode server at ${server.url}`);

	// The proxy injects a shim that seeds the WebUI's localStorage project
	// store with the canonical worktree, so the WebUI auto-opens this
	// workspace as a project (with its full session list) on every load.
	// The canonical string comes from the server itself: the WebUI matches
	// sessions to projects case-sensitively, and vscode may hand us a
	// lower-cased drive letter ("c:/...") while the server uses "C:/...".
	const worktree = await resolveProjectWorktree(server.url, cwd);
	log.info(`canonical worktree: ${worktree}`);
	const proxy = await startProxy(
		{ hostname: "127.0.0.1", port: server.port },
		{ port: proxyPort > 0 ? proxyPort : 0, directory: worktree, log: (l) => log.info(l) },
	);
	log.info(`local proxy at http://127.0.0.1:${proxy.port}/`);

	runtime.server = server;
	runtime.proxy = proxy;
	runtime.workspaceKey = workspaceKey();

	for (const p of providers) p.setProxyPort(proxy.port);
	for (const p of providers) p.postTheme(vscode.window.activeColorTheme.kind);

	// Register for tree-kill on extension teardown even if activate exits early.
	context.subscriptions.push({
		dispose: () => void teardown(runtime),
	});
}

async function teardown(runtime: Runtime): Promise<void> {
	const { proxy, server } = runtime;
	runtime.proxy = undefined;
	runtime.server = undefined;
	runtime.workspaceKey = undefined;
	if (proxy) {
		await proxy.stop().catch(() => undefined);
	}
	if (server) {
		await server.stop().catch(() => undefined);
		untrackPid(server.pid);
	}
}

function showBootError(err: unknown, log: vscode.LogOutputChannel): void {
	const message = err instanceof Error ? err.message : String(err);
	log.error(message);
	void vscode.window.showErrorMessage(`OpenCode Sidebar failed to start: ${message}`, "Show Log").then((pick) => {
		if (pick === "Show Log") {
			log.show();
		}
	});
}

export async function deactivate(): Promise<void> {
	// VS Code awaits the promise returned from deactivate() (with a short grace
	// period) before killing the extension host. Without this, the fire-and-forget
	// dispose below never gets to run taskkill and every `opencode serve` spawned
	// during the session is orphaned (Windows keeps child processes alive after
	// their parent dies). Awaiting here guarantees the process tree is reaped.
	await teardown(runtime);
}
