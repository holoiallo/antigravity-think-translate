/**
 * Read-only multi-stream transcript & Swarm reader for Antigravity conversations.
 *
 * Reads:
 * 1. Main conversation `<appData>/brain/<convId>/.system_generated/logs/transcript.jsonl`
 *    (with lazy on-demand fallback to `transcript_full.jsonl` for truncated fields).
 * 2. Side Questions (`/btw` / 支线提问) linked via `<appData>/annotations/<convId>.pbtxt`
 *    (`side_question_cascade_ids` and `side_question_titles`).
 * 3. `ask_question` tool cards (questions, options, and user answers) across main,
 *    side questions, and subagents.
 * 4. Subagents (`<appData>/brain/<convId>/.system_generated/subagents/*.json`).
 * 5. Swarm multi-agent data (`<appData>/brain/<coordId>/.system_generated/swarm/`
 *    including `board.jsonl`, `members.json`, `plan.json`, `view.json`, and each
 *    Swarm worker's own `transcript.jsonl`).
 *
 * Never mutates any session or Swarm file on disk.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const ID_RE = /^[0-9a-f-]{8,}$/i;

const MAX_MAIN_THINKING_STEPS = 120;
const MAX_SIDE_STEPS_PER_SOURCE = 45;
const MAX_SWARM_BOARD_POSTS = 200;
const MAX_SWARM_WORKER_STEPS_PER_MEMBER = 35;

// Incremental caches keyed by file path
const rawStepsCache = new Map(); // primaryPath -> { sig, richSteps }
const thinkingOnlyCache = new Map(); // primaryPath -> { sig, steps }
const pbtxtCache = new Map(); // pbtxtPath -> { sig, data }
const jsonFileCache = new Map(); // filePath -> { sig, data }
const boardCache = new Map(); // boardPath -> { sig, messages }

let familyScanCache = { at: 0, appDataKey: '', childToParent: new Map(), convMeta: new Map() };

function sha24(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 24);
}

/**
 * Discovers Antigravity appData directories containing `brain/`.
 */
export function findAppDataDirs() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      if (existsSync(join(appData, 'brain'))) {
        return [appData];
      }
    }
  }

  const geminiRoot = join(homedir(), '.gemini');
  if (!existsSync(geminiRoot)) return [];
  const dirs = [];
  for (const entry of safeReaddir(geminiRoot)) {
    const candidate = join(geminiRoot, entry);
    if (existsSync(join(candidate, 'brain'))) {
      dirs.push(candidate);
    }
  }
  dirs.sort((a, b) => {
    const aMain = basename(a) === 'antigravity' ? 0 : 1;
    const bMain = basename(b) === 'antigravity' ? 0 : 1;
    return aMain - bMain || a.localeCompare(b);
  });
  return dirs;
}

/**
 * Resolves the sidecar persistent storage directory.
 */
export function resolveSidecarDataDir(appDataDirs) {
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  }
  const baseAppData = appDataDirs[0] || join(homedir(), '.gemini', 'antigravity');
  return join(baseAppData, 'sidecar_data', 'think-translate', 'think_panel', 'data');
}

/**
 * Resolves the shared data directory from a transcriptPath when running outside
 * the sidecar process (e.g. from a lifecycle hook).
 */
export function resolveDataDirFromTranscriptPath(transcriptPath, fallbackAppDataDirs = []) {
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  }
  if (transcriptPath && typeof transcriptPath === 'string') {
    for (let d = dirname(transcriptPath); d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'brain') {
        const appData = dirname(d);
        return join(appData, 'sidecar_data', 'think-translate', 'think_panel', 'data');
      }
    }
  }
  return resolveSidecarDataDir(fallbackAppDataDirs);
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeStat(filePath) {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

function readJsonCached(filePath) {
  const st = safeStat(filePath);
  if (!st) return null;
  const sig = `${st.mtimeMs}:${st.size}`;
  const cached = jsonFileCache.get(filePath);
  if (cached && cached.sig === sig) return cached.data;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    jsonFileCache.set(filePath, { sig, data });
    return data;
  } catch {
    return null;
  }
}

function parseJsonlSteps(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const steps = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      steps.push(JSON.parse(line));
    } catch {
      // Ignore partial trailing line while the Language Server is flushing.
    }
  }
  return steps;
}

function findConversationLogPaths(appDataDirs, conversationId) {
  if (!conversationId || !ID_RE.test(conversationId)) return null;
  for (const appData of appDataDirs) {
    const convDir = join(appData, 'brain', conversationId);
    const logsDir = join(convDir, '.system_generated', 'logs');
    const compactPath = join(logsDir, 'transcript.jsonl');
    const fullPath = join(logsDir, 'transcript_full.jsonl');
    if (existsSync(compactPath) || existsSync(fullPath)) {
      return { appData, convDir, logsDir, compactPath, fullPath };
    }
  }
  return null;
}

function unescapePbtxtString(raw) {
  if (!raw) return '';
  try {
    // Handle standard C/protobuf string escapes (\n, \t, \", \\, and octal/hex bytes if any)
    return raw
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');
  } catch {
    return raw;
  }
}

function parseAnnotationPbtxt(pbtxtPath) {
  const st = safeStat(pbtxtPath);
  if (!st) {
    return { title: '', sideQuestionIds: [], sideQuestionTitles: {} };
  }
  const sig = `${st.mtimeMs}:${st.size}`;
  const cached = pbtxtCache.get(pbtxtPath);
  if (cached && cached.sig === sig) return cached.data;

  let raw = '';
  try {
    raw = readFileSync(pbtxtPath, 'utf-8');
  } catch {
    return { title: '', sideQuestionIds: [], sideQuestionTitles: {} };
  }

  const titleMatch = /\btitle:"((?:[^"\\]|\\.)*)"/.exec(raw);
  const title = titleMatch ? unescapePbtxtString(titleMatch[1]).trim() : '';

  const sideQuestionIds = [];
  const seenIds = new Set();
  const idRe = /\bside_question_cascade_ids:"([0-9a-f-]{8,})"/gi;
  for (const m of raw.matchAll(idRe)) {
    const id = m[1];
    if (ID_RE.test(id) && !seenIds.has(id)) {
      seenIds.add(id);
      sideQuestionIds.push(id);
    }
  }

  const sideQuestionTitles = {};
  const titleMapRe = /\bside_question_titles:\{\s*key:"([0-9a-f-]{8,})"\s+value:"((?:[^"\\]|\\.)*)"\s*\}/gi;
  for (const m of raw.matchAll(titleMapRe)) {
    const k = m[1];
    const v = unescapePbtxtString(m[2]).trim();
    if (ID_RE.test(k) && v) {
      sideQuestionTitles[k] = v;
    }
  }

  const data = { title, sideQuestionIds, sideQuestionTitles };
  pbtxtCache.set(pbtxtPath, { sig, data });
  return data;
}

function cleanUserInputText(rawContent) {
  const content = typeof rawContent === 'string' ? rawContent : '';
  if (!content) return '';
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(content);
  const body = match ? match[1] : content.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
  return body.replace(/\r\n/g, '\n').trim();
}

function unquoteArgString(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseQuestionsArg(rawQuestions) {
  let candidate = rawQuestions;
  if (typeof candidate === 'string') {
    candidate = unquoteArgString(candidate);
    if (typeof candidate === 'string') {
      try {
        candidate = JSON.parse(candidate);
      } catch {
        return [];
      }
    }
  }
  if (!Array.isArray(candidate)) return [];
  return candidate
    .filter((q) => q && typeof q.question === 'string' && q.question.trim())
    .map((q) => ({
      question: q.question.trim(),
      isMultiSelect: Boolean(q.is_multi_select),
      options: Array.isArray(q.options)
        ? q.options.map((o) => String(o ?? '').trim()).filter(Boolean)
        : [],
    }));
}

function extractAskQuestionAnswer(rawGenericContent) {
  if (typeof rawGenericContent !== 'string' || !rawGenericContent.trim()) return '';
  const lines = rawGenericContent
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^A\d+\s*:/i.test(l));
  return lines.join('\n');
}

function formatAskQuestionMarkdown(questions, answerSummary) {
  const blocks = [];
  questions.forEach((q, idx) => {
    const modeTag = q.isMultiSelect ? '多选' : '单选';
    const header = `### ❓ 问题 ${idx + 1} (${modeTag})\n${q.question}`;
    const opts = q.options.map((opt, oIdx) => `- **选项 ${oIdx + 1}**: ${opt}`).join('\n');
    blocks.push(opts ? `${header}\n\n${opts}` : header);
  });
  if (answerSummary) {
    blocks.push(`**✅ 已选回答**\n${answerSummary}`);
  }
  return blocks.join('\n\n');
}

/**
 * Incrementally parses and caches rich steps (USER_INPUT, PLANNER_RESPONSE
 * thinking & content, ask_question tool calls, invoke_subagent calls) for a
 * transcript pair, resolving truncated fields from `transcript_full.jsonl` only
 * for new truncated steps.
 */
function extractRichTranscriptSteps(compactPath, fullPath) {
  const compactStat = safeStat(compactPath);
  const fullStat = safeStat(fullPath);
  const fileMtimeMs = compactStat?.mtimeMs || fullStat?.mtimeMs || Date.now();
  const sig = `${compactStat?.mtimeMs ?? 0}:${compactStat?.size ?? 0}|${fullStat?.mtimeMs ?? 0}:${fullStat?.size ?? 0}`;

  const primaryPath = compactStat ? compactPath : fullPath;
  const prev = rawStepsCache.get(primaryPath);
  if (prev && prev.sig === sig) {
    return prev;
  }

  // Reuse previously resolved full steps so we don't re-read 17MB transcript_full.jsonl
  // on every streaming append unless a new step is actually truncated.
  const prevResolvedByIdx = prev?.resolvedByIdx || new Map();
  const compactSteps = compactStat ? parseJsonlSteps(compactPath) : parseJsonlSteps(fullPath);
  let fullByStepIndex = null;

  const loadFullStep = (stepIdx) => {
    if (!fullStat) return null;
    if (!fullByStepIndex) {
      fullByStepIndex = new Map();
      for (const fs of parseJsonlSteps(fullPath)) {
        if (fs && typeof fs.step_index === 'number') {
          fullByStepIndex.set(fs.step_index, fs);
        }
      }
    }
    return fullByStepIndex.get(stepIdx) || null;
  };

  const resolvedByIdx = new Map();
  const richSteps = [];

  for (let i = 0; i < compactSteps.length; i++) {
    const step = compactSteps[i];
    if (!step || typeof step !== 'object') continue;
    const stepIndex = typeof step.step_index === 'number' ? step.step_index : i;
    const trunc = Array.isArray(step.truncated_fields) ? step.truncated_fields : [];
    const stepSig = `${step.status || ''}:${trunc.join(',')}:${(step.thinking || '').length}:${(step.content || '').length}:${Array.isArray(step.tool_calls) ? step.tool_calls.length : 0}`;

    const cachedStep = prevResolvedByIdx.get(stepIndex);
    let thinkingText = typeof step.thinking === 'string' ? step.thinking : '';
    let contentText = typeof step.content === 'string' ? step.content : '';
    let toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];

    if (cachedStep && cachedStep.stepSig === stepSig) {
      thinkingText = cachedStep.thinkingText;
      contentText = cachedStep.contentText;
      toolCalls = cachedStep.toolCalls;
    } else {
      if (trunc.includes('thinking') && fullStat) {
        const full = loadFullStep(stepIndex);
        if (full && typeof full.thinking === 'string' && full.thinking.trim()) {
          thinkingText = full.thinking;
        }
      }
      if (trunc.includes('content') && fullStat && step.type === 'PLANNER_RESPONSE') {
        const full = loadFullStep(stepIndex);
        if (full && typeof full.content === 'string' && full.content.trim()) {
          contentText = full.content;
        }
      }
      if (trunc.includes('tool_calls') && fullStat) {
        const full = loadFullStep(stepIndex);
        if (full && Array.isArray(full.tool_calls)) {
          toolCalls = full.tool_calls;
        }
      }
    }

    resolvedByIdx.set(stepIndex, {
      stepSig,
      thinkingText,
      contentText,
      toolCalls,
    });

    const createdAt = step.created_at || '';
    const parsedTs = createdAt ? Date.parse(createdAt) : NaN;
    const timestampMs = Number.isFinite(parsedTs) ? parsedTs : fileMtimeMs;

    if (step.type === 'USER_INPUT') {
      const userText = cleanUserInputText(contentText);
      if (userText) {
        richSteps.push({
          stepIndex,
          type: 'USER_INPUT',
          createdAt,
          timestampMs,
          status: step.status || 'DONE',
          userText,
          userHash: cachedStep?.userHash && cachedStep.userText === userText ? cachedStep.userHash : sha24(userText),
        });
      }
      continue;
    }

    if (step.type === 'PLANNER_RESPONSE') {
      const normThinking = thinkingText.replace(/\r\n/g, '\n').trim();
      const normContent = contentText.replace(/\r\n/g, '\n').trim();
      const toolNames = toolCalls
        .map((t) => t?.name)
        .filter((n) => typeof n === 'string' && n);

      let askQuestions = null;
      let askAnswer = '';
      for (const tc of toolCalls) {
        if (tc?.name === 'ask_question' && tc?.args) {
          const parsedQs = parseQuestionsArg(tc.args.questions);
          if (parsedQs.length > 0) {
            askQuestions = parsedQs;
            const nextStep = compactSteps[i + 1];
            if (nextStep && nextStep.type === 'GENERIC') {
              askAnswer = extractAskQuestionAnswer(nextStep.content);
            }
          }
        }
      }

      const thoughtHash = normThinking
        ? (cachedStep?.thoughtHash && cachedStep.normThinking === normThinking
            ? cachedStep.thoughtHash
            : sha24(normThinking))
        : '';
      const replyHash = normContent
        ? (cachedStep?.replyHash && cachedStep.normContent === normContent
            ? cachedStep.replyHash
            : sha24(normContent))
        : '';

      const prevRef = resolvedByIdx.get(stepIndex);
      if (prevRef) {
        prevRef.normThinking = normThinking;
        prevRef.thoughtHash = thoughtHash;
        prevRef.normContent = normContent;
        prevRef.replyHash = replyHash;
      }

      richSteps.push({
        stepIndex,
        type: 'PLANNER_RESPONSE',
        createdAt,
        timestampMs,
        status: step.status || 'DONE',
        model: step.model || '',
        thinking: normThinking,
        thoughtHash,
        reply: normContent,
        replyHash,
        toolNames,
        hasReply: normContent.length > 0,
        outputTokens: typeof step.output_tokens === 'number' ? step.output_tokens : null,
        charCount: normThinking.length,
        askQuestions,
        askAnswer,
      });
    }
  }

  const result = { sig, fileMtimeMs, richSteps, resolvedByIdx };
  rawStepsCache.set(primaryPath, result);
  return result;
}

function extractThinkingSteps(compactPath, fullPath) {
  const { sig, richSteps } = extractRichTranscriptSteps(compactPath, fullPath);
  const primaryPath = safeStat(compactPath) ? compactPath : fullPath;
  const cached = thinkingOnlyCache.get(primaryPath);
  if (cached && cached.sig === sig) {
    return cached;
  }

  const thinkingSteps = [];
  for (const s of richSteps) {
    if (s.type !== 'PLANNER_RESPONSE' || !s.thinking) continue;
    thinkingSteps.push({
      stepIndex: s.stepIndex,
      createdAt: s.createdAt,
      timestampMs: s.timestampMs,
      status: s.status,
      thinking: s.thinking,
      thoughtHash: s.thoughtHash,
      toolNames: s.toolNames,
      hasReply: s.hasReply,
      outputTokens: s.outputTokens,
      charCount: s.charCount,
    });
  }

  const result = { sig, steps: thinkingSteps };
  thinkingOnlyCache.set(primaryPath, result);
  return result;
}

/**
 * Reads all thinking steps for a conversation (backward-compatible API).
 */
export function readConversationThinking(appDataDirs, conversationId) {
  if (!conversationId || !ID_RE.test(conversationId)) {
    return { exists: false, sig: '', steps: [] };
  }
  const paths = findConversationLogPaths(appDataDirs, conversationId);
  if (!paths) {
    return { exists: false, sig: '', steps: [] };
  }
  const { sig, steps } = extractThinkingSteps(paths.compactPath, paths.fullPath);
  return { exists: true, sig, steps };
}

/**
 * Reads thinking steps directly from a transcript.jsonl path (used by PostInvocation hook).
 */
export function readThinkingFromTranscriptPath(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    return { exists: false, sig: '', steps: [] };
  }
  const logsDir = dirname(transcriptPath);
  const fullPath = join(logsDir, 'transcript_full.jsonl');
  if (!existsSync(transcriptPath) && !existsSync(fullPath)) {
    return { exists: false, sig: '', steps: [] };
  }
  const { sig, steps } = extractThinkingSteps(transcriptPath, fullPath);
  return { exists: true, sig, steps };
}

function extractFirstUserTitle(transcriptPath) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf-8').slice(0, 16384);
  } catch {
    return '';
  }
  const firstLine = raw.split(/\r?\n/, 1)[0];
  if (!firstLine) return '';
  try {
    const obj = JSON.parse(firstLine);
    const clean = cleanUserInputText(obj?.content).replace(/\s+/g, ' ').trim();
    return clean.slice(0, 64);
  } catch {
    return '';
  }
}

/**
 * Scans annotations, subagents, and swarm rosters to build a fast child -> parent
 * lookup index (cached for 2.5 seconds).
 */
function getFamilyIndex(appDataDirs) {
  const now = Date.now();
  const appDataKey = appDataDirs.join('|');
  if (now - familyScanCache.at < 2500 && familyScanCache.appDataKey === appDataKey) {
    return familyScanCache;
  }

  const childToParent = new Map(); // childConvId -> { parentId, kind, label }
  const convMeta = new Map(); // convId -> { appData, pbtxt, hasSwarm, swarmMembers }

  for (const appData of appDataDirs) {
    const annotationsDir = join(appData, 'annotations');
    const brainDir = join(appData, 'brain');

    // 1. Scan annotations/*.pbtxt for titles and side_question_cascade_ids
    for (const file of safeReaddir(annotationsDir)) {
      if (!file.endsWith('.pbtxt')) continue;
      const convId = file.slice(0, -6);
      if (!ID_RE.test(convId)) continue;
      const pbtxt = parseAnnotationPbtxt(join(annotationsDir, file));
      const meta = convMeta.get(convId) || { appData, pbtxt: null };
      meta.pbtxt = pbtxt;
      convMeta.set(convId, meta);

      for (const sqId of pbtxt.sideQuestionIds) {
        childToParent.set(sqId, {
          parentId: convId,
          kind: 'side_question',
          label: pbtxt.sideQuestionTitles[sqId] || '支线提问',
        });
      }
    }

    // 2. Scan brain/*/.system_generated/{swarm,subagents}
    for (const convId of safeReaddir(brainDir)) {
      if (!ID_RE.test(convId)) continue;
      const sysDir = join(brainDir, convId, '.system_generated');
      const membersPath = join(sysDir, 'swarm', 'members.json');
      const membersJson = readJsonCached(membersPath);
      if (membersJson && membersJson.members && typeof membersJson.members === 'object') {
        const meta = convMeta.get(convId) || { appData, pbtxt: null };
        meta.hasSwarm = true;
        meta.swarmDir = join(sysDir, 'swarm');
        meta.swarmMembers = membersJson;
        convMeta.set(convId, meta);

        for (const [memberName, memberInfo] of Object.entries(membersJson.members)) {
          const mConvId = memberInfo?.conversation_id;
          if (mConvId && ID_RE.test(mConvId) && mConvId !== convId) {
            childToParent.set(mConvId, {
              parentId: convId,
              kind: 'swarm_worker',
              label: `@${memberName}`,
            });
          }
        }
      }

      const subagentsDir = join(sysDir, 'subagents');
      for (const subFile of safeReaddir(subagentsDir)) {
        if (!subFile.endsWith('.json')) continue;
        const subJson = readJsonCached(join(subagentsDir, subFile));
        const subId = subJson?.conversationId;
        if (subId && ID_RE.test(subId) && subId !== convId && !childToParent.has(subId)) {
          const typeName = subJson?.subagentDescriptor?.typeName || 'subagent';
          const role = subJson?.subagentDescriptor?.role || typeName;
          childToParent.set(subId, {
            parentId: convId,
            kind: typeName === 'worker' ? 'swarm_worker' : 'subagent',
            label: role,
          });
        }
      }
    }
  }

  familyScanCache = { at: now, appDataKey, childToParent, convMeta };
  return familyScanCache;
}

/**
 * Resolves a conversationId to its root main conversation and discovers all linked
 * Side Questions, Subagents, and Swarm directories.
 */
export function resolveConversationFamily(appDataDirs, conversationId) {
  const index = getFamilyIndex(appDataDirs);
  let rootConvId = conversationId;
  let focusedChild = null;

  const parentLink = index.childToParent.get(conversationId);
  if (parentLink && ID_RE.test(parentLink.parentId)) {
    rootConvId = parentLink.parentId;
    focusedChild = {
      id: conversationId,
      kind: parentLink.kind,
      label: parentLink.label,
    };
  }

  // Locate appData for rootConvId
  const rootPaths = findConversationLogPaths(appDataDirs, rootConvId);
  const appData = rootPaths?.appData || appDataDirs[0] || '';
  const pbtxtPath = appData ? join(appData, 'annotations', `${rootConvId}.pbtxt`) : '';
  const pbtxt = pbtxtPath ? parseAnnotationPbtxt(pbtxtPath) : { title: '', sideQuestionIds: [], sideQuestionTitles: {} };

  const rootTitle =
    pbtxt.title ||
    (rootPaths ? extractFirstUserTitle(rootPaths.compactPath) : '') ||
    rootConvId.slice(0, 8);

  // Discover Side Questions
  const sideQuestions = [];
  for (const sqId of pbtxt.sideQuestionIds) {
    const sqPaths = findConversationLogPaths(appDataDirs, sqId);
    if (!sqPaths) continue;
    const st = safeStat(sqPaths.compactPath) || safeStat(sqPaths.fullPath);
    const sqPbtxt = parseAnnotationPbtxt(join(sqPaths.appData, 'annotations', `${sqId}.pbtxt`));
    const sqTitle =
      pbtxt.sideQuestionTitles[sqId] ||
      sqPbtxt.title ||
      extractFirstUserTitle(sqPaths.compactPath) ||
      `支线 ${sqId.slice(0, 6)}`;
    sideQuestions.push({
      id: sqId,
      title: sqTitle,
      mtimeMs: st?.mtimeMs || 0,
      paths: sqPaths,
    });
  }

  // Discover Swarm directory & members
  let swarmDir = null;
  let swarmCoordId = null;
  let swarmMembersJson = null;

  for (const dir of appDataDirs) {
    const candidateSwarmDir = join(dir, 'brain', rootConvId, '.system_generated', 'swarm');
    const membersPath = join(candidateSwarmDir, 'members.json');
    const boardPath = join(candidateSwarmDir, 'board.jsonl');
    if (existsSync(membersPath) || existsSync(boardPath)) {
      swarmDir = candidateSwarmDir;
      swarmCoordId = rootConvId;
      swarmMembersJson = readJsonCached(membersPath);
      break;
    }
  }

  const swarmWorkerConvIds = new Set();
  if (swarmMembersJson?.members && typeof swarmMembersJson.members === 'object') {
    for (const info of Object.values(swarmMembersJson.members)) {
      if (info?.conversation_id && ID_RE.test(info.conversation_id)) {
        swarmWorkerConvIds.add(info.conversation_id);
      }
    }
  }

  // Discover non-Swarm-worker Subagents
  const subagents = [];
  for (const dir of appDataDirs) {
    const subDir = join(dir, 'brain', rootConvId, '.system_generated', 'subagents');
    for (const file of safeReaddir(subDir)) {
      if (!file.endsWith('.json')) continue;
      const meta = readJsonCached(join(subDir, file));
      const subId = meta?.conversationId;
      if (!subId || !ID_RE.test(subId)) continue;
      const typeName = meta?.subagentDescriptor?.typeName || 'subagent';
      if (typeName === 'worker' || swarmWorkerConvIds.has(subId)) continue;
      const subPaths = findConversationLogPaths(appDataDirs, subId);
      if (!subPaths) continue;
      const st = safeStat(subPaths.compactPath) || safeStat(subPaths.fullPath);
      subagents.push({
        id: subId,
        typeName,
        role: meta?.subagentDescriptor?.role || typeName,
        state: meta?.state || '',
        spawnStepIndex: typeof meta?.spawnStepIndex === 'number' ? meta.spawnStepIndex : 0,
        mtimeMs: st?.mtimeMs || 0,
        paths: subPaths,
      });
    }
  }

  return {
    rootConvId,
    rootTitle,
    rootPaths,
    focusedChild,
    sideQuestions,
    subagents,
    swarmDir,
    swarmCoordId,
    swarmMembersJson,
  };
}

const MENTION_EXTRACT_RE = /(?:^|[^\p{L}\p{N}_-])@([\p{L}\p{N}_-]+)/gu;
const CHANNEL_MENTION_EXTRACT_RE = /(?:^|[^\p{L}\p{N}_-])@#([a-z][a-z0-9-]{0,23})(?![\p{L}\p{N}_-])/giu;

function parseSwarmBoardMessages(boardPath, memberNamesLowerMap) {
  const st = safeStat(boardPath);
  if (!st) return { sig: '0:0', messages: [] };
  const sig = `${st.mtimeMs}:${st.size}`;
  const cached = boardCache.get(boardPath);
  if (cached && cached.sig === sig) {
    return { sig, messages: cached.messages };
  }

  const rawLines = parseJsonlSteps(boardPath);
  const messages = [];
  for (const row of rawLines) {
    if (!row || typeof row.seq !== 'number') continue;
    const text = String(row.text || '').replace(/\r\n/g, '\n').trim();
    if (!text) continue;
    const agent = String(row.agent || 'unknown');
    const timeStr = String(row.time || '');
    const parsedTime = timeStr ? Date.parse(timeStr.replace(' ', 'T')) : NaN;
    const timestampMs = Number.isFinite(parsedTime) ? parsedTime : st.mtimeMs;

    const mentions = [];
    const seenMentions = new Set();
    let isAll = false;
    for (const m of text.matchAll(MENTION_EXTRACT_RE)) {
      const token = m[1];
      const lower = token.toLowerCase();
      if (lower === 'all') {
        isAll = true;
        continue;
      }
      const canonical = memberNamesLowerMap.get(lower) || token;
      if (!seenMentions.has(canonical)) {
        seenMentions.add(canonical);
        mentions.push(canonical);
      }
    }

    const channelMentions = [];
    for (const m of text.matchAll(CHANNEL_MENTION_EXTRACT_RE)) {
      const ch = m[1].toLowerCase();
      if (!channelMentions.includes(ch)) channelMentions.push(ch);
    }

    messages.push({
      seq: row.seq,
      agent,
      text,
      thoughtHash: sha24(text),
      time: timeStr,
      createdAt: Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : timeStr,
      timestampMs,
      channel: typeof row.channel === 'string' && row.channel ? row.channel : 'main',
      kind: row.kind || (row.control ? 'control' : 'post'),
      isControl: Boolean(row.control),
      mentions,
      channelMentions,
      isAll,
    });
  }

  boardCache.set(boardPath, { sig, messages });
  return { sig, messages };
}

function buildSwarmOverviewMarkdown(swarmTitle, membersList, planJson, viewJson) {
  const sections = [];
  const headline = viewJson?.headline || planJson?.goal?.title || swarmTitle || 'Swarm 多智能体协作';
  const goalLine = planJson?.goal?.line || '';

  let headerBlock = `### 🐝 ${headline}`;
  if (goalLine && goalLine !== headline) {
    headerBlock += `\n${goalLine}`;
  }
  if (viewJson?.phase && viewJson.phase.label) {
    headerBlock += `\n- **当前阶段**: ${viewJson.phase.label} (${viewJson.phase.index || 1}/${viewJson.phase.total || 1})`;
  }
  sections.push(headerBlock);

  // Attention items from view.json
  if (Array.isArray(viewJson?.attention) && viewJson.attention.length > 0) {
    const attLines = viewJson.attention.slice(0, 8).map((item) => {
      const kind = item.kind ? `[${String(item.kind).toUpperCase()}] ` : '';
      const why = item.why ? ` — ${item.why}` : '';
      return `- **${kind}${item.title || ''}**${why}`;
    });
    sections.push(`### ⚠️ 重点关注 (Attention)\n${attLines.join('\n')}`);
  }

  // Threads from plan.json or Workstreams from view.json
  if (Array.isArray(viewJson?.workstreams) && viewJson.workstreams.length > 0) {
    const wsLines = viewJson.workstreams.slice(0, 12).map((ws) => {
      const owners = Array.isArray(ws.owners) && ws.owners.length ? ` (${ws.owners.map((o) => `@${o}`).join(', ')})` : '';
      const st = ws.state ? `[${ws.state}] ` : '';
      const note = ws.note ? `：${ws.note}` : '';
      return `- **${st}${ws.title || ws.id || '任务'}**${owners}${note}`;
    });
    sections.push(`### 🔧 工作流进度 (Workstreams)\n${wsLines.join('\n')}`);
  } else if (Array.isArray(planJson?.threads) && planJson.threads.length > 0) {
    const thLines = planJson.threads.map((th) => {
      const owners = Array.isArray(th.tasks) && th.tasks.length ? ` (${th.tasks.map((o) => `@${o}`).join(', ')})` : '';
      const goal = th.goal ? `：${th.goal}` : '';
      return `- **${th.title || th.id || '分组'}**${owners}${goal}`;
    });
    sections.push(`### 🧭 任务分组 (Threads)\n${thLines.join('\n')}`);
  }

  // Tasks dictionary from plan.json
  if (planJson?.tasks && typeof planJson.tasks === 'object' && Object.keys(planJson.tasks).length > 0) {
    const taskLines = Object.entries(planJson.tasks).map(([member, desc]) => `- **@${member}**: ${desc}`);
    sections.push(`### 📋 成员分工 (Tasks)\n${taskLines.join('\n')}`);
  }

  // Risks & Milestones from view.json
  if (Array.isArray(viewJson?.risks) && viewJson.risks.length > 0) {
    const riskLines = viewJson.risks.slice(0, 6).map((r) => `- ${r.text}`);
    sections.push(`### 🚨 风险提示 (Risks)\n${riskLines.join('\n')}`);
  }
  if (Array.isArray(viewJson?.milestones) && viewJson.milestones.length > 0) {
    const msLines = viewJson.milestones.slice(0, 6).map((m) => `- ${m.text}`);
    sections.push(`### 🏁 里程碑 (Milestones)\n${msLines.join('\n')}`);
  }

  // If neither plan.json nor view.json exists, only emit an overview card if the title itself is English text worth translating
  const hasRichPlanOrView = sections.length > 1 || Boolean(goalLine);
  return {
    hasRichPlanOrView,
    markdown: sections.join('\n\n'),
  };
}

/**
 * Reads all 3 translation streams (`main`, `side`, `swarm`) for a conversation.
 */
export function readConversationStreams(appDataDirs, conversationId, settings = {}) {
  if (!conversationId || !ID_RE.test(conversationId)) {
    return {
      exists: false,
      rootConvId: conversationId || null,
      rootTitle: '',
      focusedChild: null,
      sig: 'none',
      mainSteps: [],
      sideItems: [],
      sideSources: [],
      swarm: { exists: false, title: '', members: [], channels: [], items: [] },
      streamMeta: {
        main: { count: 0, latestTs: 0, headKey: '' },
        side: { count: 0, latestTs: 0, headKey: '' },
        swarm: { count: 0, latestTs: 0, headKey: '' },
      },
    };
  }

  const family = resolveConversationFamily(appDataDirs, conversationId);
  const sigParts = [`root:${family.rootConvId}`];

  // ---------- 1. Main Conversation Stream ----------
  const mainSteps = [];
  const askItems = [];

  if (family.rootPaths) {
    const { sig, richSteps } = extractRichTranscriptSteps(
      family.rootPaths.compactPath,
      family.rootPaths.fullPath
    );
    sigParts.push(`main:${sig}`);

    const allMainThinking = [];
    for (const s of richSteps) {
      if (s.type !== 'PLANNER_RESPONSE') continue;
      if (s.thinking) {
        allMainThinking.push({
          id: `main:think:${s.stepIndex}`,
          tab: 'main',
          kind: 'main_thinking',
          stepIndex: s.stepIndex,
          badgeLabel: `Step #${s.stepIndex}`,
          createdAt: s.createdAt,
          timestampMs: s.timestampMs,
          status: s.status,
          thinking: s.thinking,
          thoughtHash: s.thoughtHash,
          toolNames: s.toolNames,
          hasReply: s.hasReply,
          outputTokens: s.outputTokens,
          charCount: s.charCount,
        });
      }
      if (settings.translateAskQuestions !== false && s.askQuestions && s.askQuestions.length > 0) {
        const md = formatAskQuestionMarkdown(s.askQuestions, s.askAnswer);
        askItems.push({
          id: `side:ask:${family.rootConvId}:${s.stepIndex}`,
          tab: 'side',
          category: 'ask_question',
          kind: 'ask_question',
          sourceId: `ask:${family.rootConvId}`,
          sourceTitle: '主会话提问卡片',
          stepIndex: s.stepIndex,
          badgeLabel: `❓ 提问卡片 · Step #${s.stepIndex}`,
          createdAt: s.createdAt,
          timestampMs: s.timestampMs,
          status: s.status,
          thinking: md,
          thoughtHash: sha24(md),
          toolNames: ['ask_question'],
          hasReply: Boolean(s.askAnswer),
          charCount: md.length,
          questionsCount: s.askQuestions.length,
        });
      }
    }

    mainSteps.push(...allMainThinking.slice(-MAX_MAIN_THINKING_STEPS));
  }

  // ---------- 2. Side Questions & Subagents Stream ----------
  const sideItems = [...askItems];
  const sideSources = [];

  if (askItems.length > 0) {
    sideSources.push({
      id: 'cat:ask_question',
      kind: 'ask_question',
      title: '❓ 提问卡片',
      count: askItems.length,
    });
  }

  if (settings.translateSideQuestions !== false) {
    for (const sq of family.sideQuestions) {
      const { sig, richSteps } = extractRichTranscriptSteps(sq.paths.compactPath, sq.paths.fullPath);
      sigParts.push(`sq:${sq.id}:${sig}`);

      const sqItems = [];
      let currentPrompt = '';
      for (const s of richSteps) {
        if (s.type === 'USER_INPUT') {
          currentPrompt = s.userText;
          // If the user's side question prompt itself contains English letters, include it as a card
          if (currentPrompt && /[A-Za-z]{3,}/.test(currentPrompt)) {
            sqItems.push({
              id: `side:sq:${sq.id}:prompt:${s.stepIndex}`,
              tab: 'side',
              category: 'side_question',
              kind: 'side_question_prompt',
              sourceId: `sq:${sq.id}`,
              sourceTitle: sq.title,
              stepIndex: s.stepIndex,
              badgeLabel: `🙋 支线提问 · Step #${s.stepIndex}`,
              createdAt: s.createdAt,
              timestampMs: s.timestampMs,
              status: s.status,
              thinking: currentPrompt,
              thoughtHash: s.userHash,
              toolNames: [],
              hasReply: false,
              charCount: currentPrompt.length,
            });
          }
          continue;
        }
        if (s.type === 'PLANNER_RESPONSE') {
          if (s.thinking) {
            sqItems.push({
              id: `side:sq:${sq.id}:think:${s.stepIndex}`,
              tab: 'side',
              category: 'side_question',
              kind: 'side_question_thinking',
              sourceId: `sq:${sq.id}`,
              sourceTitle: sq.title,
              promptPreview: currentPrompt ? currentPrompt.slice(0, 90) : '',
              stepIndex: s.stepIndex,
              badgeLabel: `💭 支线思考 · Step #${s.stepIndex}`,
              createdAt: s.createdAt,
              timestampMs: s.timestampMs,
              status: s.status,
              thinking: s.thinking,
              thoughtHash: s.thoughtHash,
              toolNames: s.toolNames,
              hasReply: s.hasReply,
              charCount: s.charCount,
            });
          }
          if (s.reply) {
            sqItems.push({
              id: `side:sq:${sq.id}:reply:${s.stepIndex}`,
              tab: 'side',
              category: 'side_question',
              kind: 'side_question_reply',
              sourceId: `sq:${sq.id}`,
              sourceTitle: sq.title,
              promptPreview: currentPrompt ? currentPrompt.slice(0, 90) : '',
              stepIndex: s.stepIndex,
              badgeLabel: `💬 支线回复 · Step #${s.stepIndex}`,
              createdAt: s.createdAt,
              timestampMs: s.timestampMs,
              status: s.status,
              thinking: s.reply,
              thoughtHash: s.replyHash,
              toolNames: [],
              hasReply: true,
              charCount: s.reply.length,
            });
          }
          if (settings.translateAskQuestions !== false && s.askQuestions && s.askQuestions.length > 0) {
            const md = formatAskQuestionMarkdown(s.askQuestions, s.askAnswer);
            sqItems.push({
              id: `side:ask:${sq.id}:${s.stepIndex}`,
              tab: 'side',
              category: 'ask_question',
              kind: 'ask_question',
              sourceId: `sq:${sq.id}`,
              sourceTitle: sq.title,
              stepIndex: s.stepIndex,
              badgeLabel: `❓ 支线提问卡 · Step #${s.stepIndex}`,
              createdAt: s.createdAt,
              timestampMs: s.timestampMs,
              status: s.status,
              thinking: md,
              thoughtHash: sha24(md),
              toolNames: ['ask_question'],
              hasReply: Boolean(s.askAnswer),
              charCount: md.length,
            });
          }
        }
      }

      const trimmedSqItems = sqItems.slice(-MAX_SIDE_STEPS_PER_SOURCE);
      if (trimmedSqItems.length > 0) {
        sideItems.push(...trimmedSqItems);
        sideSources.push({
          id: `sq:${sq.id}`,
          kind: 'side_question',
          title: `💬 ${sq.title}`,
          count: trimmedSqItems.length,
          focused: family.focusedChild?.id === sq.id,
        });
      }
    }
  }

  if (settings.translateSubagents !== false) {
    for (const sub of family.subagents) {
      const { sig, richSteps } = extractRichTranscriptSteps(sub.paths.compactPath, sub.paths.fullPath);
      sigParts.push(`sub:${sub.id}:${sig}`);

      const subItems = [];
      for (const s of richSteps) {
        if (s.type === 'USER_INPUT' && s.stepIndex === 0 && s.userText) {
          subItems.push({
            id: `side:sub:${sub.id}:brief:0`,
            tab: 'side',
            category: 'subagent',
            kind: 'subagent_brief',
            sourceId: `sub:${sub.id}`,
            sourceTitle: `${sub.role} (${sub.typeName})`,
            stepIndex: 0,
            badgeLabel: `📋 子代理任务简报`,
            createdAt: s.createdAt,
            timestampMs: s.timestampMs,
            status: s.status,
            thinking: s.userText,
            thoughtHash: s.userHash,
            toolNames: [],
            hasReply: false,
            charCount: s.userText.length,
          });
          continue;
        }
        if (s.type === 'PLANNER_RESPONSE') {
          if (s.thinking) {
            subItems.push({
              id: `side:sub:${sub.id}:think:${s.stepIndex}`,
              tab: 'side',
              category: 'subagent',
              kind: 'subagent_thinking',
              sourceId: `sub:${sub.id}`,
              sourceTitle: `${sub.role} (${sub.typeName})`,
              stepIndex: s.stepIndex,
              badgeLabel: `💭 子代理思考 · Step #${s.stepIndex}`,
              createdAt: s.createdAt,
              timestampMs: s.timestampMs,
              status: s.status,
              thinking: s.thinking,
              thoughtHash: s.thoughtHash,
              toolNames: s.toolNames,
              hasReply: s.hasReply,
              charCount: s.charCount,
            });
          }
          if (s.reply) {
            subItems.push({
              id: `side:sub:${sub.id}:reply:${s.stepIndex}`,
              tab: 'side',
              category: 'subagent',
              kind: 'subagent_reply',
              sourceId: `sub:${sub.id}`,
              sourceTitle: `${sub.role} (${sub.typeName})`,
              stepIndex: s.stepIndex,
              badgeLabel: `📤 子代理报告 · Step #${s.stepIndex}`,
              createdAt: s.createdAt,
              timestampMs: s.timestampMs,
              status: s.status,
              thinking: s.reply,
              thoughtHash: s.replyHash,
              toolNames: [],
              hasReply: true,
              charCount: s.reply.length,
            });
          }
        }
      }

      const trimmedSubItems = subItems.slice(-MAX_SIDE_STEPS_PER_SOURCE);
      if (trimmedSubItems.length > 0) {
        sideItems.push(...trimmedSubItems);
        sideSources.push({
          id: `sub:${sub.id}`,
          kind: 'subagent',
          title: `🤖 ${sub.role}`,
          count: trimmedSubItems.length,
          focused: family.focusedChild?.id === sub.id,
        });
      }
    }
  }

  sideItems.sort((a, b) => a.timestampMs - b.timestampMs || a.stepIndex - b.stepIndex);

  // ---------- 3. Swarm Multi-Agent Stream ----------
  let swarmResult = {
    exists: false,
    swarmId: null,
    title: '',
    members: [],
    channels: [],
    items: [],
  };

  if (family.swarmDir) {
    const membersPath = join(family.swarmDir, 'members.json');
    const boardPath = join(family.swarmDir, 'board.jsonl');
    const planPath = join(family.swarmDir, 'plan.json');
    const viewPath = join(family.swarmDir, 'view.json');

    const membersJson = readJsonCached(membersPath) || { title: '', members: {} };
    const planJson = readJsonCached(planPath);
    let viewJson = readJsonCached(viewPath);

    const rawMembers = membersJson.members && typeof membersJson.members === 'object'
      ? membersJson.members
      : {};
    const memberNamesLowerMap = new Map();
    for (const name of Object.keys(rawMembers)) {
      memberNamesLowerMap.set(name.toLowerCase(), name);
    }

    // Check narrator's swarm_view/view.json fallback if no view.json in swarmDir
    if (!viewJson) {
      for (const [mName, mInfo] of Object.entries(rawMembers)) {
        if ((mInfo?.role === 'narrator' || /^narrator(-\d+)?$/i.test(mName)) && mInfo?.conversation_id) {
          for (const dir of appDataDirs) {
            const candidateView = join(dir, 'brain', mInfo.conversation_id, 'swarm_view', 'view.json');
            viewJson = readJsonCached(candidateView);
            if (viewJson) break;
          }
        }
        if (viewJson) break;
      }
    }

    const { sig: boardSig, messages: boardMessages } = parseSwarmBoardMessages(boardPath, memberNamesLowerMap);
    sigParts.push(`swarmBoard:${boardSig}`);

    const postCountsByAgent = new Map();
    const channelSet = new Set(['main']);
    for (const m of boardMessages) {
      postCountsByAgent.set(m.agent, (postCountsByAgent.get(m.agent) || 0) + 1);
      if (m.channel) channelSet.add(m.channel);
    }

    const membersList = [];
    const workerThinkingItems = [];

    for (const [name, info] of Object.entries(rawMembers)) {
      const mConvId = info?.conversation_id || '';
      const killed = Boolean(info?.killed || info?.phase === 'KILLED' || info?.desired_state === 'KILLED');
      const role = info?.role || (/^(narrator|monitor)(-\d+)?$/i.test(name) ? name.replace(/-\d+$/, '') : 'worker');
      const model = info?.applied_model || info?.model || info?.desired_model || '';

      let status = killed ? 'killed' : info?.wake_mode === 'working' ? 'working' : 'waiting';
      let thinkingCount = 0;

      if (mConvId && ID_RE.test(mConvId) && mConvId !== family.rootConvId) {
        const mPaths = findConversationLogPaths(appDataDirs, mConvId);
        if (mPaths) {
          const { sig: mSig, richSteps: mSteps } = extractRichTranscriptSteps(mPaths.compactPath, mPaths.fullPath);
          sigParts.push(`swm:${name}:${mSig}`);

          // Determine live working/waiting status from newest step
          if (!killed && mSteps.length > 0) {
            const lastRich = mSteps[mSteps.length - 1];
            const isWaitCall = Array.isArray(lastRich.toolNames) && lastRich.toolNames.includes('swarm_wait');
            const endedWithReplyOnly = lastRich.type === 'PLANNER_RESPONSE' && (!lastRich.toolNames || lastRich.toolNames.length === 0) && lastRich.hasReply;
            status = isWaitCall || endedWithReplyOnly ? 'waiting' : 'working';
          }

          const memberThinks = [];
          for (const s of mSteps) {
            if (s.type !== 'PLANNER_RESPONSE' || !s.thinking) continue;
            thinkingCount++;
            if (settings.translateSwarmWorkers !== false) {
              memberThinks.push({
                id: `swarm:worker:${name}:think:${s.stepIndex}`,
                tab: 'swarm',
                category: 'worker_thinking',
                kind: 'swarm_worker_thinking',
                agent: name,
                agentRole: role,
                agentModel: model,
                agentStatus: status,
                stepIndex: s.stepIndex,
                badgeLabel: `💭 @${name} 思考 · Step #${s.stepIndex}`,
                createdAt: s.createdAt,
                timestampMs: s.timestampMs,
                status: s.status,
                thinking: s.thinking,
                thoughtHash: s.thoughtHash,
                toolNames: s.toolNames,
                hasReply: s.hasReply,
                charCount: s.charCount,
              });
            }
          }
          workerThinkingItems.push(...memberThinks.slice(-MAX_SWARM_WORKER_STEPS_PER_MEMBER));
        }
      }

      membersList.push({
        name,
        conversationId: mConvId,
        role,
        model,
        status,
        killed,
        postsCount: postCountsByAgent.get(name) || 0,
        thinkingCount,
      });
    }

    const memberStatusMap = new Map(membersList.map((m) => [m.name, m]));
    const swarmItems = [];

    // 3a. Swarm Overview / Plan Card
    const swarmTitle = membersJson.title || 'Swarm 多智能体协作';
    if (settings.translateSwarmOverview !== false) {
      const ov = buildSwarmOverviewMarkdown(swarmTitle, membersList, planJson, viewJson);
      if (ov.hasRichPlanOrView || /[A-Za-z]{3,}/.test(swarmTitle)) {
        const ovStat = safeStat(viewPath) || safeStat(planPath) || safeStat(membersPath);
        swarmItems.push({
          id: `swarm:overview:${family.swarmCoordId}`,
          tab: 'swarm',
          category: 'overview',
          kind: 'swarm_overview',
          agent: 'coordinator',
          stepIndex: 0,
          badgeLabel: '📋 Swarm 概览与任务计划',
          sourceTitle: swarmTitle,
          createdAt: viewJson?.updated_at || (ovStat ? new Date(ovStat.mtimeMs).toISOString() : ''),
          timestampMs: ovStat?.mtimeMs || 0,
          status: 'DONE',
          thinking: ov.markdown,
          thoughtHash: sha24(ov.markdown),
          toolNames: [],
          hasReply: false,
          charCount: ov.markdown.length,
        });
      }
    }

    // 3b. Swarm Board Messages (board.jsonl)
    const timelineItems = [];
    if (settings.translateSwarmBoard !== false) {
      for (const m of boardMessages.slice(-MAX_SWARM_BOARD_POSTS)) {
        const mem = memberStatusMap.get(m.agent);
        timelineItems.push({
          id: `swarm:post:${m.seq}`,
          tab: 'swarm',
          category: 'board',
          kind: 'swarm_post',
          seq: m.seq,
          stepIndex: m.seq,
          agent: m.agent,
          agentRole: mem?.role || 'worker',
          agentModel: mem?.model || '',
          agentStatus: mem?.status || 'waiting',
          mentions: m.mentions,
          channelMentions: m.channelMentions,
          channel: m.channel,
          isAll: m.isAll,
          postKind: m.kind,
          isControl: m.isControl,
          badgeLabel: `#${m.seq} · @${m.agent}`,
          createdAt: m.createdAt,
          timeLabel: m.time,
          timestampMs: m.timestampMs,
          status: 'DONE',
          thinking: m.text,
          thoughtHash: m.thoughtHash,
          toolNames: [],
          hasReply: true,
          charCount: m.text.length,
        });
      }
    }

    // 3c. Swarm Worker Thinking Steps
    if (settings.translateSwarmWorkers !== false && workerThinkingItems.length > 0) {
      timelineItems.push(...workerThinkingItems);
    }

    timelineItems.sort((a, b) => {
      if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
      if (a.kind === 'swarm_post' && b.kind === 'swarm_post') return a.seq - b.seq;
      return a.stepIndex - b.stepIndex;
    });

    swarmItems.push(...timelineItems);

    swarmResult = {
      exists: boardMessages.length > 0 || membersList.length > 0,
      swarmId: family.swarmCoordId,
      title: swarmTitle,
      members: membersList,
      channels: [...channelSet],
      items: swarmItems,
    };
  }

  const computeStreamMeta = (items) => {
    if (!items.length) return { count: 0, latestTs: 0, headKey: '' };
    let latestTs = 0;
    for (const item of items) {
      if (item.timestampMs > latestTs) latestTs = item.timestampMs;
    }
    const last = items[items.length - 1];
    return {
      count: items.length,
      latestTs,
      headKey: `${items.length}:${last.id}:${last.thoughtHash}`,
    };
  };

  const exists = Boolean(family.rootPaths) || sideItems.length > 0 || swarmResult.exists;

  return {
    exists,
    rootConvId: family.rootConvId,
    rootTitle: family.rootTitle,
    focusedChild: family.focusedChild,
    sig: sigParts.join('|'),
    mainSteps,
    sideItems,
    sideSources,
    swarm: swarmResult,
    streamMeta: {
      main: computeStreamMeta(mainSteps),
      side: computeStreamMeta(sideItems),
      swarm: computeStreamMeta(swarmResult.items),
    },
  };
}

/**
 * Lists recent main conversations (filtering out or tagging child side-questions
 * and Swarm workers so the dropdown stays clean and informative).
 */
export function listRecentConversations(appDataDirs, limit = 25) {
  const index = getFamilyIndex(appDataDirs);
  const seen = new Map();

  for (const appData of appDataDirs) {
    const brainDir = join(appData, 'brain');
    for (const id of safeReaddir(brainDir)) {
      if (!ID_RE.test(id)) continue;
      // Skip child conversations (side questions / swarm workers / subagents) in the top-level selector
      if (index.childToParent.has(id)) continue;

      const transcriptPath = join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
      const st = safeStat(transcriptPath);
      if (!st) continue;

      const pbtxt = parseAnnotationPbtxt(join(appData, 'annotations', `${id}.pbtxt`));
      const hasSwarm = existsSync(join(brainDir, id, '.system_generated', 'swarm', 'board.jsonl'));
      const sideCount = pbtxt.sideQuestionIds.length;

      let latestMtime = st.mtimeMs;
      if (hasSwarm) {
        const boardSt = safeStat(join(brainDir, id, '.system_generated', 'swarm', 'board.jsonl'));
        if (boardSt && boardSt.mtimeMs > latestMtime) latestMtime = boardSt.mtimeMs;
      }

      const prev = seen.get(id);
      if (!prev || latestMtime > prev.mtimeMs) {
        seen.set(id, {
          id,
          mtimeMs: latestMtime,
          transcriptPath,
          pbtxtTitle: pbtxt.title,
          hasSwarm,
          sideCount,
        });
      }
    }
  }

  return [...seen.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((item) => {
      const baseTitle = item.pbtxtTitle || extractFirstUserTitle(item.transcriptPath) || item.id.slice(0, 8);
      const badges = [];
      if (item.hasSwarm) badges.push('🐝Swarm');
      if (item.sideCount > 0) badges.push(`💬支线×${item.sideCount}`);
      const suffix = badges.length ? ` [${badges.join(' ')}]` : '';
      return {
        id: item.id,
        updatedAt: new Date(item.mtimeMs).toISOString(),
        title: `${baseTitle}${suffix}`,
        hasSwarm: item.hasSwarm,
        sideCount: item.sideCount,
      };
    });
}
