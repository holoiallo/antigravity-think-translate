/**
 * PostInvocation lifecycle hook for Think Translate.
 *
 * Fires synchronously after tool calls finish and before the next model
 * invocation. Reads newly produced `thinking` blocks from the current turn's
 * transcript, translates them via the shared ThinkingTranslator (using the same
 * settings and disk cache as the right-hand sidecar panel), and injects compact
 * Simplified Chinese blockquotes into the main chat stream via
 * `metadata.user_markdown` (leaving `systemMessage` empty so the model never
 * sees the injected translation).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  findAppDataDirs,
  ID_RE,
  readConversationThinking,
  readThinkingFromTranscriptPath,
  resolveDataDirFromTranscriptPath,
} from '../sidecars/think_panel/transcript.mjs';
import { isMostlyChinese, ThinkingTranslator } from '../sidecars/think_panel/translator.mjs';

const HOOK_REQUEST_TIMEOUT_MS = 4500;
const MAX_STEPS_PER_HOOK = 3;

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  return raw ? JSON.parse(raw) : {};
}

function readCursor(cursorPath, initialNumSteps) {
  try {
    if (existsSync(cursorPath)) {
      const parsed = JSON.parse(readFileSync(cursorPath, 'utf-8'));
      if (typeof parsed?.lastInlinedStepIndex === 'number') {
        return parsed.lastInlinedStepIndex;
      }
    }
  } catch {
    // Ignore corrupt cursor and derive from initialNumSteps.
  }
  // When first enabled mid-conversation, start from current turn only.
  return typeof initialNumSteps === 'number' && initialNumSteps > 0 ? initialNumSteps - 1 : -1;
}

function writeCursorAtomic(cursorPath, lastInlinedStepIndex) {
  mkdirSync(dirname(cursorPath), { recursive: true });
  const tmpPath = `${cursorPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ lastInlinedStepIndex, updatedAt: Date.now() }), 'utf-8');
  renameSync(tmpPath, cursorPath);
}

function formatBlockquote(step, translatedText) {
  const tools = Array.isArray(step.toolNames) && step.toolNames.length
    ? ` · ${step.toolNames.slice(0, 2).join(', ')}${step.toolNames.length > 2 ? '…' : ''}`
    : '';
  const header = `> **💭 思考过程（Step #${step.stepIndex}${tools}）**`;
  const lines = String(translatedText || '')
    .replace(/\r\n/g, '\n')
    .trim()
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`));
  return `${header}\n>\n${lines.join('\n')}`;
}

async function main() {
  const input = await readStdinJson();
  const convId = typeof input?.conversationId === 'string' && ID_RE.test(input.conversationId)
    ? input.conversationId
    : '';
  const transcriptPath = typeof input?.transcriptPath === 'string' ? input.transcriptPath : '';
  const initialNumSteps = typeof input?.initialNumSteps === 'number' ? input.initialNumSteps : 0;

  const appDataDirs = findAppDataDirs();
  const dataDir = resolveDataDirFromTranscriptPath(transcriptPath, appDataDirs);
  const translator = new ThinkingTranslator(dataDir, { requestTimeoutMs: HOOK_REQUEST_TIMEOUT_MS });
  const settings = translator.getPublicSettings();

  if (!settings.inlineHook) {
    process.stdout.write('{}');
    return;
  }

  let transcript = readThinkingFromTranscriptPath(transcriptPath);
  if (!transcript.exists && convId) {
    transcript = readConversationThinking(appDataDirs, convId);
  }
  if (!transcript.exists || !transcript.steps.length) {
    process.stdout.write('{}');
    return;
  }

  const cursorKey = convId || 'default';
  const cursorPath = join(dataDir, 'hook-state', `${cursorKey}.json`);
  const floorStep = readCursor(cursorPath, initialNumSteps);

  const candidates = transcript.steps.filter((s) => s.stepIndex > floorStep);
  if (!candidates.length) {
    process.stdout.write('{}');
    return;
  }

  const maxStepIndex = candidates[candidates.length - 1].stepIndex;
  const quotes = [];

  for (const step of candidates.slice(-MAX_STEPS_PER_HOOK)) {
    if (settings.skipChinese && isMostlyChinese(step.thinking)) {
      continue;
    }
    try {
      const result = await translator.translateStep(step, { force: false });
      if (result?.translatedText) {
        quotes.push(formatBlockquote(step, result.translatedText));
      }
    } catch {
      // Do not block or break the agent loop on transient translation errors;
      // the right-hand sidecar panel still preserves the original + Retry button.
    }
  }

  translator.flushCacheSync();
  writeCursorAtomic(cursorPath, maxStepIndex);

  if (!quotes.length) {
    process.stdout.write('{}');
    return;
  }

  const payload = {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: '',
          metadata: {
            user_markdown: quotes.join('\n\n'),
          },
        },
      },
    ],
  };
  process.stdout.write(JSON.stringify(payload));
}

main().catch(() => {
  process.stdout.write('{}');
});
