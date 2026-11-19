/**
 * Read-only transcript reader for Antigravity conversations.
 *
 * Reads `<appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`
 * and resolves truncated `thinking` fields from `transcript_full.jsonl` when
 * `truncated_fields` includes `"thinking"`. Never modifies any session file.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const ID_RE = /^[0-9a-f-]{8,}$/i;

const parsedTranscriptCache = new Map(); // convId -> { sig, steps }

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
  // Prefer `antigravity` first if present.
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

function safeStat(path) {
  try {
    return statSync(path);
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
    const logsDir = join(appData, 'brain', conversationId, '.system_generated', 'logs');
    const compactPath = join(logsDir, 'transcript.jsonl');
    const fullPath = join(logsDir, 'transcript_full.jsonl');
    if (existsSync(compactPath) || existsSync(fullPath)) {
      return { appData, compactPath, fullPath };
    }
  }
  return null;
}

function extractThinkingSteps(compactPath, fullPath) {
  const compactStat = safeStat(compactPath);
  const fullStat = safeStat(fullPath);
  const sig = `${compactStat?.mtimeMs ?? 0}:${compactStat?.size ?? 0}|${fullStat?.mtimeMs ?? 0}:${fullStat?.size ?? 0}`;

  const primaryPath = compactStat ? compactPath : fullPath;
  const cached = parsedTranscriptCache.get(primaryPath);
  if (cached && cached.sig === sig) {
    return cached;
  }

  const compactSteps = compactStat ? parseJsonlSteps(compactPath) : parseJsonlSteps(fullPath);
  let fullByStepIndex = null;

  const thinkingSteps = [];
  for (const step of compactSteps) {
    if (!step || typeof step.thinking !== 'string' || !step.thinking.trim()) {
      continue;
    }

    let thinkingText = step.thinking;
    const truncated = Array.isArray(step.truncated_fields) && step.truncated_fields.includes('thinking');
    if (truncated && fullStat) {
      if (!fullByStepIndex) {
        fullByStepIndex = new Map();
        for (const fullStep of parseJsonlSteps(fullPath)) {
          if (fullStep && typeof fullStep.step_index === 'number') {
            fullByStepIndex.set(fullStep.step_index, fullStep);
          }
        }
      }
      const matchedFull = fullByStepIndex.get(step.step_index);
      if (matchedFull && typeof matchedFull.thinking === 'string' && matchedFull.thinking.trim()) {
        thinkingText = matchedFull.thinking;
      }
    }

    const normalized = thinkingText.replace(/\r\n/g, '\n').trim();
    if (!normalized) continue;

    const toolNames = Array.isArray(step.tool_calls)
      ? step.tool_calls.map((t) => t?.name).filter((n) => typeof n === 'string' && n)
      : [];
    const thoughtHash = createHash('sha256').update(normalized).digest('hex').slice(0, 24);

    thinkingSteps.push({
      stepIndex: typeof step.step_index === 'number' ? step.step_index : thinkingSteps.length,
      createdAt: step.created_at || '',
      status: step.status || 'DONE',
      thinking: normalized,
      thoughtHash,
      toolNames,
      hasReply: typeof step.content === 'string' && step.content.trim().length > 0,
      outputTokens: typeof step.output_tokens === 'number' ? step.output_tokens : null,
      charCount: normalized.length,
    });
  }

  const result = { sig, steps: thinkingSteps };
  parsedTranscriptCache.set(primaryPath, result);
  return result;
}

/**
 * Reads all thinking steps for a conversation.
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
 * Reads thinking steps directly from a transcript.jsonl path (plus sibling
 * transcript_full.jsonl when truncated_fields includes "thinking").
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
    // Reading first 16 KB is enough for step 0 USER_INPUT.
    raw = readFileSync(transcriptPath, 'utf-8').slice(0, 16384);
  } catch {
    return '';
  }
  const firstLine = raw.split(/\r?\n/, 1)[0];
  if (!firstLine) return '';
  try {
    const obj = JSON.parse(firstLine);
    const content = typeof obj?.content === 'string' ? obj.content : '';
    const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(content);
    const clean = (match ? match[1] : content).replace(/\s+/g, ' ').trim();
    return clean.slice(0, 64);
  } catch {
    return '';
  }
}

/**
 * Lists recent conversations that have transcript logs.
 */
export function listRecentConversations(appDataDirs, limit = 20) {
  const seen = new Map();
  for (const appData of appDataDirs) {
    const brainDir = join(appData, 'brain');
    for (const id of safeReaddir(brainDir)) {
      if (!ID_RE.test(id)) continue;
      const transcriptPath = join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
      const st = safeStat(transcriptPath);
      if (!st) continue;
      const prev = seen.get(id);
      if (!prev || st.mtimeMs > prev.mtimeMs) {
        seen.set(id, { id, mtimeMs: st.mtimeMs, transcriptPath });
      }
    }
  }

  return [...seen.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      updatedAt: new Date(item.mtimeMs).toISOString(),
      title: extractFirstUserTitle(item.transcriptPath) || item.id.slice(0, 8),
    }));
}
