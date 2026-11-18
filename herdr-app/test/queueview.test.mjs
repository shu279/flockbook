import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, log, reset } from "./stub/herdr.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { agent } from "./fixtures.mjs";
import { textOf, byId } from "./stub/ui.mjs";
import { ChatQueue, QUEUE_POLL_MS, queueIdentity, queueSnapshot, queueHtml } from "../mods/flockbook/queueview.js";

const a = (address = "gce/t1", status = "working") => agent(address, status, { app: "antigravity" });
const feed = (address = "gce/t1", path = "/logs/one.jsonl") => ({ address, path, agent: "agy", error: null });
const term = (address = "gce/t1", pid = 10) => ({ address, state: "live", foreground: { pid }, report: { state: "working" } });
const rule = "─".repeat(40);
const screen = (items) => `⣽ Working…\n${items.map((s, i) => `▸ ${s}${i === items.length - 1 ? " (alt+m to send immediately)" : ""}\n`).join("")}${rule}\n>\n${rule}\nModel: Test`;
const result = (items) => ({ code: 0, stdout: JSON.stringify({ complete: true, how: "screen", text: screen(items) }) });
const t = new Proxy({}, { get: (_o, key) => `#${key}` });
beforeEach(() => { reset(); fake.terminals = [term()]; fake.machines = [{ name: "gce", layout: "ready" }]; });

test("the real CLI queue appears in order without becoming transcript rows or terminal input", async () => {
  fake.exec = async () => result(["First message", "次のメッセージ"]);
  const cx = fakeCx(), q = new ChatQueue(), f = feed();
  q.tick(cx, a(), f); await cx.settle();
  assert.deepEqual(log.exec[0].slice(0, 2), ["hc", ["read", "gce/t1", "--json"]]);
  const view = q.render(a(), f, t);
  assert.match(textOf(view), /キュー待ち · 表示 2件.*First message.*次のメッセージ/);
  assert.equal(log.exec.filter(([, args]) => args.includes("send")).length, 0);
  assert.equal(f.rows, undefined, "observing the queue never edits the transcript");
});

test("fresh empty queue removes the panel, and regular reads are throttled", async () => {
  let now = 100;
  const q = new ChatQueue(() => now), cx = fakeCx(), f = feed();
  fake.exec = async () => result(["Waiting"]);
  q.tick(cx, a(), f); await cx.settle();
  q.tick(cx, a(), f); await cx.settle();
  assert.equal(log.exec.length, 1);
  now += QUEUE_POLL_MS;
  fake.exec = async () => result([]);
  q.tick(cx, a(), f); await cx.settle();
  assert.equal(q.render(a(), f, t), null);
});

test("refresh after sending reads immediately without resending any message", async () => {
  const q = new ChatQueue(() => 1), cx = fakeCx(), f = feed();
  fake.exec = async () => result([]);
  q.tick(cx, a(), f); await cx.settle();
  fake.exec = async () => result(["New queued message"]);
  q.refresh(cx, a(), f); await cx.settle();
  assert.equal(log.exec.length, 2);
  assert.match(textOf(q.render(a(), f, t)), /New queued message/);
});

test("unknown, incomplete and failed reads retain a labelled stale snapshot", async () => {
  const q = new ChatQueue(), cx = fakeCx(), f = feed();
  fake.exec = async () => result(["Keep this preview"]);
  q.tick(cx, a(), f); await cx.settle();
  for (const answer of [
    { code: 0, stdout: JSON.stringify({ complete: false, how: "screen", text: screen([]) }) },
    { code: 0, stdout: JSON.stringify({ complete: true, how: "scrollback", text: screen([]) }) },
    { code: 0, stdout: JSON.stringify({ complete: true, how: "screen", text: "Switch Model" }) },
    { code: 1, stdout: "" }, { code: 0, stdout: "not json" },
  ]) {
    fake.exec = async () => answer;
    q.refresh(cx, a(), f); await cx.settle();
    assert.match(textOf(q.render(a(), f, t)), /更新待ち.*Keep this preview/);
  }
  fake.exec = async () => { throw new Error("offline"); };
  q.refresh(cx, a(), f); await cx.settle();
  assert.match(textOf(q.render(a(), f, t)), /更新待ち/);
});

test("disconnect and approval wait retain prior previews without polling; reconnect clears consumed items", async () => {
  const q = new ChatQueue(), cx = fakeCx(), f = feed();
  fake.exec = async () => result(["Queued"]);
  q.tick(cx, a(), f); await cx.settle();
  fake.machines[0].layout = "unavailable";
  q.refresh(cx, a(), f); await cx.settle();
  assert.equal(log.exec.length, 1);
  assert.match(textOf(q.render(a(), f, t)), /更新待ち.*Queued/);
  fake.machines[0].layout = "ready";
  q.refresh(cx, a("gce/t1", "blocked"), f); await cx.settle();
  assert.equal(log.exec.length, 1);
  assert.match(textOf(q.render(a("gce/t1", "blocked"), f, t)), /更新待ち/);
  fake.exec = async () => result([]);
  q.refresh(cx, a(), f); await cx.settle();
  assert.equal(q.render(a(), f, t), null);
});

test("a delayed result cannot cross agent switches, even when switching back before it answers", async () => {
  let resolve;
  fake.exec = () => new Promise((done) => { resolve = done; });
  fake.terminals.push(term("gce/t2", 20));
  const q = new ChatQueue(), cx = fakeCx(), f = feed();
  q.tick(cx, a(), f);
  assert.equal(q.render(a("gce/t2"), feed("gce/t2", "/logs/two"), t), null);
  assert.equal(q.render(a(), f, t), null);
  resolve(result(["Old delayed queue"])); await cx.settle();
  assert.equal(q.render(a(), f, t), null);
});

test("PID and conversation changes reject old results and keep snapshots separate", async () => {
  for (const change of [
    () => { fake.terminals[0].foreground.pid++; },
    (f) => { f.path = "/logs/new-session"; },
  ]) {
    let resolve;
    fake.exec = () => new Promise((done) => { resolve = done; });
    const q = new ChatQueue(), cx = fakeCx(), f = feed();
    q.tick(cx, a(), f);
    change(f);
    resolve(result(["Wrong session"])); await cx.settle();
    assert.equal(q.render(a(), f, t), null);
  }
});

test("idle and done clear queued previews and invalidate pending reads", async () => {
  const q = new ChatQueue(), cx = fakeCx(), f = feed();
  fake.exec = async () => result(["Waiting"]);
  q.tick(cx, a(), f); await cx.settle();
  assert.equal(q.render(a("gce/t1", "idle"), f, t), null);
  let resolve;
  fake.exec = () => new Promise((done) => { resolve = done; });
  q.refresh(cx, a(), f);
  assert.equal(q.render(a("gce/t1", "done"), f, t), null);
  resolve(result(["Already consumed"])); await cx.settle();
  assert.equal(q.render(a(), f, t), null);
});

test("live terminal completion also rejects a reply before the next chat tick", async () => {
  let resolve;
  fake.exec = () => new Promise((done) => { resolve = done; });
  const q = new ChatQueue(), cx = fakeCx(), f = feed();
  q.tick(cx, a(), f);
  fake.terminals[0].report.state = "idle";
  resolve(result(["Old queue"])); await cx.settle();
  assert.equal(q.render(a(), f, t), null);
});

test("non-Antigravity, mismatched feed, missing PID and check mode never read screens", async () => {
  const q = new ChatQueue(), cx = fakeCx(), f = feed();
  assert.equal(queueIdentity(agent("gce/t1", "working"), f), null);
  assert.equal(queueIdentity(a(), feed("gce/t2")), null);
  assert.equal(queueIdentity(a(), { ...f, agent: "claude" }), null);
  fake.terminals[0].foreground.pid = null;
  assert.equal(queueIdentity(a(), f), null);
  fake.terminals[0].foreground.pid = 10;
  fake.checking = true;
  q.tick(cx, a(), f); await cx.settle();
  assert.equal(log.exec.length, 0);
});

test("literal full previews are selectable in a bounded scroller and CLI truncation is disclosed", async () => {
  const literal = "<script>bad()</script> **not bold** [link](https://example.test)";
  assert.equal(queueHtml(literal + "\nnext"), "<p>&lt;script&gt;bad()&lt;/script&gt; **not bold** [link](https://example.test)<br>next</p>");
  const q = new ChatQueue(), cx = fakeCx(), f = feed();
  fake.exec = async () => result([literal, "長いテキスト".repeat(100) + "..."]);
  q.tick(cx, a(), f); await cx.settle();
  const view = q.render(a(), f, t);
  assert.match(textOf(view), /一部省略（CLIの表示）/);
  assert.ok(byId(view, "chat-queue-items")._a.h <= 100);
  const rows = byId(view, "chat-queue-items").kids;
  assert.equal(rows[0].kids[1].tag, "html");
  assert.equal(rows[0].kids[1]._a.selectable, true);
  assert.match(rows[1].kids[1]._a.text, new RegExp("長いテキスト".repeat(100)));
});

test("queue snapshots require an exact current screen rather than arbitrary text", () => {
  assert.equal(queueSnapshot({ code: 0, stdout: JSON.stringify({ text: screen(["x"]) }) }), null);
  assert.equal(queueSnapshot({ code: 0, stdout: "x".repeat(600000) }), null);
  assert.deepEqual(queueSnapshot(result(["x"])), { known: true, items: ["x"], truncated: false });
});
