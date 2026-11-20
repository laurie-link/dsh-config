/**
 * dsh-live-page — injected in-page direct HTML editor (classic script, no modules).
 *
 * The host injects:
 *   <script id="dsh-live-overlay" src="/__live/overlay.js" defer
 *           data-file data-version data-title data-nonce>
 *
 * Responsibilities (see CONTRACT.md):
 *  - fixed top-right Edit badge + refresh + save status (CSS in overlay.css, `dsh-live-` prefix)
 *  - click-to-edit the article blocks (contenteditable), caret near the click
 *  - autosave after 900ms of inactivity via POST /__live/save
 *  - poll GET /__live/version?file= every 2s; on external change reload automatically
 *    unless the page holds unsaved edits
 *  - post the current text selection to the parent window (non-editing state only)
 *  - window.__dshLivePageOverlay debug object
 *
 * The direct-edit core is adapted from the user's standalone visual editor
 * (visual-editor/public/overlay.js); the AI popover, spellcheck and the
 * region/whole-article mode are intentionally left out.
 */
(function () {
  'use strict';

  // -- constants ------------------------------------------------------------

  var SCRIPT_ID = 'dsh-live-overlay';
  var SAVE_URL = '/__live/save';
  var VERSION_URL = '/__live/version';
  var AUTOSAVE_MS = 900;
  var VERSION_POLL_MS = 2000;
  var SELECTION_DEBOUNCE_MS = 400;
  var MIN_SELECTION_CHARS = 2;
  var MAX_QUOTE_CHARS = 8000;
  var MAX_ERRORS = 20;
  var SPLITTABLE_TAGS = { p: 1, li: 1, blockquote: 1 };

  // Inline completion (IDE-style ghost text inside the page).
  var COMPLETE_URL = '/__live/complete';
  var COMPLETE_DEBOUNCE_MS = 650;
  var COMPLETE_MIN_PREFIX = 3;
  var COMPLETE_MAX_TEXT = 180;
  var COMPLETE_CONTEXT_CHARS = 700;

  // Selection rewriting (select text → describe the change → replace in place).
  var REWRITE_URL = '/__live/rewrite';
  var REWRITE_MIN_CHARS = 2;
  var REWRITE_MAX_BLOCKS = 12;
  var REWRITE_TIMEOUT_MS = 28000;
  var REWRITE_UNDO_MS = 20000;
  var REWRITE_TOOLBAR_DEBOUNCE_MS = 140;

  var EDITABLE_SELECTOR = [
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'li',
    'blockquote',
    'figcaption',
    'dt',
    'dd',
    'td',
    'th',
  ].join(', ');

  // Elements that never become an editing host (page chrome / embedded widgets).
  var BLOCKED_SELECTOR = [
    'script',
    'style',
    'noscript',
    'template',
    'textarea',
    'input',
    'select',
    'option',
    'button',
    'iframe',
    'object',
    'embed',
    'video',
    'audio',
    'canvas',
    'svg',
    'math',
    '[data-dsh-live-ui]',
  ].join(', ');

  var SCOPE_SELECTORS = ['.article-content', 'main', 'article', '[role="main"]'];

  // -- host-provided configuration -----------------------------------------

  function readConfig() {
    var script = null;
    try {
      script = document.getElementById(SCRIPT_ID);
      if (!script) script = document.querySelector('script[id="' + SCRIPT_ID + '"]');
    } catch (error) {
      script = null;
    }

    var dataset = (script && script.dataset) || {};
    var file = dataset.file || '';
    var version = dataset.version || '';
    var title = dataset.title || '';
    var nonce = dataset.nonce || '';

    if (!file) file = deriveFileFromLocation();

    return {
      script: script,
      file: file,
      version: version,
      title: title,
      nonce: nonce,
    };
  }

  /** Best-effort fallback when the host omitted data-file (diagnostics only). */
  function deriveFileFromLocation() {
    var path = '/';
    try {
      path = String(window.location.pathname || '/');
      path = decodeURIComponent(path);
    } catch (error) {
      path = '/';
    }
    path = path.replace(/^\/+/, '');
    if (path === '') return 'index.html';
    if (/\/$/.test(path)) return path + 'index.html';
    var last = path.slice(path.lastIndexOf('/') + 1);
    if (last.indexOf('.') === -1) return path + '/index.html';
    return path;
  }

  var config = readConfig();

  var state = {
    enabled: false,
    activeEl: null,
    saveTimer: null,
    selectingTimer: null,
    pollTimer: null,
    hoverEl: null,
    scopeCache: null,
    version: config.version || '',
    versionUnknown: !config.version,
    pollFailures: 0,
    reloading: false,
    saving: false,
    lastSave: null,
    errors: [],
    booted: false,
    // inline completion
    completionTimer: null,
    completionSeq: 0,
    completionController: null,
    suggestion: null,
    completing: false,
    lastRequestKey: '',
    skipNextInputCompletion: false,
    // pointer gesture (click = edit, drag = native cross-block selection)
    pointer: null,
    // selection rewriting
    rewrite: {
      open: false,
      pending: false,
      selection: null,
      result: null,
      status: '',
      error: '',
      applied: null,
      controller: null,
    },
    rewriteTimer: null,
    rewriteUndoTimer: null,
  };

  /** Last known on-disk snapshot per edited element: { outerHTML, matchText }. */
  var baselines = new Map();
  var queue = [];
  var queueRunning = false;
  var idleResolvers = [];

  var hud = null;
  var badgeEl = null;
  var statusEl = null;
  var noticeEl = null;
  var toastEl = null;
  var toastTimer = null;
  var ghostLayer = null;
  var ghostBox = null;
  var ghostEl = null;
  var ghostKeyEl = null;

  var rewriteUi = null;
  var rewriteTrigger = null;
  var rewritePanel = null;
  var rewriteCountEl = null;
  var rewriteInput = null;
  var rewriteStatusEl = null;
  var rewritePreviewEl = null;
  var rewriteRunBtn = null;
  var rewriteApplyBtn = null;
  var rewriteRetryBtn = null;
  var rewriteUndoBtn = null;

  var debug = {
    version: state.version,
    editing: false,
    lastSave: null,
    errors: [],
    completion: null,
  };
  try {
    window.__dshLivePageOverlay = debug;
  } catch (error) {
    // ignore (defensive: exotic sandboxes)
  }

  // -- small helpers -------------------------------------------------------

  function normalizeText(text) {
    return String(text == null ? '' : text)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isElement(node) {
    return !!node && node.nodeType === 1;
  }

  function syncDebug() {
    debug.version = state.version;
    debug.editing = state.enabled;
    debug.lastSave = state.lastSave;
    debug.errors = state.errors;
    debug.completing = state.completing;
    debug.suggestion = state.suggestion ? state.suggestion.text : '';
    debug.rewrite = {
      open: state.rewrite.open,
      pending: state.rewrite.pending,
      blocks: state.rewrite.selection ? state.rewrite.selection.blocks.length : 0,
      result: state.rewrite.result ? state.rewrite.result.blocks.length : 0,
      status: state.rewrite.status,
      error: state.rewrite.error,
    };
  }

  function recordError(error, context) {
    var entry = {
      at: new Date().toISOString(),
      context: context || '',
      message: String((error && error.message) || error || 'unknown error'),
      status: (error && error.status) || 0,
      code: (error && error.code) || '',
    };
    state.errors.push(entry);
    if (state.errors.length > MAX_ERRORS) state.errors.splice(0, state.errors.length - MAX_ERRORS);
    syncDebug();
    return entry;
  }

  function clearNode(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  // -- HUD (badge + refresh + save status) ---------------------------------

  function buildHud() {
    hud = document.createElement('div');
    hud.className = 'dsh-live-hud';
    hud.setAttribute('data-dsh-live-ui', '1');
    if (config.title) hud.setAttribute('title', '直接编辑：' + config.title);

    badgeEl = document.createElement('button');
    badgeEl.type = 'button';
    badgeEl.className = 'dsh-live-badge is-off';
    badgeEl.textContent = 'Edit: Off';
    badgeEl.title = '开启/关闭直接编辑（Ctrl/⌘ + Shift + E）';

    statusEl = document.createElement('span');
    statusEl.className = 'dsh-live-status';
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.textContent = '就绪';

    hud.appendChild(badgeEl);
    hud.appendChild(statusEl);
  }

  function buildNotice() {
    noticeEl = document.createElement('div');
    noticeEl.className = 'dsh-live-notice';
    noticeEl.setAttribute('data-dsh-live-ui', '1');
    noticeEl.hidden = true;

    var text = document.createElement('span');
    text.className = 'dsh-live-notice-text';
    text.textContent = '文件已更新';

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'dsh-live-notice-refresh';
    button.textContent = '刷新页面';

    noticeEl.appendChild(text);
    noticeEl.appendChild(button);
  }

  function buildToast() {
    toastEl = document.createElement('div');
    toastEl.className = 'dsh-live-toast';
    toastEl.setAttribute('data-dsh-live-ui', '1');
    toastEl.setAttribute('role', 'alert');
    toastEl.hidden = true;
  }

  function mountParent() {
    return document.body || document.documentElement || null;
  }

  function mountNode(node) {
    var parent = mountParent();
    if (!parent || !node) return false;
    if (node.parentNode === parent) return true;
    try {
      if (node.parentNode) node.parentNode.removeChild(node);
      parent.appendChild(node);
    } catch (error) {
      recordError(error, 'mount');
      return false;
    }
    return true;
  }

  /** Re-mount the UI when a page script replaced the body/our nodes. */
  function ensureHud() {
    if (!hud) buildHud();
    mountNode(hud);

    if (!noticeEl) buildNotice();
    if (!noticeEl.hidden) mountNode(noticeEl);

    if (!toastEl) buildToast();
    if (!toastEl.hidden) mountNode(toastEl);

    if (!rewriteUi) buildRewriteUi();
    if (rewriteUi && (state.rewrite.open || (rewriteTrigger && !rewriteTrigger.hidden) || (rewriteUndoBtn && !rewriteUndoBtn.hidden))) {
      if (!rewriteUi.isConnected) mountNode(rewriteUi);
    }
    return hud.isConnected;
  }

  function setStatus(text, kind, detail) {
    ensureStatusEl();
    statusEl.textContent = text;
    statusEl.className = 'dsh-live-status' + (kind ? ' is-' + kind : '');
    statusEl.title = detail ? String(detail) : text;
  }

  function ensureStatusEl() {
    if (!statusEl) ensureHud();
    if (!statusEl) {
      statusEl = document.createElement('span');
      statusEl.className = 'dsh-live-status';
    }
  }

  function showToast(message, kind, duration) {
    if (!message) return;
    if (!toastEl) buildToast();
    toastEl.className = 'dsh-live-toast' + (kind ? ' is-' + kind : '');
    toastEl.textContent = String(message);
    toastEl.hidden = false;
    if (!toastEl.isConnected) mountNode(toastEl);

    window.clearTimeout(toastTimer);
    var timeout = typeof duration === 'number' ? duration : kind === 'error' ? 6000 : 3200;
    toastTimer = window.setTimeout(function () {
      if (toastEl) toastEl.hidden = true;
    }, timeout);
  }

  function hideToast() {
    window.clearTimeout(toastTimer);
    if (toastEl) toastEl.hidden = true;
  }

  function showUpdatedNotice() {
    if (!noticeEl) buildNotice();
    noticeEl.hidden = false;
    if (!noticeEl.isConnected) mountNode(noticeEl);
    setStatus('文件已更新', 'warn', '磁盘上的文件被外部修改，刷新页面以查看最新内容');
  }

  function hideUpdatedNotice() {
    if (noticeEl) noticeEl.hidden = true;
  }

  // -- edit scope / block discovery ---------------------------------------

  function getEditScope() {
    var now = Date.now();
    if (state.scopeCache && now - state.scopeCache.at < 1000 && state.scopeCache.el && state.scopeCache.el.isConnected) {
      return state.scopeCache.el;
    }

    var scope = null;
    for (var i = 0; i < SCOPE_SELECTORS.length; i += 1) {
      var found = null;
      try {
        found = document.querySelector(SCOPE_SELECTORS[i]);
      } catch (error) {
        found = null;
      }
      if (found) {
        scope = found;
        break;
      }
    }
    if (!scope) scope = document.body || document.documentElement || null;
    state.scopeCache = { el: scope, at: now };
    return scope;
  }

  function isTrackedBlock(el) {
    return !!el && (el === state.activeEl || baselines.has(el));
  }

  function editableAllowed(el) {
    if (!isElement(el) || !el.isConnected) return false;
    if (isTrackedBlock(el)) return true;
    if (el.isContentEditable) return false; // a page editor we do not own
    var scope = getEditScope();
    if (!scope || !scope.contains(el)) return false;
    return true;
  }

  function findEditableTarget(target) {
    if (!target) return null;
    var node = target;
    if (!isElement(node)) node = node.parentElement || null;
    if (!node || typeof node.closest !== 'function') return null;
    if (node.closest(BLOCKED_SELECTOR)) return null;
    var el = node.closest(EDITABLE_SELECTOR);
    if (!el) return null;
    if (!editableAllowed(el)) return null;
    return el;
  }

  function isUiTarget(target) {
    if (!target) return false;
    var node = isElement(target) ? target : target.parentElement;
    if (!node || typeof node.closest !== 'function') return false;
    return !!node.closest('[data-dsh-live-ui]');
  }

  function findAdjacentEditable(el, direction) {
    if (!el) return null;
    var node = direction === 'prev' ? el.previousElementSibling : el.nextElementSibling;
    while (node) {
      if (findEditableTarget(node) === node) return node;
      node = direction === 'prev' ? node.previousElementSibling : node.nextElementSibling;
    }
    return null;
  }

  // -- editing surface -----------------------------------------------------

  function applyEditingSurface(el) {
    if (!el) return;
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('spellcheck', 'false');
    el.setAttribute('autocorrect', 'off');
    el.classList.add('dsh-live-editing');
  }

  function clearEditingSurface(el) {
    if (!el) return;
    if (el.getAttribute('contenteditable') === 'true') el.removeAttribute('contenteditable');
    el.removeAttribute('spellcheck');
    el.removeAttribute('autocorrect');
    el.classList.remove('dsh-live-editing', 'dsh-live-hover');
    if (!el.classList.length) el.removeAttribute('class');
  }

  function clearHover() {
    if (state.hoverEl) {
      state.hoverEl.classList.remove('dsh-live-hover');
      state.hoverEl = null;
    }
  }

  // -- sanitizing / snapshots ---------------------------------------------

  function stripRuntimeAttrs(node) {
    node.removeAttribute('contenteditable');
    node.removeAttribute('spellcheck');
    node.removeAttribute('autocorrect');

    var attributes = Array.prototype.slice.call(node.attributes || []);
    for (var i = 0; i < attributes.length; i += 1) {
      var name = attributes[i] && attributes[i].name ? attributes[i].name : '';
      if (!name) continue;
      if (name.indexOf('data-dsh-live-') === 0 || name.indexOf('on') === 0) {
        node.removeAttribute(name);
      }
    }

    var href = node.getAttribute && node.getAttribute('href');
    if (href && /^\s*javascript:/i.test(href)) node.setAttribute('href', '#');
    var src = node.getAttribute && node.getAttribute('src');
    if (src && /^\s*javascript:/i.test(src)) node.removeAttribute('src');

    if (node.classList && node.classList.length) {
      var kept = [];
      for (var j = 0; j < node.classList.length; j += 1) {
        var token = node.classList[j];
        if (token && token.indexOf('dsh-live-') !== 0) kept.push(token);
      }
      if (kept.length) node.setAttribute('class', kept.join(' '));
      else node.removeAttribute('class');
    } else if (node.hasAttribute && node.hasAttribute('class')) {
      node.removeAttribute('class');
    }
  }

  /** Serialize one block without any overlay runtime state. */
  function sanitizeElement(el) {
    if (!el) return '';
    var clone = el.cloneNode(true);
    var nodes = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll('*')));
    for (var i = 0; i < nodes.length; i += 1) stripRuntimeAttrs(nodes[i]);
    return clone.outerHTML;
  }

  function snapshotOf(el) {
    return {
      outerHTML: sanitizeElement(el),
      matchText: normalizeText(el ? el.textContent : ''),
    };
  }

  function hasMediaEl(el) {
    if (!el || !el.querySelector) return false;
    return !!el.querySelector('img, picture, video, audio, iframe, svg, canvas, object, embed, hr');
  }

  /** True when the block no longer has visible content (br/&nbsp;/whitespace excluded). */
  function isNodeVisuallyEmpty(el) {
    if (!el) return true;
    if (hasMediaEl(el)) return false;
    var text = String(el.textContent || '').replace(/\u200b/g, '');
    if (normalizeText(text) !== '') return false;
    var stripped = String(el.innerHTML || '')
      .replace(/<br\s*\/?>/gi, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\u00a0/g, ' ')
      .replace(/\u200b/g, '')
      .replace(/\s+/g, '');
    return stripped === '';
  }

  function isHtmlEmpty(html) {
    if (!html) return true;
    var box = document.createElement('div');
    box.innerHTML = html;
    var el = box.firstElementChild;
    return el ? isNodeVisuallyEmpty(el) : normalizeText(box.textContent) === '';
  }

  function isParagraph(el) {
    return !!el && String(el.tagName || '').toLowerCase() === 'p';
  }

  // -- payload helpers ----------------------------------------------------

  function selectorPath(el) {
    var parts = [];
    var current = el;
    while (current && current !== document.body && current !== document.documentElement && parts.length < 8) {
      var part = String(current.tagName || '').toLowerCase();
      if (current.id) {
        part += '#' + current.id;
        parts.unshift(part);
        break;
      }
      var parent = current.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (child) {
          return child.tagName === current.tagName;
        });
        if (siblings.length > 1) {
          part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ');
  }

  function nearestAnchor(el) {
    var current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      if (current.id) return '#' + current.id;
      current = current.parentElement;
    }

    current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      var sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.id && /^H[1-4]$/.test(String(sibling.tagName || '').toUpperCase())) {
          return '#' + sibling.id;
        }
        sibling = sibling.previousElementSibling;
      }
      current = current.parentElement;
    }
    return '';
  }

  function buildPayload(el, baseline, newOuterHTML) {
    var text = (baseline && baseline.matchText) || normalizeText(el ? el.textContent : '');
    return {
      file: config.file,
      tag: String((el && el.tagName) || 'p').toLowerCase(),
      text: text,
      outerHTML: (baseline && baseline.outerHTML) || '',
      newOuterHTML: typeof newOuterHTML === 'string' ? newOuterHTML : '',
      selectorPath: selectorPath(el),
      anchor: nearestAnchor(el),
    };
  }

  function postJson(url, payload) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    }).then(function (response) {
      return response
        .json()
        .catch(function () {
          return null;
        })
        .then(function (data) {
          if (response.ok && data && data.ok === true) return data;
          var error = new Error((data && data.error) || '保存失败（HTTP ' + response.status + '）');
          error.status = response.status;
          error.code = (data && data.code) || '';
          throw error;
        });
    });
  }

  function afterSaveSuccess(data) {
    var method = (data && data.method) || '';
    state.lastSave = {
      at: new Date().toISOString(),
      ok: true,
      method: method,
      version: (data && data.version) || '',
      changed: !(data && data.changed === false),
      backup: (data && data.backup) || '',
    };
    if (data && data.version) {
      state.version = String(data.version);
      state.versionUnknown = false;
    } else {
      state.versionUnknown = true;
    }
    state.pollFailures = 0;
    syncDebug();
  }

  function afterSaveFailure(error) {
    var entry = recordError(error, 'save');
    state.lastSave = {
      at: entry.at,
      ok: false,
      error: entry.message,
      status: entry.status,
      code: entry.code,
    };
    syncDebug();
    setStatus('保存失败', 'error', entry.message);
    showToast(entry.message, 'error', 7000);
  }

  // -- save queue (serialized, per-element baseline resolved at run time) --

  function isQueueBusy() {
    return queueRunning || queue.length > 0;
  }

  function resolveIdle() {
    if (isQueueBusy()) return;
    var waiters = idleResolvers.splice(0, idleResolvers.length);
    for (var i = 0; i < waiters.length; i += 1) {
      try {
        waiters[i]();
      } catch (error) {
        recordError(error, 'idle');
      }
    }
  }

  function whenSavesIdle() {
    return new Promise(function (resolve) {
      if (!isQueueBusy()) {
        resolve();
        return;
      }
      idleResolvers.push(resolve);
    });
  }

  function dropQueuedSaves(el) {
    for (var i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i].el === el && queue[i].kind === 'save') queue.splice(i, 1);
    }
  }

  function pushTask(task) {
    if (task.kind !== 'replace') dropQueuedSaves(task.el);
    queue.push(task);
    pumpQueue();
  }

  function enqueueSave(el, options) {
    if (!el || !el.isConnected) return;
    if (!baselines.has(el)) baselines.set(el, snapshotOf(el));
    for (var i = 0; i < queue.length; i += 1) {
      if (queue[i].kind === 'save' && queue[i].el === el) {
        queue[i].options = options || queue[i].options || {};
        return;
      }
    }
    queue.push({ kind: 'save', el: el, options: options || {} });
    pumpQueue();
  }

  function pumpQueue() {
    if (queueRunning) return;
    if (queue.length === 0) {
      state.saving = false;
      resolveIdle();
      return;
    }
    queueRunning = true;
    state.saving = true;
    var task = queue.shift();
    syncDebug();
    Promise.resolve()
      .then(function () {
        return executeTask(task);
      })
      .catch(function (error) {
        recordError(error, 'task');
        showToast(String((error && error.message) || error), 'error', 7000);
      })
      .then(function () {
        queueRunning = false;
        state.saving = false;
        pumpQueue();
      });
  }

  function executeTask(task) {
    if (!task || !task.el) return Promise.resolve(false);
    if (task.kind === 'replace') return runReplace(task);

    var el = task.el;
    if (!el.isConnected) return Promise.resolve(false);
    var baseline = baselines.get(el);
    if (!baseline) {
      baseline = snapshotOf(el);
      baselines.set(el, baseline);
    }

    var cleanHtml = sanitizeElement(el);
    var nowText = normalizeText(el.textContent);
    if (cleanHtml === baseline.outerHTML && !(task.options && task.options.force)) {
      if (!(task.options && task.options.silent)) setStatus('已保存', 'ok');
      return Promise.resolve(false);
    }

    var deleting =
      task.kind === 'delete' ||
      (!(task.options && task.options.keepEmpty) &&
        isParagraph(el) &&
        isNodeVisuallyEmpty(el) &&
        !!baseline.outerHTML &&
        !isHtmlEmpty(baseline.outerHTML));
    if (deleting) return runDelete(el, baseline, task.options || {});
    return runSave(el, baseline, cleanHtml, nowText, task.options || {});
  }

  function runSave(el, baseline, cleanHtml, nowText, options) {
    var payload = buildPayload(el, baseline, cleanHtml);
    setStatus('正在保存…', 'busy');
    return postJson(SAVE_URL, payload).then(
      function (data) {
        baselines.set(el, { outerHTML: cleanHtml, matchText: nowText });
        afterSaveSuccess(data);
        if (!options.silent) setStatus('已保存', 'ok');
        return true;
      },
      function (error) {
        afterSaveFailure(error);
        return false;
      },
    );
  }

  function runDelete(el, baseline, options) {
    var parent = el.parentNode;
    if (!parent) return Promise.resolve(false);

    var payload = buildPayload(el, baseline, '');
    var nextSibling = el.nextSibling;
    var wasActive = state.activeEl === el;
    var focusTarget = wasActive ? findAdjacentEditable(el, 'next') || findAdjacentEditable(el, 'prev') : null;

    clearEditingSurface(el);
    parent.removeChild(el);
    baselines.delete(el);
    if (wasActive) {
      state.activeEl = null;
      syncDebug();
    }
    if (!options.silent) setStatus('正在删除…', 'busy');

    return postJson(SAVE_URL, payload).then(
      function (data) {
        afterSaveSuccess(data);
        setStatus('已删除', 'ok');
        if (wasActive && focusTarget && focusTarget.isConnected) {
          activateBlock(focusTarget, { caretOffset: 0 });
        }
        return true;
      },
      function (error) {
        if (parent.isConnected !== false) parent.insertBefore(el, nextSibling);
        baselines.set(el, baseline);
        afterSaveFailure(error);
        if (wasActive) activateBlock(el, { caretOffset: normalizeText(el.textContent).length });
        return false;
      },
    );
  }

  function runReplace(task) {
    var el = task.el;
    if (!el || !el.isConnected) {
      if (task.revert) safeCall(task.revert);
      return Promise.resolve(false);
    }
    var baseline = baselines.get(el) || task.baseline || snapshotOf(el);
    var requestKey = String(el.tagName || '') + '\u0000split\u0000' + String(task.html || '').slice(-300);
    if (requestKey === state.lastRequestKey) return Promise.resolve(false);
    state.lastRequestKey = requestKey;
    var payload = {
      file: config.file,
      tag: task.tag || 'p',
      text: (baseline && baseline.matchText) || '',
      outerHTML: (baseline && baseline.outerHTML) || '',
      newOuterHTML: task.html,
      selectorPath: task.selectorPath || '',
      anchor: task.anchor || '',
    };
    setStatus('正在保存…', 'busy');
    return postJson(SAVE_URL, payload).then(
      function (data) {
        baselines.set(el, task.primary || baseline);
        var updates = task.updates || [];
        for (var i = 0; i < updates.length; i += 1) {
          var entry = updates[i];
          if (entry && entry.el && entry.el.isConnected) baselines.set(entry.el, entry.snapshot);
        }
        afterSaveSuccess(data);
        setStatus('已保存', 'ok');
        return true;
      },
      function (error) {
        if (task.revert) safeCall(task.revert);
        afterSaveFailure(error);
        return false;
      },
    );
  }

  function safeCall(fn) {
    try {
      fn();
    } catch (error) {
      recordError(error, 'revert');
    }
  }

  // -- autosave scheduling ------------------------------------------------

  function scheduleSave() {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(function () {
      var el = state.activeEl;
      if (el && el.isConnected) enqueueSave(el, { silent: false });
    }, AUTOSAVE_MS);
  }

  function onBlockInput(el) {
    if (!el) return;
    setStatus('未保存…', 'dirty');
    clearSuggestion();
    scheduleSave();
    // Accepting a suggestion must not immediately ask for the next one; the
    // next real keystroke re-arms completion.
    if (state.skipNextInputCompletion) {
      state.skipNextInputCompletion = false;
      return;
    }
    scheduleCompletion();
  }

  // -- caret helpers ------------------------------------------------------

  function caretRangeFromPoint(x, y) {
    try {
      if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
      if (document.caretPositionFromPoint) {
        var position = document.caretPositionFromPoint(x, y);
        if (!position) return null;
        var range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
        range.collapse(true);
        return range;
      }
    } catch (error) {
      // ignore
    }
    return null;
  }

  function placeSelectionRange(range) {
    if (!range) return;
    var selection = window.getSelection();
    if (!selection) return;
    try {
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (error) {
      recordError(error, 'caret');
    }
  }

  /** Put a collapsed caret at the given text offset inside `el`. */
  function placeCaretInText(el, offset) {
    if (!el) return;
    var selection = window.getSelection();
    if (!selection) return;
    var remaining = Math.max(0, Number(offset) || 0);
    var walker = document.createTreeWalker(
      el,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node) {
          if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      },
      false,
    );
    var node = walker.nextNode();
    while (node) {
      var length = node.nodeValue.length;
      if (remaining <= length) {
        var range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        placeSelectionRange(range);
        return;
      }
      remaining -= length;
      node = walker.nextNode();
    }
    var fallback = document.createRange();
    fallback.selectNodeContents(el);
    fallback.collapse(false);
    placeSelectionRange(fallback);
  }

  function caretFromSelection() {
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    return selection.getRangeAt(0);
  }

  // -- inline completion (IDE-style ghost text) ---------------------------

  /** Ensure the fixed ghost layer exists (suggestion text + inline Tab hint). */
  function ensureGhostLayer() {
    if (ghostLayer && ghostLayer.isConnected) return ghostLayer;
    try {
      var layer = document.createElement('div');
      layer.className = 'dsh-live-ghost-layer';
      layer.setAttribute('aria-hidden', 'true');
      var box = document.createElement('span');
      box.className = 'dsh-live-ghost';
      var text = document.createElement('span');
      text.className = 'dsh-live-ghost-text';
      var key = document.createElement('span');
      key.className = 'dsh-live-ghost-key';
      key.textContent = 'Tab';
      box.appendChild(text);
      box.appendChild(key);
      layer.appendChild(box);
      (document.body || document.documentElement).appendChild(layer);
      ghostLayer = layer;
      ghostBox = box;
      ghostEl = text;
      ghostKeyEl = key;
    } catch (error) {
      recordError(error, 'ghost');
      return null;
    }
    return ghostLayer;
  }

  /** Remove the visible suggestion (keeps the pending/active request state). */
  function hideGhost() {
    if (ghostLayer) {
      try { ghostLayer.style.display = 'none'; } catch (error) { /* ignore */ }
    }
  }

  /** Drop the suggestion and cancel any in-flight completion request. */
  function clearSuggestion(options) {
    options = options || {};
    state.suggestion = null;
    hideGhost();
    if (!options.keepRequest) {
      window.clearTimeout(state.completionTimer);
      state.completionTimer = null;
      if (state.completionController) {
        try { state.completionController.abort(); } catch (error) { /* ignore */ }
        state.completionController = null;
      }
      state.completing = false;
    }
    syncDebug();
  }

  /** Text before/after the caret plus the live range, or null when unusable. */
  function caretInfo(el) {
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed === false) return null;
    var range = selection.getRangeAt(0);
    if (!range.startContainer || !el || !el.contains(range.startContainer)) return null;
    var prefixRange = document.createRange();
    prefixRange.selectNodeContents(el);
    try {
      prefixRange.setEnd(range.startContainer, range.startOffset);
    } catch (error) {
      return null;
    }
    var suffixRange = document.createRange();
    suffixRange.selectNodeContents(el);
    try {
      suffixRange.setStart(range.startContainer, range.startOffset);
    } catch (error) {
      return null;
    }
    return {
      range: range.cloneRange(),
      prefix: String(prefixRange.toString() || ''),
      suffix: String(suffixRange.toString() || ''),
    };
  }

  /** Text of the block right before the edited one (short writing context). */
  function contextBefore(el) {
    if (!el) return '';
    var previous = el.previousElementSibling;
    var parts = [];
    var budget = COMPLETE_CONTEXT_CHARS;
    while (previous && parts.length < 3 && budget > 0) {
      var text = normalizeText(previous.textContent || '');
      if (text !== '') {
        parts.unshift(text.slice(-budget));
        budget -= text.length;
      }
      previous = previous.previousElementSibling;
    }
    return parts.join('\n').slice(-COMPLETE_CONTEXT_CHARS);
  }

  /** Viewport rect of the caret (falls back to the block's rect). */
  function caretRect(info, el) {
    try {
      var probe = info.range.cloneRange();
      probe.collapse(true);
      var rects = probe.getClientRects();
      var rect = rects && rects.length ? rects[rects.length - 1] : probe.getBoundingClientRect();
      if (rect && (rect.width > 0 || rect.height > 0)) return rect;
    } catch (error) {
      // fall through
    }
    try {
      return el.getBoundingClientRect();
    } catch (error) {
      return null;
    }
  }

  /** First opaque background color at or above `el` (for the halo behind ghost text). */
  function effectiveBackground(el) {
    var node = el;
    var guard = 0;
    while (node && node !== document.documentElement && guard < 12) {
      guard += 1;
      try {
        var color = window.getComputedStyle(node).backgroundColor;
        if (color && color !== 'transparent' && !/rgba\([^)]*,\s*0(?:\.\d+)?\)/.test(color)) return color;
      } catch (error) {
        // fall through
      }
      node = node.parentElement;
    }
    return '';
  }

  /** Paint the suggestion at the caret without touching the page DOM. */
  function paintSuggestion(suggestion) {
    var layer = ensureGhostLayer();
    if (!layer || !suggestion) return;
    var el = suggestion.el;
    if (!el || !el.isConnected) {
      clearSuggestion();
      return;
    }
    var rect = caretRect({ range: suggestion.range }, el);
    if (!rect) {
      hideGhost();
      return;
    }
    var style = null;
    try {
      style = window.getComputedStyle(el);
    } catch (error) {
      style = null;
    }
    var blockRect = null;
    try {
      blockRect = el.getBoundingClientRect();
    } catch (error) {
      blockRect = null;
    }
    var left = Math.max(0, rect.left);
    var available = blockRect ? Math.max(160, blockRect.right - left - 6) : 360;
    var width = Math.min(Math.max(160, available), 560);
    if (ghostEl) ghostEl.textContent = suggestion.text;
    if (ghostBox) {
      ghostBox.style.font = 'inherit';
      if (style) {
        ghostBox.style.fontFamily = style.fontFamily;
        ghostBox.style.fontSize = style.fontSize;
        ghostBox.style.fontWeight = style.fontWeight;
        ghostBox.style.fontStyle = style.fontStyle;
        ghostBox.style.lineHeight = style.lineHeight;
        ghostBox.style.letterSpacing = style.letterSpacing;
        ghostBox.style.color = style.color;
        ghostBox.style.textTransform = style.textTransform;
      }
      var halo = effectiveBackground(el);
      if (halo) {
        ghostBox.style.textShadow = '0 0 3px ' + halo + ', 0 0 2px ' + halo;
      } else {
        ghostBox.style.textShadow = 'none';
      }
      ghostBox.style.top = Math.round(Math.max(0, rect.top)) + 'px';
      ghostBox.style.left = Math.round(left + 1) + 'px';
      ghostBox.style.maxWidth = Math.round(width) + 'px';
    }
    layer.style.display = 'block';
  }

  /** Ask the host for one continuation of the active block. */
  function requestCompletion(seq) {
    var el = state.activeEl;
    if (!el || !state.enabled) return;
    var info = caretInfo(el);
    if (!info) return;
    if (info.suffix.trim() !== '') return; // only continue at the visible end of the text
    if (info.prefix.replace(/\s+/g, ' ').trim().length < COMPLETE_MIN_PREFIX) return;
    var requestKey = String(el.tagName || '') + '\u0000' + info.prefix.slice(-200) + '\u0000' + contextBefore(el).slice(-120);
    if (requestKey === state.lastRequestKey) return;
    state.lastRequestKey = requestKey;
    var payload = {
      file: config.file,
      title: config.title || document.title || '',
      tag: String(el.tagName || 'p').toLowerCase(),
      before: contextBefore(el),
      prefix: info.prefix,
      suffix: info.suffix,
    };
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    state.completionController = controller;
    state.completing = true;
    var startedAt = Date.now();
    fetch(COMPLETE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
      ...(controller ? { signal: controller.signal } : {}),
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () { return null; })
          .then(function (data) {
            if (!response.ok || !data || data.ok !== true) {
              var failure = new Error((data && data.error) || '补全失败（HTTP ' + response.status + '）');
              failure.status = response.status;
              throw failure;
            }
            return data;
          });
      })
      .then(function (data) {
        state.completing = false;
        state.completionController = null;
        if (seq !== state.completionSeq) return;
        var text = typeof data.text === 'string' ? data.text : '';
        text = text.replace(/[\r\n]+/g, ' ').slice(0, COMPLETE_MAX_TEXT);
        debug.completion = {
          at: new Date().toISOString(),
          ms: Date.now() - startedAt,
          route: data.route || '',
          note: data.note || '',
          text: text,
        };
        syncDebug();
        if (text === '' || !state.activeEl || state.activeEl !== el) return;
        var live = caretInfo(el);
        if (!live || live.suffix.trim() !== '') return;
        state.suggestion = { el: el, range: live.range, text: text };
        paintSuggestion(state.suggestion);
        syncDebug();
      })
      .catch(function (error) {
        state.completing = false;
        state.completionController = null;
        if (seq !== state.completionSeq) return;
        if (error && error.name === 'AbortError') return;
        debug.completion = { at: new Date().toISOString(), ms: Date.now() - startedAt, note: String((error && error.message) || error), text: '' };
        syncDebug();
      });
  }

  /** Debounced completion trigger (typing pause). */
  function scheduleCompletion() {
    window.clearTimeout(state.completionTimer);
    state.completionTimer = null;
    if (!state.enabled) return;
    state.completionTimer = window.setTimeout(function () {
      state.completionTimer = null;
      state.completionSeq += 1;
      requestCompletion(state.completionSeq);
    }, COMPLETE_DEBOUNCE_MS);
  }

  /** Insert the suggestion at the stored caret through the browser's own edit path. */
  function acceptSuggestion() {
    var suggestion = state.suggestion;
    if (!suggestion) return false;
    var el = suggestion.el;
    if (!el || !el.isConnected) {
      clearSuggestion();
      return false;
    }
    var live = caretInfo(el);
    if (!live) {
      clearSuggestion();
      return false;
    }
    var sameCaret = false;
    try {
      sameCaret = live.range.startContainer === suggestion.range.startContainer
        && live.range.startOffset === suggestion.range.startOffset;
    } catch (error) {
      sameCaret = false;
    }
    if (!sameCaret) {
      clearSuggestion();
      return false;
    }
    var text = suggestion.text;
    // The suggestion is a continuation of the prefix. If the model returns a
    // bare English word and the user's last character was also a word
    // character, join them with one space instead of gluing "Moredetails".
    var beforeChar = String(live.prefix || '').slice(-1);
    if (/[A-Za-z0-9]$/.test(beforeChar) && /^[A-Za-z0-9(]/.test(text)) text = ' ' + text;
    state.skipNextInputCompletion = true;
    clearSuggestion();
    placeSelectionRange(live.range);
    var inserted = false;
    try {
      inserted = document.execCommand && document.execCommand('insertText', false, text);
    } catch (error) {
      inserted = false;
    }
    if (!inserted) {
      try {
        var range = caretFromSelection();
        if (!range) return false;
        range.deleteContents();
        var node = document.createTextNode(text);
        range.insertNode(node);
        var after = document.createRange();
        after.setStart(node, node.nodeValue.length);
        after.collapse(true);
        placeSelectionRange(after);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (error) {
        recordError(error, 'complete-insert');
        return false;
      }
    }
    return true;
  }

  // -- selection rewriting (select text → instruction → replace in place) --

  function makeRewriteButton(className, label, title) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    if (title) button.title = title;
    return button;
  }

  function buildRewriteUi() {
    if (rewriteUi) return;
    rewriteUi = document.createElement('div');
    rewriteUi.className = 'dsh-live-rewrite-layer';
    rewriteUi.setAttribute('data-dsh-live-ui', '1');

    rewriteTrigger = makeRewriteButton('dsh-live-rewrite-trigger', 'AI 改写', '选中文字后按指令改写（保持其余内容不变）');
    rewriteTrigger.hidden = true;
    rewriteTrigger.addEventListener('mousedown', function (event) {
      event.preventDefault();
    });
    rewriteTrigger.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      openRewritePanel();
    });
    rewriteUi.appendChild(rewriteTrigger);

    rewriteUndoBtn = makeRewriteButton('dsh-live-rewrite-undo', '撤销替换', '恢复应用改写前的内容');
    rewriteUndoBtn.hidden = true;
    rewriteUndoBtn.addEventListener('mousedown', function (event) {
      event.preventDefault();
    });
    rewriteUndoBtn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      undoRewrite();
    });
    rewriteUi.appendChild(rewriteUndoBtn);

    rewritePanel = document.createElement('div');
    rewritePanel.className = 'dsh-live-rewrite-panel';
    rewritePanel.hidden = true;
    // Keep the page selection alive when a panel control is pressed.
    rewritePanel.addEventListener('mousedown', function (event) {
      if (event.target === rewriteInput) return;
      event.preventDefault();
    });

    var head = document.createElement('div');
    head.className = 'dsh-live-rewrite-head';
    var heading = document.createElement('span');
    heading.className = 'dsh-live-rewrite-heading';
    heading.textContent = 'AI 改写选区';
    var close = makeRewriteButton('dsh-live-rewrite-close', '×', '关闭');
    close.addEventListener('click', function (event) {
      event.preventDefault();
      closeRewritePanel();
    });
    head.appendChild(heading);
    head.appendChild(close);
    rewritePanel.appendChild(head);

    rewriteCountEl = document.createElement('div');
    rewriteCountEl.className = 'dsh-live-rewrite-meta';
    rewritePanel.appendChild(rewriteCountEl);

    rewriteInput = document.createElement('textarea');
    rewriteInput.className = 'dsh-live-rewrite-input';
    rewriteInput.rows = 2;
    rewriteInput.placeholder = '要改成什么？例如：更简洁、改成英文、语气更口语';
    rewriteInput.addEventListener('keydown', function (event) {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        runRewrite();
        return;
      }
      if (event.key === 'Escape' || event.key === 'Esc') {
        event.preventDefault();
        event.stopPropagation();
        closeRewritePanel();
      }
    });
    rewritePanel.appendChild(rewriteInput);

    var actions = document.createElement('div');
    actions.className = 'dsh-live-rewrite-actions';
    rewriteRunBtn = makeRewriteButton('dsh-live-rewrite-run', '改写', '用选中文字生成替换内容（⌘/Ctrl + Enter）');
    rewriteRunBtn.addEventListener('click', function (event) {
      event.preventDefault();
      runRewrite();
    });
    var cancel = makeRewriteButton('dsh-live-rewrite-cancel', '取消');
    cancel.addEventListener('click', function (event) {
      event.preventDefault();
      closeRewritePanel();
    });
    actions.appendChild(rewriteRunBtn);
    actions.appendChild(cancel);
    rewritePanel.appendChild(actions);

    rewriteStatusEl = document.createElement('div');
    rewriteStatusEl.className = 'dsh-live-rewrite-status';
    rewriteStatusEl.setAttribute('role', 'status');
    rewriteStatusEl.setAttribute('aria-live', 'polite');
    rewritePanel.appendChild(rewriteStatusEl);

    rewritePreviewEl = document.createElement('div');
    rewritePreviewEl.className = 'dsh-live-rewrite-preview';
    rewritePreviewEl.hidden = true;
    rewritePanel.appendChild(rewritePreviewEl);

    var previewActions = document.createElement('div');
    previewActions.className = 'dsh-live-rewrite-actions dsh-live-rewrite-preview-actions';
    previewActions.hidden = true;
    rewriteApplyBtn = makeRewriteButton('dsh-live-rewrite-apply', '应用替换', '写回页面并保存');
    rewriteApplyBtn.addEventListener('click', function (event) {
      event.preventDefault();
      applyRewrite();
    });
    rewriteRetryBtn = makeRewriteButton('dsh-live-rewrite-retry', '改指令重试');
    rewriteRetryBtn.addEventListener('click', function (event) {
      event.preventDefault();
      clearRewritePreview();
      setRewriteStatus('可以修改指令后重试', '');
      try {
        rewriteInput.focus({ preventScroll: true });
      } catch (error) {
        rewriteInput.focus();
      }
    });
    var dismiss = makeRewriteButton('dsh-live-rewrite-dismiss', '取消');
    dismiss.addEventListener('click', function (event) {
      event.preventDefault();
      closeRewritePanel();
    });
    previewActions.appendChild(rewriteApplyBtn);
    previewActions.appendChild(rewriteRetryBtn);
    previewActions.appendChild(dismiss);
    rewritePanel.appendChild(previewActions);
    rewritePreviewEl._actions = previewActions;

    rewriteUi.appendChild(rewritePanel);
  }

  function mountRewriteUi() {
    if (!rewriteUi) buildRewriteUi();
    if (!rewriteUi) return false;
    if (!rewriteUi.isConnected) mountNode(rewriteUi);
    return rewriteUi.isConnected;
  }

  function hideRewriteTrigger() {
    if (rewriteTrigger) rewriteTrigger.hidden = true;
  }

  function hideRewriteUndo() {
    window.clearTimeout(state.rewriteUndoTimer);
    state.rewriteUndoTimer = null;
    if (rewriteUndoBtn) rewriteUndoBtn.hidden = true;
  }

  function positionRewriteTrigger() {
    if (!rewriteTrigger || rewriteTrigger.hidden) return;
    var selection = state.rewrite.selection;
    if (!selection || !selection.rect) return;
    var rect = selection.rect;
    var width = rewriteTrigger.offsetWidth || 86;
    var height = rewriteTrigger.offsetHeight || 32;
    var top = rect.top - height - 8;
    if (top < 8) top = rect.bottom + 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - height - 8);
    var left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    rewriteTrigger.style.top = Math.round(top) + 'px';
    rewriteTrigger.style.left = Math.round(left) + 'px';
  }

  function positionRewritePanel() {
    if (!rewritePanel || rewritePanel.hidden) return;
    var selection = state.rewrite.selection;
    var rect = (selection && selection.rect) || {
      top: 80,
      bottom: 104,
      left: window.innerWidth / 2,
      width: 0,
    };
    var width = Math.min(400, Math.max(280, window.innerWidth - 24));
    var left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    var panelHeight = rewritePanel.offsetHeight || 240;
    var top = rect.bottom + 10;
    if (top + panelHeight > window.innerHeight - 12) {
      top = Math.max(12, rect.top - panelHeight - 10);
    }
    if (top < 12) top = 12;
    rewritePanel.style.width = Math.round(width) + 'px';
    rewritePanel.style.left = Math.round(left) + 'px';
    rewritePanel.style.top = Math.round(top) + 'px';
    rewritePanel.style.maxHeight = Math.max(200, window.innerHeight - top - 12) + 'px';
  }

  function setRewriteStatus(text, kind) {
    state.rewrite.status = String(text || '');
    if (!rewriteStatusEl) return;
    rewriteStatusEl.textContent = state.rewrite.status;
    rewriteStatusEl.className = 'dsh-live-rewrite-status' + (kind ? ' is-' + kind : '');
  }

  function setRewriteBusy(busy) {
    state.rewrite.pending = !!busy;
    if (rewriteInput) rewriteInput.disabled = !!busy;
    if (rewriteRunBtn) rewriteRunBtn.disabled = !!busy;
    if (rewriteApplyBtn) rewriteApplyBtn.disabled = !!busy;
    if (rewriteRetryBtn) rewriteRetryBtn.disabled = !!busy;
    syncDebug();
  }

  function clearRewritePreview() {
    state.rewrite.result = null;
    if (rewritePreviewEl) {
      rewritePreviewEl.hidden = true;
      rewritePreviewEl.innerHTML = '';
      if (rewritePreviewEl._actions) rewritePreviewEl._actions.hidden = true;
    }
    if (rewriteRunBtn) rewriteRunBtn.hidden = false;
    state.rewrite.status = '';
  }

  function offsetInBlock(el, node, offset) {
    try {
      var probe = document.createRange();
      probe.selectNodeContents(el);
      probe.setEnd(node, offset);
      return probe.toString().length;
    } catch (error) {
      return -1;
    }
  }

  /** Text before/after the block, used as light context for the model. */
  function contextAfter(el) {
    var next = el ? el.nextElementSibling : null;
    var parts = [];
    var budget = 600;
    while (next && parts.length < 2 && budget > 0) {
      var text = normalizeText(next.textContent || '');
      if (text !== '') {
        parts.push(text.slice(0, budget));
        budget -= text.length;
      }
      next = next.nextElementSibling;
    }
    return parts.join('\n').slice(0, 600);
  }

  function clipBlock(el, range) {
    var text = String(el.textContent || '');
    if (text === '') return null;
    var clipped = document.createRange();
    try {
      if (el.contains(range.startContainer)) clipped.setStart(range.startContainer, range.startOffset);
      else clipped.setStart(el, 0);
      if (el.contains(range.endContainer)) clipped.setEnd(range.endContainer, range.endOffset);
      else clipped.setEnd(el, el.childNodes.length);
    } catch (error) {
      return null;
    }
    var selected = clipped.toString();
    if (normalizeText(selected) === '') return null;
    var start = el.contains(range.startContainer)
      ? offsetInBlock(el, range.startContainer, range.startOffset)
      : 0;
    var end = el.contains(range.endContainer)
      ? offsetInBlock(el, range.endContainer, range.endOffset)
      : text.length;
    if (start < 0 || end < 0 || start >= end) return null;
    return {
      el: el,
      text: text,
      start: start,
      end: end,
      tag: String(el.tagName || 'p').toLowerCase(),
      range: clipped,
    };
  }

  /** Describe the current native selection as editable blocks + offsets. */
  function selectionSnapshot() {
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    var range = selection.getRangeAt(0);
    if (isUiTarget(range.startContainer) || isUiTarget(range.endContainer)) return null;
    var scope = getEditScope();
    if (!scope) return null;

    var blocks = [];
    var all = scope.querySelectorAll(EDITABLE_SELECTOR);
    for (var i = 0; i < all.length; i += 1) {
      var el = all[i];
      if (!editableAllowed(el)) continue;
      // Keep the innermost block when a wrapper (li, blockquote) contains one.
      if (el.querySelector(EDITABLE_SELECTOR)) continue;
      var intersects = false;
      try {
        intersects = range.intersectsNode(el);
      } catch (error) {
        intersects = false;
      }
      if (!intersects) continue;
      var clipped = clipBlock(el, range);
      if (clipped) blocks.push(clipped);
    }

    // Fallback for a block whose only editable child did not intersect.
    if (blocks.length === 0) {
      var owner = findEditableTarget(range.startContainer);
      if (owner) {
        var one = clipBlock(owner, range);
        if (one) blocks.push(one);
      }
    }
    if (blocks.length === 0) return null;

    var chars = 0;
    for (var j = 0; j < blocks.length; j += 1) chars += blocks[j].end - blocks[j].start;
    if (chars < REWRITE_MIN_CHARS) return null;

    var tooMany = 0;
    if (blocks.length > REWRITE_MAX_BLOCKS) {
      tooMany = blocks.length;
      blocks = blocks.slice(0, REWRITE_MAX_BLOCKS);
    }

    var rect = null;
    try {
      rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        var rects = range.getClientRects();
        rect = rects && rects.length ? rects[rects.length - 1] : null;
      }
    } catch (error) {
      rect = null;
    }

    return {
      blocks: blocks,
      chars: chars,
      tooMany: tooMany,
      before: contextBefore(blocks[0].el).slice(-600),
      after: contextAfter(blocks[blocks.length - 1].el),
      rect: rect
        ? { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height }
        : { top: 80, bottom: 104, left: window.innerWidth / 2, width: 0, height: 24 },
    };
  }

  function updateRewriteToolbar() {
    if (!state.enabled || state.pointer) return;
    if (state.rewrite.open || state.rewrite.pending) return;
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      state.rewrite.selection = null;
      hideRewriteTrigger();
      syncDebug();
      return;
    }
    if (isUiTarget(selection.anchorNode) || isUiTarget(selection.focusNode)) {
      hideRewriteTrigger();
      return;
    }
    var snapshot = selectionSnapshot();
    if (!snapshot) {
      state.rewrite.selection = null;
      hideRewriteTrigger();
      return;
    }
    state.rewrite.selection = snapshot;
    mountRewriteUi();
    if (rewriteTrigger) rewriteTrigger.hidden = false;
    positionRewriteTrigger();
    syncDebug();
  }

  function scheduleRewriteToolbar() {
    window.clearTimeout(state.rewriteTimer);
    state.rewriteTimer = window.setTimeout(function () {
      state.rewriteTimer = null;
      updateRewriteToolbar();
    }, REWRITE_TOOLBAR_DEBOUNCE_MS);
  }

  function openRewritePanel() {
    var snapshot = state.rewrite.selection;
    if (!snapshot || !snapshot.blocks.length) return;
    state.rewrite.open = true;
    state.rewrite.error = '';
    clearRewritePreview();
    hideRewriteTrigger();
    if (!mountRewriteUi()) return;
    rewritePanel.hidden = false;
    rewriteInput.value = '';
    rewriteCountEl.textContent =
      snapshot.blocks.length + ' 段 · ' + snapshot.chars + ' 字' +
      (snapshot.tooMany ? '（一次最多 ' + REWRITE_MAX_BLOCKS + ' 段）' : '');
    setRewriteStatus(snapshot.tooMany ? '选区包含 ' + snapshot.tooMany + ' 段，请缩小范围' : '', snapshot.tooMany ? 'error' : '');
    if (rewriteRunBtn) rewriteRunBtn.disabled = !!snapshot.tooMany;
    if (rewriteInput) rewriteInput.disabled = false;
    positionRewritePanel();
    syncDebug();
    window.setTimeout(function () {
      if (!state.rewrite.open) return;
      try {
        rewriteInput.focus({ preventScroll: true });
      } catch (error) {
        rewriteInput.focus();
      }
    }, 0);
  }

  function closeRewritePanel() {
    if (state.rewrite.controller) {
      try {
        state.rewrite.controller.abort();
      } catch (error) {
        // ignore
      }
      state.rewrite.controller = null;
    }
    state.rewrite.open = false;
    setRewriteBusy(false);
    state.rewrite.selection = null;
    clearRewritePreview();
    hideRewriteTrigger();
    if (rewritePanel) rewritePanel.hidden = true;
    syncDebug();
  }

  function runRewrite() {
    var snapshot = state.rewrite.selection;
    if (!snapshot || !snapshot.blocks.length || state.rewrite.pending) return;
    if (snapshot.tooMany) {
      setRewriteStatus('一次最多改写 ' + REWRITE_MAX_BLOCKS + ' 段', 'error');
      return;
    }
    var instruction = String((rewriteInput && rewriteInput.value) || '').trim();
    if (instruction.length < 2) {
      setRewriteStatus('先写一句要改成什么', 'error');
      try {
        rewriteInput.focus({ preventScroll: true });
      } catch (error) {
        rewriteInput.focus();
      }
      return;
    }

    clearRewritePreview();
    setRewriteBusy(true);
    setRewriteStatus('正在改写…', 'busy');
    var payload = {
      file: config.file,
      title: config.title || document.title || '',
      before: snapshot.before,
      after: snapshot.after,
      instruction: instruction,
      blocks: snapshot.blocks.map(function (block) {
        return { text: block.text, start: block.start, end: block.end, tag: block.tag };
      }),
    };
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    state.rewrite.controller = controller;
    var startedAt = Date.now();
    var timer = window.setTimeout(function () {
      if (controller) {
        try {
          controller.abort();
        } catch (error) {
          // ignore
        }
      }
    }, REWRITE_TIMEOUT_MS);

    fetch(REWRITE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
      ...(controller ? { signal: controller.signal } : {}),
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return null;
          })
          .then(function (data) {
            if (!response.ok || !data) {
              var failure = new Error((data && (data.error || data.note)) || '改写失败（HTTP ' + response.status + '）');
              failure.status = response.status;
              throw failure;
            }
            return data;
          });
      })
      .then(function (data) {
        window.clearTimeout(timer);
        if (state.rewrite.controller === controller) state.rewrite.controller = null;
        if (!state.rewrite.open) return;
        if (!data.ok || !Array.isArray(data.blocks) || data.blocks.length === 0) {
          state.rewrite.error = data.note || data.error || '模型没有返回改写结果';
          setRewriteBusy(false);
          setRewriteStatus(state.rewrite.error, 'error');
          return;
        }
        state.rewrite.result = {
          blocks: data.blocks,
          route: data.route || '',
          ms: typeof data.ms === 'number' ? data.ms : Date.now() - startedAt,
        };
        state.rewrite.error = '';
        setRewriteBusy(false);
        renderRewritePreview();
      })
      .catch(function (error) {
        window.clearTimeout(timer);
        if (state.rewrite.controller === controller) state.rewrite.controller = null;
        if (!state.rewrite.open) return;
        setRewriteBusy(false);
        if (error && error.name === 'AbortError') {
          setRewriteStatus('改写超时，请重试', 'error');
          return;
        }
        var message = String((error && error.message) || error || '改写失败');
        state.rewrite.error = message;
        setRewriteStatus(message, 'error');
      });
  }

  function renderRewritePreview() {
    var snapshot = state.rewrite.selection;
    var result = state.rewrite.result;
    if (!snapshot || !result || !rewritePreviewEl) return;
    rewritePreviewEl.innerHTML = '';

    var byIndex = {};
    for (var i = 0; i < result.blocks.length; i += 1) {
      var entry = result.blocks[i];
      if (entry && typeof entry.index === 'number') byIndex[entry.index] = entry;
    }

    for (var j = 0; j < snapshot.blocks.length; j += 1) {
      var block = snapshot.blocks[j];
      var replacement = byIndex[j];
      if (!replacement) continue;
      var item = document.createElement('div');
      item.className = 'dsh-live-rewrite-item';

      var label = document.createElement('div');
      label.className = 'dsh-live-rewrite-label';
      label.textContent = '第 ' + (j + 1) + ' 段 · ' + block.tag;
      item.appendChild(label);

      var before = document.createElement('div');
      before.className = 'dsh-live-rewrite-before';
      var oldText = block.text.slice(block.start, block.end);
      before.textContent = oldText.length > 500 ? oldText.slice(0, 500) + '…' : oldText;
      item.appendChild(before);

      var after = document.createElement('div');
      after.className = 'dsh-live-rewrite-after';
      var fragment = createSafeFragment(replacement.html);
      if (fragment) after.appendChild(fragment);
      if (normalizeText(after.textContent) === '' && !after.querySelector('br')) {
        after.textContent = '（删除这段文字）';
        after.classList.add('is-empty');
      }
      item.appendChild(after);
      rewritePreviewEl.appendChild(item);
    }

    rewritePreviewEl.hidden = false;
    if (rewritePreviewEl._actions) rewritePreviewEl._actions.hidden = false;
    if (rewriteRunBtn) rewriteRunBtn.hidden = true;
    setRewriteStatus(
      '已生成 ' + result.blocks.length + ' 段替换' + (result.ms ? ' · ' + result.ms + 'ms' : '') + (result.route ? ' · ' + result.route : ''),
      'ok',
    );
    positionRewritePanel();
  }

  var SAFE_INLINE_TAGS = {
    a: 1,
    strong: 1,
    em: 1,
    b: 1,
    i: 1,
    code: 1,
    span: 1,
    br: 1,
    small: 1,
    sup: 1,
    sub: 1,
    mark: 1,
    u: 1,
    s: 1,
    del: 1,
    ins: 1,
  };

  /** Client-side allowlist: only inline text markup reaches the page. */
  function createSafeFragment(html) {
    var source = String(html == null ? '' : html);
    if (source.trim() === '') return null;
    var holder = document.createElement('template');
    holder.innerHTML = source;
    var root = holder.content || holder;

    function walk(parent) {
      var nodes = Array.prototype.slice.call(parent.childNodes || []);
      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i];
        if (!isElement(node)) continue;
        var tag = String(node.tagName || '').toLowerCase();
        if (!SAFE_INLINE_TAGS[tag]) {
          var text = document.createTextNode(node.textContent || '');
          if (node.parentNode) node.parentNode.replaceChild(text, node);
          continue;
        }
        var attributes = Array.prototype.slice.call(node.attributes || []);
        for (var a = attributes.length - 1; a >= 0; a -= 1) {
          var attr = attributes[a];
          var name = String(attr.name || '').toLowerCase();
          var keep = false;
          if (tag === 'a' && (name === 'href' || name === 'title' || name === 'target' || name === 'rel')) keep = true;
          if (!keep) node.removeAttribute(attr.name);
        }
        if (tag === 'a') {
          var href = node.getAttribute('href') || '';
          if (!/^(?:https?:|mailto:|#|\/)/i.test(href)) node.removeAttribute('href');
          if (node.getAttribute('target') === '_blank') node.setAttribute('rel', 'noopener noreferrer');
          if (!node.getAttribute('href')) node.removeAttribute('target');
        }
        walk(node);
      }
    }

    walk(root);
    return root;
  }

  function applyRewrite() {
    var snapshot = state.rewrite.selection;
    var result = state.rewrite.result;
    if (!snapshot || !result) return;
    var byIndex = {};
    for (var i = 0; i < result.blocks.length; i += 1) {
      var entry = result.blocks[i];
      if (entry && typeof entry.index === 'number') byIndex[entry.index] = entry;
    }

    // Validate every block before touching the DOM.
    for (var j = 0; j < snapshot.blocks.length; j += 1) {
      var block = snapshot.blocks[j];
      if (!byIndex[j]) {
        setRewriteStatus('替换结果不完整，请重试', 'error');
        return;
      }
      if (!block.el || !block.el.isConnected || String(block.el.textContent || '') !== block.text) {
        setRewriteStatus('页面内容已经变化，请重新选中再改写', 'error');
        return;
      }
    }

    var undo = [];
    for (var k = 0; k < snapshot.blocks.length; k += 1) {
      var target = snapshot.blocks[k];
      var html = String(byIndex[k].html == null ? '' : byIndex[k].html);
      if (html.trim() !== '') {
        // Keep the whitespace boundary of the original range. Without this a
        // translation can glue "发布日期" directly to the following word.
        var selected = String(target.text || '').slice(target.start, target.end);
        var leading = /^\s*/.exec(selected);
        var trailing = /\s*$/.exec(selected);
        if (leading && leading[0] && !/^\s/.test(html)) html = leading[0] + html;
        if (trailing && trailing[0] && !/\s$/.test(html)) html = html + trailing[0];
      }
      // A range edit can start on a block that was never activated, so it has
      // no baseline yet. Snapshot it before mutating; undo needs the original
      // outerHTML to find the block again in the source file.
      var currentBaseline = baselines.get(target.el);
      if (!currentBaseline) {
        currentBaseline = snapshotOf(target.el);
        baselines.set(target.el, currentBaseline);
      }
      var original = {
        el: target.el,
        html: target.el.innerHTML,
        baseline: currentBaseline,
        appliedBaseline: null,
      };
      try {
        var range = target.range.cloneRange();
        range.deleteContents();
        if (html.trim() !== '') {
          var fragment = createSafeFragment(html);
          if (fragment) range.insertNode(fragment);
        }
        target.el.normalize();
      } catch (error) {
        recordError(error, 'rewrite-apply');
        // Roll back blocks already changed in this pass.
        for (var u = 0; u < undo.length; u += 1) {
          try {
            undo[u].el.innerHTML = undo[u].html;
          } catch (innerError) {
            // ignore
          }
        }
        setRewriteStatus('替换失败：' + String((error && error.message) || error), 'error');
        return;
      }
      original.appliedBaseline = snapshotOf(target.el);
      undo.push(original);
    }

    state.rewrite.applied = undo;
    state.rewrite.open = false;
    state.rewrite.pending = false;
    state.rewrite.selection = null;
    state.rewrite.result = null;
    if (rewritePanel) rewritePanel.hidden = true;
    hideRewriteTrigger();
    setRewriteStatus('', '');
    setStatus('正在保存替换…', 'busy');
    for (var n = 0; n < undo.length; n += 1) {
      if (undo[n].el && undo[n].el.isConnected) enqueueSave(undo[n].el, { silent: false, keepEmpty: true });
    }
    showRewriteUndo();
    showToast('已应用 AI 改写，20 秒内可撤销。', 'success', 4200);
    syncDebug();
  }

  function showRewriteUndo() {
    if (!rewriteUndoBtn) return;
    if (!mountRewriteUi()) return;
    rewriteUndoBtn.hidden = false;
    window.clearTimeout(state.rewriteUndoTimer);
    state.rewriteUndoTimer = window.setTimeout(function () {
      hideRewriteUndo();
    }, REWRITE_UNDO_MS);
  }

  function undoRewrite() {
    var applied = state.rewrite.applied;
    if (!applied || !applied.length) return;
    for (var i = 0; i < applied.length; i += 1) {
      var item = applied[i];
      if (!item || !item.el || !item.el.isConnected) continue;
      try {
        item.el.innerHTML = item.html;
        // The save must locate the applied block on disk, then write the
        // original HTML back. The applied snapshot is that on-disk state.
        if (item.appliedBaseline) baselines.set(item.el, item.appliedBaseline);
        enqueueSave(item.el, { silent: false, keepEmpty: true, force: true });
      } catch (error) {
        recordError(error, 'rewrite-undo');
      }
    }
    state.rewrite.applied = null;
    hideRewriteUndo();
    showToast('已撤销替换。', 'success', 3000);
    setStatus('已撤销替换', 'ok');
    syncDebug();
  }

  // -- activation / exit --------------------------------------------------

  function activateBlock(el, options) {
    options = options || {};
    if (!el || !editableAllowed(el)) return;
    if (state.activeEl === el) {
      if (options.caretRange) placeSelectionRange(options.caretRange);
      return;
    }

    if (state.activeEl) {
      var previous = state.activeEl;
      enqueueSave(previous, { silent: true });
      clearActiveBlock();
    }

    clearHover();
    if (!baselines.has(el)) baselines.set(el, snapshotOf(el));
    state.activeEl = el;
    applyEditingSurface(el);
    setStatus('编辑中…', 'dirty');

    if (!el.isContentEditable) {
      try {
        el.focus({ preventScroll: true });
      } catch (error) {
        try {
          el.focus();
        } catch (innerError) {
          // ignore
        }
      }
    }

    if (options.caretRange && el.contains(options.caretRange.startContainer)) {
      placeSelectionRange(options.caretRange);
    } else if (typeof options.caretOffset === 'number') {
      placeCaretInText(el, options.caretOffset);
    } else if (!options.keepSelection) {
      placeCaretInText(el, 0);
    }
    syncDebug();
  }

  function clearActiveBlock() {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
    state.lastRequestKey = '';
    state.skipNextInputCompletion = false;
    clearSuggestion();
    var el = state.activeEl;
    state.activeEl = null;
    clearEditingSurface(el);
    clearHover();
    setStatus('就绪', 'idle');
    syncDebug();
  }

  /** Save whatever the active block holds and leave the block. */
  function exitBlock(options) {
    options = options || {};
    var el = state.activeEl;
    if (!el) return;
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
    if (options.flush !== false) {
      if (el.isConnected) enqueueSave(el, { silent: true });
    }
    clearActiveBlock();
  }

  // -- enter / split / line break ----------------------------------------

  function insertLineBreak() {
    var el = state.activeEl;
    if (!el) return;
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    var range = selection.getRangeAt(0);
    if (!el.contains(range.startContainer)) return;
    range.deleteContents();
    var br = document.createElement('br');
    range.insertNode(br);
    var after = document.createElement('br');
    br.parentNode.insertBefore(after, br.nextSibling);
    var caret = document.createRange();
    caret.setStartAfter(after);
    caret.collapse(true);
    placeSelectionRange(caret);
    onBlockInput(el);
  }

  function splitActiveBlock() {
    var el = state.activeEl;
    if (!el || !el.isConnected) return;
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;

    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    var range = selection.getRangeAt(0).cloneRange();
    if (!el.contains(range.startContainer)) return;

    var baseline = baselines.get(el);
    if (!baseline) {
      baseline = snapshotOf(el);
      baselines.set(el, baseline);
    }

    if (!selection.isCollapsed) {
      try {
        selection.deleteFromDocument();
      } catch (error) {
        // ignore
      }
      range = selection.getRangeAt(0).cloneRange();
    }
    range.collapse(true);

    var prefix = document.createRange();
    prefix.selectNodeContents(el);
    try {
      prefix.setEnd(range.startContainer, range.startOffset);
    } catch (error) {
      return;
    }
    var prefixEmpty = !hasMeaningfulContent(prefix.cloneContents());

    var newEl = el.cloneNode(false);
    stripRuntimeAttrs(newEl);
    newEl.removeAttribute('contenteditable');
    newEl.removeAttribute('spellcheck');
    newEl.removeAttribute('autocorrect');
    newEl.classList.remove('dsh-live-editing', 'dsh-live-hover');
    if (!newEl.classList.length) newEl.removeAttribute('class');

    var originalInnerHtml = el.innerHTML;
    var originalBaseline = baseline;
    var originalCaretOffset = 0;
    try {
      var beforeCaret = document.createRange();
      beforeCaret.selectNodeContents(el);
      beforeCaret.setEnd(range.startContainer, range.startOffset);
      originalCaretOffset = String(beforeCaret.toString() || '').length;
    } catch (error) {
      originalCaretOffset = normalizeText(el.textContent).length;
    }
    var parent = el.parentNode;
    if (!parent) return;

    var before = prefixEmpty;
    if (!before) {
      var suffix = document.createRange();
      suffix.selectNodeContents(el);
      try {
        suffix.setStart(range.startContainer, range.startOffset);
      } catch (error) {
        return;
      }
      try {
        newEl.appendChild(suffix.extractContents());
      } catch (error) {
        return;
      }
      parent.insertBefore(newEl, el.nextSibling);
    } else {
      parent.insertBefore(newEl, el);
    }

    var elHtml = sanitizeElement(el);
    var newHtml = sanitizeElement(newEl);
    var combined = before ? newHtml + '\n' + elHtml : elHtml + '\n' + newHtml;

    var elSnapshot = snapshotOf(el);
    var newSnapshot = snapshotOf(newEl);

    clearEditingSurface(el);
    state.activeEl = null;
    if (!baselines.has(newEl)) baselines.set(newEl, newSnapshot);

    var task = {
      kind: 'replace',
      el: el,
      baseline: originalBaseline,
      tag: String(el.tagName || 'p').toLowerCase(),
      html: combined,
      selectorPath: selectorPath(el),
      anchor: nearestAnchor(el),
      primary: elSnapshot,
      updates: [
        { el: el, snapshot: elSnapshot },
        { el: newEl, snapshot: newSnapshot },
      ],
      revert: function () {
        if (newEl.parentNode) newEl.parentNode.removeChild(newEl);
        el.innerHTML = originalInnerHtml;
        baselines.set(el, originalBaseline);
        if (state.activeEl === newEl || state.activeEl === null) {
          clearActiveBlock();
          if (el.isConnected) activateBlock(el, { caretOffset: originalCaretOffset });
        }
      },
    };
    pushTask(task);
    activateBlock(newEl, { caretOffset: 0 });
  }

  function hasMeaningfulContent(fragment) {
    if (!fragment) return false;
    if (normalizeText(fragment.textContent) !== '') return true;
    try {
      if (fragment.querySelector && fragment.querySelector('img, picture, video, audio, iframe, svg, canvas, hr')) return true;
    } catch (error) {
      // ignore
    }
    return false;
  }

  // -- version polling / reload ------------------------------------------

  function isEditingNow() {
    return state.enabled || !!state.activeEl || isQueueBusy();
  }

  /** True when one edited block differs from its last on-disk snapshot. */
  function blockHasLocalEdits(el) {
    if (!el || !el.isConnected) return false;
    var baseline = baselines.get(el);
    if (!baseline) return false;
    try {
      var now = snapshotOf(el);
      return !!now && now.outerHTML !== baseline.outerHTML;
    } catch (error) {
      return true;
    }
  }

  /** True when reloading now would throw away text that is not on disk yet. */
  function hasUnsavedEdits() {
    if (isQueueBusy() || state.saving) return true;
    if (blockHasLocalEdits(state.activeEl)) return true;
    var pending = false;
    baselines.forEach(function (baseline, el) {
      if (pending) return;
      if (blockHasLocalEdits(el)) pending = true;
    });
    return pending;
  }

  function scheduleNextPoll() {
    if (state.reloading) return;
    window.clearTimeout(state.pollTimer);
    state.pollTimer = window.setTimeout(pollVersion, VERSION_POLL_MS);
  }

  function pollVersion() {
    if (state.reloading) return;
    ensureHud();
    if (state.activeEl && !state.activeEl.isConnected) clearActiveBlock();
    if (!config.file) {
      scheduleNextPoll();
      return;
    }
    if (document.hidden) {
      scheduleNextPoll();
      return;
    }

    var url = VERSION_URL + '?file=' + encodeURIComponent(config.file);
    fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return null;
          })
          .then(function (data) {
            if (response.ok && data && data.ok === true) return data;
            var error = new Error((data && data.error) || '版本检查失败（HTTP ' + response.status + '）');
            error.status = response.status;
            throw error;
          });
      })
      .then(handleVersion)
      .catch(handlePollError)
      .then(scheduleNextPoll);
  }

  function handleVersion(data) {
    state.pollFailures = 0;
    var version = data && typeof data.version === 'string' ? data.version : '';
    if (!version) return;

    if (!state.version || state.versionUnknown) {
      state.version = version;
      state.versionUnknown = false;
      syncDebug();
      return;
    }
    if (version === state.version) return;

    // The file changed on disk: show the new content right away. Only hold
    // back when unsaved edits would be lost, so editing does not need a manual
    // refresh for every outside change.
    if (hasUnsavedEdits()) {
      showUpdatedNotice();
      return;
    }
    requestReload({ auto: true });
  }

  function handlePollError(error) {
    state.pollFailures += 1;
    if (state.pollFailures === 1) recordError(error, 'version');
    if (state.pollFailures === 3) {
      setStatus('连接异常', 'error', String((error && error.message) || error));
      showToast('无法连接本地编辑服务，修改可能无法保存。', 'error', 6000);
    }
  }

  /** Flush pending edits, then reload so the file and the page agree again. */
  function requestReload(options) {
    options = options || {};
    if (state.reloading) return;
    state.reloading = true;
    hideUpdatedNotice();
    setStatus('正在保存…', 'busy');

    if (state.activeEl && state.activeEl.isConnected && blockHasLocalEdits(state.activeEl)) {
      enqueueSave(state.activeEl, { silent: true });
    }

    whenSavesIdle().then(function () {
      var failed = !!(state.lastSave && state.lastSave.ok === false);
      if (failed && !options.auto) {
        if (!confirm('保存失败，未保存的修改会丢失。仍然刷新页面吗？')) {
          state.reloading = false;
          setStatus('保存失败', 'error', state.lastSave && state.lastSave.error);
          return;
        }
      }
      try {
        window.location.reload();
      } catch (error) {
        state.reloading = false;
        recordError(error, 'reload');
      }
    });
  }

  // -- selection reporting to the Web GUI ---------------------------------

  function scheduleSelectionReport() {
    window.clearTimeout(state.selectingTimer);
    state.selectingTimer = window.setTimeout(reportSelection, SELECTION_DEBOUNCE_MS);
  }

  function reportSelection() {
    try {
      if (state.enabled) return; // CONTRACT: only outside edit mode
      if (!window.parent || window.parent === window) return;

      var selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

      var text = String(selection.toString() || '').trim();
      if (text.length < MIN_SELECTION_CHARS) return;
      if (text.length > MAX_QUOTE_CHARS) text = text.slice(0, MAX_QUOTE_CHARS);

      var anchor = selection.anchorNode;
      var anchorEl = isElement(anchor) ? anchor : anchor && anchor.parentElement;
      if (!anchorEl || typeof anchorEl.closest !== 'function') return;
      if (anchorEl.closest('input, textarea, [contenteditable], [data-dsh-live-ui]')) return;
      if (state.activeEl && state.activeEl.contains(anchorEl)) return;

      window.parent.postMessage(
        {
          type: 'dsh-live-selection',
          nonce: config.nonce,
          text: text,
          url: window.location.href,
          title: document.title,
          file: config.file,
        },
        '*',
      );
    } catch (error) {
      recordError(error, 'selection');
    }
  }

  // -- edit mode ----------------------------------------------------------

  var EDIT_MODE_KEY = 'dsh-live-edit-mode';

  function readStoredEditMode() {
    try {
      var value = window.sessionStorage.getItem(EDIT_MODE_KEY);
      return value === '1' ? true : value === '0' ? false : null;
    } catch (error) {
      return null;
    }
  }

  function rememberEditMode(next) {
    try {
      window.sessionStorage.setItem(EDIT_MODE_KEY, next ? '1' : '0');
    } catch (error) {
      // Storage may be unavailable; editing still works for this page load.
    }
  }

  function setEnabled(next) {
    if (state.enabled === next) return;
    if (!ensureHud()) {
      // No body yet; retry once the document is ready (handled in boot()).
    }
    if (!next) {
      clearSuggestion();
      closeRewritePanel();
      hideRewriteTrigger();
      exitBlock({ flush: true });
    }

    state.enabled = next;
    rememberEditMode(next);
    if (badgeEl) {
      badgeEl.classList.toggle('is-off', !next);
      badgeEl.textContent = next ? 'Edit: On' : 'Edit: Off';
    }

    if (next) {
      setStatus('点击段落开始编辑', 'dirty');
      showToast('直接编辑已开启：点击段落修改，选中文字可让 AI 按指令改写；停顿后出现补全建议。', 'success', 4200);
    } else {
      setStatus('已关闭编辑', 'idle');
    }
    clearHover();
    syncDebug();
  }

  function isToggleShortcut(event) {
    if (!event) return false;
    var key = String(event.key || '').toLowerCase();
    if (key !== 'e') return false;
    return (event.ctrlKey || event.metaKey) && event.shiftKey;
  }

  // -- event handlers -----------------------------------------------------

  function onDocumentMouseMove(event) {
    if (!state.enabled || state.activeEl) return;
    if (isUiTarget(event.target)) {
      clearHover();
      return;
    }
    var target = findEditableTarget(event.target);
    if (!target) {
      clearHover();
      return;
    }
    if (state.hoverEl !== target) {
      clearHover();
      state.hoverEl = target;
      target.classList.add('dsh-live-hover');
    }
  }

  function onDocumentMouseDown(event) {
    if (event.button !== 0) return;

    if (state.suggestion) clearSuggestion();
    if (isUiTarget(event.target)) return;
    if (!state.enabled) return;

    var target = findEditableTarget(event.target);
    // Leave the editing host before the browser starts a native selection:
    // contenteditable would otherwise clamp the drag to one block.
    if (state.activeEl) exitBlock({ flush: true });
    if (state.rewrite.open) closeRewritePanel();

    state.pointer = {
      x: event.clientX,
      y: event.clientY,
      target: target,
      detail: event.detail || 1,
      at: Date.now(),
    };
  }

  function onDocumentMouseUp(event) {
    if (!state.enabled || event.button !== 0) {
      state.pointer = null;
      return;
    }
    var pointer = state.pointer;
    state.pointer = null;
    if (!pointer) {
      scheduleRewriteToolbar();
      return;
    }
    var moved = Math.abs(event.clientX - pointer.x) > 4 || Math.abs(event.clientY - pointer.y) > 4;
    var selection = window.getSelection();
    var hasSelection = !!selection && selection.rangeCount > 0 && !selection.isCollapsed;

    // A plain click (not a drag, not a word/paragraph multi-click) edits the
    // block under the cursor; a drag keeps the native selection for rewriting.
    if (!moved && !hasSelection && pointer.detail < 2 && pointer.target && pointer.target.isConnected) {
      var caret = caretRangeFromPoint(event.clientX, event.clientY);
      activateBlock(pointer.target, { caretRange: caret, keepSelection: true });
      state.rewrite.selection = null;
      hideRewriteTrigger();
      return;
    }
    scheduleRewriteToolbar();
  }

  function onDocumentKeyDown(event) {
    if (event.defaultPrevented) return;

    if (isToggleShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      setEnabled(!state.enabled);
      return;
    }

    if (state.rewrite.open && (event.key === 'Escape' || event.key === 'Esc')) {
      event.preventDefault();
      event.stopPropagation();
      closeRewritePanel();
      return;
    }

    if (state.suggestion && (event.key === 'Tab' || event.keyCode === 9) && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      acceptSuggestion();
      return;
    }

    if (event.key === 'Escape' || event.key === 'Esc') {
      if (state.suggestion) {
        event.preventDefault();
        event.stopPropagation();
        clearSuggestion();
        return;
      }
      if (state.activeEl) {
        event.preventDefault();
        event.stopPropagation();
        exitBlock({ flush: true });
        setStatus('已保存', 'ok');
        return;
      }
      if (state.enabled) {
        event.preventDefault();
        event.stopPropagation();
        setEnabled(false);
      }
      return;
    }

    if (!state.enabled || !state.activeEl) return;
    if (event.isComposing || event.keyCode === 229) return;
    if (state.suggestion) clearSuggestion();
    if (!state.activeEl.contains(event.target)) return;

    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) insertLineBreak();
      else if (SPLITTABLE_TAGS[String(state.activeEl.tagName || '').toLowerCase()]) splitActiveBlock();
      else insertLineBreak();
    }
  }

  function onDocumentInput(event) {
    if (!state.enabled) return;
    var el = state.activeEl;
    if (!el) return;
    if (event.isComposing) return; // IME composition: wait for the settled text
    if (event.target === el || el.contains(event.target)) onBlockInput(el);
  }

  function onDocumentSelectionChange() {
    if (state.enabled) {
      if (state.suggestion) {
        var live = state.activeEl ? caretInfo(state.activeEl) : null;
        var stale = !live || live.range.startContainer !== state.suggestion.range.startContainer
          || live.range.startOffset !== state.suggestion.range.startOffset;
        if (stale) clearSuggestion();
      }
      if (!state.pointer) scheduleRewriteToolbar();
      return;
    }
    scheduleSelectionReport();
  }

  function bindEvents() {
    document.addEventListener('mousemove', onDocumentMouseMove, true);
    document.addEventListener('mousedown', onDocumentMouseDown, true);
    document.addEventListener('mouseup', onDocumentMouseUp, true);
    document.addEventListener('keydown', onDocumentKeyDown, true);
    document.addEventListener('input', onDocumentInput, true);
    document.addEventListener('selectionchange', onDocumentSelectionChange);

    window.addEventListener('scroll', function () {
      if (state.suggestion) clearSuggestion();
      if (rewriteTrigger && !rewriteTrigger.hidden) positionRewriteTrigger();
      if (state.rewrite.open) positionRewritePanel();
    }, true);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) clearSuggestion();
      if (!document.hidden) {
        window.clearTimeout(state.pollTimer);
        state.pollTimer = window.setTimeout(pollVersion, 120);
      }
    });

    if (badgeEl) {
      badgeEl.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        setEnabled(!state.enabled);
      });
    }


    if (noticeEl) {
      noticeEl.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        requestReload({});
      });
    }

    window.addEventListener('load', ensureHud);
  }

  // -- boot ---------------------------------------------------------------

  /** The IDE button opens the live URL with a one-shot __live_edit=1 flag:
   *  the first page loads directly in edit mode; later navigation drops it. */
  function editRequestedByUrl() {
    try {
      return new URLSearchParams(window.location.search).get('__live_edit') === '1';
    } catch (error) {
      return false;
    }
  }

  function stripEditFlag() {
    try {
      var clean = window.location.pathname + (window.location.hash || '');
      window.history.replaceState(null, '', clean);
    } catch (error) {
      // URL rewriting is cosmetic; keep editing if it fails.
    }
  }

  function boot() {
    if (state.booted) return;
    state.booted = true;

    buildHud();
    buildNotice();
    buildToast();
    buildRewriteUi();
    ensureHud();
    bindEvents();
    syncDebug();
    scheduleNextPoll();
    var storedEditMode = readStoredEditMode();
    if (editRequestedByUrl() || storedEditMode === true) {
      setEnabled(true);
      stripEditFlag();
    } else if (storedEditMode === false && state.enabled) {
      setEnabled(false);
    }

    // Pages that rerender their body should still keep the HUD around.
    try {
      var observer = new MutationObserver(function () {
        ensureHud();
      });
      observer.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (error) {
      // MutationObserver unsupported: the version poll still re-mounts the HUD.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // Defensive retry for documents that expose no body while the script runs.
  window.setTimeout(function () {
    if (!state.booted || !hud || !hud.isConnected) boot();
  }, 250);
})();
