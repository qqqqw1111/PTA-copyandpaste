// ==UserScript==
// @name         PTA 粘贴解锁器（Allow Copy & Paste for pintia.cn）
// @namespace    local.pta
// @version      7.0.0
// @description  pintia.cn 专用：解除复制/剪切/粘贴/右键/框选/拖拽限制。支持 CodeMirror 6 / CodeMirror 5 / Monaco / 原生输入框，优先走编辑器官方 API 写入，找不到时逐字符模拟键盘输入兜底。自带右下角浮动面板显示实时状态，无需打开 Console。
// @author       qqqw1111
// @icon         https://www.pintia.cn/static/img/favicon.ico
// @match        *://*.pintia.cn/*
// @match        *://pintia.cn/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/**
 * ============================================================
 * PTA 粘贴解锁器 v7.0.0
 * ============================================================
 *
 * 功能
 *   1. 全局解除 copy / cut / paste / contextmenu / selectstart / dragstart 拦截
 *   2. CSS user-select: text 强制恢复文本选择
 *   3. 自动清理 oncopy / onpaste 等内联事件属性（MutationObserver 持续监听）
 *   4. 粘贴时优先走 CodeMirror 6 API（view.dispatch）
 *      其次 CodeMirror 5 / Monaco 官方 API
 *      最后逐字符 execCommand('insertText') 模拟键盘输入兜底
 *   5. 右下角浮动面板实时显示脚本状态（激活/未激活/写入方式/写入字符数）
 *   6. SPA 路由感知：监听 pushState / replaceState / popstate，页面切换自动重新检测
 *   7. Alt+Shift+P 手动重新检测；Alt+Shift+M 隐藏/显示面板
 *
 * 兼容性
 *   - 现代浏览器：Chrome / Edge / Firefox / Safari 最新稳定版
 *   - 编辑器：CodeMirror 6（主要）、CodeMirror 5、Monaco Editor、原生 input/textarea
 *   - 无扩展依赖：@grant none，纯原生 JS
 *
 * 使用方法
 *   1. 安装 Tampermonkey / Violentmonkey / 篡改猴 扩展
 *   2. 新建脚本 → 粘贴本文件全部内容 → Ctrl+S 保存
 *   3. 打开 pintia.cn 的考试页或 dashboard 页，右下角出现状态面板即成功
 *
 * 原理
 *   - PTA 通过 window 捕获阶段监听 paste/copy 事件并 stopImmediatePropagation，
 *     同时用 beforeinput 拦截 insertFromPaste 类型、用 CSS 禁止 user-select。
 *   - 本脚本同样在 window 捕获阶段注册监听器，且 @run-at=document-start
 *     保证先于页面自身脚本执行，从而接管事件。
 *   - 真正写入编辑器时走 CodeMirror 官方 API，绕过所有粘贴检测层；
 *     API 不可用时用逐字符 execCommand 模拟键盘，输入事件序列与真实打字一致。
 *
 * 风险提示
 *   - 本脚本仅解除前端限制；考试作答可能有服务端行为记录。
 *   - 在考试页面绕过粘贴限制用于作弊，风险由使用者自行承担。
 *     建议仅用于个人练习、课程作业、自我学习场景。
 *
 * ============================================================
 */

(function () {
  'use strict';

  // ==================== 0. 域名守卫 ====================
  // 双重保险：@match 已限制 pintia.cn，这里再校验一次避免配置异常时误注入
  var host = location.hostname;
  var isPtaDomain = host === 'pintia.cn' ||
                    host.indexOf('.pintia.cn') === host.length - '.pintia.cn'.length;
  if (!isPtaDomain) return;

  // ==================== 1. 浮动状态面板 ====================
  // 右下角常驻小面板，实时显示脚本状态；Alt+Shift+M 可隐藏
  var panel = null;

  function makePanel() {
    if (panel || !document.documentElement) return;
    panel = document.createElement('div');
    panel.id = '__pta_panel__';
    panel.style.cssText = [
      'position:fixed',
      'right:12px', 'bottom:12px',
      'z-index:2147483647',
      'background:rgba(30,30,30,0.92)',
      'color:#e8e8e8',
      'font:12px/1.5 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
      'padding:8px 12px',
      'border-radius:6px',
      'box-shadow:0 2px 10px rgba(0,0,0,0.35)',
      'max-width:280px',
      'user-select:none',
      'cursor:default',
      'border-left:3px solid #64b5f6',
      'transition:opacity .2s',
    ].join(';');
    document.documentElement.appendChild(panel);
  }

  // 日志数组（面板里只显示最近 12 条）
  var logs = [];
  function log(msg, color) {
    logs.unshift({ text: msg, color: color || '#9ccc65' });
    if (logs.length > 12) logs.pop();
    try { console.log('[PTA]', msg); } catch (e) {}
    if (panel) {
      var html = logs.map(function (item) {
        return '<div style="color:' + item.color + '">' + item.text + '</div>';
      }).join('');
      panel.innerHTML = html;
    }
  }

  // ==================== 2. 页面类型检测 ====================
  // 只对考试页和 dashboard 激活，其他 pintia.cn 页面静默
  function detectPage() {
    var p = location.pathname;
    if (p.indexOf('/exam/') !== -1 ||
        p.indexOf('/exam/problems') !== -1) {
      return 'exam';
    }
    if (p.indexOf('/problem-sets/dashboard') !== -1 ||
        (p.indexOf('/problem-sets') !== -1 &&
         p.indexOf('/problems') === -1 &&
         p.indexOf('/exam') === -1 &&
         p.indexOf('/detail') === -1)) {
      return 'dashboard';
    }
    return 'other';
  }

  // ==================== 3. 编辑器实例查找 ====================

  /**
   * 从当前焦点元素或 DOM 根查找 CodeMirror 6 的 EditorView 实例
   * 实例挂载节点的 cmView 属性上，可能是 EditorView 或 EditorState
   * @param {Element} el 当前焦点元素（向上遍历）
   * @returns {EditorView|null}
   */
  function findCodeMirror6View(el) {
    var node = el;
    while (node && node.nodeType === 1) {
      var cv = node.cmView;
      if (cv) {
        if (cv.view && cv.view.state && typeof cv.view.dispatch === 'function') return cv.view;
        if (cv.state && typeof cv.dispatch === 'function') return cv;
      }
      node = node.parentElement;
    }
    // 兜底：直接查 DOM 根
    var root = document.querySelector('.cm-editor');
    if (root && root.cmView) {
      var rcv = root.cmView;
      if (rcv.view && typeof rcv.view.dispatch === 'function') return rcv.view;
      if (typeof rcv.dispatch === 'function') return rcv;
    }
    return null;
  }

  // ==================== 4. 文本写入引擎 ====================
  // 按编辑器类型路由到对应的写入策略，失败则逐字符模拟

  /**
   * 将文本写入当前焦点元素
   * @param {Element} el
   * @param {string} text
   * @returns {boolean}
   */
  function writeInto(el, text) {
    if (!text) return true;

    // --- 类型 1：原生 input / textarea ---
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      try {
        if (document.execCommand('insertText', false, text)) return true;
      } catch (err) {}
      try {
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
                                              : HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) {
          var s = el.selectionStart || 0, e = el.selectionEnd || 0;
          desc.set.call(el, el.value.slice(0, s) + text + el.value.slice(e));
          el.selectionStart = el.selectionEnd = s + text.length;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
      } catch (err2) {}
      return false;
    }

    // --- 类型 2：CodeMirror 6（官方 API，最稳） ---
    try {
      var view = findCodeMirror6View(el);
      if (view) {
        var range = view.state.selection.main;
        view.dispatch({ changes: { from: range.from, to: range.to, insert: text } });
        view.focus();
        log('✓ CM6 API 写入 ' + text.length + ' 字符', '#4caf50');
        return true;
      }
    } catch (err) {
      log('CM6 API 异常: ' + (err && err.message), '#ef5350');
    }

    // --- 类型 3：CodeMirror 5 ---
    try {
      var wrap = el.closest && el.closest('.CodeMirror');
      var cm = wrap && wrap.CodeMirror;
      if (cm && typeof cm.replaceSelection === 'function') {
        cm.replaceSelection(text);
        cm.focus();
        log('✓ CM5 写入 ' + text.length + ' 字符', '#4caf50');
        return true;
      }
    } catch (err) {}

    // --- 类型 4：Monaco Editor ---
    try {
      var api = window.monaco;
      if (api && api.editor && typeof api.editor.getEditors === 'function') {
        var editors = api.editor.getEditors();
        for (var i = 0; i < editors.length; i++) {
          if (editors[i].hasTextFocus && editors[i].hasTextFocus()) {
            editors[i].executeEdits('pta', [{
              range: editors[i].getSelection(), text: text, forceMoveMarkers: true,
            }]);
            editors[i].focus();
            log('✓ Monaco 写入 ' + text.length + ' 字符', '#4caf50');
            return true;
          }
        }
      }
    } catch (err) {}

    // --- 类型 5：contenteditable 逐字符模拟键盘（终极兜底） ---
    // 关键：一次整段 insertText 可能仍被页面判定为粘贴并回滚；
    // 逐个字符触发 execCommand 产生的 beforeinput/input 序列与真实打字完全一致
    if (el.isContentEditable) {
      log('逐字符写入 ' + text.length + ' 字符...', '#ffb74d');
      var idx = 0;
      (function step() {
        if (idx >= text.length) { log('✓ 逐字符完成', '#4caf50'); return; }
        try { document.execCommand('insertText', false, text.charAt(idx++)); } catch (err) {}
        setTimeout(step, 10);  // 10ms 间隔，可按需调整
      })();
      return true;
    }

    log('✗ 无法写入：元素类型不支持', '#ef5350');
    return false;
  }

  // ==================== 5. 事件拦截层 ====================
  // 在 window 捕获阶段统一 stopImmediatePropagation，
  // 阻止页面自身脚本注册的监听器执行"禁止粘贴"逻辑

  function block(e) { e.stopImmediatePropagation(); }

  // 需要拦截的事件类型
  var BLOCK_EVENTS = [
    'copy', 'cut',
    'beforecopy', 'beforecut', 'beforepaste',
    'contextmenu', 'selectstart', 'dragstart',
  ];

  // 劫持 keydown：阻止页面劫持 Ctrl+C/X/V/A
  // 但保留 Alt+Shift+P 和 Alt+Shift+M 两个快捷键
  function onKeydown(e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && /^(c|x|v|a)$/i.test(e.key)) {
      e.stopImmediatePropagation();
    }
  }

  // 粘贴接管：页面事件被 stopImmediatePropagation 后，
  // 我们在这里从 clipboardData 读文本并调用 writeInto 手动写入
  function onPaste(e) {
    var text = '';
    try { text = e.clipboardData ? e.clipboardData.getData('text/plain') : ''; } catch (err) {}
    e.stopImmediatePropagation();

    var el = document.activeElement;
    if (!el) return;

    var isEditable = el.isContentEditable ||
                     el.tagName === 'TEXTAREA' ||
                     el.tagName === 'INPUT';
    if (!isEditable) return;

    e.preventDefault();
    writeInto(el, text);
  }

  // beforeinput 层：部分编辑器在这一层判定 insertFromPaste
  function onBeforeInput(e) {
    if (e.inputType === 'insertFromPaste') e.stopImmediatePropagation();
  }

  // ==================== 6. 激活/停用控制 ====================

  var ACTIVE = false;
  var listenersAttached = false;
  var observerStarted = false;
  var styleInjected = false;
  var hooksAttached = false;

  function activate() {
    if (ACTIVE) return;
    ACTIVE = true;
    log('>>> 粘贴解锁器 已激活 <<<', '#4caf50');

    // 注入样式
    if (!styleInjected) {
      var style = document.createElement('style');
      style.id = '__pta_style__';
      style.textContent = [
        '*, *::before, *::after {',
        '  -webkit-user-select: text !important;',
        '  -moz-user-select: text !important;',
        '  user-select: text !important;',
        '  -webkit-user-drag: auto !important;',
        '}',
        '*::selection { background: #3390ff !important; color: #fff !important; }',
      ].join('\n');
      (document.head || document.documentElement).appendChild(style);
      styleInjected = true;
    }

    // 注册事件监听（每个只注册一次）
    if (!listenersAttached) {
      BLOCK_EVENTS.forEach(function (t) {
        window.addEventListener(t, block, true);
      });
      window.addEventListener('paste', onPaste, true);
      window.addEventListener('beforeinput', onBeforeInput, true);
      window.addEventListener('keydown', onKeydown, true);
      listenersAttached = true;
    }

    // 清理内联 oncopy/onpaste 等属性
    if (!observerStarted) {
      function stripAttrs() {
        document.querySelectorAll('[oncopy],[oncut],[onpaste],[oncontextmenu],[onselectstart]')
          .forEach(function (n) {
            ['oncopy','oncut','onpaste','oncontextmenu','onselectstart'].forEach(function (a) {
              n.removeAttribute(a);
            });
          });
      }
      stripAttrs();
      new MutationObserver(function (records) {
        records.forEach(function (r) {
          r.addedNodes.forEach(stripAttrs);
        });
      }).observe(document.documentElement, { childList: true, subtree: true });
      observerStarted = true;
    }

    // SPA 路由 Hook（每个只 Hook 一次）
    if (!hooksAttached) {
      var _push = history.pushState, _replace = history.replaceState;
      history.pushState = function () {
        var r = _push.apply(this, arguments);
        setTimeout(checkPage, 300);
        return r;
      };
      history.replaceState = function () {
        var r = _replace.apply(this, arguments);
        setTimeout(checkPage, 300);
        return r;
      };
      window.addEventListener('popstate', function () { setTimeout(checkPage, 300); });
      hooksAttached = true;
    }
  }

  // 注意：不做 deactivate/stop，原因是事件监听已注册，
  // 如果 deactivate 时移除监听，下次 activate 再注册会导致重复；
  // 但 STOP 不是必需的——非目标页面时事件仍然触发但被 stopImmediatePropagation，
  // 对功能无副作用（PTA 非目标页本身也不涉及编辑器）
  // 所以只做 ACTIVE 标志置位，不做反注册

  function checkPage() {
    var page = detectPage();
    if (page === 'other') {
      if (ACTIVE) {
        ACTIVE = false;
        log('当前页面不是考试/dashboard，已停用', '#ffb74d');
      }
      return;
    }
    activate();
    if (page === 'exam') log('📝 考试页', '#64b5f6');
    if (page === 'dashboard') log('📊 Dashboard 页', '#64b5f6');
  }

  // ==================== 7. 快捷键 ====================
  document.addEventListener('keydown', function (e) {
    // Alt + Shift + P → 手动重新检测并激活
    if (e.altKey && e.shiftKey && e.keyCode === 80) {
      ACTIVE = false;
      log('手动重新检测...', '#ffb74d');
      checkPage();
    }
    // Alt + Shift + M → 显示/隐藏面板
    if (e.altKey && e.shiftKey && e.keyCode === 77 && panel) {
      panel.style.opacity = panel.style.opacity === '0' ? '1' : '0';
    }
  }, true);

  // ==================== 8. 启动入口 ====================

  // 先挂面板让用户能看到状态
  if (document.documentElement) {
    makePanel();
    log('脚本加载完成，URL=' + location.pathname, '#64b5f6');
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      makePanel();
      log('脚本加载完成，URL=' + location.pathname, '#64b5f6');
    }, { once: true });
  }

  // SPA 页面加载时 DOM 还没挂载完，给 150ms 缓冲再检测
  var kick = function () { setTimeout(checkPage, 150); };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', kick, { once: true });
  } else {
    kick();
  }

  // ==================== 9. Console 调试 API ====================
  // 只在 PTA 域名下暴露，其他页面不会存在
  window.__ptaUnlocker = {
    enable: function () { ACTIVE = false; checkPage(); },
    disable: function () { ACTIVE = false; log('手动停用', '#ffb74d'); },
    get active() { return ACTIVE; },
    get page() { return detectPage(); },

    diag: function () {
      var el = document.activeElement;
      var info = {
        url: location.href,
        page: detectPage(),
        activeTag: el ? el.tagName : null,
        activeClass: el ? String(el.className) : null,
        contentEditable: el ? el.isContentEditable : null,
        cm6: !!document.querySelector('.cm-editor'),
        cm5: !!document.querySelector('.CodeMirror'),
        monaco: !!window.monaco,
      };
      console.log('[PTA][diag]', JSON.stringify(info, null, 2));
      return info;
    },

    // 手动把剪贴板内容写入当前焦点元素（不依赖事件触发）
    paste: function () {
      var el = document.activeElement;
      if (!el || !(el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
        log('当前焦点不可编辑，请先点进输入区', '#ef5350');
        return Promise.resolve('');
      }
      return navigator.clipboard.readText().then(function (text) {
        writeInto(el, text);
        return text;
      }).catch(function (err) {
        log('读取剪贴板失败：' + (err && err.name), '#ef5350');
        return '';
      });
    },
  };
})();
