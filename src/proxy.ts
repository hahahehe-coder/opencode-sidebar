import * as http from "http";
import * as net from "net";

export interface ProxyServer {
	readonly port: number;
	readonly server: http.Server;
	stop(): Promise<void>;
}

export interface ProxyTarget {
	readonly hostname: string;
	readonly port: number;
}

/**
 * Script injected into every HTML response served by the local proxy.
 *
 * Responsibilities:
 * 1. Seed the WebUI's localStorage project store with the workspace directory.
 *    The WebUI keeps its project list client-side (origin-scoped localStorage,
 *    key "opencode.global.dat:server.v3", shape {list,projects,lastProject,
 *    recentlyClosed}); it is NOT read back from the server. Writing the
 *    workspace as projects.local[] + lastProject.local makes startup
 *    auto-open the project with its full session list — no matter which
 *    (random) port the server/proxy got this time.
 * 2. Set the OpenCode color scheme (localStorage) before the app boots, based
 *    on the mode passed via ?__ocsMode= in the URL.
 * 3. Listen for postMessage({type:"opencodeSidebar:theme", mode}) from the
 *    webview host and re-apply the scheme live by writing localStorage and
 *    mutating dataset.colorScheme — both are signals the app already reacts to.
 */
function buildInjectScript(directory: string): string {
	// The WebUI strips backslashes out of the worktree when it builds
	// /session?directory=... queries, which empties the session list on
	// Windows. Seeding forward slashes keeps the query resolvable.
	const normalized = directory.replaceAll("\\", "/");
	const dirJson = JSON.stringify(normalized);
	return `
<script>
(function () {
  var MODE_KEY = "opencode-color-scheme";
  var SERVER_KEYS = ["opencode.global.dat:server.v3", "opencode.global.dat:server"];
  function normalize(mode) {
    return mode === "dark" || mode === "light" ? mode : "system";
  }
  function seedProject(dir) {
    if (!dir) return;
    for (var i = 0; i < SERVER_KEYS.length; i++) {
      try {
        var key = SERVER_KEYS[i];
        var cur = JSON.parse(localStorage.getItem(key) || "null");
        if (!cur || typeof cur !== "object") cur = {};
        if (!Array.isArray(cur.list)) cur.list = [];
        if (!cur.projects || typeof cur.projects !== "object") cur.projects = {};
        if (!cur.lastProject || typeof cur.lastProject !== "object") cur.lastProject = {};
        if (!cur.recentlyClosed || typeof cur.recentlyClosed !== "object") cur.recentlyClosed = {};
        var arr = Array.isArray(cur.projects.local) ? cur.projects.local : [];
        var found = false;
        for (var j = 0; j < arr.length; j++) {
          if (arr[j] && arr[j].worktree === dir) { found = true; break; }
        }
        if (!found) arr.push({ id: "global", worktree: dir, vcs: "git" });
        cur.projects.local = arr;
        // Always reopen the workspace project on full page (re)loads.
        cur.lastProject.local = dir;
        localStorage.setItem(key, JSON.stringify(cur));
      } catch (e) {}
    }
  }
  function boot() {
    var params = new URLSearchParams(window.location.search);
    var mode = normalize(params.get("__ocsMode"));
    if (mode !== "system") {
      try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
    }
    seedProject(${dirJson});
  }
  function applyLive(mode) {
    mode = normalize(mode);
    if (mode === "system") return;
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
    // The bundled preload script style tag (id oc-theme-preload) is only for
    // custom themes; toggling the dataset is what the running app observes.
    document.documentElement.dataset.colorScheme = mode;
  }
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "opencodeSidebar:theme" && typeof data.mode === "string") {
      applyLive(data.mode);
    }
  });
  boot();
})();
</script>
`;
}

function injectIntoHtml(html: string, directory: string): string {
	const script = buildInjectScript(directory);
	if (html.includes("<head>")) {
		return html.replace("<head>", "<head>" + script);
	}
	return script + html;
}

function rewriteIndexUrl(rawUrl: string | undefined, target: ProxyTarget): { pathname: string; search: URLSearchParams } {
	const url = new URL(rawUrl ?? "/", `http://${target.hostname}:${target.port}`);
	// Strip our marker params before forwarding upstream.
	url.searchParams.delete("__ocsMode");
	return { pathname: url.pathname, search: url.searchParams };
}

function proxyRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	target: ProxyTarget,
	directory: string,
	log: (line: string) => void,
): void {
	const upstream = {
		hostname: target.hostname,
		port: target.port,
		path: req.url ?? "/",
		method: req.method ?? "GET",
		headers: { ...req.headers },
	};
	// Host header must describe the upstream, not our proxy listener.
	delete upstream.headers.host;

	const proxied = http.request(upstream, (upstreamRes) => {
		const headers = { ...upstreamRes.headers };
		delete headers["content-security-policy"];
		delete headers["x-frame-options"];

		const contentType = String(headers["content-type"] ?? "");
		if (contentType.includes("text/html")) {
			// Buffer HTML so we can inject the shim; these responses are small.
			const chunks: Buffer[] = [];
			upstreamRes.on("data", (c: Buffer) => chunks.push(c));
			upstreamRes.on("end", () => {
				const body = injectIntoHtml(Buffer.concat(chunks).toString("utf8"), directory);
				res.writeHead(upstreamRes.statusCode ?? 502, {
					...headers,
					"content-length": Buffer.byteLength(body),
					"cache-control": "no-store",
				});
				res.end(body);
			});
			upstreamRes.on("error", () => res.destroy());
			return;
		}

		res.writeHead(upstreamRes.statusCode ?? 502, headers);
		// Stream everything else verbatim. SSE responses (text/event-stream)
		// stay open indefinitely, which pipe() handles naturally.
		upstreamRes.pipe(res);
	});

	proxied.on("error", (err) => {
		log(`[proxy] upstream error on ${req.method} ${req.url}: ${err.message}`);
		if (!res.headersSent) {
			res.writeHead(502, { "content-type": "text/plain" });
		}
		res.end(`opencode sidebar: upstream opencode server unreachable (${err.message})`);
	});

	req.pipe(proxied);
}

function handleUpgrade(
	req: http.IncomingMessage,
	socket: net.Socket,
	head: Buffer,
	target: ProxyTarget,
	sockets: Set<net.Socket>,
): void {
	const upstream = net.connect(target.port, target.hostname, () => {
		const lines: string[] = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
		for (let i = 0; i < req.rawHeaders.length; i += 2) {
			const key = req.rawHeaders[i];
			if (key.toLowerCase() === "host") {
				lines.push(`${key}: ${target.hostname}:${target.port}`);
				continue;
			}
			if (key.toLowerCase() === "origin") {
				continue; // let upstream treat it as same-origin
			}
			lines.push(`${key}: ${req.rawHeaders[i + 1]}`);
		}
		upstream.write(lines.join("\r\n") + "\r\n\r\n");
		if (head.length > 0) {
			upstream.write(head);
		}
		socket.write(upstream.read() ?? Buffer.alloc(0));
	});
	sockets.add(upstream);
	const cleanup = () => {
		sockets.delete(upstream);
		sockets.delete(socket);
		socket.destroy();
		upstream.destroy();
	};
	socket.on("error", cleanup);
	upstream.on("error", cleanup);
	socket.on("close", cleanup);
	upstream.on("close", cleanup);
	upstream.on("data", (chunk: Buffer) => socket.write(chunk));
	socket.on("data", (chunk: Buffer) => upstream.write(chunk));
}

/**
 * Starts a thin reverse proxy bound to 127.0.0.1 that forwards to the
 * opencode server while injecting the theme/bootstrap shim into HTML.
 */
export function startProxy(
	target: ProxyTarget,
	opts: { port?: number; directory?: string; log: (line: string) => void },
): Promise<ProxyServer> {
	return new Promise((resolve, reject) => {
		const sockets = new Set<net.Socket>();
		const directory = opts.directory ?? "";
		const server = http.createServer((req, res) => proxyRequest(req, res, target, directory, opts.log));

		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
		});

		server.on("upgrade", (req, socket, head) => {
			handleUpgrade(req, socket as net.Socket, head, target, sockets);
		});

		server.on("clientError", (_err: Error, socket: net.Socket) => {
			socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
		});
		server.once("error", reject);

		const listenPort = opts.port && opts.port > 0 ? opts.port : 0;
		server.listen(listenPort, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Proxy failed to bind to 127.0.0.1"));
				return;
			}
			resolve({
				port: address.port,
				server,
				stop: () =>
					new Promise<void>((res) => {
						server.close(() => res());
						for (const s of sockets) s.destroy();
						sockets.clear();
						server.closeAllConnections();
						// Hard fallback: upgraded/lingering sockets may not be tracked by
						// closeAllConnections, so never let shutdown deadlock.
						setTimeout(() => res(), 1000).unref();
					}),
			});
		});
	});
}

/** Exposed for tests. */
export const __internals = { injectIntoHtml, rewriteIndexUrl };
