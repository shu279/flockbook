import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { log, reset } from "./stub/herdr.mjs";
import { byId, textOf } from "./stub/ui.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { parseSubagents, subagentState, subagentHtml, SubagentsView } from "../mods/flockbook/subagents.js";

const ROOT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000999";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = (n, state = "unknown") => ({ id: id(n), parent_id: ROOT, name: `Research ${n}`, state,
  state_current: false, summary: `Synthetic response ${n}`, updated_at: `2026-11-18T03:45:${String(n).padStart(2, "0")}Z` });
const raw = (items = [item(2)]) => ({ parent_id: ROOT, complete: true, missing: 0, items });
const report = (items) => parseSubagents(raw(items), ROOT);
const t = new Proxy({}, { get: (_o, key) => `#${key}` });
beforeEach(reset);

test("metadata is bound to the exact selected parent and malformed data stays unavailable", () => {
  for (const value of [null, [], {}, { ...raw(), items: null }, { ...raw(), missing: -1 }]) {
    assert.equal(parseSubagents(value, ROOT), null);
  }
  assert.equal(parseSubagents(raw(), OTHER), null);
  assert.equal(parseSubagents(raw(), null), null);
  assert.equal(parseSubagents(raw(), ROOT).items[0].id, id(2));
});

test("duplicate children are deduplicated and invalid entries are explicitly incomplete", () => {
  const got = parseSubagents(raw([item(2), item(2), { ...item(3), id: "../unrelated" },
    { ...item(4), id: ROOT }, { ...item(5), parent_id: "invalid" }]), ROOT);
  assert.equal(got.items.length, 1);
  assert.equal(got.complete, false);
  assert.equal(got.missing, 3);
});

test("only descendants reachable from this parent are accepted, including unordered nested children", () => {
  const got = report([{ ...item(3), parent_id: id(2) }, { ...item(4), parent_id: OTHER }, item(2),
    { ...item(5), parent_id: id(6) }, { ...item(6), parent_id: id(5) },
    { ...item(7), parent_id: id(7) }]);
  assert.deepEqual(got.items.map((child) => child.id), [id(3), id(2)]);
  assert.equal(got.complete, false);
  assert.equal(got.missing, 4, "unrelated parents, disconnected cycles and self-links remain unavailable");
  const valid = report([{ ...item(4), parent_id: id(3) }, { ...item(3), parent_id: id(2) }, item(2)]);
  assert.equal(valid.items.length, 3);
  assert.equal(valid.complete, true);
  assert.equal(valid.missing, 0);
});

test("bounded names, summaries, timestamps and states never imply live activity", () => {
  const got = report([{ ...item(2), name: " a\0\n" + "x".repeat(100), summary: "y".repeat(500),
    state: "surprising", state_current: true, updated_at: "yesterday" }]).items[0];
  assert.ok(got.name.length <= 80);
  assert.doesNotMatch(got.name, /[\x00\n]/);
  assert.equal(got.summary.length, 240);
  assert.equal(got.state, "unknown");
  assert.equal(got.state_current, false);
  assert.equal(got.updated_at, null);
  const many = report(Array.from({ length: 70 }, (_, i) => item(i + 2)));
  assert.equal(many.items.length, 64);
  assert.equal(many.missing, 6);
  assert.equal(many.complete, false);
});

test("ISO offset timestamps normalize before sorting and display uses the Mac timezone", () => {
  const data = report([{ ...item(2), updated_at: "2026-11-18T14:45:02+11:00" },
    { ...item(3), updated_at: "2026-11-18T04:00:00Z" }]);
  assert.equal(data.items[0].updated_at, "2026-11-18T03:45:02.000Z");
  const panel = new SubagentsView().render(data, t, { key: ROOT });
  assert.ok(textOf(panel).indexOf("Research 3") < textOf(panel).indexOf("Research 2"));
});

test("recent children are visible by default; all children have a bounded scroll view", () => {
  const view = new SubagentsView(), cx = fakeCx();
  const data = report([item(2), item(3), item(4), item(5)]);
  let panel = view.render(data, t, { key: ROOT });
  assert.match(textOf(panel), /サブエージェント · 4件/);
  assert.ok(byId(panel, `subagent-${id(5)}`));
  assert.equal(byId(panel, `subagent-${id(2)}`), null);
  byId(panel, "subagents-toggle")._h.on_click({}, cx);
  panel = view.render(data, t, { key: ROOT });
  assert.ok(byId(panel, `subagent-${id(2)}`));
  assert.ok(byId(panel, "subagents-items")._a.h <= 150);
  assert.ok(Object.hasOwn(byId(panel, "subagents-items")._a, "overflow_y_scrollbar"));
  assert.equal(log.exec.length, 0);
});

test("row details show identity, timestamp and escaped normal-response excerpt only", () => {
  const view = new SubagentsView(), cx = fakeCx();
  const data = report([{ ...item(2, "responded"), summary: '<script>x()</script>\n[link](https://example.invalid) & text' }]);
  let panel = view.render(data, t, { key: ROOT });
  assert.match(textOf(panel), /最終記録: 応答あり/);
  byId(panel, `subagent-${id(2)}`)._h.on_click({}, cx);
  panel = view.render(data, t, { key: ROOT });
  const details = byId(panel, `subagent-details-${id(2)}`);
  const date = new Date(data.items[0].updated_at), two = (n) => String(n).padStart(2, "0");
  const local = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} `
    + `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}（このMacの時刻）`;
  assert.ok(textOf(details).includes(`最新記録: ${local}`));
  assert.match(textOf(details), /直近の応答（抜粋）/);
  const summary = byId(panel, `subagent-summary-${id(2)}`);
  assert.equal(summary.tag, "html");
  assert.match(summary._a.text, /&lt;script&gt;x\(\)&lt;\/script&gt;<br>\[link\]/);
  assert.doesNotMatch(summary._a.text, /<script>|<a /);
  assert.equal(summary._a.selectable, true);
  assert.equal(log.exec.length, 0);
});

test("states are always identified as historical observations and have no spinner", () => {
  for (const [state, label] of [["working", "作業中"], ["waiting", "待機"], ["responded", "応答あり"],
    ["done", "完了"], ["error", "エラー"], ["unknown", "状態未取得"]]) {
    assert.equal(subagentState(item(2, state)), `最終記録: ${label}`);
  }
  const panel = new SubagentsView().render(report([item(2, "working")]), t, { key: ROOT });
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    assert.equal(node._a?.spin, undefined);
    for (const child of node.kids ?? []) walk(child);
  };
  walk(panel);
});

test("changing parent, missing report and refreshed children cannot retain another child's details", () => {
  const view = new SubagentsView(), cx = fakeCx();
  let panel = view.render(report([item(2)]), t, { key: ROOT });
  byId(panel, `subagent-${id(2)}`)._h.on_click({}, cx);
  assert.ok(byId(view.render(report([item(2)]), t, { key: ROOT }), `subagent-details-${id(2)}`));
  assert.equal(view.render(null, t, { key: OTHER }), null);
  assert.equal(view.open, null);
  panel = view.render(report([item(3)]), t, { key: ROOT });
  assert.equal(byId(panel, `subagent-${id(2)}`), null);
  assert.doesNotMatch(textOf(panel), /Synthetic response 2/);
});

test("missing or stale records are visible and fresh empty reports remove the panel", () => {
  const view = new SubagentsView();
  assert.equal(view.render(report([]), t, { key: ROOT }), null);
  const data = parseSubagents({ ...raw([]), complete: false, missing: 2 }, ROOT);
  assert.match(textOf(view.render(data, t, { key: ROOT, stale: true })), /更新待ち.*2件の情報を取得できていません/);
  const partial = parseSubagents({ ...raw([item(2)]), complete: false }, ROOT);
  assert.match(textOf(view.render(partial, t, { key: ROOT })), /一部の情報を取得できていません/);
});

test("keyboard controls expand rows and absent normal responses are explained", () => {
  const view = new SubagentsView(), cx = fakeCx(), data = report([{ ...item(2), summary: null }]);
  const panel = view.render(data, t, { key: ROOT });
  byId(panel, `subagent-${id(2)}`)._h.on_key_down({ key: "enter" }, cx);
  assert.match(textOf(view.render(data, t, { key: ROOT })), /表示できる応答はまだありません/);
  assert.equal(subagentHtml("<x> &\r\ny"), "<p>&lt;x&gt; &amp;<br>y</p>");
});
