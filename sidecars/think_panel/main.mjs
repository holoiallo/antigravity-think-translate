/**
 * Think Translate sidecar server.
 *
 * Serves the Auxiliary Pane Web UI and exposes JSON routes to read the active
 * conversation's thinking steps, manage translation cache/settings, and run
 * translations using Bing / Google / OpenAI-compatible providers.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import {
  findAppDataDirs,
  ID_RE,
  listRecentConversations,
  readConversationThinking,
  resolveSidecarDataDir,
} from './transcript.mjs';
import { ThinkingTranslator } from './translator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDataDirs = findAppDataDirs();
const dataDir = resolveSidecarDataDir(appDataDirs);
const translator = new ThinkingTranslator(dataDir);

console.log(`[think_panel] appDataDirs: ${appDataDirs.join(', ') || '(none)'}`);
console.log(`[think_panel] dataDir: ${dataDir}`);

const app = new SidecarApp();

// The pane runs inside an embedded webview that happily keeps a cached
// app.js / styles.css across reloads. A stale bundle means a shipped UI fix
// never reaches the user, so every static asset is served non-cacheable.
const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
};

function serveText(file, contentType) {
  return () =>
    new Response(readFileSync(join(__dirname, file), 'utf-8'), {
      contentType,
      headers: NO_STORE_HEADERS,
    });
}

function jsonNoStore(value) {
  return new Response(JSON.stringify(value), {
    contentType: 'application/json; charset=utf-8',
    headers: NO_STORE_HEADERS,
  });
}

app.page('/', serveText('index.html', 'text/html; charset=utf-8'));
app.api('/styles.css', serveText('styles.css', 'text/css; charset=utf-8'), 'GET');
app.api('/app.js', serveText('app.js', 'application/javascript; charset=utf-8'), 'GET');

function buildStatePayload(conversationId) {
  const settings = translator.getPublicSettings();
  const resolvedConv = conversationId || app.config.conversationId || '';
  if (!resolvedConv || !ID_RE.test(resolvedConv)) {
    return {
      conversationId: resolvedConv || null,
      exists: false,
      steps: [],
      settings,
      etag: `none|${JSON.stringify(settings)}`,
    };
  }

  const { exists, sig, steps } = readConversationThinking(appDataDirs, resolvedConv);
  if (exists && steps.length > 0) {
    translator.scheduleAutoTranslate(steps);
  }

  const enrichedSteps = steps.map((step) => {
    const tr = translator.getStepTranslationState(step);
    return {
      stepIndex: step.stepIndex,
      createdAt: step.createdAt,
      status: step.status,
      thinking: step.thinking,
      thoughtHash: step.thoughtHash,
      toolNames: step.toolNames,
      hasReply: step.hasReply,
      outputTokens: step.outputTokens,
      charCount: step.charCount,
      ...tr,
    };
  });

  const digestSource = JSON.stringify({
    resolvedConv,
    exists,
    sig,
    settings,
    statuses: enrichedSteps.map((s) => `${s.stepIndex}:${s.thoughtHash}:${s.translationStatus}:${s.error || ''}`),
  });
  const etag = createHash('sha1').update(digestSource).digest('hex');

  return {
    conversationId: resolvedConv,
    exists,
    steps: enrichedSteps,
    settings,
    etag,
  };
}

app.api('/api/state', (data) => {
  const convId = typeof data.conversationId === 'string' ? data.conversationId.trim() : '';
  const payload = buildStatePayload(convId);
  if (data.etag && data.etag === payload.etag) {
    return jsonNoStore({ unchanged: true, etag: payload.etag, conversationId: payload.conversationId });
  }
  return jsonNoStore(payload);
}, 'GET');

app.api('/api/conversations', () => {
  return {
    currentConversationId: app.config.conversationId || null,
    conversations: listRecentConversations(appDataDirs, 25),
  };
}, 'GET');

app.api('/api/translate', async (data) => {
  const convId = typeof data.conversationId === 'string' && data.conversationId.trim()
    ? data.conversationId.trim()
    : (app.config.conversationId || '');
  const stepIndex = Number(data.stepIndex);
  const force = Boolean(data.force);

  const { exists, steps } = readConversationThinking(appDataDirs, convId);
  if (!exists) {
    return new Response(JSON.stringify({ error: '未找到会话日志' }), {
      status: 404,
      contentType: 'application/json',
    });
  }

  if (Number.isInteger(stepIndex)) {
    const target = steps.find((s) => s.stepIndex === stepIndex);
    if (!target) {
      return new Response(JSON.stringify({ error: `未找到 Step #${stepIndex}` }), {
        status: 404,
        contentType: 'application/json',
      });
    }
    const result = await translator.translateStep(target, { force });
    return { ok: true, stepIndex, result };
  }

  // Translate all pending/selected steps when no specific stepIndex is given.
  const results = [];
  for (const step of [...steps].reverse()) {
    const state = translator.getStepTranslationState(step);
    if (force || state.translationStatus === 'pending' || state.translationStatus === 'error') {
      await translator.translateStep(step, { force });
      results.push(step.stepIndex);
    }
  }
  return { ok: true, translatedSteps: results };
}, 'POST');

app.api('/api/settings', (data) => {
  const settings = translator.updateSettings(data || {});
  return { ok: true, settings };
}, 'POST');

app.api('/api/test-provider', async (data) => {
  return translator.testProvider(data || null);
}, 'POST');

app.api('/api/cache/clear', () => {
  return { ok: true, ...translator.clearCache() };
}, 'POST');

app.run();
