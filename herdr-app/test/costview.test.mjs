import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, log, reset } from "./stub/herdr.mjs";
import { byId, textOf } from "./stub/ui.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { loadConfig, KEY_CONFIG } from "../mods/flockbook/config.js";
import { estimateCost } from "../mods/flockbook/cost.js";
import { CostDetails, parseFxRate, renderCostDetails } from "../mods/flockbook/costview.js";

const t = new Proxy({}, { get: (_t, key) => `#${key}` });
const path = "/home/test/.config/herdr-app/flockbook/config.json";
const usage = (model = "Gemini 4 Argon (High)") => ({ usage_scope: "conversation", usage_complete: true,
  usage_by_model: [{ model, input_tokens: 1000000, input_cached_tokens: 2000000, output_tokens: 100000, requests: 3 }] });
let file;
beforeEach(() => {
  reset(); file = null;
  fake.readText = (p) => p === path ? file : null;
  fake.writeText = (p, text, expected) => {
    assert.equal(p, path); assert.equal(expected, file); file = text;
  };
});

test("FX accepts finite positive decimal values only, including strict bounds", () => {
  for (const value of ["", " ", "0", "-2", "10000.01", "NaN", "Infinity", "1e2", "0x10", "159円", null]) {
    assert.equal(parseFxRate(value), null, String(value));
  }
  for (const [value, expected] of [["159.34", 159.34], [" 160 ", 160], ["10000", 10000], [".5", .5]]) {
    assert.equal(parseFxRate(value), expected);
  }
});

test("details separate cached input and reasoning-inclusive output, state reference basis and scope", () => {
  const panel = renderCostDetails(estimateCost(usage()), usage(), t);
  const text = textOf(panel);
  assert.match(text, /API換算: 約¥1,020 \(\$6\.4000\)/);
  assert.match(text, /入力（キャッシュ除外）: 1,000,000 tokens × \$4\/100万 = \$4\.0000/);
  assert.match(text, /キャッシュ読込: 2,000,000 tokens × \$0.2\/100万 = \$0\.4000/);
  assert.match(text, /出力（推論含む）: 100,000 tokens × \$20\/100万 = \$2\.0000/);
  assert.match(text, /Global・Standard・割引前/);
  assert.match(text, /2026-11-18確認/);
  assert.match(text, /請求額・残高ではありません/);
  assert.match(text, /この親会話のみ/);
  assert.match(text, /サブエージェントの使用量は含みません/);
  assert.match(text, /ツール料金・税金は含みません/);
  assert.match(text, /2026-11-17時点/);
  assert.equal(panel._a.h, 220);
  assert.equal(panel._a.max_h, 220);
  assert.ok(Object.hasOwn(byId(panel, "cost-details-scroll")._a, "overflow_y_scrollbar"));
  assert.equal(byId(panel, "cost-unpriced-warning"), null);
});

test("non-global unit prices hide floating point artifacts", () => {
  const text = textOf(renderCostDetails(estimateCost(usage(), { region: "non-global" }), usage(), t));
  assert.match(text, /\$0\.22\/100万/);
  assert.doesNotMatch(text, /0\.2200000/);
});

test("conversation-tree details explain linked children and parent-only In/Out counters", () => {
  const calc = { ...estimateCost(usage()), scope: "conversation_tree", conversations: 4, missingConversations: 0 };
  const panel = renderCostDetails(calc, usage(), t), text = textOf(panel);
  assert.match(text, /親会話＋紐づくサブエージェント 3会話（計4会話）/);
  assert.match(text, /In／Outは親会話の使用量、API換算は親＋子の合計/);
  assert.doesNotMatch(text, /サブエージェントの使用量は含みません/);
  assert.equal(byId(panel, "cost-missing-children"), null);
});

test("missing child records are prominent and live updates replace counts in the open panel", () => {
  const view = new CostDetails(); view.open(fakeCx());
  const calc = { ...estimateCost(usage()), scope: "conversation_tree", conversations: 2,
    missingConversations: 3, partial: true, unpricedRequests: null };
  let panel = view.render(calc, usage(), t);
  assert.match(textOf(byId(panel, "cost-missing-children")), /未計上: 紐づくサブエージェント 3会話/);
  assert.equal(byId(panel, "cost-missing-children")._a.text_color, "#blocked");
  assert.match(textOf(panel), /約¥1,020＋/);
  panel = view.render({ ...calc, conversations: 5, missingConversations: 0, partial: false, unpricedRequests: 0 }, usage(), t);
  assert.match(textOf(panel), /親会話＋紐づくサブエージェント 4会話（計5会話）/);
  assert.equal(byId(panel, "cost-missing-children"), null);
  assert.equal(byId(panel, "cost-unpriced-warning"), null);
  panel = view.render(estimateCost(usage()), usage(), t);
  assert.match(textOf(panel), /この親会話のみ/);
  assert.doesNotMatch(textOf(panel), /API換算は親＋子の合計/);
});

test("partial and missing usage display prominent unpriced counts rather than zero totals", () => {
  const data = usage();
  data.usage_by_model.push({ model: "future-model", input_tokens: 4, input_cached_tokens: 0, output_tokens: 7, requests: 2 });
  let panel = renderCostDetails(estimateCost(data), data, t);
  assert.match(textOf(byId(panel, "cost-unpriced-warning")), /未計上: 2件/);
  assert.equal(byId(panel, "cost-unpriced-warning")._a.text_color, "#blocked");
  assert.match(textOf(panel), /換算済み 3 \/ 5 リクエスト/);
  assert.match(textOf(panel), /約¥1,020＋/);
  panel = renderCostDetails(estimateCost(null), null, t);
  assert.match(textOf(panel), /API換算: N\/A/);
  assert.match(textOf(byId(panel, "cost-unpriced-warning")), /件数未取得/);
});

test("construction and rendering are inert until open; changing conversations replaces every sum", () => {
  const view = new CostDetails(), cx = fakeCx();
  assert.equal(view.input, null);
  view.close();
  assert.equal(view.input, null, "selection cleanup needs no native input or live context");
  assert.equal(view.render(estimateCost(usage()), usage(), t), null);
  view.open(cx);
  assert.equal(view.input.value(), "159.34");
  assert.match(textOf(view.render(estimateCost(usage()), usage(), t)), /gemini-4-argon/);
  const other = usage("Gemini 4 Carbon");
  const changed = textOf(view.render(estimateCost(other), other, t));
  assert.match(changed, /gemini-4-carbon/);
  assert.doesNotMatch(changed, /gemini-4-argon/);
  view.close(cx);
  assert.equal(view.render(estimateCost(other), other, t), null);
  assert.equal(log.writes.length, 0);
});

test("invalid FX never writes; saving preserves current settings and cost options with manual provenance", async () => {
  file = JSON.stringify({ text_size: "large", mine: 1, cost_reference: { region: "non-global", fxAsOf: "2026-11-17", custom: 7 } });
  await loadConfig();
  const view = new CostDetails(), cx = fakeCx();
  view.open(cx);
  view.input.set_value(""); view.save(cx); await cx.settle();
  assert.equal(log.writes.length, 0);
  assert.equal(view.error, true);
  // Changes made after opening the editor are preserved by loading at save time.
  file = JSON.stringify({ text_size: "small", mine: 2, cost_reference: { region: "non-global", custom: 9 } });
  view.input.set_value("150.25");
  const panel = view.render(estimateCost(usage()), usage(), t);
  byId(panel, "cost-fx-save")._h.on_click({}, cx); await cx.settle();
  assert.deepEqual(JSON.parse(file), { text_size: "small", mine: 2,
    cost_reference: { region: "non-global", custom: 9, usdJpy: 150.25, fxAsOf: null, fxSource: "manual" } });
  assert.equal(view.error, false);
  assert.match(textOf(view.render(estimateCost(usage(), fake.shared[KEY_CONFIG].file.cost_reference), usage(), t)), /手動設定/);
  assert.equal(log.exec.length, 0, "saving FX makes no external requests");
});

test("malformed configuration and write errors remain visible and preserve existing files", async () => {
  const view = new CostDetails(), cx = fakeCx();
  view.open(cx); view.input.set_value("160"); file = "broken json";
  view.save(cx); await cx.settle();
  assert.equal(file, "broken json"); assert.equal(log.writes.length, 0);
  assert.equal(view.error, true); assert.match(view.message, /保存できません/);
  file = JSON.stringify({ mine: true });
  fake.writeText = () => { throw new Error("read only"); };
  view.save(cx); await cx.settle();
  assert.equal(file, '{"mine":true}'); assert.equal(view.saving, false); assert.equal(view.error, true);
});

test("Enter saves a manual FX and closing / reopening reads the latest shared value", async () => {
  const view = new CostDetails(), cx = fakeCx();
  view.toggle(cx);
  view.input.set_value("161.5"); view.input._h.submit({}, cx); await cx.settle();
  byId(view.render(estimateCost(usage()), usage(), t), "cost-close")._h.on_click({}, cx);
  assert.equal(view.isOpen, false);
  view.toggle(cx);
  assert.equal(view.input.value(), "161.5");
});
