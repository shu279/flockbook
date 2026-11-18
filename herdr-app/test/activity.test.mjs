import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, reset } from "./stub/herdr.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { agent } from "./fixtures.mjs";
import { textOf, byId } from "./stub/ui.mjs";
import { ChatActivity, activityView, ACK_WAIT_MS } from "../mods/flockbook/activity.js";
import { Composer } from "../mods/flockbook/composer.js";

const terminal = (address = "t1", extra = {}) => ({ address, state: "live", turn: 2, status_ms: 100,
  foreground: { pid: 10 }, report: {}, ...extra });
const t = new Proxy({}, { get: (_t, k) => `#${k}` });
beforeEach(() => { reset(); fake.terminals = [terminal()]; });

test("working is visible beside the composer; done text never becomes fabricated live progress", () => {
  const activity = new ChatActivity(), a = agent("t1", "working");
  fake.terminals[0].report = { state: "idle", msg: "An old completed answer" };
  const working = activity.describe(a);
  assert.equal(working.text, "処理しています…");
  assert.equal(byId(activityView(working, t), "chat-activity-spinner")._a.spin, 900);
  fake.terminals[0].report = { state: "working", msg: "Checking\nfiles\u001b" };
  assert.equal(activity.describe(a).text, "Checking files");
  assert.equal(activity.describe(agent("t1", "idle")), null);
  assert.equal(activity.describe(agent("t1", "done")), null);
});

test("approval waits have readable text without claiming ongoing work", () => {
  const activity = new ChatActivity(), a = agent("t1", "blocked");
  const status = activity.describe(a);
  assert.equal(status.spinning, false);
  assert.match(textOf(activityView(status, t)), /確認・承認を待っています/);
  assert.equal(byId(activityView(status, t), "chat-activity-spinner"), null);
});

test("send acknowledgement starts immediately, bridges status lag, and ends with the actual turn", () => {
  const cx = fakeCx(), activity = new ChatActivity(), a = agent("t1", "idle");
  const send = activity.begin(a, { path: "/one" });
  assert.equal(activity.describe(a, { path: "/one" }).text, "送信しています…");
  activity.finish(send, true, cx);
  assert.equal(activity.describe(a, { path: "/one" }).text, "応答を待っています…");
  assert.equal(activity.describe({ ...a, status: "working" }, { path: "/one" }).text, "処理しています…");
  assert.equal(activity.describe(a, { path: "/one" }), null);
  assert.equal(cx.timers.filter((x) => x.once).length, 1);
});

test("a very fast completed turn clears pending acknowledgement without observing working", () => {
  const activity = new ChatActivity(), a = agent("t1", "idle");
  const send = activity.begin(a, { path: "/one" });
  activity.finish(send, true, fakeCx());
  fake.terminals[0].turn++;
  fake.terminals[0].status_ms = 105;
  assert.equal(activity.describe(a, { path: "/one" }), null);
});

test("sending and delayed completion stay with their own agent, session and process", () => {
  const activity = new ChatActivity(), a = agent("t1", "idle"), b = agent("t2", "idle");
  fake.terminals.push(terminal("t2", { foreground: { pid: 20 } }));
  const old = activity.begin(a, { path: "/one" });
  assert.equal(activity.describe(b, { path: "/two" }), null);
  assert.equal(activity.describe(a, { path: "/new-session" }), null);
  activity.finish(old, true, fakeCx());
  assert.equal(activity.describe(a, { path: "/new-session" }), null);
  activity.begin(a, { path: "/new-session" });
  fake.terminals[0].foreground.pid = 99;
  assert.equal(activity.describe(a, { path: "/new-session" }), null);
});

test("failed sends, ended processes and disconnections stop the activity spinner", () => {
  const activity = new ChatActivity(), a = agent("t1", "idle"), cx = fakeCx();
  const send = activity.begin(a);
  activity.finish(send, false, cx);
  assert.equal(activity.describe(a), null);
  activity.begin(a);
  fake.terminals[0].state = "finished";
  assert.equal(activity.describe(a), null);
  fake.machines = [{ name: "gce", layout: "unavailable" }];
  const remote = activity.describe(agent("gce/t1", "working"));
  assert.equal(remote.spinning, false);
  assert.equal(remote.text, "接続を待っています");
});

test("an unconfirmed send cannot spin forever while the agent remains idle", () => {
  let now = 0;
  const activity = new ChatActivity(() => now), a = agent("t1", "idle"), cx = fakeCx();
  activity.finish(activity.begin(a), true, cx);
  now = ACK_WAIT_MS;
  const timerCx = fakeCx();
  cx.timers[0].f(timerCx);
  assert.equal(activity.describe(a).spinning, false);
  assert.equal(activity.describe(a).text, "応答の開始をまだ確認できません");
  assert.equal(cx.notified, 0, "the scheduling context is never retained for later use");
  assert.equal(timerCx.notified, 1);
});

const answer = (result) => ({ code: 0, stderr: "", stdout: [
  { type: "header", protocol: 1 }, { type: "done", result }, { type: "end", ok: true },
].map((row) => JSON.stringify(row)).join("\n") });

test("the real composer shows sending before the sidecar answers and keeps other agents clear", async () => {
  let resolve;
  fake.exec = () => new Promise((r) => { resolve = r; });
  const cx = fakeCx(), c = new Composer(cx), a = agent("t1", "idle"), b = agent("t2", "idle");
  c.box(a); c.setText("Hello");
  const pending = c.submit(cx);
  assert.match(textOf(byId(c.render(a, t), "chat-activity")), /送信しています/);
  const other = c.render(b, t);
  assert.equal(byId(other, "chat-activity"), null);
  assert.match(byId(other, "send").kids[0]._a.path, /send\.svg$/, "another agent's button does not spin for this send");
  resolve(answer("sent")); await pending;
  assert.equal(byId(c.render(b, t), "chat-activity"), null);
  assert.match(textOf(byId(c.render(a, t), "chat-activity")), /応答を待っています/);
  fake.terminals[0].turn++;
  assert.equal(byId(c.render(a, t), "chat-activity"), null);
});

test("a rejected composer send clears acknowledgement and restores the draft", async () => {
  fake.exec = async () => answer("changed");
  const c = new Composer(fakeCx()), a = agent("t1", "idle");
  c.box(a); c.setText("Keep this draft");
  await c.submit(fakeCx());
  assert.equal(c.input.value(), "Keep this draft");
  assert.equal(byId(c.render(a, t), "chat-activity"), null);
});
