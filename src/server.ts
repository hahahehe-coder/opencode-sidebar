import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface OpencodeServer {
	readonly url: string;
	readonly port: number;
	stop(): Promise<void>;
}

interface SpawnOptions {
	serverPath?: string;
	cwd: string;
	log: (line: string) => void;
}

function resolveServerBinary(serverPath?: string): { command: string; args: string[] } {
	if (serverPath && serverPath.trim().length > 0) {
		const trimmed = serverPath.trim();
		if (path.extname(trimmed).toLowerCase() === ".cmd" || path.extname(trimmed).toLowerCase() === ".bat") {
			// Windows npm shim: must go through cmd.exe, no shell string needed.
			return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", trimmed, "serve"] };
		}
		return { command: trimmed, args: ["serve"] };
	}
	// Bare name on PATH. Prefer the .cmd shim next to it so we can avoid shell:true.
	if (process.platform === "win32") {
		const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
		for (const dir of dirs) {
			const candidate = path.join(dir, "opencode.cmd");
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", candidate, "serve"] };
			} catch {
				// keep scanning
			}
		}
	}
	return { command: "opencode", args: ["serve"] };
}

/**
 * Kills the whole process tree on Windows (taskkill /T) and falls back to a
 * plain SIGTERM elsewhere. Resolves once the process has exited.
 */
function killTree(proc: ChildProcess): Promise<void> {
	if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const done = () => resolve();
		proc.once("exit", done);
		if (process.platform === "win32") {
			spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			}).once("error", () => {
				// taskkill unavailable (unlikely): fall back to signal.
				proc.kill("SIGTERM");
			});
		} else {
			proc.kill("SIGTERM");
		}
		// Safety net so stop() never hangs forever.
		setTimeout(() => {
			proc.removeListener("exit", done);
			resolve();
		}, 5000).unref();
	});
}

/**
 * Spawns `opencode serve --hostname 127.0.0.1` with the given cwd and resolves
 * once the server prints its listening URL. The port is chosen by opencode
 * itself (its default is OS-assigned; a configured default like 4096 wins if set) —
 * we never pick one for it.
 */
export function startOpencodeServer(opts: SpawnOptions): Promise<OpencodeServer> {
	return new Promise((resolve, reject) => {
		const { command, args } = resolveServerBinary(opts.serverPath);
		let child: ChildProcess;

		try {
			child = spawn(command, [...args, "--hostname", "127.0.0.1"], {
				cwd: opts.cwd,
				windowsHide: true,
				env: {
					...process.env,
					OPENCODE_CLIENT: "vscode-opencode-sidebar",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			reject(new Error(`Failed to spawn opencode: ${String(err)}`));
			return;
		}

		let settled = false;
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];

		const timeout = setTimeout(() => {
			if (!settled) {
				settled = true;
				void killTree(child);
				reject(
					new Error(
						`opencode serve did not report a listening URL within 30s.\nstdout: ${stdoutChunks.join("")}\nstderr: ${stderrChunks.join("")}`,
					),
				);
			}
		}, 30_000);

		child.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			opts.log(`[opencode] ${text.trimEnd()}`);
			stdoutChunks.push(text);
			if (settled) {
				return;
			}
			// Server prints: "opencode server listening on http://127.0.0.1:<port>"
			for (const line of text.split(/\r?\n/)) {
				const match = line.match(/listening\s+on\s+(https?:\/\/[^\s]+)/);
				if (match) {
					settled = true;
					clearTimeout(timeout);
					try {
						const url = new URL(match[1]);
						resolve({
							url: match[1],
							port: Number(url.port),
							stop: async () => {
								await killTree(child);
							},
						});
					} catch (err) {
						clearTimeout(timeout);
						reject(new Error(`Failed to parse opencode URL "${match[1]}": ${String(err)}`));
					}
				}
			}
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			opts.log(`[opencode:err] ${text.trimEnd()}`);
			stderrChunks.push(text);
		});

		child.once("error", (err) => {
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				reject(new Error(`opencode failed to start: ${err.message}. Is the CLI installed and on PATH?`));
			}
		});

		child.once("exit", (code, signal) => {
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				reject(
					new Error(
						`opencode exited prematurely (code=${code ?? "null"}, signal=${signal ?? "null"}).\nstdout: ${stdoutChunks.join("")}\nstderr: ${stderrChunks.join("")}`,
					),
				);
			}
		});
	});
}

/**
 * Returns the canonical worktree string for `directory` as the opencode
 * server spells it in GET /project (e.g. drive-letter casing fixed from
 * vscode's `c:/...` fsPath to the server's `C:/...`). The WebUI matches
 * sessions to projects with a case-sensitive path comparison, so the
 * seeded project must reuse the server's exact casing or the session
 * list renders empty.
 */
export async function resolveProjectWorktree(baseUrl: string, directory: string): Promise<string> {
	try {
		const res = await fetch(new URL("/project", baseUrl));
		if (res.ok) {
			const projects = (await res.json()) as { worktree?: string }[];
			const hit = projects.find((p) => p.worktree && p.worktree.toLowerCase() === directory.toLowerCase());
			if (hit?.worktree) {
				return hit.worktree;
			}
		}
	} catch {
		// fall through to the local fallback
	}
	// The server creates the project lazily; mirror its drive-letter casing.
	if (/^[a-z]:/.test(directory)) {
		return directory.charAt(0).toUpperCase() + directory.slice(1);
	}
	return directory;
}

/** Returns the first workspace folder path, or undefined when no folder is open. */
export function getWorkspaceCwd(workspaceFolders: readonly { uri: { fsPath: string } }[] | undefined): string | undefined {
	const first = workspaceFolders?.[0];
	if (!first) {
		return undefined;
	}
	const p = first.uri.fsPath;
	return fs.existsSync(p) ? p : undefined;
}
