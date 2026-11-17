#!/usr/bin/env node
/**
 * 契约冒烟测试：不启动 GUI，只验证壳子依赖的 4 条上游契约。
 * 每次 pi-web 升级后跑一次：npm run smoke
 *
 *   1. 能找到已安装的 @agegr/pi-web（并读到版本号）
 *   2. node bin/pi-web.js --no-open -p <port> 能在 90s 内让 / 返回 HTTP 200
 *   3. /?session=<id> 仍然返回 200（页签恢复依赖这个 query 路由）
 *   4. 杀掉进程树后端口释放、运行记录被清理
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PI_WEB_PACKAGE = "@agegr/pi-web";
const TIMEOUT_MS = 90_000;

const pass = (msg) => console.log(`\u001b[32m✓\u001b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\u001b[31m✗\u001b[0m ${msg}`);
  process.exitCode = 1;
};
const info = (msg) => console.log(`\u001b[90m·\u001b[0m ${msg}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function exec(command, args, shell = false) {
  const result = spawnSync(command, args, { encoding: "utf8", shell, windowsHide: true, timeout: 20_000 });
  return { out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim(), status: result.status };
}

function which(name) {
  const result = process.platform === "win32" ? exec("where", [name]) : exec("sh", ["-lc", `command -v ${name}`]);
  return result.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function findScript() {
  const tried = [];
  const push = (path) => {
    if (path && existsSync(path)) tried.push(path);
  };
  for (const shim of which("pi-web")) {
    push(join(dirname(shim), "node_modules", PI_WEB_PACKAGE, "bin", "pi-web.js"));
  }
  push(join(dirname(process.execPath), "node_modules", PI_WEB_PACKAGE, "bin", "pi-web.js"));
  const npmRoot = exec(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], true).out;
  for (const line of npmRoot.split(/\r?\n/)) {
    const root = line.trim();
    if (root) push(join(root, PI_WEB_PACKAGE, "bin", "pi-web.js"));
  }
  return tried[0] ?? null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function httpStatus(url) {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel().catch(() => {});
    return response.status;
  } catch {
    return null;
  }
}

function killTree(pid) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
}

function runRecordsDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  const agentDir = configured ? configured : join(homedir(), ".pi", "agent");
  return join(agentDir, "pi-web-run");
}

function runRecordCount() {
  try {
    return readdirSync(runRecordsDir()).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

async function main() {
  // 1. 安装可定位
  const script = findScript();
  if (!script) {
    fail("找不到 @agegr/pi-web。先运行：npm install -g @agegr/pi-web@latest");
    return;
  }
  const pkg = JSON.parse(readFileSync(join(dirname(dirname(script)), "package.json"), "utf8"));
  pass(`找到 pi-web v${pkg.version}：${script}`);

  // 2. 能起服务
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  info(`启动测试实例：node pi-web.js --no-open -p ${port} -H 127.0.0.1`);

  const child = spawn(process.execPath, [script, "--no-open", "-p", String(port), "-H", "127.0.0.1"], {
    env: { ...process.env, PI_WEB_NO_OPEN: "1" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  let logTail = "";
  const capture = (chunk) => {
    logTail = `${logTail}${chunk.toString()}`.slice(-4_000);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const deadline = Date.now() + TIMEOUT_MS;
  let status = null;
  while (Date.now() < deadline) {
    status = await httpStatus(`${base}/`);
    if (status !== null) break;
    if (child.exitCode !== null) break;
    await sleep(400);
  }

  if (status === null) {
    fail(`服务未能在 ${TIMEOUT_MS / 1000}s 内应答。日志尾部：\n${logTail}`);
    killTree(child.pid);
    return;
  }
  pass(`GET / → HTTP ${status}`);

  // 3. query 路由仍在（页签恢复依赖它）
  const sessionUrl = `${base}/?session=smoke-test-session`;
  const sessionStatus = await httpStatus(sessionUrl);
  if (sessionStatus === 200) pass(`GET /?session=<id> → HTTP ${sessionStatus}`);
  else fail(`GET /?session=<id> 返回 ${sessionStatus ?? "无响应"}（页签恢复会失效）`);

  // 4. 收尸干净
  const before = runRecordCount();
  killTree(child.pid);
  const stopDeadline = Date.now() + 15_000;
  let stillServing = true;
  while (Date.now() < stopDeadline) {
    stillServing = (await httpStatus(`${base}/`)) !== null;
    if (!stillServing) break;
    await sleep(300);
  }
  if (stillServing) fail(`${base} 在杀进程后仍在应答（进程树没杀干净）`);
  else pass("杀掉进程树后端口已释放");

  await sleep(500);
  const after = runRecordCount();
  if (after > before) fail(`运行记录残留（${before} → ${after}）：${runRecordsDir()}`);
  else pass("运行记录已清理");
}

main().catch((error) => {
  fail(`冒烟脚本异常：${error?.stack ?? error}`);
});
