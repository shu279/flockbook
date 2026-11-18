import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAntigravityQueue } from "../mods/flockbook/queueparse.js";

const rule = "─".repeat(80);
const frame = (before, input = ">") => `${before}\n${rule}\n${input}\n${rule}\nModel: Example (High)\nTurn: 8s`;
const queued = (text) => `▸ ${text} (alt+m to send immediately)`;

test("reads an Antigravity queue beside the live composer, preserving CJK and order", () => {
  assert.deepEqual(parseAntigravityQueue(frame(`⣽ Working…\n${queued("次はテストを確認してください")}`)),
    { known: true, items: ["次はテストを確認してください"], truncated: false });
  assert.deepEqual(parseAntigravityQueue(frame(`⣽ Working…\n▸ First message\n${queued("Second message")}`)),
    { known: true, items: ["First message", "Second message"], truncated: false });
});

test("keeps visible wrapping and truncation instead of inventing original text", () => {
  assert.deepEqual(parseAntigravityQueue(frame("⣽ Working…\n▸ A longer preview that wraps\n  across terminal rows… (alt+m to send immediately)")),
    { known: true, items: ["A longer preview that wraps\nacross terminal rows…"], truncated: true });
  assert.deepEqual(parseAntigravityQueue(frame("⣽ Working…\n▸ First\n  ▸ part of the same preview\n  (alt+m to send immediately)")),
    { known: true, items: ["First\n▸ part of the same preview"], truncated: false });
});

test("does not confuse history, a draft or an assistant's examples with the current queue", () => {
  assert.deepEqual(parseAntigravityQueue(frame(`${queued("Old queue example")}\n\n⣽ Working…`, "> Current draft")),
    { known: true, items: [], truncated: false });
  assert.deepEqual(parseAntigravityQueue(frame("  Ordinary assistant paragraph")), { known: true, items: [], truncated: false });
  assert.deepEqual(parseAntigravityQueue(frame("⣽ Working…", `> ${queued("typed draft")}`)), { known: true, items: [], truncated: false });
});

test("unknown or clipped frames are not treated as confirmed empty", () => {
  for (const screen of [null, "", queued("No input frame"), frame(queued("Not the normal composer"), "Switch Model"),
    frame("▸ Queue without its end marker"), frame("  continuation (alt+m to send immediately)"),
    frame("▸ (alt+m to send immediately)"), frame("\x1b[31m▸ ANSI"), `${rule}\n>\ntruncated`]) {
    assert.equal(parseAntigravityQueue(screen), null, JSON.stringify(screen));
  }
});

test("screen padding is removed without consuming ordinary leading content", () => {
  assert.deepEqual(parseAntigravityQueue(frame("⣽ Working…\n▸ Keep **literal** markup (alt+m to send immediately)   \r")),
    { known: true, items: ["Keep **literal** markup"], truncated: false });
});

test("only the last item has a CLI hint; an earlier message can contain the same literal text", () => {
  assert.deepEqual(parseAntigravityQueue(frame(`⣽ Working…\n${queued("Explain this literal ending")}\n${queued("Then continue")}`)), {
    known: true, items: ["Explain this literal ending (alt+m to send immediately)", "Then continue"], truncated: false,
  });
});

test("a queue reaching the top of the screen is only a partial visible preview", () => {
  assert.deepEqual(parseAntigravityQueue(frame(queued("Only visible item"))), {
    known: true, items: ["Only visible item"], truncated: true,
  });
});

test("finds the input above running-task footer rules and keeps multiple shortened previews", () => {
  const screen = `⣾ Running command...\n▸ QUEUE-ONE: reply ONE only.\n${queued("QUEUE-TWO: 日本語の長い待機メッセージ...")}\n${rule}\n>\n${rule}\n  ● [03:16:43] sleep 45 running\n${rule}\nModel: Example`;
  assert.deepEqual(parseAntigravityQueue(screen), {
    known: true, items: ["QUEUE-ONE: reply ONE only.", "QUEUE-TWO: 日本語の長い待機メッセージ..."], truncated: true,
  });
  assert.equal(parseAntigravityQueue(`${frame(queued("Old queue"))}\n${rule}\nSwitch Model\n${rule}`), null,
    "a newer menu must not revive an old prompt's queue");
});
