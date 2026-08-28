import * as vscode from "vscode";

export const PRIMARY_VIEW_TYPE = "opencodeSidebar.panel";
export const SECONDARY_VIEW_TYPE = "opencodeSidebar.panelSecondary";

interface ThemeMessage {
	type: "opencodeSidebar:theme";
	mode: "light" | "dark" | "system";
}

export class OpencodePanelProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private proxyPort?: number;
	/** Last theme mode pushed from the extension host; re-applied when the relay page (re)loads. */
	private lastMode?: ThemeMessage["mode"];

	constructor(
		private readonly log: vscode.LogOutputChannel,
	) {}

	/** Called by the extension whenever the proxy is (re)started. */
	setProxyPort(port: number): void {
		this.proxyPort = port;
		if (this.view) {
			this.loadTarget();
		}
	}

	clearProxy(): void {
		this.proxyPort = undefined;
		if (this.view && this.view.visible) {
			this.showUnavailable("<p>opencode server stopped.</p>");
		}
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		webviewView.webview.options = { enableScripts: true };
		this.view = webviewView;

		webviewView.webview.onDidReceiveMessage((msg: unknown) => {
			if (
				msg &&
				typeof msg === "object" &&
				"type" in msg &&
				(msg as { type: string }).type === "ready"
			) {
				this.log.info("webview relay ready");
				// The relay page just (re)loaded and any earlier theme postMessage
				// was dropped, so push the current mode now. The shim also applies
				// it inside the iframe once that finishes loading.
				if (this.lastMode) {
					void webviewView.webview.postMessage({ type: "theme", mode: this.lastMode } satisfies RelayCommand);
				}
			}
		});

		if (this.proxyPort !== undefined) {
			this.loadTarget();
		} else {
			this.showStarting();
		}
	}

	/** Push a theme change down to the iframe through the relay page. */
	postTheme(kind: vscode.ColorThemeKind): void {
		const mode = themeKindToMode(kind);
		this.lastMode = mode;
		void this.view?.webview.postMessage({ type: "theme", mode } satisfies RelayCommand);
	}

	private loadTarget(): void {
		const view = this.view;
		const port = this.proxyPort;
		if (!view || port === undefined) {
			return;
		}
		view.webview.html = buildRelayHtml(view.webview, port, this.log);
	}

	private showStarting(): void {
		if (!this.view) {
			return;
		}
		this.view.webview.html = buildStartingHtml(this.view.webview);
	}

	private showUnavailable(bodyHtml: string): void {
		if (!this.view) {
			return;
		}
		this.view.webview.html = buildFallbackHtml(this.view.webview, bodyHtml);
	}
}

function themeKindToMode(kind: vscode.ColorThemeKind): ThemeMessage["mode"] {
	switch (kind) {
		case vscode.ColorThemeKind.Light:
		case vscode.ColorThemeKind.HighContrastLight:
			return "light";
		case vscode.ColorThemeKind.Dark:
		case vscode.ColorThemeKind.HighContrast:
			return "dark";
	}
}

interface RelayCommand {
	type: "theme";
	mode: ThemeMessage["mode"];
}

const RELAY_JS = `
const vscode = acquireVsCodeApi();
const frame = document.getElementById("frame");

window.addEventListener("message", (event) => {
  // Messages from the extension host arrive with origin vscode-webview://.
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "theme") {
    if (frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "opencodeSidebar:theme", mode: data.mode }, "*");
      if (data.mode !== "system") setUrlParam("__ocsMode", data.mode);
    }
  }
});

function setUrlParam(key, value) {
  try {
    const url = new URL(frame.src);
    url.searchParams.set(key, value);
    if (frame.src !== url.toString()) frame.src = url.toString();
  } catch (e) {}
}

function ready() {
  vscode.postMessage({ type: "ready" });
}

frame.addEventListener("load", () => {
  ready();
});
`;

function nonce(): string {
	let out = "";
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	for (let i = 0; i < 24; i++) {
		out += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return out;
}

function baseStyles(): string {
	return `
    <style>
      html,body { height:100%; margin:0; padding:0; overflow:hidden; background:var(--vscode-editor-background); }
      .frame-wrap { position:absolute; inset:0; }
      iframe { position:absolute; inset:0; width:100%; height:100%; border:0; display:block; }
      .wrap { position:absolute; inset:0; color:var(--vscode-foreground); font-family:var(--vscode-font-family); padding:16px; }
      .dim { opacity:.7 }
      code { font-family: var(--vscode-editor-font-family, monospace) }
      .center { display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; gap:12px; }
      .logo { width:52px; height:52px; object-fit:contain; }
      .spinner { width:18px; height:18px; border-radius:50%; border:2px solid var(--vscode-widget-border, rgba(128,128,128,.4)); border-top-color: var(--vscode-foreground); animation: spin 1s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg) } }
      .status { font-size: 1.1em; }
    </style>
  `;
}

function buildStartingHtml(webview: vscode.Webview): string {
	const icon = "<img class=\"logo\" alt=\"OpenCode\" src=\"data:image/png;base64,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\" />";
	return buildFallbackHtml(webview, `
		${icon}
		<div class="status">Starting the opencode server&hellip;</div>
		<div class="spinner" aria-label="starting"></div>
		<p class="dim">If this persists, make sure the <code>opencode</code> CLI is installed and on PATH.</p>
	`, { centered: true });
}

function buildFallbackHtml(
	webview: vscode.Webview,
	bodyHtml: string,
	opts?: { centered?: boolean },
): string {
	const wrapClass = opts?.centered ? 'wrap center' : "wrap";
	const heading = opts?.centered ? "" : "<h2>OpenCode Sidebar</h2>";
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src data:;">
  ${baseStyles()}
</head>
<body>
  <div class="${wrapClass}">
    ${heading}
    ${bodyHtml}
  </div>
</body>
</html>`;
}

function buildRelayHtml(
	webview: vscode.Webview,
	port: number,
	log: vscode.LogOutputChannel,
): string {
	const n = nonce();
	// Point the WebUI at the server root. The proxy injects a shim that seeds
	// the WebUI's client-side project store (localStorage) with the workspace
	// directory, so startup auto-opens the workspace project and shows all of
	// its sessions — the same view a user gets after adding the project
	// manually in a browser.
	const targetUrl = `http://127.0.0.1:${port}/`;
	log.info(`pointing webview at proxy ${targetUrl}`);
	return `<!DOCTYPE html>
	<html lang="en">
	<head>
	  <meta charset="UTF-8">
	  <meta http-equiv="Content-Security-Policy"
	        content="default-src 'none'; frame-src http://127.0.0.1:*; script-src 'nonce-${n}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:;">
	${baseStyles()}
</head>
<body>
  <div class="frame-wrap">
    <iframe id="frame"
            sandbox="allow-scripts allow-forms allow-same-origin allow-downloads allow-popups"
            src="${targetUrl}"></iframe>
  </div>
  <script nonce="${n}">${RELAY_JS}</script>
</body>
</html>`;
}
