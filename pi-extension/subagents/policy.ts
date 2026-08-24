export const SUBAGENT_POLICY_VERSION = 1 as const;

export const SUBAGENT_MANAGEMENT_TOOLS = [
  "subagent",
  "subagent_interrupt",
  "subagents_list",
  "subagent_resume",
] as const;

const SUBAGENT_CONTROL_TOOLS = ["caller_ping", "subagent_done"] as const;

export interface EffectiveSubagentPolicy {
  version: typeof SUBAGENT_POLICY_VERSION;
  spawning: boolean;
  deniedTools: string[];
  /** Exact Pi CLI allowlist, or null when Pi's default tool set is unrestricted. */
  toolAllowlist: string[] | null;
  agent?: string;
}

function parseToolNames(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

export function parseSpawningBoolean(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`spawning must be true or false, got ${JSON.stringify(value)}`);
}

export function readSpawningFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.PI_SUBAGENT_SPAWNING?.trim();
  if (value == null || value === "" || value === "1") return true;
  if (value === "0") return false;
  throw new Error(`PI_SUBAGENT_SPAWNING must be 0 or 1, got ${JSON.stringify(value)}`);
}

export function formatSpawningPolicyGuidance(spawning: boolean): string[] {
  return spawning
    ? [
        "Recursive delegation is allowed. Before creating a child, account for your current depth and full ancestry. " +
          "Delegate only when another layer has clear value; do not re-delegate the same or a broader task, duplicate work already represented in the lineage, or create fan-out merely because an earlier attempt was slow or blocked.",
        "Any child launched through the subagent tool will receive this lineage with its own node appended.",
      ]
    : [
        "Recursive spawning is disabled for this agent. Do not attempt to spawn, interrupt, list, or resume subagents; those management tools are unavailable.",
        "This restriction remains in effect if this session is resumed.",
      ];
}

export function buildSubagentToolAllowlist(
  effectiveTools?: string,
  deniedTools: ReadonlySet<string> = new Set(),
  spawning = true,
): string | null {
  const requested = parseToolNames(effectiveTools);
  if (requested.length === 0) return null;

  const allow = new Set(requested);
  for (const tool of SUBAGENT_CONTROL_TOOLS) allow.add(tool);
  if (spawning) {
    for (const tool of SUBAGENT_MANAGEMENT_TOOLS) allow.add(tool);
  }
  for (const tool of deniedTools) allow.delete(tool);

  return [...allow].join(",");
}

export function createEffectiveSubagentPolicy(params: {
  spawning?: boolean;
  denyTools?: string;
  effectiveTools?: string;
  agent?: string;
}): EffectiveSubagentPolicy {
  const spawning = params.spawning ?? true;
  const denied = new Set(parseToolNames(params.denyTools));
  if (!spawning) {
    for (const tool of SUBAGENT_MANAGEMENT_TOOLS) denied.add(tool);
  }
  const allowlist = buildSubagentToolAllowlist(params.effectiveTools, denied, spawning);

  return {
    version: SUBAGENT_POLICY_VERSION,
    spawning,
    deniedTools: [...denied].sort(),
    toolAllowlist: allowlist ? allowlist.split(",") : null,
    ...(params.agent ? { agent: params.agent } : {}),
  };
}

export function validateEffectiveSubagentPolicy(value: unknown): EffectiveSubagentPolicy {
  if (!value || typeof value !== "object") {
    throw new Error("subagent policy must be an object");
  }
  const policy = value as {
    version?: unknown;
    spawning?: unknown;
    deniedTools?: unknown;
    toolAllowlist?: unknown;
    agent?: unknown;
  };
  if (policy.version !== SUBAGENT_POLICY_VERSION) {
    throw new Error(`unsupported subagent policy version: ${String(policy.version)}`);
  }
  if (typeof policy.spawning !== "boolean") {
    throw new Error("subagent policy spawning must be a boolean");
  }
  if (
    !Array.isArray(policy.deniedTools) ||
    !policy.deniedTools.every((tool) => typeof tool === "string" && tool.trim() === tool && tool.length > 0)
  ) {
    throw new Error("subagent policy deniedTools must be an array of non-empty tool names");
  }
  if (
    policy.toolAllowlist !== null &&
    (!Array.isArray(policy.toolAllowlist) ||
      !policy.toolAllowlist.every(
        (tool) => typeof tool === "string" && tool.trim() === tool && tool.length > 0,
      ))
  ) {
    throw new Error("subagent policy toolAllowlist must be null or an array of non-empty tool names");
  }
  if (policy.agent != null && (typeof policy.agent !== "string" || policy.agent.trim() === "")) {
    throw new Error("subagent policy agent must be a non-empty string");
  }

  const deniedTools = [...new Set(policy.deniedTools as string[])].sort();
  const toolAllowlist = policy.toolAllowlist === null
    ? null
    : [...new Set(policy.toolAllowlist as string[])];
  if (!policy.spawning) {
    for (const tool of SUBAGENT_MANAGEMENT_TOOLS) {
      if (!deniedTools.includes(tool)) {
        throw new Error(`disabled subagent policy must deny ${tool}`);
      }
      if (toolAllowlist?.includes(tool)) {
        throw new Error(`disabled subagent policy cannot allow ${tool}`);
      }
    }
  }

  return {
    version: SUBAGENT_POLICY_VERSION,
    spawning: policy.spawning,
    deniedTools,
    toolAllowlist,
    ...(policy.agent ? { agent: policy.agent as string } : {}),
  };
}

export function getWidgetDeniedTools(
  deniedTools: readonly string[],
  spawning: boolean,
): string[] {
  if (spawning) return [...deniedTools];
  const managementTools = new Set<string>(SUBAGENT_MANAGEMENT_TOOLS);
  return deniedTools.filter((tool) => !managementTools.has(tool));
}
