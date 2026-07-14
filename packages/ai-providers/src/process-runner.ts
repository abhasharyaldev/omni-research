import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildFilteredEnv, redactSecrets } from "@omni/security";
import { newId } from "@omni/shared";

/**
 * Resolve a bare CLI name (e.g. "claude") to a concrete file on Windows by
 * scanning PATH with PATHEXT. Returns the input unchanged when it already has
 * a directory/extension, off Windows, or when nothing is found. This lets an
 * adapter configure `claude`/`codex`/`gemini` by name while the runner still
 * finds the real `.cmd`/`.exe`.
 */
function resolveWindowsExecutable(executable: string): string {
  if (process.platform !== "win32") return executable;
  if (executable.includes("/") || executable.includes("\\") || path.extname(executable)) return executable;
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim()).filter(Boolean);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, executable + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return executable;
}

const WINDOWS_SHIM = /\.(cmd|bat)$/i;

/**
 * Safe execution of local AI CLIs.
 *
 * - No shell: executable + fixed argument arrays only.
 * - Executable allowlist: only registered provider binaries can run.
 * - Filtered environment: API-key/billing variables are never forwarded.
 * - Isolated working directory per invocation, deleted afterwards.
 * - Input/output size limits, hard timeout, process-tree termination.
 * - Global concurrency limit.
 */

export type RunnerConfig = {
  timeoutMs: number;
  maxConcurrent: number;
  maxInputChars: number;
  maxOutputChars: number;
  workspaceRoot: string;
};

export function runnerConfigFromEnv(): RunnerConfig {
  const num = (name: string, fallback: number) => {
    const raw = process.env[name];
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    timeoutMs: num("AI_PROCESS_TIMEOUT_MS", 180_000),
    maxConcurrent: num("AI_MAX_CONCURRENT_PROCESSES", 1),
    maxInputChars: num("AI_MAX_INPUT_CHARACTERS", 200_000),
    maxOutputChars: num("AI_MAX_OUTPUT_CHARACTERS", 200_000),
    workspaceRoot: process.env.AI_WORKSPACE_ROOT || ".local-ai-workspaces",
  };
}

export type CliRunRequest = {
  requestId: string;
  executable: string; // must be in the allowlist
  args: string[]; // fixed template arguments only — never raw user input
  stdin?: string;
  extraAllowedEnv?: string[];
  envOverrides?: Record<string, string>;
};

export type CliRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
};

export class ProcessRunner {
  private allowlist = new Set<string>();
  private active = new Map<string, ChildProcess>();
  private running = 0;
  private waiters: (() => void)[] = [];

  constructor(private readonly config: RunnerConfig = runnerConfigFromEnv()) {}

  allowExecutable(executable: string): void {
    this.allowlist.add(path.basename(executable).toLowerCase());
    this.allowlist.add(executable.toLowerCase());
  }

  private isAllowed(executable: string): boolean {
    return (
      this.allowlist.has(executable.toLowerCase()) ||
      this.allowlist.has(path.basename(executable).toLowerCase())
    );
  }

  private async acquireSlot(): Promise<void> {
    if (this.running < this.config.maxConcurrent) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.running++;
  }

  private releaseSlot(): void {
    this.running = Math.max(0, this.running - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  async cancel(requestId: string): Promise<void> {
    const child = this.active.get(requestId);
    if (child) this.killTree(child);
  }

  private killTree(child: ChildProcess): void {
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
      // Kill the whole tree; CLIs often spawn helpers.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore" });
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }

  async run(request: CliRunRequest): Promise<CliRunResult> {
    if (!this.isAllowed(request.executable)) {
      throw new Error(`Executable "${request.executable}" is not in the provider allowlist`);
    }
    if ((request.stdin?.length ?? 0) > this.config.maxInputChars) {
      const error = new Error(
        `Input of ${request.stdin?.length} characters exceeds AI_MAX_INPUT_CHARACTERS=${this.config.maxInputChars}`
      );
      (error as any).code = "input-too-large";
      throw error;
    }

    await this.acquireSlot();
    const workspace = path.resolve(this.config.workspaceRoot, `ws-${newId()}`);
    await mkdir(workspace, { recursive: true });

    const started = Date.now();
    let timedOut = false;
    let cancelled = false;

    try {
      const env = buildFilteredEnv({
        extraAllowed: request.extraAllowedEnv,
        overrides: { ...request.envOverrides, TMPDIR: workspace, TMP: workspace, TEMP: workspace },
      });

      // Resolve bare names to a concrete file, then handle Windows batch
      // shims (npm `.cmd`/`.bat`): they cannot be spawned with shell:false, so
      // route through cmd.exe using the BASENAME + the shim's own directory as
      // cwd — no backslash-containing token reaches cmd's parser (which mangles
      // them). Args stay a fixed template + stdin (no shell-injection surface),
      // env is still filtered, and TMP still points at the isolated workspace.
      const resolvedExe = resolveWindowsExecutable(request.executable);
      let spawnExe = resolvedExe;
      let spawnArgs = request.args;
      let spawnCwd = workspace;
      if (process.platform === "win32" && WINDOWS_SHIM.test(resolvedExe)) {
        spawnExe = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
        spawnCwd = path.dirname(resolvedExe);
        spawnArgs = ["/d", "/s", "/c", path.basename(resolvedExe), ...request.args];
      }

      const child = spawn(spawnExe, spawnArgs, {
        shell: false,
        cwd: spawnCwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      this.active.set(request.requestId, child);

      const result = await new Promise<CliRunResult>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;

        const timer = setTimeout(() => {
          timedOut = true;
          this.killTree(child);
        }, this.config.timeoutMs);

        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            exitCode,
            stdout: redactSecrets(stdout),
            stderr: redactSecrets(stderr),
            durationMs: Date.now() - started,
            timedOut,
            cancelled,
          });
        };

        child.stdout!.on("data", (data: Buffer) => {
          stdout += data.toString("utf8");
          if (stdout.length > this.config.maxOutputChars) {
            stdout = stdout.slice(0, this.config.maxOutputChars);
            this.killTree(child);
          }
        });
        child.stderr!.on("data", (data: Buffer) => {
          stderr += data.toString("utf8");
          if (stderr.length > this.config.maxOutputChars) {
            stderr = stderr.slice(0, this.config.maxOutputChars);
          }
        });
        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code) => finish(code));

        if (request.stdin !== undefined) {
          child.stdin!.write(request.stdin, () => child.stdin!.end());
        } else {
          child.stdin!.end();
        }

        // Track external cancellation (cancel() kills the process; close fires).
        child.once("exit", () => {
          if (!timedOut && this.active.get(request.requestId) === undefined) cancelled = true;
        });
      });

      return result;
    } finally {
      this.active.delete(request.requestId);
      this.releaseSlot();
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Shared runner instance for the app. */
let sharedRunner: ProcessRunner | undefined;
export function getProcessRunner(): ProcessRunner {
  if (!sharedRunner) sharedRunner = new ProcessRunner();
  return sharedRunner;
}

export function isWindows(): boolean {
  return os.platform() === "win32";
}
