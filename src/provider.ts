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
			this.view.title = "OpenCode";
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
		this.showUnavailable(
			`<p>Starting the opencode server for this workspace&hellip;</p><p class="dim">If this persists, make sure the <code>opencode</code> CLI is installed and on PATH.</p>`,
		);
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
      iframe { position:absolute; inset:0; width:100%; height:100%; border:0; display:block; }
      .wrap { position:absolute; inset:0; color:var(--vscode-foreground); font-family:var(--vscode-font-family); padding:16px; }
      .dim { opacity:.7 }
      code { font-family: var(--vscode-editor-font-family, monospace) }
    </style>
  `;
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
	  <iframe id="frame"
	          sandbox="allow-scripts allow-forms allow-same-origin allow-downloads allow-popups"
	          src="${targetUrl}"></iframe>
	  <script nonce="${n}">${RELAY_JS}</script>
	</body>
	</html>`;
}

function buildFallbackHtml(webview: vscode.Webview, bodyHtml: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';">
  ${baseStyles()}
</head>
<body>
  <div class="wrap">
    <h2>OpenCode Sidebar</h2>
    ${bodyHtml}
  </div>
</body>
</html>`;
}
