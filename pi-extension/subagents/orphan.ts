/**
 * Restored-orphan support.
 *
 * herdr (`resume_agents_on_restore`) relaunches pi panes after a reboot from
 * their session ref alone. A subagent relaunched that way loses everything the
 * parent passed per launch: `-e subagent-done.ts`, `--tools`, and the
 * `PI_SUBAGENT_*` env. Its parent's in-memory watcher died at the same reboot,
 * so a `.exit` sidecar would reach no one.
 *
 * The always-loaded main extension detects such a session (persisted lineage
 * at depth > 0, no `PI_SUBAGENT_SESSION`) and registers orphan variants of
 * `subagent_done` / `caller_ping` that hand the result to the parent's live
 * pane directly.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import type { SubagentLineage } from "./lineage.ts";
import type { EffectiveSubagentPolicy } from "./policy.ts";
import { findLastAssistantMessage, type SessionEntry } from "./session.ts";

export function isRestoredOrphan(
  lineage: SubagentLineage | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): lineage is SubagentLineage {
  return !!lineage && lineage.chain.length > 0 && !env.PI_SUBAGENT_SESSION?.trim();
}

export function parentSessionFileOf(lineage: SubagentLineage): string {
  const chain = lineage.chain;
  return chain.length >= 2 ? chain[chain.length - 2].sessionFile : lineage.root.sessionFile;
}

interface HerdrPaneRecord {
  pane_id?: unknown;
  agent_session?: { value?: unknown } | null;
}

/** Find the live pane whose agent session is `sessionFile` in `herdr pane list` JSON. */
export function findPaneForSession(paneListJson: string, sessionFile: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(paneListJson);
  } catch {
    return null;
  }
  const panes = (parsed as { result?: { panes?: unknown } })?.result?.panes;
  if (!Array.isArray(panes)) return null;
  for (const pane of panes as HerdrPaneRecord[]) {
    if (pane?.agent_session?.value === sessionFile && typeof pane.pane_id === "string") {
      return pane.pane_id;
    }
  }
  return null;
}

/**
 * The single-line prompt typed into the parent's pane. One line, because a
 * newline would submit early; the full summary goes to `resultFile`.
 */
export function formatOrphanHandoff(params: {
  kind: "done" | "ping";
  name: string;
  resultFile: string;
  childSessionFile: string;
  childPane?: string;
}): string {
  const what = params.kind === "done"
    ? `finished; its summary is in ${params.resultFile}`
    : `needs help (caller_ping); its message is in ${params.resultFile}. Resume it with subagent_resume to answer`;
  const pane = params.childPane ? ` Its pane ${params.childPane} can be closed.` : "";
  return (
    `[subagent_result] Subagent "${params.name}" (restored by herdr after a reboot, so no watcher delivered this) ` +
    `${what}. Session: ${params.childSessionFile}.${pane}`
  );
}

/** Tools to activate for a restored orphan: its persisted allowlist, or null for no change. */
export function orphanActiveTools(
  policy: EffectiveSubagentPolicy | null | undefined,
  registered: readonly string[],
): string[] | null {
  if (!policy?.toolAllowlist) return null;
  const known = new Set(registered);
  return policy.toolAllowlist.filter((tool) => known.has(tool));
}

export interface OrphanDeps {
  listPanes: () => string;
  runInPane: (pane: string, text: string) => void;
  currentPane: () => string | undefined;
}

export function registerOrphanTools(
  pi: ExtensionAPI,
  lineage: SubagentLineage,
  deps: OrphanDeps,
): void {
  const self = lineage.chain[lineage.chain.length - 1];
  const parentSession = parentSessionFileOf(lineage);

  const deliver = (kind: "done" | "ping", body: string): { delivered: boolean; text: string } => {
    const resultFile = `${self.sessionFile}.${kind === "done" ? "result" : "ping"}.md`;
    writeFileSync(resultFile, body.endsWith("\n") ? body : `${body}\n`, "utf8");
    let pane: string | null = null;
    try {
      pane = findPaneForSession(deps.listPanes(), parentSession);
    } catch {
      pane = null;
    }
    if (!pane) {
      return {
        delivered: false,
        text:
          `The parent session (${parentSession}) has no live pane, so nothing was delivered. ` +
          `The ${kind === "done" ? "summary" : "message"} is saved at ${resultFile}. ` +
          "Tell the user that, and leave your summary in this pane. Do not retry.",
      };
    }
    deps.runInPane(
      pane,
      formatOrphanHandoff({
        kind,
        name: self.name,
        resultFile,
        childSessionFile: self.sessionFile,
        childPane: deps.currentPane(),
      }),
    );
    return { delivered: true, text: `Delivered to the parent in pane ${pane}. Shutting down.` };
  };

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = deliver("ping", params.message);
      if (result.delivered) ctx.shutdown();
      return { content: [{ type: "text", text: result.text }], details: {} };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const entries = (ctx.sessionManager?.getBranch?.() ?? []) as unknown as SessionEntry[];
      const summary = findLastAssistantMessage(entries) ?? "(no summary: the subagent wrote no assistant text)";
      const result = deliver("done", summary);
      if (result.delivered) ctx.shutdown();
      return { content: [{ type: "text", text: result.text }], details: {} };
    },
  });
}
