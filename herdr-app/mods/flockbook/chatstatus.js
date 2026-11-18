// Antigravity's official statusLine data, captured beside its transcript on the agent's machine.
// The existing Herdr connection reads a terminal-specific file; no terminal scraping or new connection.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, machines, terminals, checking } from "herdr";
import { machineOf } from "./state.js";

export const ACTIVE_POLL_MS = 1000, IDLE_POLL_MS = 2000;
const number = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const count = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
const label = (v) => typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 160).trim() : "";
const bare = (address) => String(address ?? "").replace(/^hc:/, "").split("/").pop();

export function statusIdentity(agent, feed) {
  if (!agent || agent.address !== feed?.address || !feed?.path || !["agy", "antigravity"].includes(feed.agent)) return null;
  const terminal = bare(agent.address);
  // The producer uses HC_TERMINAL_ID and accepts this same conservative alphabet.
  if (!/^[A-Za-z0-9_-]+$/.test(terminal)) return null;
  const session = /\/brain\/([^/]+)\/.+\/transcript_full\.jsonl$/.exec(feed.path)?.[1]
    ?? /\/brain\/([^/]+)\/transcript(?:_full)?\.jsonl$/.exec(feed.path)?.[1];
  if (!session) return null;
  const pid = count(terminals().find((t) => t.address === agent.address)?.foreground?.pid);
  return { key: `${agent.address}\n${feed.path}\n${pid ?? ""}`, address: agent.address, path: feed.path,
    session, terminal, pid, machine: machineOf(agent.address), file: `${feed.path}.flockbook-status.${terminal}.json`,
    reader: `${feed.path.split("/brain/")[0]}/statusline_bridge.py` };
}

// Reject a different session or terminal, even when a stale request finishes after navigation.
export function parseStatus(text, id) {
  if (typeof text !== "string" || text.length > 32768 || !id) return null;
  let v; try { v = JSON.parse(text); } catch { return null; }
  if (!v || v.schema !== 1 || v.session_id !== id.session || v.transcript_path !== id.path || v.terminal_id !== id.terminal
    || count(v.observed_at_ms) === null || count(v.sampled_at_ms) === null || v.producer_alive !== true
    || typeof v.producer_id !== "string" || !/^[1-9][0-9]*:/.test(v.producer_id)
    || (id.pid !== null && !v.producer_id.startsWith(`${id.pid}:`))) return null;
  const turn = v.turn && typeof v.turn === "object" ? v.turn : {};
  return { observed: v.observed_at_ms, sampled: v.sampled_at_ms, producer: v.producer_id, name: label(v.model?.name), effort: label(v.model?.effort),
    input: count(v.input_tokens), output: count(v.output_tokens), cost: number(v.cost_usd), subcost: number(v.subagent_usd),
    state: label(v.state), turn: { id: label(turn.id), elapsed: turn.complete === true ? number(turn.elapsed_ms) : null,
      running: turn.running === true && turn.complete === true, complete: turn.complete === true } };
}

export const formatTokens = (n) => count(n) === null ? "N/A" : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export function formatCost(n) {
  if (number(n) === null) return "N/A";
  if (n > 0 && n < 0.0001) return "<$0.0001";
  return `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;
}
export function modelText(snapshot) {
  if (!snapshot?.name) return "N/A";
  const e = snapshot.effort;
  return e && !snapshot.name.toLowerCase().includes(`(${e.toLowerCase()})`) ? `${snapshot.name} (${e[0].toUpperCase()}${e.slice(1)})` : snapshot.name;
}

function online(id, feed) {
  if (feed?.error) return false;
  if (id.machine && !machines().some((m) => m.name === id.machine && m.layout === "ready")) return false;
  const terminal = terminals().find((t) => t.address === id.address);
  return !terminal || terminal.state === "live";
}

export class ChatStatus {
  constructor(clock = () => Date.now()) {
    this.clock = clock;
    this.entries = new Map();
    this.inFlight = false;
    this.shown = null;
    this.lastText = "";
  }

  elapsed(entry, at = this.clock()) {
    if (!entry || entry.elapsed === null) return null;
    return entry.elapsed + (entry.advancing ? Math.max(0, at - entry.anchor) : 0);
  }

  freeze(entry, stale = false) {
    if (!entry) return;
    if (entry.advancing) { entry.elapsed = this.elapsed(entry); entry.advancing = false; }
    // A later working state must not restart the old turn while its next snapshot is in flight.
    if (entry.held !== "state") entry.held = stale ? "stale" : "state";
    if (stale) entry.stale = true;
  }

  entry(id) {
    if (!this.entries.has(id.key)) {
      // Bound memory for long-running windows that visit many sessions.
      if (this.entries.size >= 64) this.entries.delete(this.entries.keys().next().value);
      this.entries.set(id.key, { snapshot: null, elapsed: null, anchor: 0, advancing: false, held: false,
        stale: false, lastPoll: -Infinity });
    }
    return this.entries.get(id.key);
  }

  select(id) {
    const key = id?.key ?? null;
    if (key !== this.shown) {
      const previous = this.entries.get(this.shown);
      // While another chat is shown we cannot observe every state transition here.
      // Reopening it gets authoritative elapsed time from the remote reader first.
      if (previous?.advancing) this.freeze(previous, true);
      this.shown = key;
    }
  }

  tick(cx, agent, feed) {
    const id = statusIdentity(agent, feed);
    this.select(id);
    if (!id || checking()) return;
    const entry = this.entry(id), at = this.clock();
    const connected = online(id, feed);
    if (!connected || agent.status !== "working") this.freeze(entry, !connected);
    const text = this.text(agent, feed);
    if (text !== this.lastText) { this.lastText = text; cx.notify(); }
    if (!connected || this.inFlight || at - entry.lastPoll < (agent.status === "working" ? ACTIVE_POLL_MS : IDLE_POLL_MS)) return;
    entry.lastPoll = at;
    this.inFlight = true;
    cx.spawn(async (cx) => {
      try {
        const result = await exec("python3", [id.reader, "--read", id.file, "--terminal", id.terminal], { on: id.machine, timeout: 3000 });
        const snapshot = result?.code === 0 ? parseStatus(result.stdout, id) : null;
        if (!snapshot) { this.freeze(entry, true); return; }
        // The reader advances active elapsed time on the remote monotonic clock, even if the
        // last statusLine callback was hours ago. Each sample becomes a new local anchor;
        // neither machine's wall clock is compared with the other's.
        const changed = !entry.snapshot || snapshot.observed !== entry.snapshot.observed
          || snapshot.producer !== entry.snapshot.producer || snapshot.turn.id !== entry.snapshot.turn.id;
        if (changed || snapshot.sampled !== entry.snapshot.sampled) {
          const paused = entry.held === "state" && !changed;
          entry.snapshot = snapshot;
          entry.stale = false;
          if (!paused) {
            entry.elapsed = snapshot.turn.elapsed;
            entry.anchor = this.clock();
            entry.held = false;
            entry.advancing = this.shown === id.key && snapshot.turn.running && agent.status === "working" && online(id, feed);
            if (this.shown !== id.key && snapshot.turn.running) entry.stale = true;
          }
        }
      } catch { this.freeze(entry, true); }
      finally {
        this.inFlight = false;
        if (this.shown === id.key) cx.notify();
      }
    });
  }

  text(agent, feed) {
    const id = statusIdentity(agent, feed);
    this.select(id);
    const entry = id ? this.entries.get(id.key) : null;
    // Rendering also sees live Herdr transitions before the next 400 ms chat tick.
    if (entry && (!online(id, feed) || agent.status !== "working")) this.freeze(entry, !online(id, feed));
    const s = entry?.snapshot, ms = this.elapsed(entry);
    return `Model: ${modelText(s)} │ In: ${formatTokens(s?.input)} │ Out: ${formatTokens(s?.output)} │ Est: ${formatCost(s?.cost)} │ Turn: ${ms === null ? "N/A" : `${Math.floor(ms / 1000)}s`}${entry?.stale ? " │ 更新待ち" : ""}`;
  }

  render(agent, feed, t) {
    const text = this.text(agent, feed);
    return v_flex().id("chat-status").w_full().flex_none()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().h(1).w_full().bg(t.border))
      .child(h_flex().w_full().px(16).py(7).gap(4).flex_wrap().items_center().justify_center()
        .bg(t.background).text_size(11.5).text_color(t.muted)
        .children(text.split(" │ ").map((part, i) => h_flex().flex_none().gap(4).items_center()
          .when(i > 0, (el) => el.child(div().text_color(t.dim).child("│")))
          .child(div().child(part)))));
  }
}
