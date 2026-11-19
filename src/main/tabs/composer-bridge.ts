/**
 * 独立输入工作区 ↔ pi-web 原生 Composer 的轻量桥接（页面 realm 注入脚本）。
 *
 * 硬约束（Plan 01 §四 / §五）：
 *  - 绝不自行调用 Agent API、不维护发送状态机、不重复实现模型/工具/Thinking；
 *    只把内容交给 pi-web 自己的 textarea，然后点它自己的按钮（发送 / 引导 / 后续消息）。
 *  - 一切选择器来自本机 pi-web v0.17.0 只读实证（见 docs/PLAN-01-*.md）：
 *      .chat-input-shell textarea.chat-input-textarea   主输入框
 *      fieldset.chat-input-shell[disabled|aria-busy]    输入被禁用
 *      button[aria-label|title|text = chat.send]        发送
 *      button[aria-label = chat.steer]                  streaming 时的「引导」
 *      button[aria-label = chat.followUp]               streaming 时的「后续消息」
 *      button[title = chat.attachFiles]                 附加文件
 *      onPaste 从 clipboardData.items 取 image/*       图片附件
 *  - 找不到主输入框 / 作用域 / 可用按钮时一律「不发送」，并把原生输入框原样恢复。
 *
 * 脚本放在独立模块（check:contracts 要求 tab-manager.ts 里不得出现内联注入脚本），
 * 全部用 String.raw 避免正则 / 转义被破坏，语法由 check:composer-bridge 回归。
 */

/**
 * 多语言按钮标签表。
 * 关键顺序：send 必须先于 steer/followUp 判定（streaming 时 send 按钮会被替换）。
 * 这些字面量同时被 scripts/check-composer-bridge.mjs 与 check-contracts.mjs 锁住。
 */
const LABELS_SOURCE = String.raw`var LABELS = {
  send: ['发送','傳送','Send','send','Send message','送信','Enviar','Envoyer','Inviare','Senden','Sending'],
  steer: ['引导','引導','Steer','steer'],
  followUp: ['后续消息','後續訊息','Follow-up','Followup','follow-up','Follow up'],
  attach: ['附加文件','附加檔案','Attach files']
};
function hasLabel(text, kind) {
  var list = LABELS[kind];
  for (var i = 0; i < list.length; i += 1) {
    if (text === list[i]) return true;
  }
  return false;
}
function buttonLabels(b) {
  return [
    (b.getAttribute('aria-label') || '').trim(),
    (b.getAttribute('title') || '').trim(),
    (b.textContent || '').trim()
  ];
}
function findButton(scope, kind) {
  var list = scope.querySelectorAll('button');
  for (var i = 0; i < list.length; i += 1) {
    var parts = buttonLabels(list[i]);
    for (var j = 0; j < parts.length; j += 1) {
      if (parts[j] && hasLabel(parts[j], kind)) return list[i];
    }
  }
  // Steer / Follow-up 的 title 是提示语（chat.steerHint），只有 aria-label 是短标签
  return null;
}`;

/** 只读探针：不改动任何 DOM，返回 JSON 字符串给主进程做兼容性判定 */
export const COMPOSER_PROBE_SCRIPT = String.raw`(() => {
  var attempts = 0;
  return new Promise(function (resolve) { attempt();
    function attempt() {
      var out = collect();
      if (out.textarea || out.error || attempts >= 12) { resolve(JSON.stringify(out)); return; }
      attempts += 1;
      window.setTimeout(attempt, 150);
    }
  });

  function collect() {
   try {
    __LABELS__
    var params = new URLSearchParams(window.location.search);
    var out = {
      textarea: false, scoped: false, sendButton: false, sendEnabled: false,
      busy: false, sessionId: params.get('session'), cwd: params.get('cwd'),
      sendMode: 'enter', compact: false, pageReady: document.readyState === 'complete',
      modes: { send: false, steer: false, followUp: false, attach: false },
      typography: null, error: null
    };
    var ta = document.querySelector('.chat-input-shell textarea.chat-input-textarea');
    if (!ta) {
      var all = document.querySelectorAll('textarea.chat-input-textarea');
      for (var i = 0; i < all.length; i += 1) {
        if (all[i].getClientRects && all[i].getClientRects().length) { ta = all[i]; break; }
      }
    }
    out.textarea = !!ta;
    if (ta) {
      out.pageReady = true;
      out.scoped = !!ta.closest('.chat-input-shell');
      var fieldset = ta.closest('fieldset');
      out.busy = !!(fieldset && (fieldset.disabled || fieldset.getAttribute('aria-busy') === 'true'));
      var scope = ta.closest('.chat-input-shell') || document;
      var send = findButton(scope, 'send');
      out.sendButton = !!send;
      out.sendEnabled = !!(send && !send.disabled);
      out.modes.send = !!send;
      out.modes.steer = !!findButton(scope, 'steer');
      out.modes.followUp = !!findButton(scope, 'followUp');
      out.modes.attach = !!findButton(scope, 'attach');
      // 字体 / 字号 / 行高直接读原生输入框，面板据此对齐（pi-web 换字体也不用改壳子）
      var st = getComputedStyle(ta);
      out.typography = {
        fontFamily: st.fontFamily, fontSize: st.fontSize,
        lineHeight: st.lineHeight, color: st.color,
        background: st.backgroundColor, letterSpacing: st.letterSpacing
      };
    }
    try { out.sendMode = window.localStorage.getItem('pi-enter-send-mode') === 'ctrlEnter' ? 'ctrlEnter' : 'enter'; } catch (e) {}
    try { out.compact = window.matchMedia('(max-width: 640px)').matches; } catch (e) {}
    return out;
   } catch (e) {
    return {
      textarea: false, scoped: false, sendButton: false, sendEnabled: false,
      busy: false, sessionId: null, cwd: null, sendMode: 'enter', compact: false,
      pageReady: false, modes: { send: false, steer: false, followUp: false, attach: false },
      typography: null, error: String(e)
    };
   }
  }
})()`.replace("__LABELS__", LABELS_SOURCE);

/** 升级上游后的一次性诊断：把真实 Composer DOM / 按钮 / 字体变量 dump 成 JSON，只读 */
export const COMPOSER_DIAGNOSE_SCRIPT = String.raw`(() => {
  try {
    var shell = document.querySelector('.chat-input-shell');
    var ta = document.querySelector('textarea.chat-input-textarea');
    var st = ta ? getComputedStyle(ta) : null;
    var root = getComputedStyle(document.documentElement);
    var buttons = [];
    if (shell) {
      var list = shell.querySelectorAll('button');
      for (var i = 0; i < list.length; i += 1) {
        var b = list[i];
        var r = b.getBoundingClientRect();
        buttons.push({
          aria: b.getAttribute('aria-label'), title: b.getAttribute('title'),
          text: (b.textContent || '').trim().slice(0, 40), disabled: b.disabled,
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]
        });
      }
    }
    return JSON.stringify({
      readyState: document.readyState,
      shell: !!shell, fieldsetDisabled: shell ? !!shell.disabled : null,
      ta: !!ta, taValueLength: ta ? (ta.value || '').length : -1,
      taFont: st ? { family: st.fontFamily, size: st.fontSize, lineHeight: st.lineHeight, color: st.color } : null,
      vars: {
        uiFont: root.getPropertyValue('--ui-font-family'),
        monoFont: root.getPropertyValue('--mono-font-family'),
        chatFontSize: root.getPropertyValue('--chat-content-font-size'),
        text: root.getPropertyValue('--text'), bg: root.getPropertyValue('--bg')
      },
      buttons: buttons
    });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

export type ComposerMode = "send" | "steer" | "followUp";

export interface ComposerImage {
  /** base64（不含 data: 前缀） */
  data: string;
  mimeType: string;
  name: string;
}

export interface ComposerSendPayload {
  text: string;
  /** 草稿关联时的会话 key（session:xxx / cwd:xxx / new），发送前复核 */
  sessionKey: string;
  /** 发送模式：空闲发 prompt、Agent 运行时发 steer（立即引导）或 followUp（排队后续消息） */
  mode: ComposerMode;
  /** 面板里粘贴/拖入的图片，交给原生 onPaste 处理 */
  images: ComposerImage[];
}

export interface ComposerProbeResult {
  textarea: boolean;
  scoped: boolean;
  sendButton: boolean;
  sendEnabled: boolean;
  busy: boolean;
  sessionId: string | null;
  cwd: string | null;
  sendMode: string;
  compact: boolean;
  pageReady: boolean;
  modes: { send: boolean; steer: boolean; followUp: boolean; attach: boolean };
  typography: {
    fontFamily: string;
    fontSize: string;
    lineHeight: string;
    color: string;
    background: string;
    letterSpacing: string;
  } | null;
  error: string | null;
}

export interface ComposerSendResult {
  ok: boolean;
  reason: string;
}

/** 把任意值安全地嵌进注入脚本（避免 </script>、U+2028/2029 破坏 JS 字符串） */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const SEND_BODY = String.raw`(() => {
  var P = __PAYLOAD__;
  var fail = function (reason) { return JSON.stringify({ ok: false, reason: reason }); };
  try {
    if (window.__piDesktopDraftSending) return fail('上一次发送尚未结束，已忽略重复点击');
    __LABELS__
    var ta = document.querySelector('.chat-input-shell textarea.chat-input-textarea');
    if (!ta) return fail('找不到 pi-web 主输入框，禁止发送（草稿已保留）');
    var shell = ta.closest('.chat-input-shell');
    if (!shell) return fail('无法确认主输入框作用域，禁止错误发送（草稿已保留）');
    var fieldset = ta.closest('fieldset');
    if (fieldset && (fieldset.disabled || fieldset.getAttribute('aria-busy') === 'true')) {
      return fail('pi-web 输入框当前不可用，已保留草稿');
    }
    var params = new URLSearchParams(window.location.search);
    var sid = params.get('session');
    var cwd = params.get('cwd');
    var currentKey = sid ? 'session:' + sid : (cwd ? 'cwd:' + cwd : 'new');
    if (P.sessionKey && currentKey !== P.sessionKey) {
      return fail('目标会话已变化，禁止发送旧会话草稿');
    }
    if (!P.text || !P.text.trim()) return fail('草稿为空');

    var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    var original = ta.value || '';
    function restore() {
      try { setter.call(ta, original); ta.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    }

    // 图片：复用 pi-web 原生 onPaste（从 clipboardData.items 取 image/*），
    // 不自己构造 /api/agent 请求体、不重写附件状态机。
    if (P.images && P.images.length) {
      try {
        var dt = new DataTransfer();
        for (var i = 0; i < P.images.length; i += 1) {
          var im = P.images[i];
          var bin = atob(im.data);
          var arr = new Uint8Array(bin.length);
          for (var k = 0; k < bin.length; k += 1) arr[k] = bin.charCodeAt(k);
          dt.items.add(new File([arr], im.name || ('image-' + i + '.png'), { type: im.mimeType }));
        }
        var pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        if (!pasteEvent.clipboardData) {
          Object.defineProperty(pasteEvent, 'clipboardData', { value: dt });
        }
        ta.dispatchEvent(pasteEvent);
      } catch (e) {
        return fail('图片交给原生输入框失败：' + String(e) + '（草稿已保留）');
      }
    }

    // 关键修复：pi-web 在输入框为空时把「发送」按钮置为 disabled，这是正常状态。
    // 必须先写入文本让 React 更新 eh / ew，按钮才会变为可用；不能写入前就检查 disabled。
    var finalText = original.trim() ? original.replace(/\s+$/, '') + '\n\n' + P.text : P.text;
    try {
      setter.call(ta, finalText);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) {
      return fail('写入原生输入框失败：' + String(e) + '（草稿已保留）');
    }

    // 等 React 受控状态同步完，再按模式找 pi-web 自己的按钮并点击。
    return new Promise(function (resolve) {
      window.setTimeout(function () {
        var kind = P.mode === 'steer' ? 'steer' : (P.mode === 'followUp' ? 'followUp' : 'send');
        var button = findButton(shell, kind);
        if (!button) {
          // Agent 刚开始 / 刚结束时按钮会从 send 切到 steer/followUp，做一次兜底互选
          if (kind === 'send') button = findButton(shell, 'steer') || findButton(shell, 'followUp');
          else button = findButton(shell, 'send');
        }
        if (!button || button.disabled) {
          restore();
          resolve(fail('找不到可用的原生' + (kind === 'send' ? '发送' : kind === 'steer' ? '引导' : '后续消息') + '按钮，已恢复原生输入框并保留草稿'));
          return;
        }
        window.__piDesktopDraftSending = true;
        try { button.click(); } catch (e) {
          window.__piDesktopDraftSending = false;
          restore();
          resolve(fail('点击原生按钮失败：' + String(e) + '（草稿已保留）'));
          return;
        }
        // pi-web 的 tS / tV 都会先 tw() 清空 textarea；失败时 nU() 把文本放回。
        var waited = 0;
        (function poll() {
          var value = ta.value || '';
          if (value.indexOf(P.text) === -1) {
            window.__piDesktopDraftSending = false;
            resolve(JSON.stringify({ ok: true, reason: '已通过 pi-web 原生按钮提交（' + kind + '）' }));
            return;
          }
          if (waited >= 1500) {
            window.__piDesktopDraftSending = false;
            resolve(fail('未能确认消息已送达，文本已保留在原生输入框，草稿未清空'));
            return;
          }
          waited += 150;
          window.setTimeout(poll, 150);
        })();
      }, 140);
    });
  } catch (e) {
    return fail('注入发送异常：' + String(e) + '（草稿已保留）');
  }
})()`.replace("__LABELS__", LABELS_SOURCE);

/** 组装发送脚本：payload 用 JSON 注入，避免手工拼接导致转义错误 */
export function buildComposerSendScript(payload: ComposerSendPayload): string {
  return SEND_BODY.replace("__PAYLOAD__", jsonForScript(payload));
}

/**
 * 「在原生输入框中继续」：把草稿 + 图片交给原生 Composer 并把焦点给它，
 * 用户就能用原生全部能力（@ 文件提及、/ 命令、模型、工具、steer/next）继续编辑。
 * 不点任何发送按钮，只是把内容搬过去。
 */
const OPEN_IN_NATIVE_BODY = String.raw`(() => {
  var P = __PAYLOAD__;
  try {
    var ta = document.querySelector('.chat-input-shell textarea.chat-input-textarea');
    if (!ta) return JSON.stringify({ ok: false, reason: '找不到 pi-web 原生输入框' });
    var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    var original = ta.value || '';
    var finalText = original.trim() ? original.replace(/\s+$/, '') + '\n\n' + P.text : P.text;
    setter.call(ta, finalText);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    if (P.images && P.images.length) {
      try {
        var dt = new DataTransfer();
        for (var i = 0; i < P.images.length; i += 1) {
          var im = P.images[i];
          var bin = atob(im.data);
          var arr = new Uint8Array(bin.length);
          for (var k = 0; k < bin.length; k += 1) arr[k] = bin.charCodeAt(k);
          dt.items.add(new File([arr], im.name || ('image-' + i + '.png'), { type: im.mimeType }));
        }
        var ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        if (!ev.clipboardData) Object.defineProperty(ev, 'clipboardData', { value: dt });
        ta.dispatchEvent(ev);
      } catch (e) {}
    }
    try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
    return JSON.stringify({ ok: true, reason: '已放入原生输入框，可继续使用 @ 文件提及 / 图片 / 模型等原生能力' });
  } catch (e) { return JSON.stringify({ ok: false, reason: String(e) }); }
})()`;

export function buildOpenInNativeScript(payload: ComposerSendPayload): string {
  return OPEN_IN_NATIVE_BODY.replace("__PAYLOAD__", jsonForScript(payload));
}
