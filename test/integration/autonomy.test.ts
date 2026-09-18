import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectPane } from "../../pi-extension/subagents/terminal.ts";
import {
  getAvailableBackends, createTestEnv, cleanupTestEnv, createTrackedSurface,
  startPi, shellQuote, PI_TIMEOUT, sleep, dumpWorkspacePanes,
} from "./harness.ts";

function entries(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
async function until<T>(check: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + PI_TIMEOUT;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    await sleep(250);
  }
  throw new Error("Timed out waiting for lifecycle evidence");
}

for (const interactive of [false, true]) {
  it(`natural ${interactive ? "user-driven handoff preserves" : "autonomous greeting cleans up"} child pane`, {
    skip: getAvailableBackends().length === 0, timeout: PI_TIMEOUT * 3,
  }, async () => {
    const env = createTestEnv("herdr");
    try {
      // No test agent role, expected tool choices, or evaluation hints in task context.
      rmSync(join(env.dir, ".pi", "agents"), { recursive: true });
      const session = join(env.dir, "parent.jsonl");
      const parentPane = createTrackedSurface(env, "natural-delegation");
      startPi(parentPane, env.dir, interactive
        ? "Open a subagent that says hi. I want to personally drive the child conversation in its pane afterward."
        : "Spawn a subagent that says hi.",
      { extraArgs: `--session ${shellQuote(session)}` });
      const launch = await until(() => entries(session).map((e) => e.message).find((m) =>
        m?.role === "toolResult" && m.toolName === "subagent" && !m.isError));
      const call = entries(session).flatMap((e) => e.message?.content ?? []).find((c) =>
        c.type === "toolCall" && c.name === "subagent");
      assert.equal(call.arguments.interactive ?? false, interactive);
      const script = readFileSync(launch.details.launchScriptFile, "utf8");
      const childPane = script.match(/^# Surface: (.+)$/m)?.[1];
      assert.ok(childPane, "launch artifact records owned pane");
      assert.notEqual(childPane, parentPane);
      await until(() => entries(launch.details.sessionFile).some((e) =>
        e.message?.role === "assistant" && e.message.content?.some((c: any) =>
          c.type === "text" && /\b(hi|hello|hey)\b/i.test(c.text))));
      if (interactive) {
        await until(async () => {
          const pane = await inspectPane(childPane);
          return pane.kind === "present" && pane.agentStatus === "idle";
        });
        assert.ok(!entries(session).some((e) => e.customType === "subagent_result"));
        console.log("User-driven child greeted and remained idle/open");
      } else {
        await until(() => entries(session).some((e) => e.customType === "subagent_result"));
        await until(async () => (await inspectPane(childPane)).kind === "missing");
        console.log("Autonomous greeting delivered; owned child pane closed");
      }
      assert.notEqual((await inspectPane(parentPane)).kind, "missing", "parent survives cleanup");
    } catch (error) {
      throw new Error(`${String(error)}\n${dumpWorkspacePanes(env, 150)}`);
    } finally {
      cleanupTestEnv(env);
    }
  });
}

it("natural clarification resumes the same child despite stale completion artifacts", {
  skip: getAvailableBackends().length === 0, timeout: PI_TIMEOUT * 4,
}, async () => {
  const env = createTestEnv("herdr");
  try {
    rmSync(join(env.dir, ".pi", "agents"), { recursive: true });
    const session = join(env.dir, "parent.jsonl");
    const pane = createTrackedSurface(env, "natural-resume");
    startPi(pane, env.dir,
      "Have a subagent greet me in my preferred language. It should ask you for the language before greeting me; I'll tell you when it asks.",
      { extraArgs: `--session ${shellQuote(session)}` });
    const question = await until(() => entries(session).find((e) => e.customType === "subagent_ping" || e.customType === "subagent_result"));
    const launch = entries(session).map((e) => e.message).find((m) => m?.toolName === "subagent" && !m.isError);
    assert.ok(launch);
    const childSession = question.details.sessionFile;
    const oldCount = entries(childSession).length;
    // Artifacts belong to the external harness, never the simulated task context.
    writeFileSync(`${childSession}.exit`, JSON.stringify({ type: "done" }));
    writeFileSync(`${childSession}.${launch.details.id}.exit`, JSON.stringify({ type: "done", executionId: launch.details.id }));
    await until(() => {
      const transcript = entries(session);
      const questionIndex = transcript.findIndex((e) => e.customType === "subagent_ping" || e.customType === "subagent_result");
      return transcript.slice(questionIndex + 1).some((e) => e.message?.role === "assistant" && e.message.stopReason === "stop");
    });
    const beforeResume = entries(session).length;
    execFileSync("herdr", ["agent", "prompt", pane, "Swedish. Please continue with the same subagent."], { encoding: "utf8" });
    const resumed = await until(() => entries(session).map((e) => e.message).find((m) => m?.toolName === "subagent_resume" && !m.isError));
    assert.equal(resumed.details.sessionPath, childSession);
    assert.notEqual(resumed.details.id, launch.details.id);
    // Simulate the old run writing once more after the resume launched.
    writeFileSync(`${childSession}.${launch.details.id}.exit`, JSON.stringify({ type: "done", executionId: launch.details.id }));
    const result = await until(() => entries(session).slice(beforeResume).find((e) => e.customType === "subagent_result"));
    assert.equal(result.details.exitCode, 0);
    assert.ok(entries(childSession).slice(oldCount).some((e) => e.message?.role === "assistant" && e.message.content?.some((c: any) => c.type === "text" && /hej/i.test(c.text))), "resumed child must produce a fresh Swedish greeting");
    const script = readFileSync(resumed.details.launchScriptFile, "utf8");
    const resumedPane = script.match(/^# Surface: (.+)$/m)?.[1];
    assert.ok(resumedPane);
    await until(async () => (await inspectPane(resumedPane)).kind === "missing");
    assert.notEqual((await inspectPane(pane)).kind, "missing");
    console.log("Clarification resumed; fresh Swedish greeting delivered and resumed pane cleaned up");
  } catch (error) {
    throw new Error(`${String(error)}\n${dumpWorkspacePanes(env, 150)}`);
  } finally { cleanupTestEnv(env); }
});
