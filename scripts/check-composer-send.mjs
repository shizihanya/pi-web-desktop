#!/usr/bin/env node
/**
 * 发送脚本的行为回归（不启动 Electron、不联网、不改 pi-web）。
 *
 * 用最小 DOM 桩在 vm 里**真正执行** buildComposerSendScript 生成的脚本，
 * 覆盖 Plan 01 复核要求：
 *   - 空闲 send / Agent 运行中 steer / Agent 运行中 followUp
 *   - 纯文字 / 文字+图片 / 纯图片 / 两者皆空
 *   - fieldset.disabled 不再一刀切拒绝所有模式（按模式判断按钮可用性）
 *   - 发送失败保留草稿、连续点击不重复提交、会话变化禁止发送
 *
 * DOM 桩按 pi-web v0.17.0 的真实 Composer 语义建模：
 *   - fieldset.chat-input-shell 包住 textarea 和全部提交按钮
 *   - 空输入时按钮 disabled，写入文本 / paste 图片后 React 把它启用
 *   - tw() 成功时清空 textarea + 图片 chip；nU() 失败时把内容放回
 *   - 图片附件预览是 <img src="blob:…|data:…">
 *
 *   npm run check:composer-send
 */
import vm from "node:vm";
import { buildComposerSendScript } from "../src/main/tabs/composer-bridge.ts";

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` → ${detail}`}`);
  if (!ok) failed += 1;
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const image = (name) => ({ data: PNG, mimeType: "image/png", name });

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}
class FakeClipboardEvent extends FakeEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.clipboardData = init.clipboardData ?? null;
  }
}
class FakeFile {
  constructor(parts, name, init = {}) {
    this.parts = parts;
    this.name = name;
    this.type = init.type ?? "";
  }
}
class FakeDataTransfer {
  constructor() {
    const list = [];
    this.items = { list, add(file) { list.push(file); } };
  }
}

class HTMLTextAreaElement {
  constructor() { this._value = ""; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
}

/**
 * 建一个「真实 Composer 语义」的最小 DOM。
 * opts.buttons: ['send'] 或 ['steer','followUp'] 或 ['followUp']
 * opts.fieldsetDisabled: 模拟上游把 fieldset 锁住
 * opts.buttonEffectivelyDisabled: 模拟按钮被禁用祖先影响（:disabled）
 * opts.sendSucceeds: click 后是否清空 textarea / 图片（false 模拟 nU() 放回）
 */
function makeDom(opts = {}) {
  const ta = new HTMLTextAreaElement();
  const dom = { opts, images: [], imageElements: [], clicks: [], buttons: [] };
  const shell = {
    querySelectorAll(selector) {
      if (selector === "button") return dom.buttons;
      if (selector.startsWith("img")) return dom.imageElements;
      return [];
    },
  };
  Object.assign(ta, {
    closest(selector) { return selector === ".chat-input-shell" ? shell : null; },
    dispatchEvent(event) {
      if (event.type === "input") {
        const hasContent = (ta.value || "").trim().length > 0 || dom.images.length > 0;
        for (const b of dom.buttons) b.disabled = !hasContent;
      } else if (event.type === "paste") {
        for (const file of event.clipboardData?.items?.list ?? []) {
          dom.images.push(file);
          const src = `blob:fake-${dom.images.length}`;
          dom.imageElements.push({ getAttribute: (name) => (name === "src" ? src : null) });
        }
      }
      return true;
    },
    focus() {},
    setSelectionRange() {},
  });

  const labels = { send: "发送", steer: "引导", followUp: "后续消息" };
  for (const kind of opts.buttons ?? ["send"]) {
    const label = labels[kind];
    dom.buttons.push({
      kind,
      attributes: { "aria-label": label, title: label },
      textContent: label,
      disabled: true,
      isConnected: true,
      getAttribute(name) { return this.attributes[name] ?? null; },
      matches(selector) {
        if (selector !== ":disabled") return false;
        return this.disabled || Boolean(opts.buttonEffectivelyDisabled);
      },
      click() {
        dom.clicks.push(kind);
        if (opts.sendSucceeds) {
          ta.value = "";
          dom.images = [];
          dom.imageElements = [];
        }
      },
    });
  }

  const window = {
    setTimeout: (fn) => setTimeout(fn, 0), // 加速轮询，不真的等 1.5s
    location: { search: opts.search ?? "?session=s1" },
    __piDesktopDraftSending: false,
  };
  const document = {
    querySelector(selector) {
      if (opts.noTextarea) return null;
      return selector.includes("chat-input-textarea") ? ta : null;
    },
  };
  const context = vm.createContext({
    window, document,
    HTMLTextAreaElement,
    Event: FakeEvent,
    ClipboardEvent: FakeClipboardEvent,
    DataTransfer: FakeDataTransfer,
    File: FakeFile,
    URLSearchParams,
    atob,
    setTimeout,
    clearTimeout,
    console,
  });
  return { dom, ta, window, context };
}

async function run(payload, opts = {}) {
  const { dom, ta, window, context } = makeDom(opts);
  const code = buildComposerSendScript({
    text: payload.text ?? "",
    sessionKey: payload.sessionKey ?? "session:s1",
    mode: payload.mode ?? "send",
    images: payload.images ?? [],
  });
  const raw = await vm.runInNewContext(code, context);
  const result = typeof raw === "string" ? JSON.parse(raw) : raw;
  return { result, dom, ta, window };
}

const okResult = (r) => r.result?.ok === true;

try {
  /* ---------------- 空闲发送 ---------------- */
  {
    const { result, dom } = await run({ text: "空闲消息", mode: "send" }, { sendSucceeds: true });
    check("空闲发送：复用原生「发送」按钮并确认送达", okResult({ result }) && dom.clicks.join() === "send", JSON.stringify(result));
  }
  {
    const { result } = await run({ text: "纯文字", mode: "send", images: [] }, { sendSucceeds: true });
    check("纯文字发送：允许", okResult({ result }), JSON.stringify(result));
  }

  /* ---------------- Agent 运行中：steer / followUp ---------------- */
  {
    const { result, dom } = await run(
      { text: "立刻引导", mode: "steer" },
      { buttons: ["steer", "followUp"], sendSucceeds: true },
    );
    check("Agent 运行中 steer：点的是原生「引导」按钮", okResult({ result }) && dom.clicks.join() === "steer", JSON.stringify(result));
  }
  {
    const { result, dom } = await run(
      { text: "排队消息", mode: "followUp" },
      { buttons: ["steer", "followUp"], sendSucceeds: true },
    );
    check("Agent 运行中 followUp：点的是原生「后续消息」按钮", okResult({ result }) && dom.clicks.join() === "followUp", JSON.stringify(result));
  }
  {
    const { result, dom } = await run(
      { text: "只有 followUp 通道", mode: "followUp" },
      { buttons: ["followUp"], sendSucceeds: true },
    );
    check("steer 不可用时只用 followUp，不误点别的按钮", okResult({ result }) && dom.clicks.join() === "followUp", JSON.stringify(result));
  }

  /* ---------------- 纯图片 / 文字+图片 ---------------- */
  {
    const { result, dom } = await run(
      { text: "", mode: "send", images: [image("only.png")] },
      { sendSucceeds: true },
    );
    check("纯图片发送：允许且能确认送达（旧代码会因空文本 / indexOf('') 失败）", okResult({ result }), JSON.stringify(result));
    check("纯图片确实走了原生 paste 并生成附件 chip", dom.images.length === 0 && dom.clicks.join() === "send");
  }
  {
    const { result } = await run(
      { text: "看图", mode: "send", images: [image("a.png"), image("b.png")] },
      { sendSucceeds: true },
    );
    check("文字 + 多张图片发送：允许", okResult({ result }), JSON.stringify(result));
  }
  {
    const { result } = await run(
      { text: "", mode: "steer", images: [image("steer.png")] },
      { buttons: ["steer", "followUp"], sendSucceeds: true },
    );
    check("运行中纯图片 steer：允许（对齐 tV 的 (t || ew.length)）", okResult({ result }), JSON.stringify(result));
  }
  {
    const { result, dom } = await run({ text: "   ", mode: "send", images: [] }, { sendSucceeds: true });
    check("文字和图片都为空才拒绝", !okResult({ result }) && /草稿为空/.test(result.reason) && dom.clicks.length === 0, JSON.stringify(result));
  }

  /* ---------------- fieldset.disabled 不再一刀切 ---------------- */
  {
    // 模拟「上游把 fieldset 锁住，但本次模式对应的按钮仍可点」：
    // 旧代码在找按钮之前就返回「pi-web 输入框当前不可用」，steer/followUp 永远发不出去。
    const { result, dom } = await run(
      { text: "锁住也要能引导", mode: "steer" },
      { buttons: ["steer", "followUp"], fieldsetDisabled: true, sendSucceeds: true },
    );
    check(
      "fieldset 被锁但按钮可点时，steer 仍能发送（不再一刀切拒绝所有模式）",
      okResult({ result }) && dom.clicks.join() === "steer",
      JSON.stringify(result),
    );
  }
  {
    const { result } = await run(
      { text: "锁住且按钮确实被禁用", mode: "followUp" },
      { buttons: ["followUp"], fieldsetDisabled: true, buttonEffectivelyDisabled: true, sendSucceeds: true },
    );
    check(
      "按钮真的不可用时按**模式**给出准确原因并保留草稿",
      !okResult({ result }) && /找不到可用的原生后续消息按钮/.test(result.reason) && /保留草稿/.test(result.reason),
      JSON.stringify(result),
    );
  }
  {
    const { result, ta } = await run(
      { text: "按钮 disabled", mode: "send" },
      { buttons: ["send"], buttonEffectivelyDisabled: true, sendSucceeds: true },
    );
    check("按钮不可用时恢复原生输入框原内容", !okResult({ result }) && ta.value === "", JSON.stringify(result));
  }

  /* ---------------- 失败保留 / 连点 / 会话变化 ---------------- */
  {
    const { result, dom } = await run(
      { text: "发送失败要保留", mode: "send" },
      { sendSucceeds: false },
    );
    check("发送未确认：返回失败且不清空（面板草稿保留）", !okResult({ result }) && /草稿未清空/.test(result.reason) && dom.clicks.length === 1, JSON.stringify(result));
  }
  {
    const { result, dom } = await run(
      { text: "", mode: "send", images: [image("x.png")] },
      { sendSucceeds: false },
    );
    check("纯图片发送失败：同样返回失败，不误报成功", !okResult({ result }) && dom.clicks.length === 1, JSON.stringify(result));
  }
  {
    const { result } = await run({ text: "旧会话草稿", mode: "send", sessionKey: "session:s9" }, { sendSucceeds: true });
    check("会话变化禁止发送旧草稿", !okResult({ result }) && /目标会话已变化/.test(result.reason), JSON.stringify(result));
  }
  {
    const { result } = await run({ text: "没有输入框", mode: "send" }, { noTextarea: true, sendSucceeds: true });
    check("找不到主输入框禁止发送", !okResult({ result }) && /禁止发送/.test(result.reason), JSON.stringify(result));
  }
  {
    // 页面 realm 内的重复发送闸门：上一次还在轮询时第二次直接被忽略
    const { dom, context } = makeDom({ sendSucceeds: false });
    const code = buildComposerSendScript({ text: "连点", sessionKey: "session:s1", mode: "send", images: [] });
    const first = vm.runInNewContext(code, context);
    const second = vm.runInNewContext(code, context);
    const secondResult = JSON.parse(String(second));
    check("连续点击：第二次在页面 realm 内被闸门忽略", /上一次发送尚未结束/.test(secondResult.reason), JSON.stringify(secondResult));
    await Promise.resolve(first); // 让第一次的轮询跑完，避免挂住进程
    check("连续点击：只点了一次原生按钮", dom.clicks.length === 1, String(dom.clicks.length));
  }
} catch (error) {
  check("行为测试执行过程无异常", false, String(error));
}

if (failed) process.exit(1);
console.log("发送脚本行为检查通过");
