// Antigravity's internal child conversations have no independent Herdr terminal.
// Show only the selected parent's explicitly linked children, using the status
// reader's bounded metadata. This view never sends input or starts an agent.
import { div } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const STATES = new Set(["working", "waiting", "responded", "done", "error", "unknown"]);
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const clean = (value, max) => typeof value === "string"
  ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").slice(0, max).trim() : "";
const timestamp = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const picks = (e) => ["enter", "space", " "].includes(e?.key);

export function parseSubagents(value, parentId) {
  if (!object(value) || !UUID.test(parentId ?? "") || value.parent_id !== parentId
      || !Array.isArray(value.items) || count(value.missing) === null) return null;
  const items = [], seen = new Set();
  let missing = value.missing, complete = value.complete === true;
  if (value.items.length > 64) { missing += value.items.length - 64; complete = false; }
  for (const item of value.items.slice(0, 64)) {
    if (!object(item) || !UUID.test(item.id ?? "") || !UUID.test(item.parent_id ?? "") || item.id === parentId) {
      missing++; complete = false; continue;
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push({ id: item.id, parent_id: item.parent_id,
      name: clean(item.name, 80).replace(/\s+/g, " ") || `Agent ${item.id.slice(0, 8)}`,
      state: STATES.has(item.state) ? item.state : "unknown",
      // A log snapshot is evidence of a past state, not a live process probe.
      state_current: false,
      summary: clean(item.summary, 240) || null, updated_at: timestamp(item.updated_at) });
  }
  // Nested children may arrive before their parent. Accept only the connected
  // tree rooted at this conversation; valid UUIDs alone do not prove linkage.
  const reachable = new Set([parentId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (!reachable.has(item.id) && reachable.has(item.parent_id)) {
        reachable.add(item.id); changed = true;
      }
    }
  }
  const linked = items.filter((item) => reachable.has(item.id));
  missing += items.length - linked.length;
  return { parent_id: parentId, items: linked, missing, complete: complete && missing === 0 };
}

export function subagentState(item) {
  return `最終記録: ${{ working: "作業中", waiting: "待機", responded: "応答あり",
    done: "完了", error: "エラー", unknown: "状態未取得" }[item?.state] ?? "状態未取得"}`;
}

export function subagentHtml(value) {
  return `<p>${String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\r\n|\r/g, "\n").replace(/\n/g, "<br>")}</p>`;
}

const stampText = (value) => {
  if (!value) return "未取得";
  const date = new Date(value), two = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} `
    + `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}（このMacの時刻）`;
};
const button = (id, title, t, act) => div().id(id).h(22).px(6).flex_none().flex().items_center()
  .rounded(5).text_size(11).text_color(t.muted).tab_index(0).hover((s) => s.bg(t.hover))
  .on_click((_e, cx) => act(cx))
  .on_key_down((e, cx) => { if (picks(e)) { cx.stop_propagation?.(); act(cx); } }).child(title);

export class SubagentsView {
  constructor() { this.key = null; this.all = false; this.open = null; }

  select(key) {
    if (key !== this.key) { this.key = key; this.all = false; this.open = null; }
  }

  render(report, t, { key = null, stale = false } = {}) {
    this.select(key);
    if (!report || (!report.items.length && report.complete && !report.missing)) return null;
    const sorted = [...report.items].sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "") || a.id.localeCompare(b.id));
    const shown = this.all ? sorted : sorted.slice(0, 3);
    if (this.open && !shown.some((item) => item.id === this.open)) this.open = null;
    const list = v_flex().id("subagents-items").w_full().min_h(0).h(Math.min(150,
      Math.max(26, shown.length * 28 + (this.open ? 100 : 0)))).overflow_y_scrollbar().gap(2);
    for (const item of shown) {
      const expanded = this.open === item.id;
      const toggle = (cx) => { this.open = expanded ? null : item.id; cx.notify(); };
      const color = item.state === "error" ? t.blocked : item.state === "working" ? t.working : t.muted;
      const row = v_flex().w_full().flex_none().rounded(6).bg(t.raised)
        .child(h_flex().id(`subagent-${item.id}`).w_full().h(26).px(6).gap(7).items_center()
          .tab_index(0).hover((s) => s.bg(t.hover)).on_click((_e, cx) => toggle(cx))
          .on_key_down((e, cx) => { if (picks(e)) { cx.stop_propagation?.(); toggle(cx); } })
          .child(div().flex_none().text_size(11).text_color(t.dim).child(expanded ? "▾" : "▸"))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(item.name))
          .child(div().flex_none().text_size(11).text_color(color).child(subagentState(item))));
      if (expanded) {
        row.child(v_flex().id(`subagent-details-${item.id}`).w_full().px(8).pb(7).gap(3)
          .child(div().text_size(10.5).text_color(t.dim).child(`ID: ${item.id}`))
          .child(div().text_size(10.5).text_color(t.dim).child(`最新記録: ${stampText(item.updated_at)}`))
          .child(div().text_size(11).text_color(t.muted).child(item.summary ? "直近の応答（抜粋）" : "表示できる応答はまだありません"))
          .when(Boolean(item.summary), (el) => el.child(TextView.html(`subagent-summary-${item.id}`, subagentHtml(item.summary))
            .selectable(true).w_full().text_size(12).text_color(t.foreground))));
      }
      list.child(row);
    }
    const panel = v_flex().id("chat-subagents").w_full().flex_none().px(16).pt(6).items_center()
      .child(v_flex().w_full().max_w(800).flex_none().p(6).gap(4).rounded(10).bg(t.chrome).border(1).border_color(t.border)
        .child(h_flex().w_full().h(22).gap(6).items_center().text_size(11.5).text_color(t.muted)
          .child(div().flex_1().child(`サブエージェント · ${report.items.length}件`))
          .when(stale, (el) => el.child(div().text_color(t.blocked).child("更新待ち")))
          .when(report.items.length > 3, (el) => el.child(button("subagents-toggle", this.all ? "直近3件" : "すべて表示", t,
            (cx) => { this.all = !this.all; cx.notify(); }))))
        .when(!report.complete || report.missing > 0, (el) => el.child(div().text_size(11).text_color(t.blocked)
          .child(report.missing > 0 ? `${report.missing}件の情報を取得できていません` : "一部の情報を取得できていません")))
        .child(list));
    return panel;
  }
}
