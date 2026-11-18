// Expanded, read-only cost breakdown with one editable local conversion rate.
// No billing account or exchange-rate service is queried by this view.
import { div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import { shared } from "herdr";
import { KEY_CONFIG, loadConfig, setSetting } from "./config.js";
import { DEFAULT_COST_CONFIG, formatYen, PRICING_AS_OF } from "./cost.js";

const count = (value) => Number.isSafeInteger(value) && value >= 0
  ? String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",") : "未取得";
const usd = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
  ? (value > 0 && value < 0.0001 ? "<$0.0001" : `$${value.toFixed(4)}`) : "未取得";
const unitRate = (value) => typeof value === "number" && Number.isFinite(value)
  ? String(Number(value.toFixed(4))) : "未取得";
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const picks = (e) => e?.key === "enter" || e?.key === "space" || e?.key === " ";

// Do not let Number("") silently turn an empty field into zero. Only a plain
// positive decimal is accepted: no exponent, hex, Infinity or trailing text.
export function parseFxRate(value) {
  if (typeof value !== "string" || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return null;
  const rate = Number(value.trim());
  return Number.isFinite(rate) && rate > 0 && rate <= 10000 ? rate : null;
}

const smallButton = (id, text, t, act, enabled = true) => div().id(id).h(25).px(8).flex_none().flex().items_center()
  .rounded(5).border(1).border_color(t.border).bg(t.chrome).text_size(11.5).text_color(enabled ? t.foreground : t.dim)
  .tab_index(0).when(enabled, (el) => el.hover((s) => s.bg(t.hover)))
  .on_click((_e, cx) => { if (enabled) act(cx); })
  .on_key_down((e, cx) => { if (enabled && picks(e)) { cx.stop_propagation?.(); act(cx); } }).child(text);

// Eager native elements: no event handlers or retained input state in virtual rows.
// `estimate` is always the currently selected conversation's calculation, never
// retained by the editor, so changing agents cannot retain another agent's sum.
export function renderCostDetails(estimate, _snapshot, t, options = {}) {
  const calc = estimate ?? {}, models = Array.isArray(calc.models) ? calc.models : [];
  const tree = calc.scope === "conversation_tree";
  const line = (text, color = t.muted) => div().w_full().flex_none().whitespace_normal().text_size(11.5).text_color(color).child(text);
  const body = v_flex().id("cost-details-scroll").w_full().flex_1().min_h(0).overflow_y_scrollbar().gap(4)
    .child(line(`この会話のAPI換算: ${formatYen(calc.jpy, { partial: calc.partial })} (${usd(calc.usd)})`, t.foreground))
    .child(line("公開単価での参考額です。Antigravityの請求額・残高ではありません。"));
  if (tree) {
    const children = Number.isSafeInteger(calc.conversations) && calc.conversations >= 1 ? calc.conversations - 1 : null;
    body.child(line(`対象: 親会話＋紐づくサブエージェント ${count(children)}会話（計${count(calc.conversations)}会話）`, t.foreground))
      .child(line("In／Outは親会話の使用量、API換算は親＋子の合計"));
    if (Number.isSafeInteger(calc.missingConversations) && calc.missingConversations > 0) {
      body.child(div().id("cost-missing-children").w_full().flex_none().whitespace_normal().text_size(12).font_semibold().text_color(t.blocked)
        .child(`未計上: 紐づくサブエージェント ${count(calc.missingConversations)}会話の記録を取得できていません。`));
    }
  } else {
    body.child(line("対象: この親会話のみ。サブエージェントの使用量は含みません。", t.foreground));
  }
  if (calc.partial || calc.usd == null) {
    body.child(div().id("cost-unpriced-warning").w_full().flex_none().text_size(12).font_semibold().text_color(t.blocked)
      .child(`未計上: ${calc.unpricedRequests == null ? "件数未取得" : `${count(calc.unpricedRequests)}件`}（モデル不明・単価未登録・記録不足）`));
  }
  body.child(line(`換算済み ${count(calc.pricedRequests)} / ${count(calc.totalRequests)} リクエスト`));
  for (const [index, model] of models.entries()) {
    body.child(div().id(`cost-model-${index}`).pt(3).text_size(12).text_color(t.foreground)
      .child(`${model.model} · ${usd(model.usd)}`));
    for (const [title, tokenKey, rateKey] of [["入力（キャッシュ除外）", "input_tokens", "input"],
      ["キャッシュ読込", "input_cached_tokens", "cached"], ["出力（推論含む）", "output_tokens", "output"]]) {
      const tokens = model[tokenKey], rate = model[rateKey];
      const cost = typeof tokens === "number" && typeof rate === "number" ? tokens * rate / 1_000_000 : null;
      body.child(line(`${title}: ${count(tokens)} tokens × $${unitRate(rate)}/100万 = ${usd(cost)}`));
    }
  }
  body.child(line(`単価: ${calc.basis ?? "Global・Standard・割引前"}（${calc.pricingAsOf ?? PRICING_AS_OF}確認）`))
    .child(line("ツール料金・税金は含みません。"))
    .child(line("クレジット還元・契約割引・サブスクリプション枠は適用していません。"))
    .child(line(`為替: 1 USD = ${calc.fx ?? "未設定"}円 · ${options.manualFx || !calc.fxAsOf ? "手動設定" : `${calc.fxAsOf}時点`}`))
    .child(line("初期為替: 日銀 2026-11-17 17時の中値159.34円。自動更新なし。"));

  const panel = v_flex().id("chat-cost-details").w_full().max_w(800).h(220).max_h(220).flex_none()
    .p(8).gap(5).rounded(8).bg(t.chrome).border(1).border_color(t.border)
    .child(h_flex().w_full().h(23).flex_none().items_center().gap(8)
      .child(div().flex_1().text_size(12).font_semibold().text_color(t.foreground).child("トークン使用額の内訳"))
      .when(Boolean(options.close), (el) => el.child(smallButton("cost-close", "閉じる", t, options.close))))
    .child(body);
  if (options.input) {
    panel.child(h_flex().w_full().h(28).flex_none().items_center().gap(6)
      .child(div().text_size(11.5).text_color(t.muted).child("1 USD ="))
      .child(Input.new(options.input).w(94).h(27))
      .child(div().text_size(11.5).text_color(t.muted).child("円"))
      .child(smallButton("cost-fx-save", options.saving ? "保存中" : "保存", t, options.save, !options.saving))
      .child(div().flex_1().min_w(0).text_size(11).text_color(options.error ? t.blocked : t.muted)
        .child(options.message ?? "手動で更新できます")));
  }
  return panel;
}

export class CostDetails {
  constructor() {
    this.isOpen = false;
    this.input = null;
    this.saving = false;
    this.message = "";
    this.error = false;
  }

  open(cx, config = shared(KEY_CONFIG)?.file?.cost_reference) {
    // Only called by a live user event: InputState requires a host call.
    if (!this.input) {
      this.input = InputState.new({ placeholder: "159.34" });
      this.input.on("submit", (_e, cx) => this.save(cx));
      this.input.on("change", (_e, cx) => { this.message = ""; this.error = false; cx.notify(); });
    }
    const cfg = object(config);
    this.input.set_value(String(cfg.usdJpy ?? DEFAULT_COST_CONFIG.usdJpy));
    this.isOpen = true;
    this.message = "";
    this.error = false;
    cx.notify();
  }

  close(cx) { this.isOpen = false; cx?.notify?.(); }
  toggle(cx, config) { this.isOpen ? this.close(cx) : this.open(cx, config); }

  save(cx) {
    if (this.saving || !this.input) return;
    const rate = parseFxRate(this.input.value());
    if (rate === null) {
      this.error = true;
      this.message = "0より大きく10,000以下の数値を入力";
      cx.notify();
      return;
    }
    this.saving = true;
    this.error = false;
    this.message = "";
    cx.notify();
    cx.spawn(async (cx) => {
      let ok = false;
      try {
        const current = await loadConfig();
        if (!current.bad) ok = await setSetting("cost_reference", {
          ...object(current.file.cost_reference), usdJpy: rate, fxAsOf: null, fxSource: "manual",
        });
      } catch { /* Keep the field and let the user retry; no unrelated setting is changed. */ }
      this.saving = false;
      this.error = !ok;
      this.message = ok ? "手動レートを保存しました" : "保存できませんでした（設定ファイルを確認）";
      cx.notify();
    });
  }

  render(estimate, snapshot, t) {
    if (!this.isOpen) return null;
    return renderCostDetails(estimate, snapshot, t, { input: this.input, saving: this.saving,
      message: this.message || undefined, error: this.error,
      manualFx: shared(KEY_CONFIG)?.file?.cost_reference?.fxSource === "manual",
      close: (cx) => this.close(cx), save: (cx) => this.save(cx) });
  }
}
