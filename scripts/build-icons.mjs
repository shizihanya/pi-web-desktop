#!/usr/bin/env node
/**
 * 由 build/logo.svg 生成窗口 ICO、托盘小图和渲染层 logo。
 * 用法：npm run icons
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
const svgPath = join(buildDir, "logo.svg");

if (!existsSync(svgPath)) {
  console.error(`找不到 ${svgPath}`);
  process.exit(1);
}

const svg = readFileSync(svgPath, "utf8");

function render(size) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    background: "rgba(0,0,0,0)",
  });
  return resvg.render().asPng();
}

function writePng(name, size) {
  const png = render(size);
  writeFileSync(join(buildDir, name), png);
  console.log(`  build/${name}  ${size}x${size}  ${png.length} bytes`);
  return png;
}

console.log("渲染 PNG：");
mkdirSync(buildDir, { recursive: true });
const png512 = writePng("icon.png", 512); // 窗口回落图 + 渲染层 logo
const png32 = writePng("tray.png", 32);  // 托盘
// 其余尺寸只进 ICO，不额外落盘
const png16 = render(16);
const png48 = render(48);
const png64 = render(64);
const png128 = render(128);

/** ICO 容器：每个尺寸塞一张 PNG（Vista 起支持） */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);

  const dirSize = 16 * entries.length;
  let offset = 6 + dirSize;
  const dir = [];
  for (const { size, data } of entries) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    dir.push(entry);
  }
  return Buffer.concat([header, ...dir, ...entries.map((entry) => entry.data)]);
}

const ico = buildIco([
  { size: 16, data: png16 },
  { size: 32, data: png32 },
  { size: 48, data: png48 },
  { size: 64, data: png64 },
  { size: 128, data: png128 },
  { size: 256, data: render(256) },
]);
writeFileSync(join(buildDir, "icon.ico"), ico);
console.log(`  build/icon.ico  16/32/48/64/128/256  ${ico.length} bytes`);

// 给渲染层用的 logo（splash / 设置页标题）
const rendererAssets = join(root, "src", "renderer", "assets");
mkdirSync(rendererAssets, { recursive: true });
writeFileSync(join(rendererAssets, "logo.png"), png512);
console.log(`  src/renderer/assets/logo.png  (512x512)`);
