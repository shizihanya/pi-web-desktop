/**
 * 大输入框（便签）：不修改 pi-web 文件，只在页面 realm 里加两个浮层元素。
 *
 * 设计要点（根据反馈调整过）：
 *  - ⤢ 按钮贴着 pi-web 自己的「发送」按钮左侧，和它同高、同一水平线；不再浮在 textarea 中间。
 *  - 点开后编辑器停靠在 pi-web 右侧文件面板（#file-panel）内部，不遮中间的对话。
 *  - 所有节点挂在 document.body 上（不插进 React 树），位置每 400ms 同步一次，
 *    pi-web 重渲染 / 面板缩放都不会把注入的元素冲掉或错位。
 */

export const COMPOSER_EXPAND_SCRIPT = String.raw`(() => {
  try {
    if (window.__piDesktopComposerExpand) return;
    window.__piDesktopComposerExpand = true;

    var BUTTON_ID = 'pi-desktop-composer-expand-button';
    var PANEL_ID = 'pi-desktop-composer-expand-panel';
    var PLACEHOLDER = /消息|訊息|message|msg|输入|type|ask|prompt|回复|发送|running|运行中/i;
    var SEND_LABEL = /^(发送|傳送|send|send message|送信|enviar|envoyer|inviare|senden|sending)/i;
    var STYLE = {
      bg: 'var(--bg-panel, var(--bg, #ffffff))',
      text: 'var(--text, #1f2328)',
      muted: 'var(--text-muted, var(--text-dim, #6e7781))',
      border: 'var(--border, #d0d7de)',
      accent: 'var(--accent, #0969da)',
      accentText: 'var(--accent-contrast, #ffffff)',
      surface: 'var(--bg, var(--bg-panel, #ffffff))'
    };

    var button = null;
    var panel = null;
    var editor = null;
    var status = null;

    function findTextarea() {
      var list = document.querySelectorAll('textarea.chat-input-textarea');
      var fallback = null;
      for (var i = 0; i < list.length; i += 1) {
        var ta = list[i];
        if (!ta.getClientRects || !ta.getClientRects().length) continue;
        if (!fallback) fallback = ta;
        var hint = (ta.getAttribute('placeholder') || '') + ' ' + (ta.getAttribute('aria-label') || '');
        if (PLACEHOLDER.test(hint) && !ta.getAttribute('aria-label')) return ta;
      }
      if (fallback) return fallback;
      var all = document.querySelectorAll('textarea');
      for (var j = 0; j < all.length; j += 1) {
        var other = all[j];
        if (!other.getClientRects || !other.getClientRects().length) continue;
        if (PLACEHOLDER.test(other.getAttribute('placeholder') || '')) return other;
      }
      return null;
    }

    function findSendButton(ta, includeDisabled) {
      var scopes = [];
      var form = ta.closest ? ta.closest('form') : null;
      if (form) scopes.push(form);
      var parent = ta.parentElement;
      for (var level = 0; parent && level < 4; level += 1) {
        scopes.push(parent);
        parent = parent.parentElement;
      }
      scopes.push(document);
      for (var s = 0; s < scopes.length; s += 1) {
        var buttons = scopes[s].querySelectorAll('button');
        for (var i = 0; i < buttons.length; i += 1) {
          var b = buttons[i];
          if (!includeDisabled && b.disabled) continue;
          var label = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.textContent || '')).trim();
          if (label && SEND_LABEL.test(label)) return b;
        }
      }
      return null;
    }

    /** ⤢ 贴在发送按钮左边：同高、同水平线，不跟 textarea 顶部走 */
    function placeButton() {
      if (!button) return;
      var ta = findTextarea();
      if (!ta) { button.style.display = 'none'; return; }
      var send = findSendButton(ta, true);
      var r = (send || ta).getBoundingClientRect();
      if (!r.width || !r.height) { button.style.display = 'none'; return; }
      var size = Math.max(26, Math.min(34, Math.round(r.height)));
      button.style.display = 'flex';
      button.style.width = size + 'px';
      button.style.height = Math.round(r.height) + 'px';
      if (send) {
        button.style.left = Math.round(r.left - size - 6) + 'px';
        button.style.top = Math.round(r.top) + 'px';
      } else {
        // Agent 运行中 pi-web 会把发送按钮换成「后续消息」标签，退到输入框右下角
        button.style.left = Math.round(r.right - size - 6) + 'px';
        button.style.top = Math.round(r.bottom - r.height) + 'px';
      }
    }

    /** 打开 pi-web 自己的右侧面板（如果它现在是收起的） */
    function openRightPanel() {
      var fp = document.getElementById('file-panel');
      if (!fp) return false;
      if (fp.classList.contains('right-panel-open')) return true;
      var toggles = document.querySelectorAll('button[aria-controls="file-panel"]');
      for (var i = 0; i < toggles.length; i += 1) {
        if (toggles[i].getAttribute('aria-expanded') === 'false') {
          toggles[i].click();
          return true;
        }
      }
      return false;
    }

    /** 让编辑器精确覆盖右侧文件面板的内容区（保留它的标题/标签栏） */
    function syncPanel() {
      if (!panel) return;
      var fp = document.getElementById('file-panel');
      if (!fp) {
        // 上游改了面板选择器时退回右侧悬浮，不遮中间对话区
        panel.style.display = 'flex';
        panel.style.left = '';
        panel.style.top = '64px';
        panel.style.right = '12px';
        panel.style.bottom = '12px';
        panel.style.width = 'min(520px, 44vw)';
        panel.style.height = '';
        return;
      }
      var r = fp.getBoundingClientRect();
      if (!r.width || !r.height || !fp.classList.contains('right-panel-open')) {
        panel.style.display = 'none';
        return;
      }
      var header = fp.firstElementChild;
      var headerH = header ? Math.round(header.getBoundingClientRect().height) : 0;
      panel.style.display = 'flex';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = Math.round(r.left + 6) + 'px';
      panel.style.top = Math.round(r.top + headerH + 6) + 'px';
      panel.style.width = Math.max(240, Math.round(r.width - 12)) + 'px';
      panel.style.height = Math.max(160, Math.round(r.height - headerH - 12)) + 'px';
    }

    function setStatus(message) {
      if (status) status.textContent = message || '';
    }

    function updateCount() {
      if (!status || !editor) return;
      setStatus(editor.value.length + ' 字 · Ctrl+Enter 发送 · Esc 收起');
    }

    function closePanel() {
      if (panel) panel.style.display = 'none';
    }

    function openPanel() {
      buildPanel();
      openRightPanel();
      panel.style.display = 'flex';
      syncPanel();
      placeButton();
      editor.focus();
    }

    function sendToChat() {
      if (!editor) return;
      var text = editor.value.replace(/\s+$/, '');
      if (!text) { setStatus('先写点内容'); return; }
      var ta = findTextarea();
      if (!ta) { setStatus('找不到对话输入框，请先打开一个会话'); return; }

      var existing = (ta.value || '').replace(/\s+$/, '');
      var finalText = existing ? existing + '\n\n' + text : text;

      try {
        var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, finalText);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) {
        setStatus('写入输入框失败：' + String(e));
        return;
      }

      // 等 React 把受控值同步完再触发发送
      window.setTimeout(function () {
        var sent = false;
        var send = findSendButton(ta, false);
        if (send && !send.disabled) {
          send.click();
          sent = true;
        } else {
          try {
            ta.focus();
            var ctrl = window.localStorage.getItem('pi-enter-send-mode') === 'ctrlEnter';
            ta.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
              bubbles: true, cancelable: true, ctrlKey: ctrl, metaKey: ctrl
            }));
            sent = true;
          } catch (e) {}
        }
        if (!sent) { setStatus('找不到发送按钮，文本已放入输入框，请手动发送'); return; }
        editor.value = '';
        updateCount();
      }, 120);
    }

    function buildPanel() {
      if (panel) return;
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.style.cssText = 'position:fixed;display:none;flex-direction:column;box-sizing:border-box;z-index:2147483000;border:1px solid ' + STYLE.border + ';border-radius:8px;background:' + STYLE.surface + ';color:' + STYLE.text + ';box-shadow:0 6px 20px rgba(0,0,0,0.16);overflow:hidden;font:14px/1.5 inherit;';

      var header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid ' + STYLE.border + ';flex:0 0 auto;background:' + STYLE.bg + ';';
      var title = document.createElement('span');
      title.textContent = '大输入框';
      title.style.cssText = 'font-weight:600;';
      var close = document.createElement('button');
      close.type = 'button';
      close.textContent = '×';
      close.title = '收起';
      close.setAttribute('aria-label', '收起大输入框');
      close.style.cssText = ButtonStyle() + 'width:26px;height:26px;padding:0;font-size:19px;line-height:1;';
      close.addEventListener('click', function (event) { event.stopPropagation(); closePanel(); });
      header.appendChild(title);
      header.appendChild(close);

      editor = document.createElement('textarea');
      editor.placeholder = '在这里写长文本…发送后会填入对话输入框并发出';
      editor.spellcheck = false;
      editor.style.cssText = 'flex:1 1 auto;width:100%;min-height:120px;resize:none;border:0;outline:none;padding:12px;box-sizing:border-box;background:transparent;color:' + STYLE.text + ';font:14px/1.6 inherit;';
      editor.addEventListener('input', updateCount);
      editor.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') { event.preventDefault(); closePanel(); return; }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          sendToChat();
        }
      });

      var footer = document.createElement('div');
      footer.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-top:1px solid ' + STYLE.border + ';flex:0 0 auto;background:' + STYLE.bg + ';';
      status = document.createElement('span');
      status.style.cssText = 'font-size:12px;color:' + STYLE.muted + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      var send = document.createElement('button');
      send.type = 'button';
      send.textContent = '发送到对话';
      send.title = '把内容填入对话输入框并发送';
      send.style.cssText = ButtonStyle() + 'background:' + STYLE.accent + ';color:' + STYLE.accentText + ';border-color:transparent;padding:5px 12px;font-weight:600;';
      send.addEventListener('click', function (event) { event.stopPropagation(); sendToChat(); });
      footer.appendChild(status);
      footer.appendChild(send);

      panel.appendChild(header);
      panel.appendChild(editor);
      panel.appendChild(footer);
      document.body.appendChild(panel);
      updateCount();
    }

    function ButtonStyle() {
      return 'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid ' + STYLE.border + ';border-radius:6px;background:' + STYLE.bg + ';color:' + STYLE.text + ';';
    }

    function ensureButton() {
      if (button) return;
      button = document.createElement('button');
      button.id = BUTTON_ID;
      button.type = 'button';
      button.textContent = '⤢';
      button.title = '展开大输入框（右侧面板）';
      button.setAttribute('aria-label', '展开大输入框');
      button.style.cssText = 'position:fixed;display:none;align-items:center;justify-content:center;padding:0;z-index:2147483000;border:1px solid ' + STYLE.border + ';border-radius:8px;background:' + STYLE.bg + ';color:' + STYLE.text + ';cursor:pointer;font-size:16px;line-height:1;';
      button.addEventListener('click', function (event) { event.stopPropagation(); openPanel(); });
      document.body.appendChild(button);
    }

    function tick() {
      placeButton();
      syncPanel();
    }

    ensureButton();
    tick();
    window.setInterval(tick, 400);
    window.addEventListener('resize', tick);
    window.addEventListener('scroll', tick, true);
  } catch (e) {}
})()`;
