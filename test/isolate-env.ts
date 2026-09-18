/** Tests must never write completion/activity sidecars belonging to their caller. */
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_SUBAGENT_") && key !== "PI_SUBAGENT_SHELL_READY_DELAY_MS") {
    delete process.env[key];
  }
}
delete process.env.PI_DENY_TOOLS;
delete process.env.PI_AGENT_NAME;
