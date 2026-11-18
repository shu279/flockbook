// Visible acknowledgement while a send is in flight, then Herdr's actual live activity.
// Animation is native; no timer invents progress or cycles through made-up work messages.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { terminals, machines } from "herdr";
import { icon, machineOf, SPIN_MS } from "./state.js";

export const ACK_WAIT_MS = 30000;
const line = (v) => typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180) : "";
const terminalFor = (address) => terminals().find((t) => t.address === address);
const stamp = (terminal) => `${terminal?.turn ?? ""}:${terminal?.status_ms ?? ""}`;
const pid = (terminal) => terminal?.foreground?.pid ?? terminal?.pid ?? null;

export class ChatActivity {
  constructor(clock = () => Date.now()) {
    this.clock = clock;
    this.pending = new Map();
  }

  begin(agent, seen) {
    const address = agent?.address;
    if (!address) return null;
    const terminal = terminalFor(address);
    const send = { address, path: seen?.path ?? null, pid: pid(terminal), stamp: stamp(terminal),
      phase: "sending", at: this.clock() };
    if (this.pending.size >= 64) this.pending.delete(this.pending.keys().next().value);
    this.pending.set(address, send);
    return send;
  }

  finish(send, accepted, cx) {
    if (!send || this.pending.get(send.address) !== send) return;
    if (!accepted) { this.pending.delete(send.address); return; }
    send.phase = "waiting";
    send.at = this.clock();
    // A lost/unconfirmed send must not look like the agent is working forever.
    // This one-shot wakes the text after a deadline; the spinner itself is native.
    cx.timer.after(ACK_WAIT_MS, (cx) => {
      if (this.pending.get(send.address) === send) cx.notify();
    });
  }

  describe(agent, seen) {
    if (!agent) return null;
    const terminal = terminalFor(agent.address), machine = machineOf(agent.address);
    const disconnected = machine && !machines().some((m) => m.name === machine && m.layout === "ready");
    if (disconnected || (terminal && terminal.state !== "live")) {
      this.pending.delete(agent.address);
      return disconnected ? { text: "接続を待っています", spinning: false, warning: true } : null;
    }
    let send = this.pending.get(agent.address);
    if (send && ((send.path && seen?.path && send.path !== seen.path)
      || (send.pid !== null && pid(terminal) !== null && send.pid !== pid(terminal)))) {
      this.pending.delete(agent.address);
      send = null;
    }
    if (send?.phase === "sending") return { text: "送信しています…", spinning: true };
    if (agent.status === "working") {
      this.pending.delete(agent.address);
      // Only a report explicitly attached to the current working state is used.
      // A completed answer often lives in report.msg; never show that as new work.
      const reported = terminal?.report?.state === "working" ? line(terminal.report.msg) : "";
      return { text: reported || "処理しています…", spinning: true };
    }
    if (agent.status === "blocked") {
      this.pending.delete(agent.address);
      return { text: "確認・承認を待っています", spinning: false, warning: true };
    }
    if (send) {
      // Even a turn that finishes before the next UI frame has a new core turn or
      // status timestamp. That completion clears the acknowledgement immediately.
      if (terminal && stamp(terminal) !== send.stamp) {
        this.pending.delete(agent.address);
        return null;
      }
      return this.clock() - send.at < ACK_WAIT_MS
        ? { text: "応答を待っています…", spinning: true }
        : { text: "応答の開始をまだ確認できません", spinning: false, warning: true };
    }
    return null;
  }
}

export function activityView(activity, t) {
  return h_flex().id("chat-activity").w_full().max_w(800).min_h(26).px(4).gap(8).items_center()
    .text_size(12.5).text_color(activity.warning ? t.blocked : t.muted)
    .child(activity.spinning
      ? svg(icon("spinner")).id("chat-activity-spinner").size(14).flex_none().text_color(t.working).spin(SPIN_MS)
      : svg(icon("bell")).size(14).flex_none())
    .child(div().flex_1().min_w(0).truncate().child(activity.text));
}
