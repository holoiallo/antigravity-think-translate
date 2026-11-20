/*
 * Think Translate frontend (Multi-Stream In-Place Translation UX).
 *
 * Supports:
 * 1. Three live translation tabs:
 *    - 💭 主思考 (Main conversation thinking steps)
 *    - 💬 侧边栏提问 (Side Questions /btw thinking & replies, ask_question cards, Subagents)
 *    - 🐝 Swarm 多智能体 (Swarm Overview/Plan, Message Board board.jsonl, Worker Thinking)
 * 2. ⚡ 智能跟随 (Smart Auto-Follow): automatically switches to whichever stream
 *    produces new content and pins to the latest card, with unread badges when paused.
 * 3. Per-card & global 译文 / 双语 / 原文 toggles, clickable #seq Swarm citations,
 *    @mention highlighting, code protection, and scroll-stable incremental DOM updates.
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
    activeTab: 'main', // 'main' | 'side' | 'swarm'
    unreadTabs: new Set(),
    prevStreamHeads: { main: '', side: '', swarm: '' },
    initialStreamSnapDone: false,
    smartFollow: true,
    globalMode: 'translation', // 'translation' | 'bilingual' | 'original'
    perCardMode: new Map(), // item.id -> 'translation' | 'bilingual' | 'original'
    collapsed: new Set(), // item.id
    searchQuery: '',
    followLatest: true,
    allCollapsed: false,
    pendingScrollReset: false,
    // Side tab filters
    sideSourceFilter: '', // '' = all, or sourceId
    sideLayers: new Set(['thinking', 'reply', 'ask']),
    // Swarm tab filters
    swarmMemberFilter: '', // '' = all, or agent name
    swarmLayers: new Set(['overview', 'board', 'worker_thinking']),
    pollTimer: null,
    toastTimer: null,
  };

  const TAB_NAMES = {
    main: '💭 主思考',
    side: '💬 侧边栏提问',
    swarm: '🐝 Swarm 多智能体',
  };

  // Deterministic agent color palette for Swarm members
  const AGENT_COLORS = [
    '#2563eb', '#16a34a', '#9333ea', '#db2777', '#0891b2',
    '#4f46e5', '#ea580c', '#0d9488', '#7c3aed', '#e11d48',
  ];
  function colorForAgent(name) {
    if (!name) return '#3b82f6';
    if (name === 'coordinator') return '#d97706';
    let h = 7;
    for (let i = 0; i < name.length; i++) {
      h = (h * 31 + name.charCodeAt(i)) >>> 0;
    }
    return AGENT_COLORS[h % AGENT_COLORS.length];
  }

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

  function showToast(msg, durationMs = 2200) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(uiState.toastTimer);
    uiState.toastTimer = setTimeout(() => el.classList.add('hidden'), durationMs);
  }

  // ---------- Safe Markdown, @mentions & #seq citations ----------
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function decorateInlineTokens(escapedHtml, { enableSeqRefs = false } = {}) {
    // Highlight @mentions and @#channel (even when adjacent to CJK characters)
    let out = escapedHtml.replace(
      /(^|[^A-Za-z0-9_-])(@#?[A-Za-z0-9_.-]+?)(?=$|[^A-Za-z0-9_.-]|\.(?:\s|$))/g,
      (all, pre, mention) => `${pre}<span class="mention-pill">${mention}</span>`
    );
    // Highlight #seq citations in Swarm tab (even when adjacent to CJK characters like "修复了#13中")
    if (enableSeqRefs) {
      out = out.replace(
        /(^|[^A-Za-z0-9_&#/-])#([1-9]\d{0,5})(?![A-Za-z0-9_-])/g,
        (all, pre, digits) =>
          `${pre}<button type="button" class="seq-ref-btn" data-action="jump-seq" data-seq="${digits}" title="跳转到 Swarm 消息 #${digits}">#${digits}</button>`
      );
    }
    return out;
  }

  function renderProseMarkdown(raw, { enableSeqRefs = false } = {}) {
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
      s = decorateInlineTokens(s, { enableSeqRefs });
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

  function formatTime(isoOrStr) {
    if (!isoOrStr) return '';
    const d = new Date(String(isoOrStr).replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) return String(isoOrStr).slice(11, 19);
    return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function statusBadgeInfo(item) {
    switch (item.translationStatus) {
      case 'done': {
        const providerName = item.provider === 'openai' ? 'LLM' : item.provider === 'google' ? 'Google' : 'Bing';
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

  function getEffectiveMode(item) {
    const requested = uiState.perCardMode.get(item.id) || uiState.globalMode;
    if (item.translationStatus !== 'done') {
      return requested === 'original' ? 'original' : requested;
    }
    return requested;
  }

  function renderItemBodyHtml(item, mode) {
    const parts = [];
    const enableSeqRefs = item.tab === 'swarm';

    if (item.promptPreview) {
      parts.push(
        `<div class="prompt-context-bar" title="${escapeHtml(item.promptPreview)}">` +
          `提问上下文：${escapeHtml(item.promptPreview)}` +
        `</div>`
      );
    }

    if (item.translationStatus === 'error' && item.error) {
      parts.push(
        `<div class="error-banner">` +
          `<span>翻译失败（已保留原文）：${escapeHtml(item.error)}</span>` +
          `<button type="button" class="card-btn retry" data-action="retry">重试</button>` +
        `</div>`
      );
    } else if (item.translationStatus === 'translating' && mode !== 'original') {
      parts.push(`<div class="translating-banner">正在实时翻译为简体中文，以下先展示原文…</div>`);
    }

    const segments = Array.isArray(item.segments) && item.segments.length
      ? item.segments
      : splitFallbackParagraphs(item.thinking);

    if (mode === 'original' || item.translationStatus !== 'done') {
      for (const seg of segments) {
        parts.push(seg.type === 'code' ? renderCodeBlock(seg.src) : renderProseMarkdown(seg.src, { enableSeqRefs }));
      }
      return parts.join('');
    }

    if (mode === 'translation') {
      for (const seg of segments) {
        parts.push(seg.type === 'code' ? renderCodeBlock(seg.src) : renderProseMarkdown(seg.dst || seg.src, { enableSeqRefs }));
      }
      return parts.join('');
    }

    // Bilingual mode: interleave source paragraph and Chinese translation paragraph in-place
    for (const seg of segments) {
      if (seg.type === 'code') {
        parts.push(renderCodeBlock(seg.src));
      } else {
        parts.push(
          `<div class="bilingual-pair">` +
            `<div class="bilingual-src">${renderProseMarkdown(seg.src, { enableSeqRefs })}</div>` +
            `<div class="bilingual-dst">${renderProseMarkdown(seg.dst || seg.src, { enableSeqRefs })}</div>` +
          `</div>`
        );
      }
    }
    return parts.join('');
  }

  function getCopyText(item, mode) {
    if (mode === 'original' || item.translationStatus !== 'done') {
      return item.thinking;
    }
    if (mode === 'translation') {
      return item.translatedText || item.thinking;
    }
    const segs = item.segments || [];
    return segs
      .map((s) => (s.type === 'code' ? s.src : `${s.src}\n${s.dst}`))
      .join('\n\n');
  }

  // ---------- Active Tab Items & Filtering ----------
  function getRawItemsForTab(tab) {
    if (!uiState.data) return [];
    if (tab === 'side') return uiState.data.sideItems || [];
    if (tab === 'swarm') return uiState.data.swarm?.items || [];
    return uiState.data.mainSteps || uiState.data.steps || [];
  }

  function getFilteredItemsForActiveTab() {
    const raw = getRawItemsForTab(uiState.activeTab);
    const q = uiState.searchQuery.trim().toLowerCase();

    return raw.filter((item) => {
      if (uiState.activeTab === 'side') {
        if (uiState.sideSourceFilter) {
          if (uiState.sideSourceFilter === 'cat:ask_question') {
            if (item.category !== 'ask_question') return false;
          } else if (item.sourceId !== uiState.sideSourceFilter) {
            return false;
          }
        }
        const isAsk = item.kind === 'ask_question';
        const isReply = item.kind === 'side_question_reply' || item.kind === 'subagent_reply' || item.kind === 'subagent_brief' || item.kind === 'side_question_prompt';
        const isThink = item.kind === 'side_question_thinking' || item.kind === 'subagent_thinking';
        if (isAsk && !uiState.sideLayers.has('ask')) return false;
        if (isReply && !uiState.sideLayers.has('reply')) return false;
        if (isThink && !uiState.sideLayers.has('thinking')) return false;
      } else if (uiState.activeTab === 'swarm') {
        if (item.category && !uiState.swarmLayers.has(item.category)) {
          return false;
        }
        if (uiState.swarmMemberFilter && item.kind !== 'swarm_overview') {
          const matchesAgent = item.agent === uiState.swarmMemberFilter;
          const matchesMention = Array.isArray(item.mentions) && item.mentions.includes(uiState.swarmMemberFilter);
          if (!matchesAgent && !matchesMention) return false;
        }
      }

      if (q) {
        const hay = [
          item.badgeLabel || '',
          item.sourceTitle || '',
          item.agent ? `@${item.agent}` : '',
          item.promptPreview || '',
          item.thinking || '',
          item.translatedText || '',
          ...(item.toolNames || []),
          ...(item.mentions || []),
        ]
          .join('\n')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }

      return true;
    });
  }

  // ---------- Render Header, Tabs & Subbars ----------
  function renderSubbars() {
    const sideBar = $('side-subbar');
    const swarmBar = $('swarm-subbar');

    sideBar.classList.toggle('hidden', uiState.activeTab !== 'side');
    swarmBar.classList.toggle('hidden', uiState.activeTab !== 'swarm');

    if (uiState.activeTab === 'side') {
      const sources = uiState.data?.sideSources || [];
      const totalCount = (uiState.data?.sideItems || []).length;
      if (uiState.sideSourceFilter && !sources.some((s) => s.id === uiState.sideSourceFilter)) {
        uiState.sideSourceFilter = '';
      }

      const chips = [
        `<button type="button" class="filter-chip ${uiState.sideSourceFilter === '' ? 'active' : ''}" data-side-source="">` +
          `<span class="chip-label">全部来源</span><span class="chip-num">${totalCount}</span>` +
        `</button>`,
      ];
      for (const src of sources) {
        const active = uiState.sideSourceFilter === src.id;
        chips.push(
          `<button type="button" class="filter-chip ${active ? 'active' : ''}" data-side-source="${escapeHtml(src.id)}" title="${escapeHtml(src.title)}">` +
            `<span class="chip-label">${escapeHtml(src.title)}</span>` +
            `<span class="chip-num">${src.count}</span>` +
          `</button>`
        );
      }
      const stripEl = $('side-source-chips');
      const nextHtml = chips.join('');
      if (stripEl.innerHTML !== nextHtml) stripEl.innerHTML = nextHtml;

      for (const btn of sideBar.querySelectorAll('[data-side-layer]')) {
        btn.classList.toggle('active', uiState.sideLayers.has(btn.dataset.sideLayer));
      }
    }

    if (uiState.activeTab === 'swarm') {
      const swarm = uiState.data?.swarm || { exists: false, title: '', members: [], items: [] };
      $('swarm-bar-title').textContent = swarm.title || 'Swarm 多智能体协作';

      const members = swarm.members || [];
      if (uiState.swarmMemberFilter && !members.some((m) => m.name === uiState.swarmMemberFilter)) {
        uiState.swarmMemberFilter = '';
      }

      const workingCount = members.filter((m) => m.status === 'working').length;
      const waitingCount = members.filter((m) => m.status === 'waiting').length;
      const killedCount = members.filter((m) => m.status === 'killed').length;
      const statsParts = [];
      if (workingCount) statsParts.push(`${workingCount} 运行中`);
      if (waitingCount) statsParts.push(`${waitingCount} 等待中`);
      if (killedCount) statsParts.push(`${killedCount} 已结束`);
      $('swarm-bar-stats').textContent = statsParts.length ? `· ${statsParts.join(' / ')}` : '';

      const chips = [
        `<button type="button" class="filter-chip ${uiState.swarmMemberFilter === '' ? 'active' : ''}" data-swarm-member="">` +
          `<span class="chip-label">全部成员</span><span class="chip-num">${(swarm.items || []).length}</span>` +
        `</button>`,
      ];

      for (const m of members) {
        const active = uiState.swarmMemberFilter === m.name;
        const count = (m.postsCount || 0) + (m.thinkingCount || 0);
        const statusText = m.status === 'working' ? '运行中' : m.status === 'killed' ? '已终止' : '等待中';
        const tip = `@${m.name} (${m.role}${m.model ? ' · ' + m.model : ''}) · ${statusText}\n发言: ${m.postsCount || 0} · 思考步: ${m.thinkingCount || 0}`;
        chips.push(
          `<button type="button" class="filter-chip ${active ? 'active' : ''} ${m.killed ? 'killed' : ''}" data-swarm-member="${escapeHtml(m.name)}" title="${escapeHtml(tip)}">` +
            `<span class="member-dot ${escapeHtml(m.status || 'waiting')}"></span>` +
            `<span class="chip-label">@${escapeHtml(m.name)}</span>` +
            `<span class="chip-num">${count}</span>` +
          `</button>`
        );
      }

      const stripEl = $('swarm-member-chips');
      const nextHtml = chips.join('');
      if (stripEl.innerHTML !== nextHtml) stripEl.innerHTML = nextHtml;

      for (const btn of swarmBar.querySelectorAll('[data-swarm-layer]')) {
        btn.classList.toggle('active', uiState.swarmLayers.has(btn.dataset.swarmLayer));
      }
    }
  }

  function updateHeaderControls() {
    const settings = uiState.data?.settings;
    const mainSteps = uiState.data?.mainSteps || uiState.data?.steps || [];
    const sideItems = uiState.data?.sideItems || [];
    const swarmItems = uiState.data?.swarm?.items || [];
    const allItems = [...mainSteps, ...sideItems, ...swarmItems];

    const activeItems = getRawItemsForTab(uiState.activeTab);
    const translatingCount = allItems.filter((s) => s.translationStatus === 'translating').length;
    const pendingCount = activeItems.filter((s) => s.translationStatus === 'pending' || s.translationStatus === 'error').length;

    const pill = $('status-pill');
    const statusText = $('status-text');
    pill.classList.remove('translating', 'idle');
    if (translatingCount > 0) {
      pill.classList.add('translating');
      statusText.textContent = `翻译中 (${translatingCount})`;
    } else if (!settings?.autoTranslate) {
      pill.classList.add('idle');
      statusText.textContent = `手动模式 · ${activeItems.length} 条`;
    } else {
      statusText.textContent = `实时同步 · ${allItems.length} 条`;
    }

    $('btn-auto').classList.toggle('active', Boolean(settings?.autoTranslate));
    $('btn-smart-follow').classList.toggle('active', Boolean(uiState.smartFollow));

    for (const btn of document.querySelectorAll('.segmented .seg-btn')) {
      btn.classList.toggle('active', btn.dataset.mode === uiState.globalMode);
    }

    // Update stream tabs & unread indicators
    $('tab-count-main').textContent = String(mainSteps.length);
    $('tab-count-side').textContent = String(sideItems.length);
    $('tab-count-swarm').textContent = String(swarmItems.length);

    for (const tabBtn of document.querySelectorAll('.stream-tab')) {
      const tab = tabBtn.dataset.tab;
      const isActive = tab === uiState.activeTab;
      tabBtn.classList.toggle('active', isActive);
      tabBtn.setAttribute('aria-selected', String(isActive));
      const unreadEl = $(`tab-unread-${tab}`);
      if (unreadEl) {
        unreadEl.classList.toggle('hidden', isActive || !uiState.unreadTabs.has(tab));
      }
    }

    $('btn-translate-all').classList.toggle('is-placeholder', pendingCount === 0);
    $('btn-follow').classList.toggle('active', uiState.followLatest);
    $('btn-collapse-all').textContent = uiState.allCollapsed ? '展开' : '折叠';

    renderSubbars();
  }

  // ---------- Feed rendering (incremental, scroll-stable) ----------
  const cardRefs = new WeakMap();

  function buildMetaTagsHtml(item) {
    const parts = [];

    if (item.sourceTitle && item.kind !== 'swarm_post' && item.kind !== 'swarm_worker_thinking') {
      parts.push(`<span class="source-pill" title="${escapeHtml(item.sourceTitle)}">${escapeHtml(item.sourceTitle)}</span>`);
    }

    if (item.kind === 'swarm_post') {
      if (item.channel && item.channel !== 'main') {
        parts.push(`<span class="channel-pill">#${escapeHtml(item.channel)}</span>`);
      }
      const recipients = [];
      if (Array.isArray(item.mentions)) {
        for (const m of item.mentions) {
          if (m !== item.agent) recipients.push(`@${escapeHtml(m)}`);
        }
      }
      if (Array.isArray(item.channelMentions)) {
        for (const ch of item.channelMentions) {
          recipients.push(`@#${escapeHtml(ch)}`);
        }
      }
      if (item.isAll) recipients.push('@all');
      if (recipients.length) {
        parts.push(
          `<span class="recipient-tags">→ ${recipients
            .slice(0, 4)
            .map((r) => `<span class="recipient-pill">${r}</span>`)
            .join('')}${recipients.length > 4 ? `<span class="recipient-pill">+${recipients.length - 4}</span>` : ''}</span>`
        );
      }
    }

    if (item.kind === 'swarm_worker_thinking' && item.agentModel) {
      parts.push(`<span class="tool-tag">${escapeHtml(item.agentModel)}</span>`);
    }

    const names = Array.isArray(item.toolNames) ? item.toolNames : [];
    if (names.length) {
      let html = names.slice(0, 3).map((t) => `<span class="tool-tag">${escapeHtml(t)}</span>`).join('');
      if (names.length > 3) html += `<span class="tool-tag">+${names.length - 3}</span>`;
      parts.push(html);
    } else if (item.kind === 'main_thinking' && item.hasReply) {
      parts.push('<span class="tool-tag">回复阶段</span>');
    }

    return parts.join('');
  }

  function createCardNode(item) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.itemCard = item.id;
    card.innerHTML =
      `<div class="card-head">` +
        `<button type="button" class="card-head-left" data-action="toggle-collapse">` +
          `<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6"/></svg>` +
          `<span class="avatar-slot"></span>` +
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
      avatarSlot: card.querySelector('.avatar-slot'),
      badge: card.querySelector('.step-badge'),
      time: card.querySelector('.time-label'),
      tools: card.querySelector('.tool-tags'),
      trBadge: card.querySelector('.tr-badge'),
      modeBtns: [...card.querySelectorAll('[data-action="card-mode"]')],
      retry: card.querySelector('[data-action="retry"]'),
      body: card.querySelector('.card-body'),
      avatarHtml: null,
      badgeText: '',
      timeText: null,
      toolsHtml: null,
      badgeCls: '',
      badgeLabel: '',
      actionLabel: '',
      bodyKey: '',
    });

    updateCardNode(card, item);
    return card;
  }

  function updateCardNode(card, item) {
    const refs = cardRefs.get(card);
    if (!refs) return;

    if (card.dataset.itemCard !== item.id) card.dataset.itemCard = item.id;
    if (card.dataset.kind !== (item.kind || '')) card.dataset.kind = item.kind || '';

    if (item.agent) {
      card.style.setProperty('--agent-hue', colorForAgent(item.agent));
    } else {
      card.style.removeProperty('--agent-hue');
    }

    const isCollapsed = uiState.collapsed.has(item.id);
    if (card.classList.contains('collapsed') !== isCollapsed) {
      card.classList.toggle('collapsed', isCollapsed);
    }

    const avatarHtml =
      item.kind === 'swarm_post' || item.kind === 'swarm_worker_thinking'
        ? `<span class="swarm-av" aria-hidden="true">${escapeHtml((item.agent || '?').charAt(0).toUpperCase())}</span>`
        : '';
    if (refs.avatarHtml !== avatarHtml) {
      refs.avatarHtml = avatarHtml;
      refs.avatarSlot.innerHTML = avatarHtml;
      refs.avatarSlot.classList.toggle('hidden', !avatarHtml);
    }

    const badgeText = item.badgeLabel || `Step #${item.stepIndex}`;
    if (refs.badgeText !== badgeText) {
      refs.badgeText = badgeText;
      refs.badge.textContent = badgeText;
    }

    const timeStr = formatTime(item.timeLabel || item.createdAt);
    if (refs.timeText !== timeStr) {
      refs.timeText = timeStr;
      refs.time.textContent = timeStr;
      refs.time.classList.toggle('hidden', !timeStr);
    }

    const toolsHtml = buildMetaTagsHtml(item);
    if (refs.toolsHtml !== toolsHtml) {
      refs.toolsHtml = toolsHtml;
      refs.tools.innerHTML = toolsHtml;
      refs.tools.classList.toggle('hidden', !toolsHtml);
    }

    const badge = statusBadgeInfo(item);
    const badgeCls = `tr-badge ${badge.cls}`;
    if (refs.badgeCls !== badgeCls) {
      refs.badgeCls = badgeCls;
      refs.trBadge.className = badgeCls;
    }
    if (refs.badgeLabel !== badge.label) {
      refs.badgeLabel = badge.label;
      refs.trBadge.textContent = badge.label;
    }

    const mode = getEffectiveMode(item);
    for (const btn of refs.modeBtns) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    }

    const actionLabel =
      item.translationStatus === 'error'
        ? '重试'
        : item.translationStatus === 'pending' || item.translationStatus === 'skipped_zh'
          ? '翻译'
          : '重译';
    if (refs.actionLabel !== actionLabel) {
      refs.actionLabel = actionLabel;
      refs.retry.textContent = actionLabel;
    }
    refs.retry.classList.toggle('retry', item.translationStatus === 'error');

    const segments = Array.isArray(item.segments) ? item.segments : null;
    const bodyKey = [
      mode,
      item.translationStatus,
      item.provider || '',
      item.thoughtHash || '',
      item.error || '',
      item.promptPreview || '',
      segments ? segments.length : -1,
    ].join('|');
    if (refs.bodyKey !== bodyKey) {
      refs.bodyKey = bodyKey;
      refs.body.innerHTML = renderItemBodyHtml(item, mode);
    }
  }

  function applyFeed(items) {
    const feedEl = $('feed');
    const existing = new Map();
    for (const child of feedEl.children) {
      const key = child.dataset.itemCard;
      if (key !== undefined) existing.set(key, child);
    }

    const wanted = new Set();
    let cursor = feedEl.firstElementChild;

    for (const item of items) {
      const keyStr = item.id;
      wanted.add(keyStr);

      let node = existing.get(keyStr);
      if (node) {
        updateCardNode(node, item);
      } else {
        node = createCardNode(item);
      }

      if (node === cursor) {
        cursor = cursor.nextElementSibling;
      } else {
        feedEl.insertBefore(node, cursor);
      }
    }

    for (const child of [...feedEl.children]) {
      if (!wanted.has(child.dataset.itemCard)) child.remove();
    }
  }

  // ---------- Scroll management ----------
  const BOTTOM_EPS = 8;
  const RESUME_EPS = 2;
  const WHEEL_ACTIVE_MS = 180;
  const MIN_SHIFT_PX = 2;

  const scrollState = {
    lastTop: 0,
    keepTop: 0,
    pendingShift: 0,
    wheelAt: -1e9,
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

      snapshot.cardKey = card.dataset.itemCard;
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
      const card = [...$('feed').children].find((c) => c.dataset.itemCard === snapshot.cardKey);
      if (card) {
        const refs = cardRefs.get(card);
        const mainRect = mainEl.getBoundingClientRect();
        let anchorEl = null;
        let anchorDelta = 0;

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
      setScrollTop(scrollState.keepTop || snapshot.top || 0);
      return;
    }

    if (gestureActive()) {
      scrollState.pendingShift = 0;
      return;
    }

    scrollState.pendingShift += shift;
    if (Math.abs(scrollState.pendingShift) < MIN_SHIFT_PX) return;

    const delta = scrollState.pendingShift;
    scrollState.pendingShift = 0;
    setScrollTop($('main').scrollTop + delta);
  }

  function updateEmptyState(q) {
    const emptyTitle = $('empty-title');
    const emptyDesc = $('empty-desc');
    if (q) {
      emptyTitle.textContent = '无匹配结果';
      emptyDesc.textContent = '没有匹配当前筛选条件或关键词的条目，可尝试清除搜索或切换上方筛选标签。';
      return;
    }
    if (uiState.activeTab === 'side') {
      emptyTitle.textContent = '暂无侧边栏提问或子智能体动态';
      emptyDesc.textContent =
        '当您在侧边栏发起支线提问 (/btw)、Agent 弹出 ask_question 提问卡片或调用子智能体 (Subagents) 时，思考与回复会自动在此原位翻译。';
      return;
    }
    if (uiState.activeTab === 'swarm') {
      emptyTitle.textContent = '当前会话暂无 Swarm 多智能体对话';
      emptyDesc.textContent =
        '当会话启动 Swarm 多智能体协作时，Swarm 概览计划、消息板 (@mention / #seq) 与各 Worker 的后台思考会自动在此同步并翻译为中文。';
      return;
    }
    emptyTitle.textContent = '暂无思考过程';
    emptyDesc.textContent = uiState.conversationId
      ? '当 Agent 开始思考并输出推理链时，这里会自动同步并翻译为简体中文。'
      : '未绑定到具体对话，可在上方下拉框选择最近会话。';
  }

  function renderFeed() {
    const feedEl = $('feed');
    const emptyEl = $('empty-state');
    const q = uiState.searchQuery.trim().toLowerCase();
    const resetScroll = uiState.pendingScrollReset;
    uiState.pendingScrollReset = false;

    const filtered = getFilteredItemsForActiveTab();
    updateHeaderControls();

    if (!filtered.length) {
      if (feedEl.firstElementChild) feedEl.replaceChildren();
      emptyEl.classList.remove('hidden');
      updateEmptyState(q);
      if (resetScroll) {
        scrollState.keepTop = 0;
        scrollState.lastTop = 0;
      }
      return;
    }

    emptyEl.classList.add('hidden');
    const snapshot = uiState.followLatest || resetScroll ? null : captureScrollAnchor();

    applyFeed(filtered);

    if (uiState.followLatest) {
      requestPinToBottom();
      schedulePinToBottom();
      updateJumpButton();
      return;
    }

    restoreScrollAnchor(snapshot, { reset: resetScroll });
    updateJumpButton();
  }

  function switchTab(nextTab, { autoSwitched = false } = {}) {
    if (!['main', 'side', 'swarm'].includes(nextTab)) return;
    const changed = uiState.activeTab !== nextTab;
    uiState.activeTab = nextTab;
    uiState.unreadTabs.delete(nextTab);
    if (changed) {
      uiState.followLatest = true;
      renderFeed();
      if (autoSwitched) {
        showToast(`⚡ 智能跟随：已切至「${TAB_NAMES[nextTab]}」最新动态`);
      }
      // Trigger a background poll so the server prioritizes translating the newly active tab
      void pollState(false);
    } else {
      updateHeaderControls();
    }
  }

  // ---------- Smart Auto-Follow Detection ----------
  function handleIncomingStreams(res) {
    const meta = res.streamMeta || {
      main: { count: 0, latestTs: 0, headKey: '' },
      side: { count: 0, latestTs: 0, headKey: '' },
      swarm: { count: 0, latestTs: 0, headKey: '' },
    };

    if (!uiState.initialStreamSnapDone) {
      uiState.initialStreamSnapDone = true;
      uiState.prevStreamHeads = {
        main: meta.main?.headKey || '',
        side: meta.side?.headKey || '',
        swarm: meta.swarm?.headKey || '',
      };

      // If opened from a focused child (Side Question / Subagent / Swarm Worker), focus that tab
      if (res.focusedChild?.kind === 'side_question' || res.focusedChild?.kind === 'subagent') {
        uiState.activeTab = 'side';
        const prefix = res.focusedChild.kind === 'side_question' ? 'sq:' : 'sub:';
        uiState.sideSourceFilter = `${prefix}${res.focusedChild.id}`;
      } else if (res.focusedChild?.kind === 'swarm_worker') {
        uiState.activeTab = 'swarm';
      } else if (meta.main.count === 0) {
        if (meta.swarm.count > 0 && meta.swarm.latestTs >= meta.side.latestTs) {
          uiState.activeTab = 'swarm';
        } else if (meta.side.count > 0) {
          uiState.activeTab = 'side';
        }
      }
      return;
    }

    const changedTabs = [];
    for (const tab of ['main', 'side', 'swarm']) {
      const nextHead = meta[tab]?.headKey || '';
      const prevHead = uiState.prevStreamHeads[tab] || '';
      if (nextHead && nextHead !== prevHead && (meta[tab]?.count || 0) > 0) {
        changedTabs.push({ tab, latestTs: meta[tab]?.latestTs || Date.now() });
      }
      uiState.prevStreamHeads[tab] = nextHead;
    }

    if (!changedTabs.length) return;

    // Sort changed tabs by newest activity timestamp descending
    changedTabs.sort((a, b) => b.latestTs - a.latestTs);
    const newestTab = changedTabs[0].tab;

    for (const c of changedTabs) {
      if (c.tab !== uiState.activeTab) {
        uiState.unreadTabs.add(c.tab);
      }
    }

    if (uiState.smartFollow && !gestureActive() && newestTab !== uiState.activeTab) {
      uiState.activeTab = newestTab;
      uiState.unreadTabs.delete(newestTab);
      uiState.followLatest = true;
      showToast(`⚡ 智能跟随：已切至「${TAB_NAMES[newestTab]}」最新动态`);
    }
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
      const activeRootId = uiState.data?.rootConvId || uiState.conversationId;
      if (activeRootId && !convs.some((c) => c.id === activeRootId)) {
        const title = uiState.data?.rootTitle || `当前会话 (${activeRootId.slice(0, 8)})`;
        options.push(`<option value="${escapeHtml(activeRootId)}">${escapeHtml(title)}</option>`);
      }
      for (const c of convs) {
        const prefix = c.id === (window.sidecar?.conversationId || res.currentConversationId) ? '★ ' : '';
        options.push(`<option value="${escapeHtml(c.id)}">${escapeHtml(prefix + c.title)}</option>`);
      }
      if (!options.length) {
        options.push('<option value="">无可用会话</option>');
      }
      select.innerHTML = options.join('');
      if (activeRootId && convs.some((c) => c.id === activeRootId)) {
        select.value = activeRootId;
      } else {
        select.value = uiState.conversationId || '';
      }
    } catch {
      // Ignore conversation list errors cleanly.
    }
  }

  let initialSettingsApplied = false;

  async function pollState(forceRefresh = false) {
    try {
      const qs = new URLSearchParams();
      if (uiState.conversationId) qs.set('conversationId', uiState.conversationId);
      qs.set('activeTab', uiState.activeTab);
      if (!forceRefresh && uiState.etag) qs.set('etag', uiState.etag);

      const res = await apiFetch(`/api/state?${qs.toString()}`, { method: 'GET' });
      if (!res.unchanged) {
        uiState.etag = res.etag || '';
        uiState.data = res;
        if (!initialSettingsApplied && res.settings) {
          if (res.settings.defaultViewMode) uiState.globalMode = res.settings.defaultViewMode;
          if (typeof res.settings.smartFollow === 'boolean') uiState.smartFollow = res.settings.smartFollow;
          initialSettingsApplied = true;
        } else if (res.settings && typeof res.settings.smartFollow === 'boolean') {
          uiState.smartFollow = res.settings.smartFollow;
        }
        handleIncomingStreams(res);
        renderFeed();
      }
    } catch {
      // Keep last good state visible during transient restart.
    } finally {
      const allItems = [
        ...(uiState.data?.mainSteps || []),
        ...(uiState.data?.sideItems || []),
        ...(uiState.data?.swarm?.items || []),
      ];
      const hasTranslating = allItems.some((s) => s.translationStatus === 'translating');
      clearTimeout(uiState.pollTimer);
      uiState.pollTimer = setTimeout(() => pollState(false), hasTranslating ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    }
  }

  // ---------- Jump to Swarm #seq ----------
  function jumpToSwarmSeq(seqNum) {
    const targetId = `swarm:post:${seqNum}`;
    if (uiState.activeTab !== 'swarm') {
      uiState.activeTab = 'swarm';
      uiState.unreadTabs.delete('swarm');
    }
    uiState.swarmLayers.add('board');
    if (uiState.swarmMemberFilter) {
      const targetItem = (uiState.data?.swarm?.items || []).find((i) => i.id === targetId);
      if (targetItem && targetItem.agent !== uiState.swarmMemberFilter) {
        uiState.swarmMemberFilter = '';
      }
    }
    uiState.collapsed.delete(targetId);
    uiState.followLatest = false;
    renderFeed();

    const card = [...$('feed').children].find((c) => c.dataset.itemCard === targetId);
    if (!card) {
      showToast(`未找到 Swarm 消息 #${seqNum}`);
      return;
    }
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('flash-highlight');
    void card.offsetWidth;
    card.classList.add('flash-highlight');
  }

  // ---------- Event Handlers ----------
  $('stream-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.stream-tab');
    if (!btn) return;
    switchTab(btn.dataset.tab, { autoSwitched: false });
  });

  $('side-subbar').addEventListener('click', (e) => {
    const srcBtn = e.target.closest('[data-side-source]');
    if (srcBtn) {
      uiState.sideSourceFilter = srcBtn.dataset.sideSource || '';
      uiState.pendingScrollReset = true;
      renderFeed();
      return;
    }
    const layerBtn = e.target.closest('[data-side-layer]');
    if (layerBtn) {
      const layer = layerBtn.dataset.sideLayer;
      if (uiState.sideLayers.has(layer)) {
        if (uiState.sideLayers.size > 1) uiState.sideLayers.delete(layer);
      } else {
        uiState.sideLayers.add(layer);
      }
      renderFeed();
    }
  });

  $('swarm-subbar').addEventListener('click', (e) => {
    const memBtn = e.target.closest('[data-swarm-member]');
    if (memBtn) {
      const m = memBtn.dataset.swarmMember || '';
      uiState.swarmMemberFilter = uiState.swarmMemberFilter === m ? '' : m;
      uiState.pendingScrollReset = true;
      renderFeed();
      return;
    }
    const layerBtn = e.target.closest('[data-swarm-layer]');
    if (layerBtn) {
      const layer = layerBtn.dataset.swarmLayer;
      if (uiState.swarmLayers.has(layer)) {
        if (uiState.swarmLayers.size > 1) uiState.swarmLayers.delete(layer);
      } else {
        uiState.swarmLayers.add(layer);
      }
      renderFeed();
    }
  });

  $('feed').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'jump-seq') {
      const seq = Number(btn.dataset.seq);
      if (Number.isInteger(seq) && seq > 0) {
        jumpToSwarmSeq(seq);
      }
      return;
    }

    const cardEl = btn.closest('[data-item-card]');
    const itemId = cardEl?.dataset.itemCard;
    if (!itemId) return;

    const allItems = getRawItemsForTab(uiState.activeTab);
    const item = allItems.find((s) => s.id === itemId);
    if (!item) return;

    if (action === 'toggle-collapse') {
      if (uiState.collapsed.has(itemId)) {
        uiState.collapsed.delete(itemId);
      } else {
        uiState.collapsed.add(itemId);
      }
      renderFeed();
      return;
    }

    if (action === 'card-mode') {
      uiState.perCardMode.set(itemId, btn.dataset.mode);
      renderFeed();
      return;
    }

    if (action === 'copy') {
      const mode = getEffectiveMode(item);
      const text = getCopyText(item, mode);
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
            itemId: item.id,
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

  $('btn-smart-follow').addEventListener('click', async () => {
    const next = !uiState.smartFollow;
    uiState.smartFollow = next;
    updateHeaderControls();
    try {
      await apiFetch('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ smartFollow: next }),
      });
      showToast(next ? '⚡ 已开启跨通道智能跟随' : '已关闭跨通道自动切换（新动态将以红点提示）');
    } catch {
      // Keep local toggle state
    }
  });

  $('btn-translate-all').addEventListener('click', async () => {
    const btn = $('btn-translate-all');
    btn.disabled = true;
    try {
      await apiFetch('/api/translate', {
        method: 'POST',
        body: JSON.stringify({
          conversationId: uiState.conversationId,
          tab: uiState.activeTab,
          force: false,
        }),
      });
      await pollState(true);
      showToast('当前视图待处理条目已翻译');
    } catch (err) {
      showToast(`翻译中断: ${err.message}`);
      await pollState(true);
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-collapse-all').addEventListener('click', () => {
    const items = getFilteredItemsForActiveTab();
    uiState.allCollapsed = !uiState.allCollapsed;
    for (const s of items) {
      if (uiState.allCollapsed) uiState.collapsed.add(s.id);
      else uiState.collapsed.delete(s.id);
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

  $('main').addEventListener('scroll', () => {
    if (scrollState.scrollRaf) return;
    scrollState.scrollRaf = requestAnimationFrame(() => {
      scrollState.scrollRaf = 0;
      const el = $('main');
      const hasCards = Boolean($('feed').firstElementChild);
      const top = el.scrollTop;
      const movedUp = top < scrollState.lastTop - 2;
      scrollState.lastTop = top;

      if (!hasCards) {
        updateJumpButton();
        return;
      }
      scrollState.keepTop = top;

      if (movedUp) {
        if (uiState.followLatest) setFollowLatest(false);
      } else if (!uiState.followLatest && distanceToBottom(el) <= RESUME_EPS) {
        if (gestureActive()) scheduleResumeCheck();
        else setFollowLatest(true);
      }
      updateJumpButton();
    });
  }, { passive: true });

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

  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      if (uiState.followLatest) requestPinToBottom();
    }).catch(() => {});
  }

  $('search-input').addEventListener('input', (e) => {
    const next = e.target.value;
    if (next === uiState.searchQuery) return;
    uiState.searchQuery = next;
    uiState.pendingScrollReset = true;
    if (uiState.followLatest) setFollowLatest(false);
    renderFeed();
  });

  $('conv-select').addEventListener('change', (e) => {
    uiState.conversationId = e.target.value;
    uiState.etag = '';
    uiState.collapsed.clear();
    uiState.perCardMode.clear();
    uiState.unreadTabs.clear();
    uiState.sideSourceFilter = '';
    uiState.swarmMemberFilter = '';
    uiState.initialStreamSnapDone = false;
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
    $('cfg-smart-follow').checked = s.smartFollow !== false;
    $('cfg-side-questions').checked = s.translateSideQuestions !== false;
    $('cfg-ask-questions').checked = s.translateAskQuestions !== false;
    $('cfg-subagents').checked = s.translateSubagents !== false;
    $('cfg-swarm-board').checked = s.translateSwarmBoard !== false;
    $('cfg-swarm-workers').checked = s.translateSwarmWorkers !== false;
    $('cfg-swarm-overview').checked = s.translateSwarmOverview !== false;
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
      smartFollow: $('cfg-smart-follow').checked,
      translateSideQuestions: $('cfg-side-questions').checked,
      translateAskQuestions: $('cfg-ask-questions').checked,
      translateSubagents: $('cfg-subagents').checked,
      translateSwarmBoard: $('cfg-swarm-board').checked,
      translateSwarmWorkers: $('cfg-swarm-workers').checked,
      translateSwarmOverview: $('cfg-swarm-overview').checked,
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
      uiState.smartFollow = res.settings.smartFollow !== false;
      uiState.perCardMode.clear();
      closeSettings();
      await pollState(true);
      showToast('设置已保存');
    } catch (err) {
      showToast(`保存失败: ${err.message}`);
    }
  });

  // ---------- Bootstrap ----------
  refreshConversations();
  pollState(true);
  setInterval(refreshConversations, 8000);
})();
