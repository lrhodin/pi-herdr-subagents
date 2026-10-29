import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findPaneForSession,
  formatOrphanHandoff,
  isRestoredOrphan,
  orphanActiveTools,
  parentSessionFileOf,
  registerOrphanTools,
} from "../pi-extension/subagents/orphan.ts";
import type { SubagentLineage } from "../pi-extension/subagents/lineage.ts";

const root = { sessionId: "r", sessionFile: "/s/root.jsonl" };
const depth1: SubagentLineage = {
  version: 1,
  root,
  chain: [{ depth: 1, id: "a", name: "child", sessionFile: "/s/child.jsonl" }],
};
const depth2: SubagentLineage = {
  version: 1,
  root,
  chain: [
    { depth: 1, id: "a", name: "child", sessionFile: "/s/child.jsonl" },
    { depth: 2, id: "b", name: "grandchild", sessionFile: "/s/grand.jsonl" },
  ],
};
const panes = (value: string) => JSON.stringify({
  result: { panes: [
    { pane_id: "w1:p1" },
    { pane_id: "w1:p2", agent_session: { value: "/s/other.jsonl" } },
    { pane_id: "w1:p3", agent_session: { value } },
  ] },
});

describe("orphan.ts", () => {
  it("detects a restored orphan only at depth > 0 without PI_SUBAGENT_SESSION", () => {
    assert.equal(isRestoredOrphan(depth1, {}), true);
    assert.equal(isRestoredOrphan(depth1, { PI_SUBAGENT_SESSION: "/s/child.jsonl" }), false);
    assert.equal(isRestoredOrphan({ ...depth1, chain: [] }, {}), false);
    assert.equal(isRestoredOrphan(null, {}), false);
  });

  it("resolves the parent session from the lineage", () => {
    assert.equal(parentSessionFileOf(depth1), "/s/root.jsonl");
    assert.equal(parentSessionFileOf(depth2), "/s/child.jsonl");
  });

  it("finds the parent pane by agent session path", () => {
    assert.equal(findPaneForSession(panes("/s/root.jsonl"), "/s/root.jsonl"), "w1:p3");
    assert.equal(findPaneForSession(panes("/s/x.jsonl"), "/s/root.jsonl"), null);
    assert.equal(findPaneForSession("not json", "/s/root.jsonl"), null);
  });

  it("formats a single-line handoff", () => {
    const text = formatOrphanHandoff({
      kind: "done", name: "child", resultFile: "/s/child.jsonl.result.md",
      childSessionFile: "/s/child.jsonl", childPane: "w1:p9",
    });
    assert.ok(!text.includes("\n"));
    assert.match(text, /^\[subagent_result\] Subagent "child"/);
    assert.match(text, /child\.jsonl\.result\.md/);
    assert.match(text, /w1:p9/);
  });

  it("re-applies only registered allowlisted tools", () => {
    const policy = { version: 1 as const, spawning: true, deniedTools: [], toolAllowlist: ["read", "subagent_done", "ghost"] };
    assert.deepEqual(orphanActiveTools(policy, ["read", "bash", "subagent_done"]), ["read", "subagent_done"]);
    assert.equal(orphanActiveTools({ ...policy, toolAllowlist: null }, ["read"]), null);
    assert.equal(orphanActiveTools(null, ["read"]), null);
  });

  function harness(paneJson: string) {
    const dir = mkdtempSync(join(tmpdir(), "orphan-"));
    const child = join(dir, "child.jsonl");
    const lineage: SubagentLineage = { ...depth1, chain: [{ ...depth1.chain[0], sessionFile: child }] };
    const tools = new Map<string, any>();
    const sent: Array<[string, string]> = [];
    let shutdowns = 0;
    registerOrphanTools({ registerTool: (t: any) => tools.set(t.name, t) } as any, lineage, {
      listPanes: () => paneJson,
      runInPane: (pane, text) => sent.push([pane, text]),
      currentPane: () => "w1:p9",
    });
    const ctx = {
      shutdown: () => { shutdowns++; },
      sessionManager: { getBranch: () => [
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "old" }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "final\nsummary" }] } },
      ] },
    };
    return { tools, sent, ctx, child, shutdowns: () => shutdowns };
  }

  it("subagent_done hands the last assistant message to the parent pane and shuts down", async () => {
    const h = harness(panes("/s/root.jsonl"));
    const res = await h.tools.get("subagent_done").execute("1", {}, undefined, undefined, h.ctx);
    assert.equal(readFileSync(`${h.child}.result.md`, "utf8"), "final\nsummary\n");
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0][0], "w1:p3");
    assert.match(h.sent[0][1], /result\.md/);
    assert.equal(h.shutdowns(), 1);
    assert.match(res.content[0].text, /Delivered/);
  });

  it("stays open and says so when the parent has no live pane", async () => {
    const h = harness(panes("/s/nobody.jsonl"));
    const res = await h.tools.get("subagent_done").execute("1", {}, undefined, undefined, h.ctx);
    assert.equal(h.sent.length, 0);
    assert.equal(h.shutdowns(), 0);
    assert.match(res.content[0].text, /no live pane/);
  });

  it("caller_ping delivers the message as a ping", async () => {
    const h = harness(panes("/s/root.jsonl"));
    await h.tools.get("caller_ping").execute("1", { message: "help" }, undefined, undefined, h.ctx);
    assert.equal(readFileSync(`${h.child}.ping.md`, "utf8"), "help\n");
    assert.match(h.sent[0][1], /caller_ping/);
    assert.equal(h.shutdowns(), 1);
  });
});
