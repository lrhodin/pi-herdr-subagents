export const SUBAGENT_LINEAGE_VERSION = 1 as const;

export interface SubagentLineageRoot {
  sessionId: string;
  sessionFile: string;
}

export interface SubagentLineageNode {
  depth: number;
  id: string;
  name: string;
  sessionFile: string;
  agent?: string;
}

export interface SubagentLineage {
  version: typeof SUBAGENT_LINEAGE_VERSION;
  root: SubagentLineageRoot;
  chain: SubagentLineageNode[];
}

export interface ChildLineageIdentity {
  id: string;
  name: string;
  sessionFile: string;
  agent?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateSubagentLineage(value: unknown): SubagentLineage {
  if (!value || typeof value !== "object") {
    throw new Error("subagent lineage must be an object");
  }

  const candidate = value as {
    version?: unknown;
    root?: { sessionId?: unknown; sessionFile?: unknown };
    chain?: unknown;
  };
  if (candidate.version !== SUBAGENT_LINEAGE_VERSION) {
    throw new Error(`unsupported subagent lineage version: ${String(candidate.version)}`);
  }
  if (
    !candidate.root ||
    !isNonEmptyString(candidate.root.sessionId) ||
    !isNonEmptyString(candidate.root.sessionFile)
  ) {
    throw new Error("subagent lineage root requires sessionId and sessionFile");
  }
  if (!Array.isArray(candidate.chain)) {
    throw new Error("subagent lineage chain must be an array");
  }

  const chain = candidate.chain.map((raw, index): SubagentLineageNode => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`subagent lineage node ${index + 1} must be an object`);
    }
    const node = raw as {
      depth?: unknown;
      id?: unknown;
      name?: unknown;
      sessionFile?: unknown;
      agent?: unknown;
    };
    const expectedDepth = index + 1;
    if (node.depth !== expectedDepth) {
      throw new Error(
        `subagent lineage node ${expectedDepth} has depth ${String(node.depth)}; expected ${expectedDepth}`,
      );
    }
    if (!isNonEmptyString(node.id) || !isNonEmptyString(node.name) || !isNonEmptyString(node.sessionFile)) {
      throw new Error(`subagent lineage node ${expectedDepth} requires id, name, and sessionFile`);
    }
    if (node.agent != null && !isNonEmptyString(node.agent)) {
      throw new Error(`subagent lineage node ${expectedDepth} has an invalid agent name`);
    }
    return {
      depth: expectedDepth,
      id: node.id,
      name: node.name,
      sessionFile: node.sessionFile,
      ...(node.agent ? { agent: node.agent } : {}),
    };
  });

  return {
    version: SUBAGENT_LINEAGE_VERSION,
    root: {
      sessionId: candidate.root.sessionId,
      sessionFile: candidate.root.sessionFile,
    },
    chain,
  };
}

export function createRootLineage(sessionId: string, sessionFile: string): SubagentLineage {
  return validateSubagentLineage({
    version: SUBAGENT_LINEAGE_VERSION,
    root: { sessionId, sessionFile },
    chain: [],
  });
}

export function appendSubagentLineage(
  parent: SubagentLineage,
  child: ChildLineageIdentity,
): SubagentLineage {
  const validParent = validateSubagentLineage(parent);
  return validateSubagentLineage({
    ...validParent,
    chain: [
      ...validParent.chain,
      {
        depth: validParent.chain.length + 1,
        id: child.id,
        name: child.name,
        sessionFile: child.sessionFile,
        ...(child.agent ? { agent: child.agent } : {}),
      },
    ],
  });
}

export function parseSubagentLineage(raw: string): SubagentLineage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: any) {
    throw new Error(`invalid PI_SUBAGENT_LINEAGE JSON: ${error?.message ?? String(error)}`);
  }
  return validateSubagentLineage(parsed);
}

export function serializeSubagentLineage(lineage: SubagentLineage): string {
  return JSON.stringify(validateSubagentLineage(lineage));
}

export function readSubagentLineageFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): SubagentLineage | null {
  const raw = env.PI_SUBAGENT_LINEAGE?.trim();
  if (!raw) return null;
  const lineage = parseSubagentLineage(raw);
  const declaredDepth = env.PI_SUBAGENT_DEPTH?.trim();
  if (declaredDepth && declaredDepth !== String(lineage.chain.length)) {
    throw new Error(
      `PI_SUBAGENT_DEPTH=${declaredDepth} disagrees with lineage depth ${lineage.chain.length}`,
    );
  }
  return lineage;
}

export function formatSubagentIdentity(lineage: SubagentLineage): string {
  const valid = validateSubagentLineage(lineage);
  const depth = valid.chain.length;
  const lines = [
    "<subagent_identity>",
    `You are a delegated subagent at recursion depth ${depth}. The root session is depth 0.`,
    "Full delegation lineage (root → you):",
    `- depth 0: root session ${valid.root.sessionId} (${valid.root.sessionFile})`,
    ...valid.chain.map((node) =>
      `- depth ${node.depth}: ${node.name}${node.agent ? ` [agent=${node.agent}]` : ""} ` +
      `(id=${node.id}, session=${node.sessionFile})`
    ),
    "Recursive delegation is allowed. Before creating a child, account for your current depth and this full ancestry. " +
      "Delegate only when another layer has clear value; do not re-delegate the same or a broader task, duplicate work already represented in the lineage, or create fan-out merely because an earlier attempt was slow or blocked.",
    "Any child launched through the subagent tool will receive this lineage with its own node appended.",
    "</subagent_identity>",
  ];
  return lines.join("\n");
}

export function prependSubagentIdentity(task: string, lineage: SubagentLineage): string {
  return `${formatSubagentIdentity(lineage)}\n\n${task}`;
}
