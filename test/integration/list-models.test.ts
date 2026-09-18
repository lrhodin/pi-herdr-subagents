import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAvailableBackends, createTestEnv, cleanupTestEnv, createTrackedSurface,
  startPi, waitForFile, dumpWorkspacePanes, shellQuote, PI_TIMEOUT, TEST_MODEL,
} from "./harness.ts";

function messages(path: string): any[] {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "message").map((entry) => entry.message);
}

it("list_models resolves a live model and remains available in a restricted greeting child", {
  skip: getAvailableBackends().length === 0,
  timeout: PI_TIMEOUT * 3,
}, async () => {
  const env = createTestEnv("herdr");
  try {
    const query = process.env.PI_TEST_DISCOVERY_QUERY ?? TEST_MODEL;
    const session = join(env.dir, "parent.jsonl");
    const done = join(env.dir, "done.txt");
    const registry = join(env.dir, "registry.json");
    const observer = join(env.dir, "registry-observer.ts");
    writeFileSync(observer, `import { writeFileSync } from 'node:fs';
export default function(pi) {
  pi.on('session_start', (_event, ctx) => {
    writeFileSync(${JSON.stringify(registry)}, JSON.stringify(ctx.modelRegistry.getAvailable().map(m => m.provider + '/' + m.id)));
  });
}`);
    const surface = createTrackedSurface(env, "list-models-integration");
    startPi(surface, env.dir, [
      `This is a focused tool integration test. First call list_models with query ${JSON.stringify(query)}.`,
      "Select an exact returned provider/model-id matching that requested model. Do not guess or inspect configuration files.",
      "Call subagent once with that model, name ModelGreeting, tools read,write, and this task:",
      `Call list_models with query ${JSON.stringify(query)}, then reply HELLO_FROM_DISCOVERED_MODEL and call subagent_done. Do not delegate.`,
      `After the automatic subagent completion arrives, use write to put COMPLETE in ${done}. Do not write it before completion.`,
    ].join("\n"), { extraArgs: `--session ${shellQuote(session)} -e ${shellQuote(observer)}` });
    try {
      await waitForFile(done, PI_TIMEOUT * 2, /COMPLETE/);
    } catch (error) {
      throw new Error(`${String(error)}\n${dumpWorkspacePanes(env, 250)}`);
    }
    const parent = messages(session);
    const catalog = parent.find((m) => m.role === "toolResult" && m.toolName === "list_models");
    assert.ok(catalog && !catalog.isError, "parent must call list_models successfully");
    const text = catalog.content.map((c: any) => c.text ?? "").join("\n");
    const available: string[] = JSON.parse(readFileSync(registry, "utf8"));
    const returned = text.split("\n").filter((line: string) => line.startsWith("- ")).map((line: string) => line.slice(2).split(" ")[0]);
    assert.ok(returned.length > 0, "catalog must return models");
    for (const id of returned) assert.ok(available.includes(id), `not an authenticated registry ID: ${id}`);
    const launch = parent.find((m) => m.role === "toolResult" && m.toolName === "subagent");
    assert.ok(launch && !launch.isError, "greeting child must launch");
    assert.ok(returned.includes(launch.details.model), "spawn model must come from list_models");
    const child = messages(launch.details.sessionFile);
    assert.ok(child.some((m) => m.role === "assistant" && `${m.provider}/${m.model}` === launch.details.model), "child must actually run the discovered model");
    assert.ok(child.some((m) => m.role === "toolResult" && m.toolName === "list_models" && !m.isError), "restricted child must call list_models");
    assert.ok(child.some((m) => m.role === "assistant" && m.content.some((c: any) => c.type === "text" && c.text.includes("HELLO_FROM_DISCOVERED_MODEL"))), "child must greet");
    console.log(`Verified live catalog, parent spawn and child tool call: ${launch.details.model}`);
  } finally {
    cleanupTestEnv(env);
  }
});
