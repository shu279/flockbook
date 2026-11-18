import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Antigravity status bridge: synthetic timing, identity, cache and terminal checks", () => {
  execFileSync("python3", ["-B", "-m", "unittest", "discover", "-s", fileURLToPath(new URL("../antigravity/", import.meta.url)), "-p", "test_*.py"],
    { stdio: "pipe", timeout: 30_000 });
});
