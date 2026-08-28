import * as vscode from "vscode";
import { getWorkspaceCwd, startOpencodeServer, resolveProjectWorktree, type OpencodeServer } from "./server";
import { startProxy, type ProxyServer } from "./proxy";
import { OpencodePanelProvider, PRIMARY_VIEW_TYPE, SECONDARY_VIEW_TYPE } from "./provider";

interface Runtime {
	server?: OpencodeServer;
	proxy?: ProxyServer;
	/** Key of the workspace folder the current server was started for. */
	workspaceKey?: string;
	starting?: Promise<void>;
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
	const runtime: Runtime = {};

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
	const server = await startOpencodeServer({ serverPath, cwd, log: (l) => log.info(l) });
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

export function deactivate(): void {
	// Cleanup is handled by the disposable registered in activate().
}
