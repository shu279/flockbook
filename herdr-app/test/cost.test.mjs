import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCost, modelRates, normalizeCostModel, formatYen, DEFAULT_COST_CONFIG } from "../mods/flockbook/cost.js";

const bucket = (model = "gemini-4-argon-high", extra = {}) => ({ model, requests: 1,
  input_tokens: 1_000_000, input_cached_tokens: 1_000_000, output_tokens: 1_000_000, ...extra });
const snapshot = (...buckets) => ({ usage_by_model: buckets, usage_scope: "conversation", usage_complete: true });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("gross Standard pricing counts uncached input, cache reads and reasoning-inclusive output once", () => {
  const result = estimateCost(snapshot(bucket()));
  near(result.usd, 24.2);
  near(result.jpy, 24.2 * 159.34);
  assert.equal(result.partial, false);
  assert.equal(result.unpricedRequests, 0);
  assert.equal(result.fxAsOf, "2026-11-17");
  assert.match(result.basis, /Global.*Standard.*割引前/);
  assert.equal(result.scope, "conversation");
  assert.deepEqual(result.coverage, { tokens: 1, requests: 1 });
  assert.equal(result.models[0].output_tokens, 1_000_000);
});

test("model changes use each historical model bucket, never the selected model or CLI/subagent cost", () => {
  const data = { ...snapshot(bucket("gemini-4-carbon-low"), bucket("gemini-4-argon-max", { requests: 2, input_tokens: 2_000_000 })),
    model: { name: "An unpriced current model" }, cost_usd: 99999, subagent_usd: 88888, thinking_tokens: 77777 };
  const before = JSON.stringify(data), result = estimateCost(data);
  near(result.usd, 52.4);
  assert.equal(result.totalRequests, 3);
  assert.equal(result.models.length, 2);
  assert.equal(JSON.stringify(data), before, "cost observations and source usage remain unchanged");
});

const treeUsage = (buckets, extra = {}) => ({ usage_scope: "conversation_tree", source: "transcript", usage_by_model: buckets,
  usage_complete: true, conversations: 2, missing_conversations: 0, ...extra });

test("a linked conversation-tree total replaces rather than adds the parent subtotal", () => {
  const parent = bucket("gemini-4-carbon-high"), child = bucket("gemini-4-argon-high");
  const data = { ...snapshot(parent), input: 1_000_000, output: 1_000_000, cached: 1_000_000,
    cost_usage: treeUsage([parent, child], { input_tokens: 2_000_000, output_tokens: 2_000_000, input_cached_tokens: 2_000_000 }),
    cost_usd: 99999, subagent_usd: 88888 };
  const before = JSON.stringify(data), result = estimateCost(data);
  near(result.usd, 48.4);
  assert.equal(result.scope, "conversation_tree");
  assert.equal(result.conversations, 2);
  assert.equal(result.missingConversations, 0);
  assert.equal(result.totalRequests, 2);
  assert.equal(result.partial, false);
  assert.equal(JSON.stringify(data), before);
});

test("missing child conversations preserve only a marked subtotal with unknown total coverage", () => {
  const data = { ...snapshot(bucket()), cost_usage: treeUsage([bucket()], {
    conversations: 1, missing_conversations: 2, usage_complete: false }) };
  const result = estimateCost(data);
  near(result.usd, 24.2);
  assert.equal(result.partial, true);
  assert.equal(result.scope, "conversation_tree");
  assert.equal(result.conversations, 1);
  assert.equal(result.missingConversations, 2);
  assert.equal(result.unpricedRequests, null, "missing logs can contain an unknown number of usage rows");
  assert.deepEqual(result.coverage, { tokens: null, requests: null });
  assert.match(formatYen(result.jpy, result), /＋$/);
  assert.equal(estimateCost({ ...data, cost_usage: { ...data.cost_usage, usage_complete: true } }).partial, true,
    "a contradictory completeness flag cannot hide known missing children");
  const unread = estimateCost({ ...snapshot(bucket()), cost_usage: treeUsage(null, {
    conversations: 0, missing_conversations: 1, usage_complete: false }) });
  assert.equal(unread.usd, null);
  assert.equal(unread.partial, true);
  assert.equal(unread.conversations, 0);
  assert.equal(unread.missingConversations, 1);
  const incomplete = estimateCost({ ...snapshot(bucket()), cost_usage: treeUsage([], {
    conversations: 1, missing_conversations: 0, usage_complete: false }) });
  assert.equal(incomplete.usd, null, "an incomplete log with no readable requests cannot claim zero spend");
  assert.equal(incomplete.partial, true);
});

test("tree scope preserves unknown-model pricing omissions and validates tree totals", () => {
  const result = estimateCost({ ...snapshot(bucket()), cost_usage: treeUsage([bucket(), bucket(null, { requests: 4 })]) });
  near(result.usd, 24.2);
  assert.equal(result.partial, true);
  assert.equal(result.unpricedRequests, 4);
  const mismatch = estimateCost({ ...snapshot(bucket()), cost_usage: treeUsage([], { input_tokens: 100 }) });
  assert.equal(mismatch.usd, null);
  assert.equal(mismatch.unavailable, "usage-mismatch");
});

test("only absent tree data falls back to a labelled parent-only estimate", () => {
  const fallback = estimateCost({ ...snapshot(bucket()), cost_usage: undefined });
  near(fallback.usd, 24.2);
  assert.equal(fallback.scope, "conversation");
  assert.equal(fallback.conversations, 1);
  for (const cost_usage of [null, {}, { ...treeUsage([bucket()]), usage_scope: "all-agents" },
    { ...treeUsage([bucket()]), scope: "conversation" },
    treeUsage([bucket()], { conversations: "2" }), treeUsage([bucket()], { missing_conversations: -1 }),
    treeUsage([], { conversations: 0 })]) {
    const invalid = estimateCost({ ...snapshot(bucket()), cost_usage });
    assert.equal(invalid.usd, null, JSON.stringify(cost_usage));
    assert.equal(invalid.scope, "conversation_tree");
  }
});

test("only exact known model IDs/display aliases are priced; High is not Priority", () => {
  for (const model of ["gemini-4-argon", "gemini-4-argon-high", "Gemini 4 Argon (High)", " Gemini 4 Carbon (XHigh) "]) {
    assert.ok(normalizeCostModel(model), model);
    assert.equal(modelRates(model).output, 20, model);
  }
  for (const model of [null, "gemini-4-argon-cyber-permissive", "gemini-4-argon-preview", "gemini-4-argon-high-extra",
    "Other Gemini 4 Argon (High)", "gemini-3.1-pro", "Gemini 4 Carbon (Ultra)", { id: "gemini-4-argon" }]) {
    assert.equal(normalizeCostModel(model), null, String(model));
    assert.equal(modelRates(model), null, String(model));
  }
});

test("unknown checkpoint models remain visibly unpriced, with known-usage coverage", () => {
  const known = bucket("gemini-4-carbon-high", { requests: 9 });
  const unknown = bucket(null, { requests: 4, input_tokens: 10, output_tokens: 20, input_cached_tokens: 30 });
  const result = estimateCost(snapshot(known, unknown));
  near(result.usd, 24.2);
  assert.equal(result.partial, true);
  assert.equal(result.unpricedRequests, 4);
  assert.equal(result.totalRequests, 13);
  near(result.coverage.requests, 9 / 13);
  near(result.coverage.tokens, 3_000_000 / 3_000_060);
  assert.deepEqual(result.unpricedModels, [null]);
  assert.match(formatYen(result.jpy, result), /＋$/);
  const allUnknown = estimateCost(snapshot(unknown));
  assert.equal(allUnknown.usd, null);
  assert.equal(allUnknown.jpy, null);
  assert.equal(formatYen(allUnknown.jpy, allUnknown), "N/A");
});

test("published non-global rates and a user-supplied dated FX reference remain explicit", () => {
  const result = estimateCost(snapshot(bucket()), { region: "non-global", usdJpy: 150, fxAsOf: "2026-11-18" });
  near(result.usd, 26.62);
  near(result.jpy, 3993);
  assert.equal(result.models[0].cached, 0.22);
  assert.match(result.basis, /Non-global/);
  assert.equal(result.fxAsOf, "2026-11-18");
  assert.equal(estimateCost(snapshot(bucket()), { usdJpy: 150 }).fxAsOf, null, "a custom rate gets no invented date");
  assert.equal(estimateCost(snapshot(bucket()), { region: "priority" }).usd, null);
});

test("invalid counters, incomplete source coverage and unsupported scope never become a full estimate", () => {
  for (const invalid of [null, undefined, -1, NaN, Infinity, "100", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const result = estimateCost(snapshot(bucket(), bucket("gemini-4-carbon", { input_tokens: invalid, requests: 2 })));
    assert.equal(result.partial, true);
    assert.equal(result.unpricedRequests, 2);
    assert.equal(result.totalTokens, null);
    near(result.usd, 24.2);
  }
  const noCount = estimateCost(snapshot(bucket(null, { requests: null })));
  assert.equal(noCount.unpricedRequests, null);
  assert.equal(noCount.totalRequests, null);
  const incomplete = estimateCost({ ...snapshot(bucket()), usage_complete: false });
  near(incomplete.usd, 24.2);
  assert.equal(incomplete.partial, true);
  assert.equal(incomplete.unpricedRequests, null);
  assert.equal(incomplete.coverage.tokens, null);
  for (const data of [null, {}, { model: "gemini-4-argon", input_tokens: 100, cost_usd: 4 },
    { ...snapshot(bucket()), usage_scope: "all-agents" }, { ...snapshot(), usage_by_model: null },
    { ...snapshot(), usage_by_model: Array(257).fill(bucket()) }]) assert.equal(estimateCost(data).usd, null);
});

test("bad FX never silently substitutes a new rate, while USD stays available", () => {
  for (const usdJpy of [null, "159.34", -1, 0, NaN, Infinity, 10001, 1e100]) {
    const result = estimateCost(snapshot(bucket()), { usdJpy });
    near(result.usd, 24.2);
    assert.equal(result.jpy, null);
    assert.equal(result.unavailable, "fx-invalid");
  }
  assert.equal(DEFAULT_COST_CONFIG.usdJpy, 159.34);
});

test("inconsistent buckets cannot turn a known nonzero total into zero or a smaller complete price", () => {
  for (const totals of [{ input_tokens: 100 }, { input: 100 }, { output: 100 }, { cached: 100 }]) {
    const result = estimateCost({ ...snapshot(), ...totals });
    assert.equal(result.usd, null);
    assert.equal(result.unavailable, "usage-mismatch");
  }
  const consistent = estimateCost({ ...snapshot(bucket()), input: 1_000_000, output: 1_000_000, cached: 1_000_000 });
  near(consistent.usd, 24.2);
  for (const totals of [{ input: 2_000_000 }, { output_tokens: 999_999 }, { input_cached_tokens: 0 }]) {
    const mismatch = estimateCost({ ...snapshot(bucket()), ...totals });
    assert.equal(mismatch.usd, null);
    assert.equal(mismatch.unavailable, "usage-mismatch");
  }
  const partial = estimateCost({ ...snapshot(bucket(), bucket(null, { input_tokens: null, requests: 2 })), input: null });
  near(partial.usd, 24.2);
  assert.equal(partial.partial, true);
});

test("zero, unknown and tiny nonzero yen values remain distinguishable", () => {
  const zero = estimateCost(snapshot());
  assert.equal(zero.usd, 0);
  assert.equal(zero.jpy, 0);
  assert.equal(zero.partial, false);
  assert.equal(formatYen(0), "¥0");
  assert.equal(formatYen(0.0001), "<¥1");
  assert.equal(formatYen(0.99, { partial: true }), "<¥1＋");
  assert.equal(formatYen(7527.25), "約¥7,527");
  for (const value of [null, undefined, NaN, Infinity, -1, "0", 1e100]) assert.equal(formatYen(value), "N/A");
  assert.equal(estimateCost({ ...snapshot(), usage_complete: false }).usd, null);
});
