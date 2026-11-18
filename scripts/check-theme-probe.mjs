/**
 * 主题探测脚本的回归检查：不启动 Electron，直接把 THEME_PROBE_SCRIPT 抽出来
 * 在模拟 DOM 里跑一遍，防止 String.raw/正则转义再次把脚本写坏（历史上踩过坑）。
 *
 *   node scripts/check-theme-probe.mjs
 */
import fs from "node:fs";

const src = fs.readFileSync("src/main/tabs/theme-probe.ts", "utf8");
const match = /export const THEME_PROBE_SCRIPT = String\.raw`([\s\S]*?)`;/.exec(src);
if (!match) throw new Error("THEME_PROBE_SCRIPT not found in src/main/tabs/theme-probe.ts");
const code = match[1];

try {
  new Function(code);
} catch (error) {
  console.error("探测脚本语法错误：", error.message);
  process.exit(1);
}

const PALETTES = {
  mist: {
    "--bg": "#f4f8f7",
    "--bg-panel": "#e9f0ee",
    "--bg-hover": "#e0eae7",
    "--bg-selected": "#d7e4df",
    "--border": "#afc4ba",
    "--text": "#202e2b",
    "--text-muted": "#455f56",
    "--text-dim": "#52685f",
    "--accent": "#1e6559",
    "--accent-hover": "#174f46",
    "--accent-contrast": "#fff",
  },
  pine: {
    "--bg": "#19201f",
    "--bg-panel": "#212b28",
    "--bg-hover": "#2b3632",
    "--bg-selected": "#35433c",
    "--border": "#4a5f52",
    "--text": "#e6ede8",
    "--text-muted": "#c3d0c6",
    "--text-dim": "#afc2b5",
    "--accent": "#acccb7",
    "--accent-hover": "#d0e2d3",
    "--accent-contrast": "#182b20",
  },
};

function run({ theme, scheme, stored, palette }) {
  global.document = { documentElement: { dataset: { theme } }, body: {} };
  global.getComputedStyle = () => ({
    colorScheme: scheme,
    getPropertyValue: (key) => palette[key] || "",
    backgroundColor: palette["--bg"] || "rgba(0, 0, 0, 0)",
  });
  global.window = {
    matchMedia: () => ({ matches: false }),
    localStorage: { getItem: () => stored },
  };
  return JSON.parse(new Function("return " + code)());
}

const cases = [
  {
    label: "明确主题（mist）",
    input: { theme: "mist", scheme: "light", stored: "mist", palette: PALETTES.mist },
    check: (out) =>
      out.name === "mist" && out.scheme === "light" && out.fromPage === true &&
      out.vars["--bg"] === "#f4f8f7" && Object.keys(out.vars).length === 11,
  },
  {
    label: "深色主题（pine）",
    input: { theme: "pine", scheme: "dark", stored: "pine", palette: PALETTES.pine },
    check: (out) =>
      out.name === "pine" && out.scheme === "dark" && out.fromPage === true &&
      out.vars["--accent"] === "#acccb7",
  },
  {
    label: "auto 且读不到 dataset",
    input: { theme: "", scheme: "normal", stored: "auto", palette: PALETTES.mist },
    check: (out) => out.name === "light" && out.scheme === "light",
  },
  {
    label: "页面还没加载完（变量为空 + 透明背景）",
    input: { theme: "", scheme: "normal", stored: "auto", palette: {} },
    check: (out) => out.name === "light" && out.scheme === "light" && out.fromPage === false,
  },
];

let failed = 0;
for (const item of cases) {
  const out = run(item.input);
  const ok = item.check(out);
  console.log(`${ok ? "✓" : "✗"} ${item.label}: ${JSON.stringify({ name: out.name, scheme: out.scheme, vars: Object.keys(out.vars).length })}`);
  if (!ok) failed += 1;
}
if (failed) process.exit(1);
console.log("主题探测脚本检查通过");
