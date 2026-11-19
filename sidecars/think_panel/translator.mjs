/**
 * DeepSeek Harness-inspired translation engine for agent thinking blocks.
 *
 * Design principles (mirroring DeepSeek Harness's translation subsystem):
 * 1. Original thinking text is never mutated; translations are stored purely
 *    in sidecar cache on disk.
 * 2. Providers never silently cross-fallback on failure; errors preserve the
 *    original text and expose explicit retry.
 * 3. Fenced code blocks remain untranslated; inline code spans & URLs are
 *    protected with `[[C0]]` placeholders during translation.
 * 4. Paragraphs exceeding provider limits are chunked safely, and each
 *    paragraph keeps a 1:1 `(src, dst)` mapping for Bilingual mode.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_SETTINGS = {
  provider: 'bing', // 'bing' | 'google' | 'openai'
  targetLang: 'zh-Hans',
  autoTranslate: true,
  inlineHook: true,
  defaultViewMode: 'translation', // 'translation' | 'bilingual' | 'original'
  skipChinese: true,
  openai: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
  },
};

const MAX_CACHE_ENTRIES = 600;
const REQUEST_TIMEOUT_MS = 18000;
const MAX_BING_BATCH_ITEMS = 8;
const MAX_BING_BATCH_CHARS = 2800;
const MAX_PROSE_CHUNK_CHARS = 1500;
const MAX_LLM_CHUNK_CHARS = 3600;

function maskApiKey(key) {
  if (!key || typeof key !== 'string') return '';
  if (key.length <= 8) return '********';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function writeJsonAtomic(filePath, obj) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf-8');
  renameSync(tmpPath, filePath);
}

function safeMtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Checks whether a thinking block is already predominantly Simplified/Traditional Chinese.
 */
export function isMostlyChinese(text) {
  const withoutCode = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  const cjkCount = (withoutCode.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinCount = (withoutCode.match(/[A-Za-z]/g) || []).length;
  if (cjkCount === 0) return false;
  if (latinCount === 0) return cjkCount >= 2;
  const ratio = cjkCount / (cjkCount + latinCount);
  return (cjkCount >= 8 && ratio >= 0.32) || (cjkCount >= 4 && latinCount < cjkCount * 1.2);
}

/**
 * Splits Markdown thinking text into preserved code blocks and translatable prose paragraphs.
 */
export function splitThinkingIntoBlocks(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const blocks = [];
  const fenceRe = /^[ \t]*(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;
  let lastIndex = 0;

  for (const match of normalized.matchAll(fenceRe)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      pushProseParagraphs(blocks, normalized.slice(lastIndex, start));
    }
    blocks.push({ type: 'code', src: match[0] });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < normalized.length) {
    pushProseParagraphs(blocks, normalized.slice(lastIndex));
  }
  return blocks;
}

function pushProseParagraphs(out, chunk) {
  const paragraphs = chunk.split(/\n\s*\n+/);
  for (const p of paragraphs) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    out.push({ type: 'prose', src: trimmed });
  }
}

/**
 * Replaces inline code spans and URLs with `[[C0]]` placeholders so machine
 * translation does not corrupt identifiers or paths.
 */
function protectInlineTokens(text) {
  const tokens = [];
  const replaced = text.replace(/(`+[^`]+`+|https?:\/\/[^\s)>\]"']+)/g, (m) => {
    const idx = tokens.length;
    tokens.push(m);
    return `[[C${idx}]]`;
  });
  return { text: replaced, tokens };
}

function restoreInlineTokens(text, tokens) {
  if (!tokens.length) return text;
  return text.replace(/\[\[\s*C(\d+)\s*\]\]/gi, (full, idxStr) => {
    const idx = Number(idxStr);
    return Number.isInteger(idx) && idx >= 0 && idx < tokens.length ? tokens[idx] : full;
  });
}

function splitLongText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const slice = remaining.slice(0, maxChars);
    let cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('. '), slice.lastIndexOf('。'));
    if (cut < maxChars * 0.4) {
      cut = slice.lastIndexOf(' ');
    }
    if (cut <= 0) cut = maxChars;
    parts.push(remaining.slice(0, cut + 1).trim());
    remaining = remaining.slice(cut + 1).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

async function translateBatchBing(texts, targetLang = 'zh-Hans', timeoutMs = REQUEST_TIMEOUT_MS) {
  const url = `https://edge.microsoft.com/translate/translatetext?from=&to=${encodeURIComponent(targetLang)}&isEnterpriseClient=false`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(texts),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Bing 翻译 HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error('Bing 翻译返回格式异常');
  }
  return data.map((item) => {
    const t = item?.translations?.[0]?.text;
    if (typeof t !== 'string') {
      throw new Error('Bing 翻译缺少译文字段');
    }
    return t;
  });
}

async function translateSingleGoogle(text, targetLang = 'zh-CN', timeoutMs = REQUEST_TIMEOUT_MS) {
  const googleLang = targetLang === 'zh-Hans' ? 'zh-CN' : targetLang;
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'auto');
  url.searchParams.set('tl', googleLang);
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', text);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Google 翻译 HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('Google 翻译返回格式异常');
  }
  return data[0].map((seg) => (Array.isArray(seg) ? String(seg[0] ?? '') : '')).join('');
}

async function translateSingleOpenAI(text, openaiCfg, timeoutMs = REQUEST_TIMEOUT_MS) {
  const baseUrl = String(openaiCfg?.baseUrl || '').replace(/\/+$/, '');
  const model = String(openaiCfg?.model || '').trim();
  const apiKey = String(openaiCfg?.apiKey || '').trim();
  if (!baseUrl || !model) {
    throw new Error('请先配置兼容接口的 Base URL 与 Model');
  }
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i.test(baseUrl);
  if (!apiKey && !isLocal) {
    throw new Error('远程 OpenAI 兼容接口需要填写 API Key');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content:
            'You are a technical translator. Translate the given AI agent reasoning paragraph into natural, concise Simplified Chinese. ' +
            'Strictly preserve all [[C0]], [[C1]]... placeholders, Markdown markers, numbers, and technical accuracy. ' +
            'Output ONLY the Chinese translation with no extra commentary or wrappers.',
        },
        { role: 'user', content: text },
      ],
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const errJson = await res.json();
      detail = errJson?.error?.message || '';
    } catch {
      detail = '';
    }
    throw new Error(`LLM 翻译 HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('LLM 接口未返回有效译文');
  }
  return content.trim();
}

export class ThinkingTranslator {
  #settingsPath;
  #cachePath;
  #requestTimeoutMs;
  #settings;
  #settingsMtimeMs = 0;
  #cacheMtimeMs = 0;
  #lastClearedAt = 0;
  #cache = new Map(); // cacheKey -> entry
  #inFlight = new Map(); // cacheKey -> Promise
  #errors = new Map(); // cacheKey -> { error, failedAt }
  #saveTimer = null;

  constructor(dataDir, { requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.#settingsPath = join(dataDir, 'settings.json');
    this.#cachePath = join(dataDir, 'translation-cache.json');
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#settings = this.#loadSettings();
    this.#settingsMtimeMs = safeMtimeMs(this.#settingsPath);
    this.#loadCache();
  }

  #loadSettings() {
    try {
      if (existsSync(this.#settingsPath)) {
        const parsed = JSON.parse(readFileSync(this.#settingsPath, 'utf-8'));
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          openai: {
            ...DEFAULT_SETTINGS.openai,
            ...(parsed?.openai || {}),
          },
        };
      }
    } catch {
      // Fall back to defaults on corrupt settings.
    }
    return structuredClone(DEFAULT_SETTINGS);
  }

  #readDiskCache() {
    if (!existsSync(this.#cachePath)) return { clearedAt: 0, entries: [] };
    const parsed = JSON.parse(readFileSync(this.#cachePath, 'utf-8'));
    return {
      clearedAt: typeof parsed?.clearedAt === 'number' ? parsed.clearedAt : 0,
      entries: Array.isArray(parsed?.entries) ? parsed.entries : [],
    };
  }

  #loadCache() {
    try {
      this.#cacheMtimeMs = safeMtimeMs(this.#cachePath);
      const { clearedAt, entries } = this.#readDiskCache();
      if (clearedAt > this.#lastClearedAt) {
        this.#cache.clear();
        this.#lastClearedAt = clearedAt;
      }
      for (const item of entries) {
        if (item?.key && item?.value && !this.#cache.has(item.key)) {
          this.#cache.set(item.key, item.value);
        }
      }
    } catch {
      // Start fresh if cache file is unreadable.
    }
  }

  syncFromDiskIfChanged() {
    const sMtime = safeMtimeMs(this.#settingsPath);
    if (sMtime && sMtime !== this.#settingsMtimeMs) {
      this.#settings = this.#loadSettings();
      this.#settingsMtimeMs = sMtime;
      this.#errors.clear();
    }
    const cMtime = safeMtimeMs(this.#cachePath);
    if (cMtime && cMtime !== this.#cacheMtimeMs) {
      this.#loadCache();
    }
  }

  flushCacheSync() {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    try {
      // Merge unseen entries written concurrently by another process (sidecar <-> hook).
      try {
        const { clearedAt, entries: diskEntries } = this.#readDiskCache();
        if (clearedAt <= this.#lastClearedAt) {
          for (const item of diskEntries) {
            if (item?.key && item?.value && !this.#cache.has(item.key)) {
              this.#cache.set(item.key, item.value);
            }
          }
        } else {
          this.#lastClearedAt = clearedAt;
        }
      } catch {
        // Ignore unreadable disk cache and overwrite cleanly.
      }
      while (this.#cache.size > MAX_CACHE_ENTRIES) {
        const oldestKey = this.#cache.keys().next().value;
        this.#cache.delete(oldestKey);
      }
      const entries = [];
      for (const [key, value] of this.#cache.entries()) {
        entries.push({ key, value });
      }
      writeJsonAtomic(this.#cachePath, { version: 1, clearedAt: this.#lastClearedAt, entries });
      this.#cacheMtimeMs = safeMtimeMs(this.#cachePath);
    } catch {
      // Non-fatal persistence error.
    }
  }

  #scheduleSaveCache() {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.flushCacheSync();
    }, 400);
  }

  getPublicSettings() {
    this.syncFromDiskIfChanged();
    return {
      provider: this.#settings.provider,
      targetLang: this.#settings.targetLang,
      autoTranslate: Boolean(this.#settings.autoTranslate),
      inlineHook: this.#settings.inlineHook !== false,
      defaultViewMode: this.#settings.defaultViewMode,
      skipChinese: Boolean(this.#settings.skipChinese),
      openai: {
        baseUrl: this.#settings.openai.baseUrl,
        model: this.#settings.openai.model,
        apiKeySet: Boolean(this.#settings.openai.apiKey),
        apiKeyPreview: maskApiKey(this.#settings.openai.apiKey),
      },
      cacheCount: this.#cache.size,
    };
  }

  updateSettings(patch) {
    this.syncFromDiskIfChanged();
    const next = structuredClone(this.#settings);
    if (patch.provider && ['bing', 'google', 'openai'].includes(patch.provider)) {
      next.provider = patch.provider;
    }
    if (typeof patch.targetLang === 'string' && patch.targetLang.trim()) {
      next.targetLang = patch.targetLang.trim();
    }
    if (typeof patch.autoTranslate === 'boolean') {
      next.autoTranslate = patch.autoTranslate;
    }
    if (typeof patch.inlineHook === 'boolean') {
      next.inlineHook = patch.inlineHook;
    }
    if (patch.defaultViewMode && ['translation', 'bilingual', 'original'].includes(patch.defaultViewMode)) {
      next.defaultViewMode = patch.defaultViewMode;
    }
    if (typeof patch.skipChinese === 'boolean') {
      next.skipChinese = patch.skipChinese;
    }
    if (patch.openai && typeof patch.openai === 'object') {
      if (typeof patch.openai.baseUrl === 'string') {
        next.openai.baseUrl = patch.openai.baseUrl.trim();
      }
      if (typeof patch.openai.model === 'string') {
        next.openai.model = patch.openai.model.trim();
      }
      // Only overwrite apiKey when caller sends an explicit new key (or explicit empty clear).
      if (typeof patch.openai.apiKey === 'string' && !patch.openai.apiKey.includes('...')) {
        next.openai.apiKey = patch.openai.apiKey.trim();
      }
    }

    this.#settings = next;
    this.#errors.clear();
    writeJsonAtomic(this.#settingsPath, this.#settings);
    this.#settingsMtimeMs = safeMtimeMs(this.#settingsPath);
    return this.getPublicSettings();
  }

  clearCache() {
    this.#cache.clear();
    this.#errors.clear();
    this.#lastClearedAt = Date.now();
    writeJsonAtomic(this.#cachePath, { version: 1, clearedAt: this.#lastClearedAt, entries: [] });
    this.#cacheMtimeMs = safeMtimeMs(this.#cachePath);
    return { cacheCount: 0 };
  }

  makeCacheKey(thoughtHash) {
    const modelPart = this.#settings.provider === 'openai' ? this.#settings.openai.model : this.#settings.provider;
    return `${this.#settings.provider}|${modelPart}|${this.#settings.targetLang}|${thoughtHash}`;
  }

  getStepTranslationState(step) {
    this.syncFromDiskIfChanged();
    const key = this.makeCacheKey(step.thoughtHash);
    const cached = this.#cache.get(key);
    if (cached) {
      // LRU bump
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return {
        translationStatus: 'done',
        provider: cached.provider,
        segments: cached.segments,
        translatedText: cached.translatedText,
        error: null,
      };
    }

    if (this.#inFlight.has(key)) {
      return {
        translationStatus: 'translating',
        provider: this.#settings.provider,
        segments: null,
        translatedText: null,
        error: null,
      };
    }

    const err = this.#errors.get(key);
    if (err) {
      return {
        translationStatus: 'error',
        provider: this.#settings.provider,
        segments: null,
        translatedText: null,
        error: err.error,
      };
    }

    if (this.#settings.skipChinese && isMostlyChinese(step.thinking)) {
      return {
        translationStatus: 'skipped_zh',
        provider: this.#settings.provider,
        segments: null,
        translatedText: null,
        error: null,
      };
    }

    return {
      translationStatus: 'pending',
      provider: this.#settings.provider,
      segments: null,
      translatedText: null,
      error: null,
    };
  }

  /**
   * Queues auto-translation for untranslated steps in the active conversation
   * (newest-first, bounded concurrency) without blocking the state poll response.
   */
  scheduleAutoTranslate(steps, onFinish) {
    if (!this.#settings.autoTranslate) return;
    const candidates = [...steps]
      .reverse()
      .filter((s) => this.getStepTranslationState(s).translationStatus === 'pending');

    if (!candidates.length) return;

    const MAX_CONCURRENT = 2;
    const activeCount = this.#inFlight.size;
    const slots = Math.max(0, MAX_CONCURRENT - activeCount);
    for (const step of candidates.slice(0, slots)) {
      this.translateStep(step, { force: false })
        .catch(() => {})
        .finally(() => {
          if (typeof onFinish === 'function') onFinish();
        });
    }
  }

  async translateStep(step, { force = false } = {}) {
    const key = this.makeCacheKey(step.thoughtHash);
    if (force) {
      this.#cache.delete(key);
      this.#errors.delete(key);
    }

    const existing = this.#cache.get(key);
    if (existing && !force) return existing;

    if (this.#inFlight.has(key)) {
      return this.#inFlight.get(key);
    }

    const promise = this.#performTranslation(step)
      .then((result) => {
        this.#errors.delete(key);
        this.#cache.set(key, result);
        this.#scheduleSaveCache();
        return result;
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.#errors.set(key, { error: message, failedAt: Date.now() });
        throw err;
      })
      .finally(() => {
        this.#inFlight.delete(key);
      });

    this.#inFlight.set(key, promise);
    return promise;
  }

  async testProvider(overrideSettings) {
    const prev = this.#settings;
    if (overrideSettings) {
      this.#settings = {
        ...prev,
        ...overrideSettings,
        openai: {
          ...prev.openai,
          ...(overrideSettings.openai || {}),
          apiKey:
            overrideSettings.openai?.apiKey && !overrideSettings.openai.apiKey.includes('...')
              ? overrideSettings.openai.apiKey.trim()
              : prev.openai.apiKey,
        },
      };
    }
    try {
      const sample = 'Initial assessment: inspect `sidecar_sdk/index.mjs` before editing.';
      const res = await this.#performTranslation({ thinking: sample });
      return { ok: true, translatedText: res.translatedText, provider: res.provider };
    } finally {
      this.#settings = prev;
    }
  }

  async #performTranslation(step) {
    const blocks = splitThinkingIntoBlocks(step.thinking);
    const provider = this.#settings.provider;
    const targetLang = this.#settings.targetLang;
    const maxChunk = provider === 'openai' ? MAX_LLM_CHUNK_CHARS : MAX_PROSE_CHUNK_CHARS;

    const proseTasks = [];
    const prepared = blocks.map((b) => {
      if (b.type === 'code') {
        return { type: 'code', src: b.src, dst: b.src };
      }
      const { text: protectedText, tokens } = protectInlineTokens(b.src);
      const chunks = splitLongText(protectedText, maxChunk);
      const entry = { type: 'prose', src: b.src, tokens, chunks, translatedChunks: [] };
      for (let i = 0; i < chunks.length; i++) {
        proseTasks.push({ entry, chunkIdx: i, text: chunks[i] });
      }
      return entry;
    });

    if (proseTasks.length > 0) {
      const timeoutMs = this.#requestTimeoutMs;
      if (provider === 'bing') {
        await this.#runBingBatches(proseTasks, targetLang, timeoutMs);
      } else if (provider === 'google') {
        for (const task of proseTasks) {
          task.entry.translatedChunks[task.chunkIdx] = await translateSingleGoogle(task.text, targetLang, timeoutMs);
        }
      } else {
        for (const task of proseTasks) {
          task.entry.translatedChunks[task.chunkIdx] = await translateSingleOpenAI(task.text, this.#settings.openai, timeoutMs);
        }
      }
    }

    const segments = prepared.map((item) => {
      if (item.type === 'code') {
        return { type: 'code', src: item.src, dst: item.dst };
      }
      const joined = item.translatedChunks.join(' ');
      const dst = restoreInlineTokens(joined, item.tokens);
      return { type: 'prose', src: item.src, dst };
    });

    const translatedText = segments.map((s) => s.dst).join('\n\n');
    return {
      provider,
      model: provider === 'openai' ? this.#settings.openai.model : provider,
      targetLang,
      segments,
      translatedText,
      updatedAt: Date.now(),
    };
  }

  async #runBingBatches(tasks, targetLang, timeoutMs = REQUEST_TIMEOUT_MS) {
    let batch = [];
    let batchChars = 0;

    const flush = async () => {
      if (!batch.length) return;
      const current = batch;
      batch = [];
      batchChars = 0;
      const texts = current.map((t) => t.text);
      const results = await translateBatchBing(texts, targetLang, timeoutMs);
      for (let i = 0; i < current.length; i++) {
        current[i].entry.translatedChunks[current[i].chunkIdx] = results[i];
      }
    };

    for (const task of tasks) {
      if (
        batch.length >= MAX_BING_BATCH_ITEMS ||
        (batch.length > 0 && batchChars + task.text.length > MAX_BING_BATCH_CHARS)
      ) {
        await flush();
      }
      batch.push(task);
      batchChars += task.text.length;
    }
    await flush();
  }
}
