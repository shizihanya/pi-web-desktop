import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

/**
 * 自绘标题栏的高度：页签栏、启动页、设置页顶部的拖曳条都用这个值。
 * 与 src/renderer/tabbar/style.css 里的 --tabbar-height 必须一致。
 */
export const TITLEBAR_HEIGHT = 40;

/**
 * WCO 原生叠加层比页签栏少 1px：
 * 页签栏的 border-bottom 画在 40px 盒子的最后一行（y=39），
 * overlay 若也是 40px，就会在右侧窗口控件区把这条线整段盖掉，视觉上分割线「断在半路」。
 * 少 1px 后边框在整窗宽连续，原生按钮仍在同一条标题栏内。
 */
const WCO_OVERLAY_HEIGHT = TITLEBAR_HEIGHT - 1;

/**
 * 是否启用「隐藏系统标题栏 + 原生窗口控件叠加（WCO）」。
 * 只有 Windows 需要；设 PI_WEB_DESKTOP_NATIVE_TITLEBAR=1 可退回系统标题栏。
 */
export function customTitleBarEnabled(): boolean {
  return process.platform === "win32" && process.env.PI_WEB_DESKTOP_NATIVE_TITLEBAR !== "1";
}

/** 创建 BrowserWindow 时叠加的构造参数 */
export function titleBarOptions(
  color: string,
  symbolColor: string,
): Partial<BrowserWindowConstructorOptions> {
  if (!customTitleBarEnabled()) return {};
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: { color, symbolColor, height: WCO_OVERLAY_HEIGHT },
  };
}

/** 主题变化时更新窗口控件的底色 / 图标色 */
export function setTitleBarColors(win: BrowserWindow, color: string, symbolColor: string): void {
  if (!customTitleBarEnabled() || win.isDestroyed()) return;
  try {
    win.setTitleBarOverlay({ color, symbolColor, height: WCO_OVERLAY_HEIGHT });
  } catch {
    // 窗口可能正在销毁，忽略
  }
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(value?: string): Rgba | null {
  if (!value) return null;
  const text = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length === 6 || h.length === 8) {
      return {
        r: Number.parseInt(h.slice(0, 2), 16),
        g: Number.parseInt(h.slice(2, 4), 16),
        b: Number.parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (rgb) {
    const parts = rgb[1]
      .split(/[,/\s]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      const alpha = parts.length >= 4 ? parts[3] : 1;
      return { r: parts[0], g: parts[1], b: parts[2], a: alpha > 1 ? alpha / 255 : alpha };
    }
  }
  return null;
}

/**
 * 把页面 CSS 颜色归一化成不透明的 #RRGGBB（Electron 的 titleBarOverlay / setBackgroundColor 用）。
 * 半透明色按明/暗底色做一次合成，避免窗口控件后面透出白色。
 */
export function toOpaqueHex(
  value: string | undefined,
  scheme: "light" | "dark",
  /** 缺失时的兜底颜色；不传则按「背景色」兜底（深色→近黑，浅色→白） */
  fallbackHex?: string,
): string {
  const base = scheme === "dark" ? 0 : 255;
  const color = parseColor(value);
  const fallback: Rgba = parseColor(fallbackHex) ?? {
    r: scheme === "dark" ? 26 : 255,
    g: scheme === "dark" ? 26 : 255,
    b: scheme === "dark" ? 26 : 255,
    a: 1,
  };
  const source = color ?? fallback;
  const mix = (channel: number): number =>
    Math.max(0, Math.min(255, Math.round(channel * source.a + base * (1 - source.a))));
  const hex = (channel: number): string => mix(channel).toString(16).padStart(2, "0");
  return `#${hex(source.r)}${hex(source.g)}${hex(source.b)}`;
}

/** 没有页面变量时，窗口控件图标的兜底色（保证与背景有对比度） */
export function defaultSymbolColor(scheme: "light" | "dark"): string {
  return scheme === "dark" ? "#e8e8e8" : "#1a1a1a";
}
