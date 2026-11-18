// Antigravity 1.5's own queue, read from Herdr's visible screen (no scrollback).
// Pending messages are not in transcript_full.jsonl until the CLI accepts them.
// These are display previews, not editable copies: terminal wrapping/truncation
// cannot recover the user's original whitespace or text beyond the screen.
const RULE = /^─{10,}$/u;
const MARK = /^▸(?: |$)/u;
const HINT = /\s*\(alt\+m to send immediately\)$/u;
const TASK = /^\s*● \[\d{2}:\d{2}:\d{2}\] /u;
const trailing = (line) => line.replace(/\r$/, "").replace(/[\t \u00a0]+$/u, "");

// null: the current input/queue frame cannot be identified safely.
// {known:true,items:[]}: an identifiable input frame has no visible queue.
// The caller must also check the read's complete/how and live terminal identity.
export function parseAntigravityQueue(screen) {
  if (typeof screen !== "string" || screen.length > 1000000 || /\x1b/.test(screen)) return null;
  const lines = screen.split("\n").map(trailing);
  const rules = [];
  for (let i = 0; i < lines.length; i++) if (RULE.test(lines[i].trim())) rules.push(i);
  if (rules.length < 2) return null;
  let top = -1;
  // A running background task adds another ruled footer BELOW the composer.
  // Skip only that observed task footer; a menu/approval frame is unknown, so
  // never fall back to an old prompt above it in the conversation.
  for (let i = rules.length - 2; i >= 0; i--) {
    const inside = lines.slice(rules[i] + 1, rules[i + 1]);
    if (/^>(?: |$)/u.test(inside[0] ?? "")) { top = rules[i]; break; }
    if (!inside.length || !TASK.test(inside[0])) return null;
  }
  if (top < 0) return null;

  const end = top - 1;
  let start = end;
  // Continuation rows are indented by the CLI. Stop at a spinner, tool output,
  // blank separation or other text; never search backwards through the transcript.
  while (start >= 0 && (MARK.test(lines[start]) || /^ {2}.*\S/u.test(lines[start]))) start--;
  const block = lines.slice(start + 1, end + 1);
  if (!block.some((line) => MARK.test(line))) {
    // A clipped standalone hint means a queue exists above the screen, but its
    // messages/count cannot be recovered. Do not turn it into a known empty queue.
    return HINT.test(lines[end] ?? "") ? null : { known: true, items: [], truncated: false };
  }
  if (!MARK.test(block[0]) || !HINT.test(block.at(-1))) return null;
  const items = [];
  for (const line of block) {
    if (MARK.test(line)) items.push(line.replace(MARK, ""));
    else if (items.length) items[items.length - 1] += "\n" + line.slice(2);
    else return null;
  }
  // The CLI's action hint is not part of the user's message. Keep every visible
  // ellipsis and line wrap; never claim to reconstruct omitted text.
  const previews = [...items];
  previews[previews.length - 1] = previews.at(-1).replace(HINT, "").trimEnd();
  if (previews.some((item) => !item.trim())) return null;
  // 1.5.10 shortens a long queued message to a single row ending in ASCII ... .
  // This flag warns about a possibly shortened preview, not a recovered count.
  return { known: true, items: previews, truncated: start < 0 || previews.some((item) => /(?:\.\.\.|…)$/u.test(item)) };
}
