/*
 * Think Translate frontend (modeled after DeepSeek Harness reasoning translation UX).
 *
 * Polls `/api/state` incrementally via ETag, preserves original thinking text,
 * supports global and per-card Translation / Bilingual / Original toggles, and
 * safely renders Markdown + fenced code blocks.
 */
(() => {
  const POLL_ACTIVE_MS = 1000;
  const POLL_IDLE_MS = 1800;

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const uiState = {
    conversationId: window.sidecar?.conversationId || params.get('conversationId') || '',
    etag: '',
    data: null,
    globalMode: 'translation', // 'translation' | 'bilingual' | 'original'
    perCardMode: new Map(), // stepIndex -> 'translation' | 'bilingual' | 'original'
    collapsed: new Set(), // stepIndex
    searchQuery: '',
    followLatest: true,
    allCollapsed: false,
    pendingScrollReset: false,
    pollTimer: null,
    toastTimer: null,
  };

  // ---------- Theme synchronization ----------
  function syncThemeScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    const nums = (color.match(/[\d.]+/g) || []).map(Number);
    if (nums.length >= 3) {
      const lum = (0.299 * nums[0] + 0.587 * nums[1] + 0.114 * nums[2]) / 255;
      document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
    }
  }
  syncThemeScheme();
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'theme-change') {
      requestAnimationFrame(syncThemeScheme);
    }
  });

  // ---------- API helpers ----------
  async function apiFetch(path, options = {}) {
    const fetcher = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await fetcher(path, options);
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: text };
    }
    if (!res.ok) {
      throw new Error(json?.error || `HTTP ${res.status}`);
    }
    return json;
  }

  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(uiState.toastTimer);
    uiState.toastTimer = setTimeout(() => el.classList.add('hidden'), 2000);
  }

  // ---------- Safe Markdown & escaping ----------
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderProseMarkdown(raw) {
    const codeTokens = [];
    const tokenized = String(raw || '').replace(/`([^`\n]+)`/g, (_, inner) => {
      const idx = codeTokens.length;
      codeTokens.push(`<code>${escapeHtml(inner)}</code>`);
      return `\u0000CODE${idx}\u0000`;
    });

    const lines = tokenized.split('\n');
    const htmlParts = [];
    let inUl = false;
    let inOl = false;

    const closeLists = () => {
      if (inUl) { htmlParts.push('</ul>'); inUl = false; }
      if (inOl) { htmlParts.push('</ol>'); inOl = false; }
    };

    const inlineFormat = (line) => {
      let s = escapeHtml(line);
      s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
      s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => codeTokens[Number(idx)] || '');
      return s;
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        closeLists();
        continue;
      }
      const hMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
      if (hMatch) {
        closeLists();
        const level = Math.min(4, hMatch[1].length + 1);
        htmlParts.push(`<h${level}>${inlineFormat(hMatch[2])}</h${level}>`);
        continue;
      }
      const ulMatch = /^[-*]\s+(.+)$/.exec(trimmed);
      if (ulMatch) {
        if (inOl) { htmlParts.push('</ol>'); inOl = false; }
        if (!inUl) { htmlParts.push('<ul>'); inUl = true; }
        htmlParts.push(`<li>${inlineFormat(ulMatch[1])}</li>`);
        continue;
      }
      const olMatch = /^\d+\.\s+(.+)$/.exec(trimmed);
      if (olMatch) {
        if (inUl) { htmlParts.push('</ul>'); inUl = false; }
        if (!inOl) { htmlParts.push('<ol>'); inOl = true; }
        htmlParts.push(`<li>${inlineFormat(olMatch[1])}</li>`);
        continue;
      }
      closeLists();
      htmlParts.push(`<p>${inlineFormat(trimmed)}</p>`);
    }
    closeLists();
    return `<div class="prose">${htmlParts.join('')}</div>`;
  }

  function renderCodeBlock(raw) {
    const cleaned = String(raw || '').replace(/^(`{3,}|~{3,})[^\n]*\n?/, '').replace(/\n?(`{3,}|~{3,})\s*$/, '');
    return `<pre class="code-block"><code>${escapeHtml(cleaned)}</code></pre>`;
  }

  function splitFallbackParagraphs(text) {
    const blocks = [];
    const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return blocks;
    const fenceRe = /^[ \t]*(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;
    let last = 0;
    for (const m of normalized.matchAll(fenceRe)) {
      const idx = m.index ?? 0;
      if (idx > last) {
        for (const p of normalized.slice(last, idx).split(/\n\s*\n+/)) {
          if (p.trim()) blocks.push({ type: 'prose', src: p.trim(), dst: p.trim() });
        }
      }
      blocks.push({ type: 'code', src: m[0], dst: m[0] });
      last = idx + m[0].length;
    }
    if (last < normalized.length) {
      for (const p of normalized.slice(last).split(/\n\s*\n+/)) {
        if (p.trim()) blocks.push({ type: 'prose', src: p.trim(), dst: p.trim() });
      }
    }
    return blocks;
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function statusBadgeInfo(step) {
    switch (step.translationStatus) {
      case 'done': {
        const providerName = step.provider === 'openai' ? 'LLM' : step.provider === 'google' ? 'Google' : 'Bing';
        return { cls: 'done', label: `${providerName} · 已译` };
      }
      case 'translating':
        return { cls: 'translating', label: '翻译中…' };
      case 'error':
        return { cls: 'error', label: '翻译失败' };
      case 'skipped_zh':
        return { cls: 'skipped_zh', label: '中文原文' };
      default:
        return { cls: 'pending', label: '待翻译' };
    }
  }

  function getEffectiveMode(step) {
    const requested = uiState.perCardMode.get(step.stepIndex) || uiState.globalMode;
    if (step.translationStatus !== 'done') {
      return requested === 'original' ? 'original' : requested;
    }
    return requested;
  }

  function renderStepBodyHtml(step, mode) {
    const parts = [];

    if (step.translationStatus === 'error' && step.error) {
      parts.push(
        `<div class="error-banner">` +
          `<span>翻译失败（已保留原文）：${escapeHtml(step.error)}</span>` +
          `<button type="button" class="card-btn retry" data-action="retry" data-step="${step.stepIndex}">重试</button>` +
        `</div>`
      );
    } else if (step.translationStatus === 'translating' && mode !== 'original') {
      parts.push(`<div class="translating-banner">正在将本步思考过程翻译为简体中文，以下先展示原文…</div>`);
    }

    const segments = Array.isArray(step.segments) && step.segments.length
      ? step.segments
      : splitFallbackParagraphs(step.thinking);

    if (mode === 'original' || step.translationStatus !== 'done') {
      for (const seg of segments) {
        parts.push(seg.type === 'code' ? renderCodeBlock(seg.src) : renderProseMarkdown(seg.src));
      }
      return parts.join('');
    }

    if (mode === 'translation') {
      for (const seg of segments) {
        parts.push(seg.type === 'code' ? renderCodeBlock(seg.src) : renderProseMarkdown(seg.dst || seg.src));
      }
      return parts.join('');
    }

    // Bilingual mode: interleave source paragraph and Chinese translation paragraph.
    for (const seg of segments) {
      if (seg.type === 'code') {
        parts.push(renderCodeBlock(seg.src));
      } else {
        parts.push(
          `<div class="bilingual-pair">` +
            `<div class="bilingual-src">${renderProseMarkdown(seg.src)}</div>` +
            `<div class="bilingual-dst">${renderProseMarkdown(seg.dst || seg.src)}</div>` +
          `</div>`
        );
      }
    }
    return parts.join('');
  }

  function getCopyText(step, mode) {
    if (mode === 'original' || step.translationStatus !== 'done') {
      return step.thinking;
    }
    if (mode === 'translation') {
      return step.translatedText || step.thinking;
    }
    const segs = step.segments || [];
    return segs
      .map((s) => (s.type === 'code' ? s.src : `${s.src}\n${s.dst}`))
      .join('\n\n');
  }

  // ---------- Render UI ----------
  function updateHeaderControls() {
    const settings = uiState.data?.settings;
    const steps = uiState.data?.steps || [];
    const translatingCount = steps.filter((s) => s.translationStatus === 'translating').length;
    const pendingCount = steps.filter((s) => s.translationStatus === 'pending').length;

    const pill = $('status-pill');
    const statusText = $('status-text');
    pill.classList.remove('translating', 'idle');
    if (translatingCount > 0) {
      pill.classList.add('translating');
      statusText.textContent = `翻译中 (${translatingCount})`;
    } else if (!settings?.autoTranslate) {
      pill.classList.add('idle');
      statusText.textContent = `手动模式 · ${steps.length} 条`;
    } else {
      statusText.textContent = `实时同步 · ${steps.length} 条`;
    }

    const autoBtn = $('btn-auto');
    autoBtn.classList.toggle('active', Boolean(settings?.autoTranslate));

    for (const btn of document.querySelectorAll('.segmented .seg-btn')) {
      btn.classList.toggle('active', btn.dataset.mode === uiState.globalMode);
    }

    // Reserve the slot instead of removing the button: it pops in exactly when a
    // translation starts, and adding/removing it re-wraps the toolbar — which
    // shifts the whole card list down by a header height mid-scroll.
    $('btn-translate-all').classList.toggle('is-placeholder', pendingCount === 0);
    $('btn-follow').classList.toggle('active', uiState.followLatest);
    $('btn-collapse-all').textContent = uiState.allCollapsed ? '展开' : '折叠';
  }

  // ---------- Feed rendering (incremental, scroll-stable) ----------
  //
  // Cards are reconciled *in place*: existing nodes are kept and patched field
  // by field instead of being rebuilt.  The previous implementation pushed
  // every child (including unchanged ones) into a DocumentFragment and only
  // then read `mainEl.scrollTop`; at that moment #feed was empty, the browser
  // had already clamped `scrollTop` to 0, and the value was written straight
  // back after `replaceChildren` — hence "jump to the very first card".
  const cardRefs = new WeakMap();

  function toolTagsInnerHtml(step) {
    const names = Array.isArray(step.toolNames) ? step.toolNames : [];
    if (names.length) {
      let html = names.slice(0, 3).map((t) => `<span class="tool-tag">${escapeHtml(t)}</span>`).join('');
      if (names.length > 3) html += `<span class="tool-tag">+${names.length - 3}</span>`;
      return html;
    }
    return step.hasReply ? '<span class="tool-tag">回复阶段</span>' : '';
  }

  function createCardNode(step) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.stepCard = String(step.stepIndex);
    card.innerHTML =
      `<div class="card-head">` +
        `<button type="button" class="card-head-left" data-action="toggle-collapse">` +
          `<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6"/></svg>` +
          `<span class="step-badge"></span>` +
          `<span class="time-label"></span>` +
          `<span class="tool-tags"></span>` +
          `<span class="tr-badge"></span>` +
        `</button>` +
        `<div class="card-actions">` +
          `<div class="mini-seg" role="group" aria-label="视图切换">` +
            `<button type="button" data-action="card-mode" data-mode="translation">译</button>` +
            `<button type="button" data-action="card-mode" data-mode="bilingual">双</button>` +
            `<button type="button" data-action="card-mode" data-mode="original">原</button>` +
          `</div>` +
          `<button type="button" class="card-btn" data-action="retry"></button>` +
          `<button type="button" class="card-btn" data-action="copy">复制</button>` +
        `</div>` +
      `</div>` +
      `<div class="card-body"></div>`;

    cardRefs.set(card, {
      badge: card.querySelector('.step-badge'),
      time: card.querySelector('.time-label'),
      tools: card.querySelector('.tool-tags'),
      trBadge: card.querySelector('.tr-badge'),
      modeBtns: [...card.querySelectorAll('[data-action="card-mode"]')],
      retry: card.querySelector('[data-action="retry"]'),
      body: card.querySelector('.card-body'),
      badgeText: '',
      timeText: null,
      toolsHtml: null,
      badgeCls: '',
      badgeLabel: '',
      actionLabel: '',
      bodyKey: '',
    });

    updateCardNode(card, step);
    return card;
  }

  function updateCardNode(card, step) {
    const refs = cardRefs.get(card);
    if (!refs) return;

    const keyStr = String(step.stepIndex);
    if (card.dataset.stepCard !== keyStr) card.dataset.stepCard = keyStr;

    const isCollapsed = uiState.collapsed.has(step.stepIndex);
    if (card.classList.contains('collapsed') !== isCollapsed) {
      card.classList.toggle('collapsed', isCollapsed);
    }

    const badgeText = `Step #${step.stepIndex}`;
    if (refs.badgeText !== badgeText) {
      refs.badgeText = badgeText;
      refs.badge.textContent = badgeText;
    }

    const timeStr = formatTime(step.createdAt);
    if (refs.timeText !== timeStr) {
      refs.timeText = timeStr;
      refs.time.textContent = timeStr;
      refs.time.classList.toggle('hidden', !timeStr);
    }

    const toolsHtml = toolTagsInnerHtml(step);
    if (refs.toolsHtml !== toolsHtml) {
      refs.toolsHtml = toolsHtml;
      refs.tools.innerHTML = toolsHtml;
      refs.tools.classList.toggle('hidden', !toolsHtml);
    }

    const badge = statusBadgeInfo(step);
    const badgeCls = `tr-badge ${badge.cls}`;
    if (refs.badgeCls !== badgeCls) {
      refs.badgeCls = badgeCls;
      refs.trBadge.className = badgeCls;
    }
    if (refs.badgeLabel !== badge.label) {
      refs.badgeLabel = badge.label;
      refs.trBadge.textContent = badge.label;
    }

    const mode = getEffectiveMode(step);
    for (const btn of refs.modeBtns) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    }

    const actionLabel =
      step.translationStatus === 'error'
        ? '重试'
        : step.translationStatus === 'pending' || step.translationStatus === 'skipped_zh'
          ? '翻译'
          : '重译';
    if (refs.actionLabel !== actionLabel) {
      refs.actionLabel = actionLabel;
      refs.retry.textContent = actionLabel;
    }
    refs.retry.classList.toggle('retry', step.translationStatus === 'error');

    // Rebuild the body only when the rendered content really changed: during
    // streaming that is once per new thought hash, not once per unrelated poll.
    const segments = Array.isArray(step.segments) ? step.segments : null;
    const bodyKey = [
      mode,
      step.translationStatus,
      step.provider || '',
      step.thoughtHash || '',
      step.error || '',
      segments ? segments.length : -1,
    ].join('|');
    if (refs.bodyKey !== bodyKey) {
      refs.bodyKey = bodyKey;
      refs.body.innerHTML = renderStepBodyHtml(step, mode);
    }
  }

  /**
   * Keyed reconcile: never empties #feed, so `scrollTop` is never clamped back
   * to 0 by the browser and node identity (selection, focus, anchor) survives.
   */
  function applyFeed(steps) {
    const feedEl = $('feed');
    const existing = new Map();
    for (const child of feedEl.children) {
      const key = child.dataset.stepCard;
      if (key !== undefined) existing.set(key, child);
    }

    const wanted = new Set();
    let cursor = feedEl.firstElementChild;

    for (const step of steps) {
      const keyStr = String(step.stepIndex);
      wanted.add(keyStr);

      let node = existing.get(keyStr);
      if (node) {
        updateCardNode(node, step);
      } else {
        node = createCardNode(step);
      }

      if (node === cursor) {
        cursor = cursor.nextElementSibling;
      } else {
        feedEl.insertBefore(node, cursor);
      }
    }

    for (const child of [...feedEl.children]) {
      if (!wanted.has(child.dataset.stepCard)) child.remove();
    }
  }

  // ---------- Scroll management ----------
  //
  // Rules enforced here:
  //  * Auto-follow only ever chases the bottom, and only while the reader has
  //    not taken over the wheel / touch gesture.
  //  * Nothing writes `scrollTop` while a wheel gesture is in flight — writing
  //    cancels Chromium's smooth wheel animation, which is what made fast
  //    wheeling feel non-linear and "snap" around.
  //  * When there is no anchor to hold on to, the position is kept as-is.
  //    Zeroing it here is what threw the reader back to the first card.

  const BOTTOM_EPS = 8;        // 「回到底部」按钮的隐藏阈值
  const RESUME_EPS = 2;        // 只有真正贴到底部才恢复自动跟随
  const WHEEL_ACTIVE_MS = 180; // 滚轮 / 触控手势冷却窗口
  const MIN_SHIFT_PX = 2;      // 小于该偏移视为抖动，绝不写 scrollTop

  const scrollState = {
    lastTop: 0,
    keepTop: 0,        // 非空列表里用户最后停留的位置
    pendingShift: 0,   // 攒够 MIN_SHIFT_PX 再一次性补偿，避免慢速漂移
    wheelAt: -1e9,     // 最近一次 wheel / touchmove 手势时间
    pinRaf: 0,
    pinSettleTimer: 0,
    resumeTimer: 0,
    scrollRaf: 0,
  };

  function nowMs() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  function gestureActive() {
    return nowMs() - scrollState.wheelAt < WHEEL_ACTIVE_MS;
  }

  function maxScrollTop(el) {
    return Math.max(0, el.scrollHeight - el.clientHeight);
  }

  function distanceToBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }

  function isNearBottom(el) {
    return distanceToBottom(el) <= BOTTOM_EPS;
  }

  function updateJumpButton() {
    $('btn-jump-latest').classList.toggle('hidden', isNearBottom($('main')));
  }

  /** The only place that writes `scrollTop`, so lastTop / keepTop never drift. */
  function setScrollTop(next) {
    const mainEl = $('main');
    const clamped = Math.min(maxScrollTop(mainEl), Math.max(0, next));
    if (Math.abs(clamped - mainEl.scrollTop) >= 0.5) mainEl.scrollTop = clamped;
    scrollState.lastTop = mainEl.scrollTop;
    scrollState.keepTop = mainEl.scrollTop;
    scrollState.pendingShift = 0;
  }

  function pinToBottom() {
    setScrollTop(maxScrollTop($('main')));
  }

  /** Catches up after a gesture settles instead of interrupting it. */
  function schedulePinSettle() {
    if (scrollState.pinSettleTimer) return;
    scrollState.pinSettleTimer = setTimeout(() => {
      scrollState.pinSettleTimer = 0;
      if (uiState.followLatest && !gestureActive()) pinToBottom();
      updateJumpButton();
    }, WHEEL_ACTIVE_MS + 40);
  }

  function requestPinToBottom() {
    if (gestureActive()) {
      schedulePinSettle();
      return;
    }
    pinToBottom();
  }

  /**
   * A gesture that ends right at the bottom should resume following — but only
   * after the gesture window closes, never in the middle of it.
   */
  function scheduleResumeCheck() {
    if (scrollState.resumeTimer) return;
    scrollState.resumeTimer = setTimeout(() => {
      scrollState.resumeTimer = 0;
      if (uiState.followLatest || gestureActive()) return;
      const mainEl = $('main');
      if (!$('feed').firstElementChild) return;
      if (distanceToBottom(mainEl) <= RESUME_EPS) setFollowLatest(true);
    }, WHEEL_ACTIVE_MS + 40);
  }

  function schedulePinToBottom() {
    if (scrollState.pinRaf) return;
    scrollState.pinRaf = requestAnimationFrame(() => {
      scrollState.pinRaf = 0;
      // A wheel gesture may have landed between the render and this frame.
      if (!uiState.followLatest) return;
      if (gestureActive()) {
        schedulePinSettle();
        return;
      }
      pinToBottom();
      updateJumpButton();
    });
  }

  function setFollowLatest(next) {
    if (uiState.followLatest === next) {
      updateJumpButton();
      return;
    }
    uiState.followLatest = next;
    updateHeaderControls();
    updateJumpButton();
  }

  /**
   * Remembers what the reader is actually looking at: the first visible block
   * inside the first visible card (falls back to the card itself).
   */
  function captureScrollAnchor() {
    const mainEl = $('main');
    const mainRect = mainEl.getBoundingClientRect();
    const snapshot = {
      top: mainEl.scrollTop,
      cardKey: null,
      cardDelta: 0,
      blockIndex: -1,
      blockDelta: 0,
      bodyKey: '',
    };

    for (const card of $('feed').children) {
      const cardRect = card.getBoundingClientRect();
      if (cardRect.bottom <= mainRect.top + 1) continue;

      snapshot.cardKey = card.dataset.stepCard;
      snapshot.cardDelta = cardRect.top - mainRect.top;

      const refs = cardRefs.get(card);
      const bodyEl = refs?.body;
      if (bodyEl) {
        const kids = bodyEl.children;
        for (let i = 0; i < kids.length; i += 1) {
          const rect = kids[i].getBoundingClientRect();
          if (rect.height === 0) continue;
          if (rect.bottom > mainRect.top + 1) {
            snapshot.blockIndex = i;
            snapshot.blockDelta = rect.top - mainRect.top;
            snapshot.bodyKey = refs.bodyKey;
            break;
          }
        }
      }
      break;
    }

    // Only trust a capture that actually found something (an empty #feed reads
    // scrollTop === 0 and must not overwrite the remembered position).
    if (snapshot.cardKey !== null) scrollState.keepTop = snapshot.top;

    return snapshot;
  }

  function restoreScrollAnchor(snapshot, { reset = false } = {}) {
    if (reset) {
      setScrollTop(0);
      return;
    }
    if (!snapshot) return;

    let shift = null;

    if (snapshot.cardKey !== null) {
      const mainEl = $('main');
      const card = [...$('feed').children].find((c) => c.dataset.stepCard === snapshot.cardKey);
      if (card) {
        const refs = cardRefs.get(card);
        const mainRect = mainEl.getBoundingClientRect();
        let anchorEl = null;
        let anchorDelta = 0;

        // Block-level anchoring is only trustworthy while the card still renders
        // the same body; otherwise fall back to the card's own top edge.
        if (snapshot.blockIndex >= 0 && refs && refs.bodyKey === snapshot.bodyKey) {
          const kid = refs.body.children[snapshot.blockIndex];
          if (kid) {
            anchorEl = kid;
            anchorDelta = snapshot.blockDelta;
          }
        }
        if (!anchorEl) {
          anchorEl = card;
          anchorDelta = snapshot.cardDelta;
        }

        const rect = anchorEl.getBoundingClientRect();
        shift = (rect.top - mainRect.top) - anchorDelta;
      }
    }

    if (shift === null) {
      // No usable anchor for *this* render (the list was momentarily empty, the
      // anchor card got filtered out, a layout read raced …). Hold the reader's
      // position, clamped to the new range. Never jump to the top from a poll.
      setScrollTop(scrollState.keepTop || snapshot.top || 0);
      return;
    }

    if (gestureActive()) {
      // The reader owns the wheel right now: stay out of the way (a write here
      // cancels Chromium's smooth wheel animation) and re-anchor on the next
      // render from wherever the gesture lands.
      scrollState.pendingShift = 0;
      return;
    }

    // Sub-pixel noise is accumulated instead of written: one write per render
    // is enough, and a skipped 1px must not slowly drift the view.
    scrollState.pendingShift += shift;
    if (Math.abs(scrollState.pendingShift) < MIN_SHIFT_PX) return;

    const delta = scrollState.pendingShift;
    scrollState.pendingShift = 0;
    setScrollTop($('main').scrollTop + delta);
  }

  function renderFeed() {
    const feedEl = $('feed');
    const emptyEl = $('empty-state');
    const steps = uiState.data?.steps || [];
    const q = uiState.searchQuery.trim().toLowerCase();
    // Consumed once: only an explicit context change (search / conversation
    // switch) may move the reader to the top. Polls never do.
    const resetScroll = uiState.pendingScrollReset;
    uiState.pendingScrollReset = false;

    const filtered = q
      ? steps.filter((s) => {
          const hay = [
            `step ${s.stepIndex}`,
            s.thinking,
            s.translatedText || '',
            ...(s.toolNames || []),
          ]
            .join('\n')
            .toLowerCase();
          return hay.includes(q);
        })
      : steps;

    updateHeaderControls();

    if (!filtered.length) {
      if (feedEl.firstElementChild) feedEl.replaceChildren();
      emptyEl.classList.remove('hidden');
      $('empty-desc').textContent = q
        ? '没有匹配筛选关键词的思考步骤。'
        : uiState.conversationId
          ? '当 Agent 开始思考并输出推理链时，这里会自动同步并翻译为简体中文。'
          : '未绑定到具体对话，可在上方下拉框选择最近会话。';
      // An emptied list clamps scrollTop to 0 by itself; keep the remembered
      // position so the next non-empty render can put the reader back.
      if (resetScroll) {
        scrollState.keepTop = 0;
        scrollState.lastTop = 0;
      }
      return;
    }

    emptyEl.classList.add('hidden');

    // Snapshot the reader's position *before* touching the DOM.
    const snapshot = uiState.followLatest || resetScroll ? null : captureScrollAnchor();

    applyFeed(filtered);

    if (uiState.followLatest) {
      // Pin before paint so new content never flashes the old position ...
      requestPinToBottom();
      // ... and once more next frame in case wrapping / fonts settled late.
      schedulePinToBottom();
      updateJumpButton();
      return;
    }

    restoreScrollAnchor(snapshot, { reset: resetScroll });
    updateJumpButton();
  }

  // ---------- Polling & Conversations ----------
  async function refreshConversations() {
    try {
      const res = await apiFetch('/api/conversations', { method: 'GET' });
      const select = $('conv-select');
      const convs = res.conversations || [];
      if (!uiState.conversationId && convs.length) {
        uiState.conversationId = res.currentConversationId || convs[0].id;
      }
      const options = [];
      if (uiState.conversationId && !convs.some((c) => c.id === uiState.conversationId)) {
        options.push(`<option value="${escapeHtml(uiState.conversationId)}">当前会话 (${escapeHtml(uiState.conversationId.slice(0, 8))})</option>`);
      }
      for (const c of convs) {
        const prefix = c.id === (window.sidecar?.conversationId || res.currentConversationId) ? '★ ' : '';
        options.push(`<option value="${escapeHtml(c.id)}">${escapeHtml(prefix + c.title)}</option>`);
      }
      if (!options.length) {
        options.push('<option value="">无可用会话</option>');
      }
      select.innerHTML = options.join('');
      select.value = uiState.conversationId || '';
    } catch {
      // Ignore conversation list errors cleanly.
    }
  }

  let initialSettingsApplied = false;

  async function pollState(forceRefresh = false) {
    try {
      const qs = new URLSearchParams();
      if (uiState.conversationId) qs.set('conversationId', uiState.conversationId);
      if (!forceRefresh && uiState.etag) qs.set('etag', uiState.etag);

      const res = await apiFetch(`/api/state?${qs.toString()}`, { method: 'GET' });
      if (!res.unchanged) {
        uiState.etag = res.etag || '';
        uiState.data = res;
        if (!initialSettingsApplied && res.settings?.defaultViewMode) {
          uiState.globalMode = res.settings.defaultViewMode;
          initialSettingsApplied = true;
        }
        renderFeed();
      }
    } catch {
      // Keep last good state visible during transient restart.
    } finally {
      const hasTranslating = (uiState.data?.steps || []).some((s) => s.translationStatus === 'translating');
      clearTimeout(uiState.pollTimer);
      uiState.pollTimer = setTimeout(() => pollState(false), hasTranslating ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    }
  }

  // ---------- Event Handlers ----------
  $('feed').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    // Cards are reused in place, so the owning step is read from the card
    // (`data-step-card`) instead of a per-button `data-step` attribute.
    const cardEl = btn.closest('[data-step-card]');
    const stepIndex = Number(btn.dataset.step ?? cardEl?.dataset.stepCard);
    if (!Number.isFinite(stepIndex)) return;
    const step = (uiState.data?.steps || []).find((s) => s.stepIndex === stepIndex);
    if (!step) return;

    if (action === 'toggle-collapse') {
      if (uiState.collapsed.has(stepIndex)) {
        uiState.collapsed.delete(stepIndex);
      } else {
        uiState.collapsed.add(stepIndex);
      }
      renderFeed();
      return;
    }

    if (action === 'card-mode') {
      uiState.perCardMode.set(stepIndex, btn.dataset.mode);
      renderFeed();
      return;
    }

    if (action === 'copy') {
      const mode = getEffectiveMode(step);
      const text = getCopyText(step, mode);
      try {
        await navigator.clipboard.writeText(text);
        showToast('已复制到剪贴板');
      } catch {
        showToast('复制失败');
      }
      return;
    }

    if (action === 'retry') {
      btn.disabled = true;
      btn.textContent = '翻译中…';
      try {
        await apiFetch('/api/translate', {
          method: 'POST',
          body: JSON.stringify({
            conversationId: uiState.conversationId,
            stepIndex,
            force: true,
          }),
        });
        await pollState(true);
      } catch (err) {
        showToast(`翻译失败: ${err.message}`);
        await pollState(true);
      }
    }
  });

  for (const btn of document.querySelectorAll('.segmented .seg-btn')) {
    btn.addEventListener('click', () => {
      uiState.globalMode = btn.dataset.mode;
      uiState.perCardMode.clear();
      renderFeed();
    });
  }

  $('btn-auto').addEventListener('click', async () => {
    const next = !uiState.data?.settings?.autoTranslate;
    try {
      await apiFetch('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ autoTranslate: next }),
      });
      await pollState(true);
      showToast(next ? '已开启自动翻译' : '已切换为手动翻译');
    } catch (err) {
      showToast(`切换失败: ${err.message}`);
    }
  });

  $('btn-translate-all').addEventListener('click', async () => {
    const btn = $('btn-translate-all');
    btn.disabled = true;
    try {
      await apiFetch('/api/translate', {
        method: 'POST',
        body: JSON.stringify({ conversationId: uiState.conversationId, force: false }),
      });
      await pollState(true);
      showToast('全部步骤已翻译');
    } catch (err) {
      showToast(`翻译中断: ${err.message}`);
      await pollState(true);
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-collapse-all').addEventListener('click', () => {
    const steps = uiState.data?.steps || [];
    uiState.allCollapsed = !uiState.allCollapsed;
    uiState.collapsed.clear();
    if (uiState.allCollapsed) {
      for (const s of steps) uiState.collapsed.add(s.stepIndex);
    }
    renderFeed();
  });

  $('btn-follow').addEventListener('click', () => {
    const next = !uiState.followLatest;
    uiState.followLatest = next;
    updateHeaderControls();
    if (next) {
      pinToBottom();
      schedulePinToBottom();
    }
    updateJumpButton();
  });

  $('btn-jump-latest').addEventListener('click', () => {
    uiState.followLatest = true;
    updateHeaderControls();
    pinToBottom();
    updateJumpButton();
  });

  // Coalesced to one handler per frame: it reads layout (scrollHeight), so it
  // must not run per wheel tick, and it must never write scrollTop itself.
  $('main').addEventListener('scroll', () => {
    if (scrollState.scrollRaf) return;
    scrollState.scrollRaf = requestAnimationFrame(() => {
      scrollState.scrollRaf = 0;
      const el = $('main');
      const hasCards = Boolean($('feed').firstElementChild);
      const top = el.scrollTop;
      const movedUp = top < scrollState.lastTop - 2;
      scrollState.lastTop = top;

      // An emptied list clamps scrollTop to 0; that is not the reader moving.
      if (!hasCards) {
        updateJumpButton();
        return;
      }
      scrollState.keepTop = top;

      if (movedUp) {
        // Any way of moving up (wheel, scrollbar drag, keyboard) stops following.
        // Content growth never counts — it does not change scrollTop.
        if (uiState.followLatest) setFollowLatest(false);
      } else if (!uiState.followLatest && distanceToBottom(el) <= RESUME_EPS) {
        // Only a real bottom re-enables following, and never while a wheel
        // gesture is still settling — otherwise a 1-notch scroll-up near the
        // bottom instantly re-arms auto-follow and the next poll jumps to the
        // newest translated card. Inside the window, decide once it closes.
        if (gestureActive()) scheduleResumeCheck();
        else setFollowLatest(true);
      }
      updateJumpButton();
    });
  }, { passive: true });

  // Any wheel tick (either direction) marks the gesture window. Nothing else in
  // this file writes scrollTop during it, so Chromium's smooth wheel animation
  // is never interrupted. Wheel-up additionally drops follow before the next
  // paint, so no pending render can pull the view back.
  $('main').addEventListener('wheel', (e) => {
    scrollState.wheelAt = nowMs();
    scrollState.pendingShift = 0;
    if (e.ctrlKey || e.deltaY >= 0) return;
    const el = $('main');
    if (maxScrollTop(el) <= 4) return;
    if (uiState.followLatest) setFollowLatest(false);
  }, { passive: true });

  let touchY = 0;
  $('main').addEventListener('touchstart', (e) => {
    scrollState.wheelAt = nowMs();
    touchY = e.touches[0] ? e.touches[0].clientY : 0;
  }, { passive: true });
  $('main').addEventListener('touchmove', (e) => {
    scrollState.wheelAt = nowMs();
    const y = e.touches[0] ? e.touches[0].clientY : 0;
    if (y - touchY > 6 && uiState.followLatest) setFollowLatest(false);
    touchY = y;
  }, { passive: true });

  // Web font swap can change card heights after paint; re-pin if still following.
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      if (uiState.followLatest) requestPinToBottom();
    }).catch(() => {});
  }

  $('search-input').addEventListener('input', (e) => {
    const next = e.target.value;
    if (next === uiState.searchQuery) return;
    uiState.searchQuery = next;
    // Filtering is a deliberate context change: show the matches from the top
    // and stop chasing the newest card (it would jump there on the next poll).
    uiState.pendingScrollReset = true;
    if (uiState.followLatest) setFollowLatest(false);
    renderFeed();
  });

  $('conv-select').addEventListener('change', (e) => {
    uiState.conversationId = e.target.value;
    uiState.etag = '';
    uiState.collapsed.clear();
    uiState.perCardMode.clear();
    // Different transcript: a held position from the old one is meaningless.
    uiState.pendingScrollReset = true;
    pollState(true);
  });

  // ---------- Settings Modal ----------
  function syncOpenAiFieldsVisibility() {
    $('cfg-openai-group').classList.toggle('hidden', $('cfg-provider').value !== 'openai');
  }

  function openSettings() {
    const s = uiState.data?.settings || {};
    $('cfg-provider').value = s.provider || 'bing';
    $('cfg-view-mode').value = s.defaultViewMode || 'translation';
    $('cfg-skip-zh').checked = s.skipChinese !== false;
    $('cfg-inline-hook').checked = s.inlineHook !== false;
    $('cfg-base-url').value = s.openai?.baseUrl || 'https://api.deepseek.com/v1';
    $('cfg-model').value = s.openai?.model || 'deepseek-chat';
    $('cfg-api-key').value = s.openai?.apiKeyPreview || '';
    $('cfg-key-hint').textContent = s.openai?.apiKeySet ? '(已配置)' : '';
    $('cfg-cache-info').textContent = `缓存: ${s.cacheCount ?? 0} 条`;
    $('cfg-test-result').classList.add('hidden');
    syncOpenAiFieldsVisibility();
    $('settings-backdrop').classList.remove('hidden');
  }

  function closeSettings() {
    $('settings-backdrop').classList.add('hidden');
  }

  $('btn-settings').addEventListener('click', openSettings);
  $('btn-close-settings').addEventListener('click', closeSettings);
  $('settings-backdrop').addEventListener('click', (e) => {
    if (e.target === $('settings-backdrop')) closeSettings();
  });
  $('cfg-provider').addEventListener('change', syncOpenAiFieldsVisibility);

  for (const chip of document.querySelectorAll('.chip-btn')) {
    chip.addEventListener('click', () => {
      const preset = chip.dataset.preset;
      if (preset === 'deepseek') {
        $('cfg-base-url').value = 'https://api.deepseek.com/v1';
        $('cfg-model').value = 'deepseek-chat';
      } else if (preset === 'ollama') {
        $('cfg-base-url').value = 'http://127.0.0.1:11434/v1';
        $('cfg-model').value = 'qwen2.5:7b';
      } else if (preset === 'openai') {
        $('cfg-base-url').value = 'https://api.openai.com/v1';
        $('cfg-model').value = 'gpt-4o-mini';
      }
    });
  }

  function collectSettingsPayload() {
    return {
      provider: $('cfg-provider').value,
      defaultViewMode: $('cfg-view-mode').value,
      skipChinese: $('cfg-skip-zh').checked,
      inlineHook: $('cfg-inline-hook').checked,
      openai: {
        baseUrl: $('cfg-base-url').value.trim(),
        model: $('cfg-model').value.trim(),
        apiKey: $('cfg-api-key').value.trim(),
      },
    };
  }

  $('btn-test-provider').addEventListener('click', async () => {
    const resEl = $('cfg-test-result');
    resEl.className = 'test-result';
    resEl.textContent = '正在测试翻译连接…';
    resEl.classList.remove('hidden');
    try {
      const res = await apiFetch('/api/test-provider', {
        method: 'POST',
        body: JSON.stringify(collectSettingsPayload()),
      });
      resEl.className = 'test-result ok';
      resEl.textContent = `连接成功！示例译文：${res.translatedText}`;
    } catch (err) {
      resEl.className = 'test-result err';
      resEl.textContent = `连接失败：${err.message}`;
    }
  });

  $('btn-clear-cache').addEventListener('click', async () => {
    try {
      await apiFetch('/api/cache/clear', { method: 'POST', body: '{}' });
      $('cfg-cache-info').textContent = '缓存: 0 条';
      await pollState(true);
      showToast('已清空本地翻译缓存');
    } catch (err) {
      showToast(`清理失败: ${err.message}`);
    }
  });

  $('btn-save-settings').addEventListener('click', async () => {
    const payload = collectSettingsPayload();
    try {
      const res = await apiFetch('/api/settings', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      uiState.globalMode = res.settings.defaultViewMode;
      uiState.perCardMode.clear();
      closeSettings();
      await pollState(true);
      showToast('设置已保存');
    } catch (err) {
      showToast(`保存失败: ${err.message}`);
    }
  });

  // Start initial sync.
  refreshConversations();
  pollState(true);
  setInterval(refreshConversations, 8000);
})();
