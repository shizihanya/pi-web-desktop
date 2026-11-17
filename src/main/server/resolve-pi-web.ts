import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppSettings } from "../settings";

const PI_WEB_PACKAGE = "@agegr/pi-web";
const MIN_NODE: [number, number, number] = [22, 19, 0];

export interface PiWebInstall {
  /** 系统 node.exe（绝不能用 Electron 自带的 Node：node-pty 的 ABI 不兼容） */
  nodePath: string;
  nodeVersion: string;
  /** pi-web 的 CLI 入口 */
  scriptPath: string;
  /** pi-web 版本号 */
  version: string;
}

export class ResolveError extends Error {
  constructor(
    message: string,
    /** 面向用户的可复制细节：试过的路径、命令等 */
    readonly detail: string,
  ) {
    super(message);
    this.name = "ResolveError";
  }
}

interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  failed: boolean;
}

function exec(command: string, args: string[], shell = false): ExecResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    shell,
    timeout: 15_000,
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    failed: Boolean(result.error),
  };
}

function which(name: string): string[] {
  const result =
    process.platform === "win32"
      ? exec("where", [name])
      : exec("sh", ["-lc", `command -v ${name}`]);
  if (result.failed && !result.stdout) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function parseNodeVersion(raw: string): [number, number, number] | null {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeast(
  version: [number, number, number],
  min: [number, number, number],
): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (version[i] > min[i]) return true;
    if (version[i] < min[i]) return false;
  }
  return true;
}

function fileVersionExe(path: string): string | null {
  const result = exec(path, ["-v"]);
  if (result.failed) return null;
  const parsed = parseNodeVersion(result.stdout || result.stderr);
  return parsed ? parsed.join(".") : null;
}

function nvmCandidates(): string[] {
  const candidates: string[] = [];
  const exe = process.platform === "win32" ? "node.exe" : join("bin", "node");
  const nvmHome = process.env.NVM_HOME;
  if (nvmHome) candidates.push(join(nvmHome, "nodejs", exe));
  const nvmSymlink = process.env.NVM_SYMLINK;
  if (nvmSymlink) candidates.push(join(nvmSymlink, exe));
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, "nvm", "nodejs", exe));
  if (process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, "Volta", "bin", exe));
    candidates.push(join(process.env.LOCALAPPDATA, "fnm_multishells", exe));
  }
  if (process.env.USERPROFILE) {
    candidates.push(join(process.env.USERPROFILE, ".volta", "bin", exe));
    candidates.push(join(process.env.USERPROFILE, ".bun", "bin", exe));
  }
  return candidates;
}

interface NodeCandidate {
  path: string;
  version: string | null;
  satisfied: boolean;
}

function collectNodeCandidates(settings: AppSettings): NodeCandidate[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  const push = (value: string | null | undefined) => {
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    paths.push(value);
  };

  push(settings.nodePath);
  push(process.env.PI_WEB_NODE);
  for (const path of which("node")) push(path);
  for (const path of nvmCandidates()) push(path);

  const electronExe = process.execPath.toLowerCase();
  return paths
    .filter((path) => existsSync(path))
    .filter((path) => path.toLowerCase() !== electronExe)
    .map((path) => {
      const version = fileVersionExe(path);
      const parsed = version ? parseNodeVersion(version) : null;
      return {
        path,
        version,
        satisfied: parsed ? isAtLeast(parsed, MIN_NODE) : false,
      };
    });
}

function readPackageVersion(pkgDir: string): string | null {
  const file = join(pkgDir, "package.json");
  if (!existsSync(file)) return null;
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as { version?: string; name?: string };
    if (pkg.name && pkg.name !== PI_WEB_PACKAGE) return null;
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export interface NpmInvocation {
  command: string;
  args: string[];
  /** Windows 上退回 npm.cmd 时必须走 shell */
  shell: boolean;
}

/**
 * 用「系统 node 自带的 npm」跑命令：检查与安装共用同一份 npm 配置 / registry。
 * 优先直接跑 npm-cli.js（不用 shell，避开 DEP0190）；找不到再退回 PATH 里的 npm。
 */
export function npmInvocation(nodePath: string, args: string[]): NpmInvocation {
  const nodeDir = dirname(nodePath);
  const npmCli = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((path) => existsSync(path));
  if (npmCli) return { command: nodePath, args: [npmCli, ...args], shell: false };
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args,
    shell: true,
  };
}

function npmGlobalRoots(nodePath: string): string[] {
  const roots: string[] = [];
  const invocation = npmInvocation(nodePath, ["root", "-g"]);
  const result = exec(invocation.command, invocation.args, invocation.shell);

  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("npm")) roots.push(trimmed);
  }
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, "npm", "node_modules"));
  return roots;
}

function scriptFromShimDir(shimPath: string): string[] {
  const dir = dirname(shimPath);
  return [join(dir, "node_modules", PI_WEB_PACKAGE, "bin", "pi-web.js")];
}

interface ScriptCandidate {
  path: string;
  version: string;
}

function collectScriptCandidates(settings: AppSettings, nodePath: string): {
  candidates: ScriptCandidate[];
  tried: string[];
} {
  const seen = new Set<string>();
  const paths: string[] = [];
  const push = (value: string | null | undefined) => {
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    paths.push(value);
  };

  push(settings.piWebScriptPath);
  push(process.env.PI_WEB_SCRIPT);
  for (const shim of which("pi-web")) {
    for (const path of scriptFromShimDir(shim)) push(path);
  }
  // nvm / 常规全局安装：node.exe 和 node_modules 常在同一层
  push(join(dirname(nodePath), "node_modules", PI_WEB_PACKAGE, "bin", "pi-web.js"));
  push(join(dirname(dirname(nodePath)), "lib", "node_modules", PI_WEB_PACKAGE, "bin", "pi-web.js"));
  for (const root of npmGlobalRoots(nodePath)) {
    push(join(root, PI_WEB_PACKAGE, "bin", "pi-web.js"));
  }

  const candidates: ScriptCandidate[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const version = readPackageVersion(dirname(dirname(path)));
    if (!version) continue;
    candidates.push({ path, version });
  }
  return { candidates, tried: paths };
}

/**
 * 解析出「用哪个 node 跑哪份 pi-web」。
 * 顺序：设置项 → 环境变量 → PATH 里的 pi-web shim → node 同级的全局 node_modules → npm root -g
 */
export function resolveInstall(settings: AppSettings): PiWebInstall {
  const nodes = collectNodeCandidates(settings);
  const goodNode = nodes.find((candidate) => candidate.satisfied);
  if (!goodNode) {
    const detail = nodes.length
      ? nodes.map((candidate) => `${candidate.path}  (${candidate.version ?? "无法执行"})`).join("\n")
      : "没有找到任何 node 可执行文件";
    throw new ResolveError(
      `需要 Node.js ${MIN_NODE.join(".")} 或更新的版本来运行 pi-web，但没有找到可用版本。`,
      detail,
    );
  }

  const { candidates, tried } = collectScriptCandidates(settings, goodNode.path);
  if (candidates.length === 0) {
    throw new ResolveError(
      "没有找到已安装的 @agegr/pi-web。请先运行：npm install -g @agegr/pi-web@latest",
      `试过的位置：\n${tried.join("\n")}`,
    );
  }

  const script = candidates[0];
  return {
    nodePath: goodNode.path,
    nodeVersion: goodNode.version ?? "unknown",
    scriptPath: script.path,
    version: script.version,
  };
}
