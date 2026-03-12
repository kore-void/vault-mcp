import { readFile, stat } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveSafePath } from "../guards/laws.js";

interface StaticResource {
  name:     string;
  uri:      string;
  path:     string;
  desc:     string;
}

const STATIC_RESOURCES: StaticResource[] = [
  {
    name: "vault-agents",
    uri:  "vault://agents",
    path: "AGENTS.md",
    desc: "L0 entry point — identita, 3 pilíře, MoE pravidla. Číst jako první.",
  },
  {
    name: "vault-session",
    uri:  "vault://session",
    path: "onboarding/session_state.md",
    desc: "Aktuální session state — co je rozděláno, pending tasks, poslední změny.",
  },
  {
    name: "vault-index",
    uri:  "vault://index",
    path: "INDEX.md",
    desc: "Kompletní mapa vaultu — navigace, adresáře, obsah.",
  },
  {
    name: "vault-laws",
    uri:  "vault://laws",
    path: "LAWS.md",
    desc: "10 absolutních zákonů vaultu — governance, co nesmí být porušeno.",
  },
];

export function register(server: McpServer): void {
  for (const res of STATIC_RESOURCES) {
    server.resource(
      res.name,
      res.uri,
      async (_uri) => {
        const abs = resolveSafePath(res.path);
        const [text, stats] = await Promise.all([
          readFile(abs, "utf-8"),
          stat(abs),
        ]);
        return {
          contents: [{
            uri:          res.uri,
            mimeType:     "text/markdown",
            text,
            // annotations jsou metadata hints pro klienta
            // priority 1.0 = vždy zahrnout do kontextu (AGENTS.md)
          }],
        };
      }
    );
  }
}
