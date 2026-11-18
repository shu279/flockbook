// The CLI's own pending queue, observed read-only through Herdr's existing connection.
// Keep it separate from the transcript: queued input is not yet an accepted conversation turn.
import { div } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";
import { hc, machines, terminals, checking } from "herdr";
import { machineOf } from "./state.js";
import { parseAntigravityQueue } from "./queueparse.js";

export const QUEUE_POLL_MS = 2000;
const MAX_SCREEN = 512 * 1024;
const pidOf = (terminal) => terminal?.foreground?.pid ?? terminal?.pid;
const terminalFor = (address) => terminals().find((terminal) => terminal.address === address);
const isAgy = (kind) => ["agy", "antigravity", "antigravity-cli"].includes(kind);

export function queueIdentity(agent, feed) {
  if (!agent || !feed || feed.address !== agent.address) return null;
  // A feed for an earlier, different program must not identify the new program's queue.
  if (agent.app && !isAgy(agent.app)) return null;
  if (feed.agent ? !isAgy(feed.agent) : !isAgy(agent.app)) return null;
  const terminal = terminalFor(agent.address), pid = pidOf(terminal);
  if (!terminal || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const path = feed.path ?? "";
  return { key: JSON.stringify([agent.address, pid, path]), address: agent.address, pid, path,
    machine: machineOf(agent.address) };
}

function connected(id, feed) {
  if (feed.error || terminalFor(id.address)?.state !== "live") return false;
  return !id.machine || machines().some((machine) => machine.name === id.machine && machine.layout === "ready");
}

export function queueSnapshot(result) {
  if (result?.code !== 0 || typeof result.stdout !== "string" || result.stdout.length > MAX_SCREEN) return null;
  let screen;
  try { screen = JSON.parse(result.stdout); } catch { return null; }
  if (screen?.complete !== true || screen.how !== "screen" || typeof screen.text !== "string") return null;
  return parseAntigravityQueue(screen.text);
}

// Treat a queued prompt literally. In particular HTML, Markdown links and code examples must not
// become active content while the user is inspecting what the CLI has waiting.
export function queueHtml(text) {
  const escaped = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\r\n|\r/g, "\n").replace(/\n/g, "<br>");
  return `<p>${escaped}</p>`;
}

export class ChatQueue {
  constructor(clock = () => Date.now()) {
    this.clock = clock;
    this.entries = new Map();
    this.shown = null;
    this.generation = 0;
  }

  entry(id) {
    if (!this.entries.has(id.key)) {
      if (this.entries.size >= 64) this.entries.delete(this.entries.keys().next().value);
      this.entries.set(id.key, { items: [], truncated: false, stale: false, lastPoll: -Infinity,
        request: 0, inFlight: false });
    }
    return this.entries.get(id.key);
  }

  select(agent, feed) {
    const id = queueIdentity(agent, feed), key = id?.key ?? null;
    if (key !== this.shown) {
      this.generation++;
      this.shown = key;
      const entry = key && this.entries.get(key);
      if (entry) { entry.stale = entry.items.length > 0; entry.lastPoll = -Infinity; }
    }
    if (!id) return { id: null, entry: null };
    const entry = this.entry(id), terminal = terminalFor(id.address);
    if (["idle", "done"].includes(agent.status) || terminal?.state === "finished" || feed.error?.code === "not-agent") {
      if (entry.items.length || entry.inFlight) entry.request++;
      entry.items = []; entry.truncated = false; entry.stale = false;
    } else if (!connected(id, feed) || agent.status !== "working") {
      entry.stale = entry.items.length > 0;
    }
    return { id, entry };
  }

  // Called immediately after a send as well as by the chat's existing tick. This does not send any
  // terminal input and does not create a second queue or retry a user's message.
  refresh(cx, agent, feed) {
    const { entry } = this.select(agent, feed);
    if (entry) entry.lastPoll = -Infinity;
    this.tick(cx, agent, feed);
  }

  tick(cx, agent, feed) {
    const { id, entry } = this.select(agent, feed);
    if (!id || checking() || !connected(id, feed) || agent.status !== "working" || entry.inFlight
      || this.clock() - entry.lastPoll < QUEUE_POLL_MS) return;
    const generation = this.generation, request = ++entry.request;
    entry.lastPoll = this.clock(); entry.inFlight = true;
    cx.spawn(async (cx) => {
      try {
        const result = await hc(["read", id.address, "--json"]);
        // A reply for a pane we left, a restarted process or an earlier conversation is never
        // applied, even if the user has already switched back to the same terminal address.
        if (this.shown !== id.key || this.generation !== generation || entry.request !== request
          || queueIdentity(agent, feed)?.key !== id.key) return;
        const report = terminalFor(id.address)?.report;
        if (["idle", "done"].includes(report?.state)) {
          entry.items = []; entry.truncated = false; entry.stale = false;
          return;
        }
        const snapshot = connected(id, feed) ? queueSnapshot(result) : null;
        if (!snapshot) { entry.stale = entry.items.length > 0; return; }
        entry.items = snapshot.items;
        entry.truncated = snapshot.truncated === true;
        entry.stale = false;
      } catch {
        if (this.shown === id.key && this.generation === generation && entry.request === request) entry.stale = entry.items.length > 0;
      } finally {
        entry.inFlight = false;
        if (this.shown === id.key && this.generation === generation) cx.notify();
      }
    });
  }

  render(agent, feed, t) {
    const { id, entry } = this.select(agent, feed);
    if (!entry?.items.length) return null;
    const count = entry.items.length;
    // A fixed, bounded viewport keeps a large queue from squeezing the composer off screen.
    // The text itself is never truncated here; longer messages and additional items scroll.
    const height = Math.min(100, entry.items.reduce((sum, item) => sum + 12 + 21 * Math.max(1,
      String(item ?? "").split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 75)), 0)), 0));
    return v_flex().id("chat-queue").w_full().flex_none().px(16).pt(6).items_center()
      .child(v_flex().w_full().max_w(800).flex_none().p(6).gap(4).rounded(10).bg(t.chrome).border(1).border_color(t.border)
        .child(h_flex().w_full().h(18).gap(8).items_center().text_size(11.5).text_color(t.muted)
          .child(div().child(`キュー待ち · 表示 ${count}件`))
          .when(entry.stale, (el) => el.child(div().text_color(t.blocked).child("更新待ち")))
          .when(entry.truncated, (el) => el.child(div().child("一部省略（CLIの表示）"))))
        .child(v_flex().id("chat-queue-items").w_full().h(height).min_h(0).overflow_y_scrollbar().gap(4)
          .children(entry.items.map((text, index) => h_flex().w_full().flex_none().py(4).px(6).gap(7).items_start().rounded(6).bg(t.raised)
            .child(div().flex_none().text_size(11).text_color(t.dim).child(String(index + 1)))
            .child(TextView.html(`queue-${id.key}-${index}`, queueHtml(text ?? "内容を取得できない待機メッセージ"))
              .selectable(true).text_size(13).text_color(t.foreground).flex_1().min_w(0))))));
  }
}
