/**
 * Think Translate sidecar server.
 *
 * Serves the Auxiliary Pane Web UI and exposes JSON routes to read the active
 * conversation's 3 translation streams (Main Thinking, Side Questions / Subagents /
 * ask_question cards, and Swarm Multi-Agent Board / Overview / Worker Thinking),
 * manage translation cache/settings, and run translations using Bing / Google /
 * OpenAI-compatible providers.
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
  readConversationStreams,
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
// app.js / styles.css across reloads. Every static asset is served non-cacheable.
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

function enrichItem(item) {
  const tr = translator.getStepTranslationState(item);
  return {
    ...item,
    ...tr,
  };
}

function buildAutoTranslateQueue(streams, activeTab = 'main') {
  const mainRecent = streams.mainSteps.slice(-12);
  const sideRecent = streams.sideItems.slice(-16);
  const swarmRecent = streams.swarm.items.slice(-20);

  // Note: scheduleAutoTranslate reverses the array it receives, so items at the
  // END of the returned array are translated FIRST.
  if (activeTab === 'swarm') {
    return [...mainRecent, ...sideRecent, ...swarmRecent];
  }
  if (activeTab === 'side') {
    return [...mainRecent, ...swarmRecent, ...sideRecent];
  }
  return [...swarmRecent, ...sideRecent, ...mainRecent];
}

function buildStatePayload(conversationId, activeTab = 'main') {
  const settings = translator.getPublicSettings();
  const resolvedConv = conversationId || app.config.conversationId || '';
  if (!resolvedConv || !ID_RE.test(resolvedConv)) {
    return {
      conversationId: resolvedConv || null,
      rootConvId: null,
      rootTitle: '',
      focusedChild: null,
      exists: false,
      steps: [],
      mainSteps: [],
      sideItems: [],
      sideSources: [],
      swarm: { exists: false, title: '', members: [], channels: [], items: [] },
      streamMeta: {
        main: { count: 0, latestTs: 0, headKey: '' },
        side: { count: 0, latestTs: 0, headKey: '' },
        swarm: { count: 0, latestTs: 0, headKey: '' },
      },
      settings,
      etag: `none|${JSON.stringify(settings)}`,
    };
  }

  const streams = readConversationStreams(appDataDirs, resolvedConv, settings);
  if (streams.exists) {
    const queue = buildAutoTranslateQueue(streams, activeTab);
    if (queue.length > 0) {
      translator.scheduleAutoTranslate(queue);
    }
  }

  const enrichedMain = streams.mainSteps.map(enrichItem);
  const enrichedSide = streams.sideItems.map(enrichItem);
  const enrichedSwarmItems = streams.swarm.items.map(enrichItem);

  const statusSig = (list) =>
    list.map((s) => `${s.id}:${s.thoughtHash}:${s.translationStatus}:${s.error || ''}`).join(',');

  const digestSource = JSON.stringify({
    resolvedConv,
    rootConvId: streams.rootConvId,
    exists: streams.exists,
    sig: streams.sig,
    settings,
    mainSt: statusSig(enrichedMain),
    sideSt: statusSig(enrichedSide),
    swarmSt: statusSig(enrichedSwarmItems),
  });
  const etag = createHash('sha1').update(digestSource).digest('hex');

  return {
    conversationId: resolvedConv,
    rootConvId: streams.rootConvId,
    rootTitle: streams.rootTitle,
    focusedChild: streams.focusedChild,
    exists: streams.exists,
    steps: enrichedMain,
    mainSteps: enrichedMain,
    sideItems: enrichedSide,
    sideSources: streams.sideSources,
    swarm: {
      ...streams.swarm,
      items: enrichedSwarmItems,
    },
    streamMeta: streams.streamMeta,
    settings,
    etag,
  };
}

app.api('/api/state', (data) => {
  const convId = typeof data.conversationId === 'string' ? data.conversationId.trim() : '';
  const activeTab = typeof data.activeTab === 'string' ? data.activeTab.trim() : 'main';
  const payload = buildStatePayload(convId, activeTab);
  if (data.etag && data.etag === payload.etag) {
    return jsonNoStore({
      unchanged: true,
      etag: payload.etag,
      conversationId: payload.conversationId,
      rootConvId: payload.rootConvId,
    });
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
  const itemId = typeof data.itemId === 'string' ? data.itemId.trim() : '';
  const stepIndex = data.stepIndex !== undefined && data.stepIndex !== null ? Number(data.stepIndex) : NaN;
  const tab = typeof data.tab === 'string' ? data.tab.trim() : '';
  const force = Boolean(data.force);

  const settings = translator.getPublicSettings();
  const streams = readConversationStreams(appDataDirs, convId, settings);
  if (!streams.exists) {
    return new Response(JSON.stringify({ error: '未找到会话日志' }), {
      status: 404,
      contentType: 'application/json',
    });
  }

  const allItems = [
    ...streams.mainSteps,
    ...streams.sideItems,
    ...streams.swarm.items,
  ];

  if (itemId) {
    const target = allItems.find((s) => s.id === itemId);
    if (!target) {
      return new Response(JSON.stringify({ error: `未找到条目 ${itemId}` }), {
        status: 404,
        contentType: 'application/json',
      });
    }
    const result = await translator.translateStep(target, { force });
    return { ok: true, itemId: target.id, stepIndex: target.stepIndex, result };
  }

  if (Number.isInteger(stepIndex)) {
    const target = streams.mainSteps.find((s) => s.stepIndex === stepIndex);
    if (!target) {
      return new Response(JSON.stringify({ error: `未找到 Step #${stepIndex}` }), {
        status: 404,
        contentType: 'application/json',
      });
    }
    const result = await translator.translateStep(target, { force });
    return { ok: true, itemId: target.id, stepIndex, result };
  }

  // Bulk translate pending/error items in the target tab (or all tabs)
  let pool = allItems;
  if (tab === 'main') pool = streams.mainSteps;
  else if (tab === 'side') pool = streams.sideItems;
  else if (tab === 'swarm') pool = streams.swarm.items;

  const translatedIds = [];
  for (const item of [...pool].reverse()) {
    const state = translator.getStepTranslationState(item);
    if (force || state.translationStatus === 'pending' || state.translationStatus === 'error') {
      await translator.translateStep(item, { force });
      translatedIds.push(item.id);
      if (translatedIds.length >= 30) break;
    }
  }
  return { ok: true, translatedIds };
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
