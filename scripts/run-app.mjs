#!/usr/bin/env node
/**
 * npm run app 的启动器：直接用官方 electron.exe 跑构建产物。
 * 图标由窗口（build/icon.ico）和快捷方式（icon.ico + AUMID）提供，不需要改动 electron.exe。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const electron = join(root, "node_modules", "electron", "dist", "electron.exe");
const main = join(root, "out", "main", "index.js");

if (!existsSync(main)) {
  console.error("还没构建产物：先运行 npm run build（或直接 npm run app）");
  process.exit(1);
}
if (!existsSync(electron)) {
  console.error(`找不到 ${electron}，先 npm install（或 node node_modules/electron/install.js）`);
  process.exit(1);
}

const child = spawn(electron, [main], {
  cwd: root,
  stdio: "inherit",
  windowsHide: false,
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (error) => {
  console.error(`启动失败：${String(error)}`);
  process.exit(1);
});
