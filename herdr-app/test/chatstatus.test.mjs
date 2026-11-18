import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ChatStatus, statusIdentity, parseStatus, formatTokens, formatCost } from "../mods/flockbook/chatstatus.js";
import { ChatView } from "../mods/flockbook/chat.js";
import { fake, reset, theme } from "./stub/herdr.mjs";
import { textOf, byId } from "./stub/ui.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { agent, space } from "./fixtures.mjs";

const path = "/home/user/.gemini/antigravity-cli/brain/session-a/.system_generated/logs/transcript_full.jsonl";
const a = (address = "cloud/t1", status = "working") => agent(address, status, { app: "antigravity" });
const feed = (address = "cloud/t1", p = path) => ({ address, path: p, agent: "agy", error: null });
const snapshot = (extra = {}) => JSON.stringify({ schema: 1, session_id: "session-a", transcript_path: path, terminal_id: "t1",
  model: { name: "Gemini 4 Carbon", effort: "high" }, input_tokens: 169032, output_tokens: 208355,
  cost_usd: null, subagent_usd: null, state: "working", observed_at_ms: 9000000, sampled_at_ms: 9000500, producer_id: "17:12345", producer_alive: true,
  turn: { id: "turn-1", elapsed_ms: 42000, running: true, complete: true }, ...extra });

const reply = (text) => ({ code: 0, stdout: text, stderr: "" });

beforeEach(() => { reset(); fake.machines = [{ name: "cloud", layout: "ready" }]; });

test("capture identity binds machine, terminal and exact conversation path", () => {
  const id = statusIdentity(a(), feed());
  assert.equal(id.machine, "cloud");
  assert.equal(id.file, `${path}.flockbook-status.t1.json`);
  assert.equal(parseStatus(snapshot(), id).input, 169032);
  for (const wrong of [{ session_id: "session-b" }, { transcript_path: path.replace("session-a", "session-b") },
    { terminal_id: "t2" }, { schema: 2 }, { observed_at_ms: "yesterday" }]) assert.equal(parseStatus(snapshot(wrong), id), null);
  assert.equal(statusIdentity(a("cloud/t2"), feed()), null);
  assert.equal(statusIdentity(a(), { ...feed(), agent: "claude" }), null);
  assert.equal(parseStatus("{broken", id), null);
  assert.equal(parseStatus(" ".repeat(32769), id), null);
});

test("status accepts model-rich snapshots through 256 KiB and rejects larger UTF-8 payloads", () => {
  const id = statusIdentity(a(), feed()), limit = 256 * 1024;
  const buckets = Array.from({ length: 256 }, (_, i) => ({ model: `unknown-${i}-${"x".repeat(140)}`,
    input_tokens: 1, output_tokens: 1, input_cached_tokens: 1, requests: 1 }));
  const large = snapshot({ usage_by_model: buckets, cost_usage: { usage_by_model: buckets } });
  assert.ok(Buffer.byteLength(large) > 32768);
  assert.equal(parseStatus(large, id).input, 169032, "cost breakdown size does not discard the rest of the status");
  const overhead = Buffer.byteLength(snapshot({ padding: "" }));
  const boundary = snapshot({ padding: "x".repeat(limit - overhead) });
  assert.equal(Buffer.byteLength(boundary), limit);
  assert.ok(parseStatus(boundary, id));
  assert.equal(parseStatus(boundary + " ", id), null);
  const unicode = snapshot({ padding: "界".repeat(Math.floor((limit - overhead) / 3) + 1) });
  assert.ok(unicode.length < limit);
  assert.ok(Buffer.byteLength(unicode) > limit);
  assert.equal(parseStatus(unicode, id), null, "the limit counts UTF-8 bytes, not just string characters");
});

test("an excessive model bucket count makes only cost unavailable", async () => {
  const buckets = Array.from({ length: 257 }, (_, i) => ({ model: `unknown-${i}-${"x".repeat(140)}`,
    input_tokens: 1, output_tokens: 1, input_cached_tokens: 1, requests: 1 }));
  fake.exec = () => reply(snapshot({ usage_by_model: buckets, usage_scope: "conversation", usage_complete: true }));
  const bar = new ChatStatus(() => 1000), cx = fakeCx();
  bar.tick(cx, a(), feed()); await cx.settle();
  assert.match(bar.text(a(), feed()), /Gemini 4 Carbon \(High\).*In: 169,032.*Out: 208,355.*API換算: N\/A.*Turn: 42s/);
  assert.doesNotMatch(bar.text(a(), feed()), /更新待ち/);
});

test("missing/invalid numbers are N/A; actual zero and small nonzero costs remain distinct", () => {
  for (const v of [null, undefined, NaN, -1, "0", Infinity]) {
    assert.equal(formatTokens(v), "N/A"); assert.equal(formatCost(v), "N/A");
  }
  assert.equal(formatTokens(169032), "169,032");
  assert.equal(formatTokens(0), "0");
  assert.equal(formatCost(0), "$0.00");
  assert.equal(formatCost(0.00001), "<$0.0001");
  assert.equal(formatCost(0.0012), "$0.0012");
  assert.equal(formatCost(12.34), "$12.34");
});

test("remote file reads use Herdr on, while elapsed interpolation uses the Mac receipt clock", async () => {
  let clock = 1000; const reads = [];
  fake.exec = (cmd, args, options) => { reads.push([cmd, args, options]); return reply(snapshot()); };
  const bar = new ChatStatus(() => clock), cx = fakeCx();
  bar.tick(cx, a(), feed()); await cx.settle();
  assert.deepEqual(reads[0], ["python3", ["/home/user/.gemini/antigravity-cli/statusline_bridge.py", "--read", `${path}.flockbook-status.t1.json`, "--terminal", "t1"], { on: "cloud", timeout: 3000 }]);
  assert.match(bar.text(a(), feed()), /Gemini 4 Carbon \(High\).*In: 169,032.*Out: 208,355.*API換算: N\/A.*Turn: 42s/);
  clock = 3000; bar.tick(cx, a(), feed()); await cx.settle();
  assert.match(bar.text(a(), feed()), /Turn: 44s/, "re-reading one unchanged snapshot does not restart its anchor");
  clock = 9000;
  assert.match(bar.text(a(), feed()), /Turn: 50s/);
});

test("opening a long-running turn uses remote projected time and accepts new samples of the same callback", async () => {
  let clock = 1000, elapsed = 742000, sampled = 9000500;
  fake.exec = () => reply(snapshot({ sampled_at_ms: sampled,
    turn: { id: "turn-1", elapsed_ms: elapsed, running: true, complete: true } }));
  const bar = new ChatStatus(() => clock), cx = fakeCx();
  bar.tick(cx, a(), feed()); await cx.settle();
  assert.match(bar.text(a(), feed()), /Turn: 742s$/);
  clock = 3000; elapsed = 744000; sampled += 2000;
  bar.tick(cx, a(), feed()); await cx.settle();
  assert.match(bar.text(a(), feed()), /Turn: 744s$/);
  clock = 4000;
  assert.match(bar.text(a(), feed()), /Turn: 745s$/);
});

test("a stopped or replaced producer cannot donate its cache to the same terminal and session", async () => {
  fake.terminals = [{ address: "cloud/t1", state: "live", foreground: { pid: 17 } }];
  const old = statusIdentity(a(), feed());
  assert.ok(parseStatus(snapshot(), old));
  assert.equal(parseStatus(snapshot({ producer_alive: false }), old), null);
  fake.exec = () => reply(snapshot());
  const bar = new ChatStatus(() => 1000), cx = fakeCx();
  bar.tick(cx, a(), feed()); await cx.settle();
  assert.match(bar.text(a(), feed()), /In: 169,032/);
  fake.terminals[0].foreground.pid = 18;
  const next = statusIdentity(a(), feed());
  assert.notEqual(old.key, next.key);
  assert.equal(parseStatus(snapshot(), next), null);
  assert.match(bar.text(a(), feed()), /In: N\/A/);
});

test("idle, approval and disconnection stop interpolation; resumed old snapshots stay frozen", async () => {
  let clock = 1000; fake.exec = () => reply(snapshot());
  const bar = new ChatStatus(() => clock), cx = fakeCx();
  bar.tick(cx, a(), feed()); await cx.settle();
  clock = 3000; bar.tick(cx, a("cloud/t1", "blocked"), feed()); await cx.settle();
  clock = 6000;
  assert.match(bar.text(a("cloud/t1", "idle"), feed()), /Turn: 44s/);
  bar.tick(cx, a(), feed()); await cx.settle();
  assert.match(bar.text(a(), feed()), /Turn: 44s/, "a second turn cannot resume the first turn's duration");
  fake.exec = () => reply(snapshot({ observed_at_ms: 9001000, turn: { id: "turn-2", elapsed_ms: 1000, running: true, complete: true } }));
  clock = 8000; bar.tick(cx, a(), feed()); await cx.settle();
  assert.match(bar.text(a(), feed()), /Turn: 1s/);
  clock = 10000; fake.machines = [{ name: "cloud", layout: "unavailable" }];
  bar.tick(cx, a(), feed());
  clock = 25000;
  assert.match(bar.text(a(), feed()), /Turn: 3s.*更新待ち/);
});

test("completion snapshot fixes the final duration and never includes later idle time", async () => {
  let clock = 0; fake.exec = () => reply(snapshot());
  const bar = new ChatStatus(() => clock), cx = fakeCx();
  bar.tick(cx, a(), feed()); await cx.settle();
  clock = 2000;
  fake.exec = () => reply(snapshot({ observed_at_ms: 9002000, state: "idle", turn: { id: "turn-1", elapsed_ms: 43321, running: false, complete: true } }));
  bar.tick(cx, a("cloud/t1", "idle"), feed()); await cx.settle();
  clock = 1000000;
  assert.match(bar.text(a("cloud/t1", "idle"), feed()), /Turn: 43s$/);
});

test("installing during a running turn does not fabricate its start time", async () => {
  fake.exec = () => reply(snapshot({ turn: { id: "turn-1", elapsed_ms: null, running: true, complete: false } }));
  const bar = new ChatStatus(() => 5000), cx = fakeCx();
  bar.tick(cx, a(), feed()); await cx.settle();
  assert.match(bar.text(a(), feed()), /Turn: N\/A$/);
});

test("failures preserve the last values as stale and freeze the clock", async () => {
  let clock = 0; fake.exec = () => reply(snapshot());
  const bar = new ChatStatus(() => clock), cx = fakeCx();
  bar.tick(cx, a(), feed()); await cx.settle();
  clock = 2000; fake.exec = () => { throw new Error("connection closed"); };
  bar.tick(cx, a(), feed()); await cx.settle();
  clock = 8000;
  assert.match(bar.text(a(), feed()), /In: 169,032.*Turn: 44s.*更新待ち/);
  fake.exec = () => reply("{malformed");
  bar.tick(cx, a(), feed()); await cx.settle();
  assert.match(bar.text(a(), feed()), /Turn: 44s.*更新待ち/);
});

test("late reads never leak across agents, machines or a new session; only one read runs", async () => {
  let finish; const reads = [];
  fake.exec = (cmd, args, opts) => { reads.push([cmd, args, opts]); return new Promise((r) => { finish = r; }); };
  const bar = new ChatStatus(() => 1000), cx = fakeCx();
  bar.tick(cx, a(), feed());
  const b = a("cloud/t2"), fb = feed(b.address);
  bar.tick(cx, b, fb);
  assert.equal(reads.length, 1);
  finish(reply(snapshot())); await cx.settle();
  assert.match(bar.text(b, fb), /In: N\/A.*Turn: N\/A/);
  assert.match(bar.text(a("other/t1"), feed("other/t1")), /In: N\/A/);
  assert.match(bar.text(a(), feed("cloud/t1", path.replace("session-a", "session-b"))), /In: N\/A/);
  fake.exec = () => reply(snapshot({ terminal_id: "t2", input_tokens: 8 }));
  bar.tick(cx, b, fb); await cx.settle();
  assert.match(bar.text(b, fb), /In: 8/);
  assert.match(bar.text(a(), feed()), /In: 169,032/);
});

test("status is fixed after the composer and remains when there is no agent or the helper fails", async () => {
  fake.spaces = [space()]; fake.agents = [a()];
  const cx = fakeCx(), chat = new ChatView(cx); await cx.settle();
  let rendered = chat.render(cx);
  const footer = byId(rendered, "chat-status");
  assert.ok(footer);
  assert.match(textOf(footer), /Model: N\/A.*In: N\/A.*Out: N\/A.*API換算: N\/A.*Turn: N\/A/);
  assert.equal(rendered.kids.at(-2), footer, "the footer is outside scrolling chat content, immediately before the absolute top bar");
  fake.agents = []; chat.switchTo(null); rendered = chat.render(cx);
  assert.ok(byId(rendered, "chat-status"));
  fake.checking = true;
  fake.exec = () => { throw new Error("must not read during herdr-app check"); };
  const bar = new ChatStatus(); bar.tick(cx, a(), feed()); await cx.settle();
  assert.match(textOf(bar.render(a(), feed(), theme())), /Turn: N\/A/);
});

test("the status bar prices historical models and cache in yen without using a different-scope CLI total", async () => {
  fake.exec = () => reply(snapshot({ input_tokens: 1000100, input_cached_tokens: 2000000, output_tokens: 100000,
    cost_usd: 999, usage_scope: "conversation", usage_complete: true, usage_by_model: [
      { model: "gemini-4-carbon-high", input_tokens: 1000000, input_cached_tokens: 2000000, output_tokens: 100000, requests: 2 },
      { model: null, input_tokens: 100, input_cached_tokens: 0, output_tokens: 0, requests: 1 },
    ] }));
  const bar = new ChatStatus(() => 1000), cx = fakeCx();
  bar.tick(cx, a(), feed()); await cx.settle();
  assert.match(bar.text(a(), feed()), /API換算: 約¥1,020＋（親のみ）（一部未計上）/);
  const id = statusIdentity(a(), feed());
  assert.equal(bar.entries.get(id.key).snapshot.cost, 999, "the CLI's separate estimate remains available");
  assert.ok(byId(bar.render(a(), feed(), theme()), "chat-cost"));
  bar.costDetails.open(cx, {});
  assert.match(textOf(bar.render(a(), feed(), theme())), /未計上/);
  bar.text(a("cloud/t2"), feed("cloud/t2"));
  assert.equal(bar.costDetails.isOpen, false, "another agent does not inherit an open detail panel");
});

test("tree cost keeps parent token counters and follows the selected session", async () => {
  const usage = { usage_scope: "conversation_tree", usage_complete: true, conversations: 3, missing_conversations: 0,
    input_tokens: 3000000, input_cached_tokens: 0, output_tokens: 0,
    usage_by_model: [{ model: "gemini-4-argon-high", input_tokens: 3000000, input_cached_tokens: 0, output_tokens: 0, requests: 3 }] };
  fake.exec = () => reply(snapshot({ input_tokens: 1000000, input_cached_tokens: 0, output_tokens: 0,
    cost_usage: usage, usage_scope: "conversation", usage_complete: true,
    usage_by_model: [{ model: "gemini-4-argon-high", input_tokens: 1000000, input_cached_tokens: 0, output_tokens: 0, requests: 1 }] }));
  const bar = new ChatStatus(() => 1000), cx = fakeCx();
  bar.tick(cx, a(), feed()); await cx.settle();
  assert.match(bar.text(a(), feed()), /In: 1,000,000.*API換算: 約¥1,912 │/);
  assert.equal(bar.entries.get(statusIdentity(a(), feed()).key).snapshot.cost_usage.conversations, 3);
  assert.match(bar.text(a("cloud/t2"), feed("cloud/t2")), /API換算: N\/A/);
});
