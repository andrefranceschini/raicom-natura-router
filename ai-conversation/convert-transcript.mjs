// Converts a Claude Code session log (JSONL) into a readable Markdown transcript.
// It copies messages and tool results verbatim; nothing is summarized or rewritten.
// Usage: node convert-transcript.mjs <session.jsonl> <outDir> [redactions.json]
//
// Included: user messages (also those sent mid-turn), assistant replies, every tool call with its
// input, and every tool result (screenshots saved as images).
// Excluded, and explained in the generated header: app-injected context, <system-reminder> notes,
// API bookkeeping records, and model reasoning, which the log stores only partially.
// The redaction list is kept outside the repository, because it names what it hides.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [input, outDir, redactionsPath] = process.argv.slice(2);
const records = readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// Each redaction is { find, replace, category }; applied to the whole output, counted per category.
const redactions = redactionsPath ? JSON.parse(readFileSync(redactionsPath, 'utf8')) : [];
mkdirSync(join(outDir, 'images'), { recursive: true });

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
let remindersStripped = 0;
const stripReminders = (text) =>
  String(text)
    .replace(REMINDER, () => {
      remindersStripped++;
      return '';
    })
    .trim();
// A fence longer than any backtick run inside the content, so code never breaks out of its block.
const fence = (text, lang = '') => {
  const longest = Math.max(2, ...(String(text).match(/`+/g) ?? []).map((m) => m.length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
};
const time = (ts) => (ts ? ts.slice(11, 19) + ' UTC' : '');

const out = [];
const seenBlocks = new Set();
const toolNames = new Map();
const counts = { userMessages: 0, toolCalls: 0, toolResults: 0, images: 0, thinking: 0, thinkingWithText: 0 };

function renderResultContent(content) {
  const parts = [];
  const items = typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? [];
  for (const item of items) {
    if (item.type === 'text') {
      const text = stripReminders(item.text);
      if (text) parts.push(fence(text));
    } else if (item.type === 'image' && item.source?.type === 'base64') {
      const ext = item.source.media_type === 'image/png' ? 'png' : 'jpg';
      const file = `images/screenshot-${String(++counts.images).padStart(2, '0')}.${ext}`;
      writeFileSync(join(outDir, file), Buffer.from(item.source.data, 'base64'));
      parts.push(`![screenshot ${counts.images}](${file})`);
    }
  }
  return parts.join('\n\n') || '_(no output)_';
}

for (const r of records) {
  if (r.isSidechain) continue;

  if (r.type === 'attachment' && r.attachment?.type === 'queued_command') {
    counts.userMessages++;
    out.push(`### User · ${time(r.timestamp)} · sent while the assistant was working\n\n${stripReminders(r.attachment.prompt)}`);
    continue;
  }

  if (r.type === 'user' && r.message && !r.isMeta) {
    const content = r.message.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    for (const b of blocks) {
      if (b.type === 'text') {
        const text = stripReminders(b.text);
        if (!text) continue;
        counts.userMessages++;
        out.push(`---\n\n## User · ${time(r.timestamp)}\n\n${text}`);
      } else if (b.type === 'tool_result') {
        counts.toolResults++;
        const name = toolNames.get(b.tool_use_id) ?? 'tool';
        const status = b.is_error ? ' (error)' : '';
        out.push(`<details><summary>Result: ${name}${status}</summary>\n\n${renderResultContent(b.content)}\n\n</details>`);
      }
    }
    continue;
  }

  if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
    r.message.content.forEach((b, i) => {
      const key = b.id ?? `${r.message.id}:${r.apiBlockIndex ?? i}:${b.type}`;
      if (seenBlocks.has(key)) return;
      seenBlocks.add(key);
      if (b.type === 'thinking') {
        counts.thinking++;
        if ((b.thinking ?? '').trim()) counts.thinkingWithText++;
      } else if (b.type === 'text' && b.text.trim()) {
        out.push(`### Assistant · ${time(r.timestamp)}\n\n${b.text.trim()}`);
      } else if (b.type === 'tool_use') {
        counts.toolCalls++;
        toolNames.set(b.id, b.name);
        const target = b.input?.file_path ?? b.input?.description ?? b.input?.url ?? '';
        out.push(`<details><summary>Tool call: ${b.name}${target ? ` · ${String(target).replace(/</g, '&lt;')}` : ''}</summary>\n\n${fence(JSON.stringify(b.input, null, 2), 'json')}\n\n</details>`);
      }
    });
  }
}

let body = out.join('\n\n');
const redactedByCategory = new Map();
for (const x of redactions) {
  const hits = body.split(x.find).length - 1;
  if (hits) redactedByCategory.set(x.category, (redactedByCategory.get(x.category) ?? 0) + hits);
  body = body.split(x.find).join(x.replace);
}

const times = records.map((r) => r.timestamp).filter(Boolean);
const model = records.find((r) => r.type === 'assistant')?.message?.model ?? 'unknown';
const redactionNote = redactedByCategory.size
  ? `Each removal is marked inline as \`[REDACTED: …]\`. Nothing else was changed.\n\n${[...redactedByCategory]
      .map(([category, n]) => `- **${category}**: ${n} occurrence${n === 1 ? '' : 's'}`)
      .join('\n')}`
  : 'None.';

const header = `# AI conversation: Raicom assessment

Generated from the local Claude Code session log by [\`convert-transcript.mjs\`](convert-transcript.mjs). Messages, tool calls and tool results are copied verbatim from the log, not reconstructed. Tool calls and results are collapsed; click to expand.

- Session: \`${records.find((r) => r.sessionId)?.sessionId}\`
- Model: \`${model}\`
- Covers: ${times[0]} to ${times.at(-1)}
- Contains: ${counts.userMessages} user messages, ${counts.toolCalls} tool calls, ${counts.toolResults} tool results, ${counts.images} screenshots

## Redactions

The repository is public, so private details that came through tool output were removed. ${redactionNote}

## What this file does not contain

- **Model reasoning.** The log holds ${counts.thinking} reasoning blocks, but only ${counts.thinkingWithText} still contain text; the rest are stored empty. None are included, so the file doesn't present a partial view of the reasoning as complete.
- **Context injected by the app**, not written by the user or returned by a tool: the system prompt, the user's personal assistant instructions, environment details, tool, skill and agent listings, and hook output. The log stores these as separate records, so leaving them out removes nothing from the messages or tool results.${remindersStripped ? ` ${remindersStripped} \`<system-reminder>\` app notices found inside messages were also removed.` : ''}
- **API bookkeeping records** (request metadata, snapshots, titles).
- **The end of the session.** The file covers the log up to the time above. The final reply of the turn that generated it, and anything after, came later.
`;

writeFileSync(join(outDir, 'transcript.md'), `${header}\n---\n\n${body}\n`);
console.log(JSON.stringify({ ...counts, remindersStripped, redactions: Object.fromEntries(redactedByCategory) }));
