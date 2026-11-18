import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, log, reset } from "./stub/herdr.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { agent, space } from "./fixtures.mjs";
import { byId, textOf } from "./stub/ui.mjs";
import { ChatView } from "../mods/flockbook/chat.js";

const result = (...lines) => ({ code: 0, stderr: "", stdout: [
  { type: "header", protocol: 1 }, ...lines, { type: "end", ok: true },
].map(JSON.stringify).join("\n") });
const rule = "─".repeat(80);
const snapshot = { code: 0, stderr: "", stdout: JSON.stringify({ complete: true, how: "screen",
  text: `⣽ Working…\n▸ Actual CLI follow-up (alt+m to send immediately)\n${rule}\n>\n${rule}\nModel: Example` }) };

beforeEach(() => {
  reset();
  fake.spaces = [space()];
  fake.agents = [agent("t1", "working", { app: "antigravity" }), agent("t2", "working", { app: "antigravity" })];
  fake.terminals = fake.agents.map((a, i) => ({ address: a.address, state: "live", foreground: { pid: i + 10 }, report: { state: "working" } }));
});

function helper(_cmd, args) {
  if (args[0] === "read") return snapshot;
  if (args[0] === "feed") return result({ type: "log", agent: "agy", path: "/logs/one", start: 0, cursor: "one" },
    { type: "splice", at: 0 }, { type: "row", id: "a1", k: "assistant", text: "Working" });
  if (args[0] === "send") return result({ type: "done", result: "sent" });
  return result();
}

test("a composer send refreshes the actual queue immediately and renders it beside the input", async () => {
  fake.exec = helper;
  const cx = fakeCx(), view = new ChatView(cx);
  await cx.settle();
  view.composer.box(fake.agents[0]); view.composer.setText("A follow-up");
  await view.composer.submit(cx); await cx.settle();
  assert.equal(log.exec.filter(([cmd, args]) => cmd === "hc" && args[0] === "read").length, 1);
  const ui = view.render(cx), queued = byId(ui, "chat-queue");
  assert.match(textOf(queued), /Actual CLI follow-up/);
  assert.doesNotMatch(textOf(queued), /A follow-up/, "the display comes from the actual queue, not an invented local copy");
  assert.ok(byId(ui, "composer"));
});

test("finishing a send after switching agents never refreshes another agent's queue", async () => {
  let resolve;
  fake.exec = (cmd, args) => args[0] === "send" ? new Promise((r) => { resolve = r; }) : helper(cmd, args);
  const cx = fakeCx(), view = new ChatView(cx);
  await cx.settle();
  view.composer.box(fake.agents[0]); view.composer.setText("A follow-up");
  const pending = view.composer.submit(cx);
  fake.focused = { agent: "t2" };
  view.switchTo("t2"); view.composer.box(fake.agents[1]);
  resolve(result({ type: "done", result: "sent" })); await pending; await cx.settle();
  assert.equal(log.exec.filter(([cmd, args]) => cmd === "hc" && args[0] === "read").length, 0);
  assert.equal(byId(view.render(cx), "chat-queue"), null);
});
