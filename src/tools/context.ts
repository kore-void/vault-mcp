import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveSafePath } from "../guards/laws.js";

export function register(server: McpServer): void {
  server.tool(
    "vault_context",
    "Načte AGENTS.md + session_state.md v jednom volání — L0 onboarding pro každou novou session.",
    {},
    async () => {
      const [agents, session] = await Promise.all([
        readFile(resolveSafePath("AGENTS.md"), "utf-8"),
        readFile(resolveSafePath("onboarding/session_state.md"), "utf-8"),
      ]);
      const combined = [
        "# VAULT CONTEXT — L0 Onboarding",
        "",
        "## AGENTS.md (identita, 3 pilíře, MoE)",
        agents,
        "",
        "## Session State (aktivní práce, pending)",
        session,
      ].join("\n");
      return { content: [{ type: "text" as const, text: combined }] };
    }
  );
}
