// A reference value at published Standard list prices, not an invoice estimate.
// Exact Gemini 4 Carbon / Argon rates: https://cloud.google.com/model-garden/pricing
// Verified 2026-11-18. The displayed November promotion is 50% credits back;
// these gross rates intentionally exclude that credit, tax and contract discounts.
// High / Max are reasoning effort, not Priority service. Gemini 4's published
// Standard table has flat token rates (unlike the explicit Gemini 3 context tiers).
export const PRICING_AS_OF = "2026-11-18";
export const PRICE_SOURCE = "https://cloud.google.com/model-garden/pricing";
export const FX_SOURCE = "https://www.boj.or.jp/statistics/market/forex/fxdaily/fxlist/fx261117.pdf";
// BOJ 2026-11-17 17:00 JST USD/JPY 159.33–35, midpoint. A dated reference;
// Cloud's actual JPY billing uses a different, monthly conversion rate.
export const DEFAULT_COST_CONFIG = Object.freeze({ region: "global", usdJpy: 159.34, fxAsOf: "2026-11-17" });
const PER_MILLION = Object.freeze({ input: 4, cached: 0.20, output: 20 });
const NON_GLOBAL_PER_MILLION = Object.freeze({ input: 4.40, cached: 0.22, output: 22 });
const MAX_BUCKETS = 256;
const token = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const amount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const label = (value) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 160).trim() : null;

// Accept only the exact public models and known effort suffixes. A future model,
// preview revision or Cyber Permissive variant must not inherit another price.
export function normalizeCostModel(value) {
  if (typeof value !== "string" || value.length > 160) return null;
  const model = value.trim().toLowerCase();
  const match = /^gemini-4-(carbon|argon)(?:-(?:low|medium|high|xhigh|max))?$/.exec(model)
    ?? /^gemini 4 (carbon|argon)(?: \((?:low|medium|high|xhigh|max)\))?$/.exec(model);
  return match ? `gemini-4-${match[1]}` : null;
}

export function modelRates(model, region = "global") {
  const id = normalizeCostModel(model);
  if (!id || !["global", "non-global"].includes(region)) return null;
  return { model: id, ...(region === "non-global" ? NON_GLOBAL_PER_MILLION : PER_MILLION) };
}

function configuration(config) {
  const region = config.region === undefined ? DEFAULT_COST_CONFIG.region : config.region;
  const fx = config.usdJpy === undefined ? DEFAULT_COST_CONFIG.usdJpy : config.usdJpy;
  // A custom rate without an explicit date has no known observation date.
  const fxAsOf = config.fxAsOf ?? (config.usdJpy === undefined ? DEFAULT_COST_CONFIG.fxAsOf : null);
  return { region, fx: typeof fx === "number" && Number.isFinite(fx) && fx > 0 && fx <= 10000 ? fx : null,
    fxAsOf: typeof fxAsOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fxAsOf) ? fxAsOf : null };
}

/** Price model-attributed usage in the producer's linked conversation tree when
 * available, otherwise explicitly fall back to this conversation's own log.
 * input_tokens is uncached input; cached input is a separate billed category.
 * output_tokens already includes reasoning: never add a thinking counter again.
 * The official cost_usd may include subagents and remains a separate observation.
 * In particular, neither cost_usd nor the currently selected model is a fallback.
 */
export function estimateCost(snapshot, config = DEFAULT_COST_CONFIG) {
  const cfg = configuration(config ?? {});
  // The tree already includes the parent. Never add the parent's counters again.
  // A present-but-invalid tree must not silently turn into a smaller parent-only
  // total. Undefined is the compatibility path for older producers only.
  const tree = snapshot?.cost_usage !== undefined;
  const data = tree ? snapshot.cost_usage : snapshot;
  const result = { usd: null, jpy: null, partial: false, pricedRequests: 0, unpricedRequests: null,
    totalRequests: null, pricedTokens: 0, totalTokens: null, coverage: { tokens: null, requests: null },
    models: [], unpricedModels: [], region: cfg.region, fx: cfg.fx, fxAsOf: cfg.fxAsOf,
    pricingAsOf: PRICING_AS_OF, source: "transcript-list-price", scope: tree ? "conversation_tree" : "conversation",
    conversations: tree ? token(data?.conversations) : 1,
    missingConversations: tree ? token(data?.missing_conversations) : 0,
    basis: `${cfg.region === "global" ? "Global" : cfg.region === "non-global" ? "Non-global" : "未設定"}・Standard・割引前`,
    unavailable: null };
  if (data?.usage_complete === false || (tree && result.missingConversations > 0)) result.partial = true;
  const buckets = data?.usage_by_model;
  const treeScope = data?.usage_scope ?? data?.scope;
  if (!Array.isArray(buckets) || buckets.length > MAX_BUCKETS
    || (tree ? treeScope !== "conversation_tree" : data?.usage_scope !== "conversation")
    || (tree && data?.usage_scope !== undefined && data?.scope !== undefined && data.usage_scope !== data.scope)) {
    result.unavailable = "usage-unavailable";
    return result;
  }
  if (tree && (result.conversations === null || result.missingConversations === null)) {
    result.unavailable = "tree-coverage-invalid";
    return result;
  }
  const complete = data.usage_complete === true && result.missingConversations === 0;
  if (tree && result.conversations === 0 && (complete || buckets.length)) {
    result.unavailable = "tree-coverage-invalid";
    return result;
  }
  if (!["global", "non-global"].includes(cfg.region)) {
    result.unavailable = "pricing-region-invalid";
    return result;
  }
  // Reject a stale/inconsistent bucket list instead of turning missing usage into
  // ¥0. Raw bridge totals and ChatStatus's parsed aliases are both understood.
  // Null totals or an incomplete category cannot vouch for a sum; those remain
  // partial through the ordinary per-bucket checks below.
  for (const [field, alias] of [["input_tokens", "input"], ["output_tokens", "output"], ["input_cached_tokens", "cached"]]) {
    const reported = token(Object.prototype.hasOwnProperty.call(data, field) ? data[field] : data[alias]);
    if (reported === null) continue;
    const values = buckets.map((bucket) => token(bucket?.[field]));
    if (values.some((value) => value === null)) continue;
    const sum = values.reduce((total, value) => total + value, 0);
    if (!Number.isSafeInteger(sum) || sum !== reported) {
      result.unavailable = "usage-mismatch";
      return result;
    }
  }
  let usd = 0, priced = 0, requests = 0, tokens = 0, unknownRequests = 0;
  let requestCountKnown = true, tokenCountKnown = true;
  const models = new Map(), unknownModels = new Set();
  for (const bucket of buckets) {
    const input = token(bucket?.input_tokens), output = token(bucket?.output_tokens), cached = token(bucket?.input_cached_tokens);
    const n = token(bucket?.requests);
    const count = input !== null && output !== null && cached !== null ? token(input + output + cached) : null;
    const valid = n !== null && count !== null && (n > 0 || count === 0);
    const rates = modelRates(bucket?.model, cfg.region);
    if (n === null || (n === 0 && count > 0) || !Number.isSafeInteger(requests + n)) requestCountKnown = false;
    else requests += n;
    if (count === null || !Number.isSafeInteger(tokens + count)) tokenCountKnown = false;
    else tokens += count;
    if (!valid || !rates) {
      result.partial = true;
      if (n === null || (n === 0 && count > 0) || !Number.isSafeInteger(unknownRequests + n)) unknownRequests = null;
      else if (unknownRequests !== null) unknownRequests += n;
      unknownModels.add(label(bucket?.model));
      continue;
    }
    const value = (input * rates.input + cached * rates.cached + output * rates.output) / 1_000_000;
    if (amount(value) === null || amount(usd + value) === null
      || !Number.isSafeInteger(result.pricedRequests + n) || !Number.isSafeInteger(result.pricedTokens + count)) {
      result.unavailable = "usage-overflow";
      return result;
    }
    usd += value;
    priced++;
    result.pricedRequests += n;
    result.pricedTokens += count;
    const model = models.get(rates.model) ?? { ...rates, requests: 0, input_tokens: 0, input_cached_tokens: 0, output_tokens: 0, usd: 0 };
    model.requests += n; model.input_tokens += input; model.input_cached_tokens += cached; model.output_tokens += output; model.usd += value;
    models.set(rates.model, model);
  }
  if (!complete) {
    result.partial = true;
    // The producer may have missed records, so the number omitted is unknown even
    // if the buckets that survived happen to contain valid counters.
    unknownRequests = null;
  }
  result.totalRequests = requestCountKnown ? requests : null;
  result.totalTokens = tokenCountKnown ? tokens : null;
  result.unpricedRequests = unknownRequests;
  result.models = [...models.values()];
  result.unpricedModels = [...unknownModels];
  result.coverage = {
    requests: requestCountKnown && complete ? (requests ? result.pricedRequests / requests : 1) : null,
    tokens: tokenCountKnown && complete ? (tokens ? result.pricedTokens / tokens : 1) : null,
  };
  if (priced || (!buckets.length && complete)) {
    result.usd = usd;
    const yen = cfg.fx !== null ? amount(usd * cfg.fx) : null;
    result.jpy = yen !== null && Number.isSafeInteger(Math.round(yen)) ? yen : null;
    if (result.jpy === null) result.unavailable = "fx-invalid";
  } else result.unavailable = "models-unpriced";
  return result;
}

export function formatYen(value, { partial = false } = {}) {
  if (amount(value) === null || !Number.isSafeInteger(Math.round(value))) return "N/A";
  const plus = partial ? "＋" : "";
  if (value > 0 && value < 1) return `<¥1${plus}`;
  const rounded = Math.round(value);
  return `${value > 0 ? "約" : ""}¥${String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${plus}`;
}
