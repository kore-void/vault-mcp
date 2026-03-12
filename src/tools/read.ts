import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveSafePath } from "../guards/laws.js";

export function register(server: McpServer): void {
  server.tool(
    "vault_read",
    "Přečte libovolný .md soubor z vaultu. Cesta je relativní k root vaultu (např. 'projects/kontraktor/CONTEXT.md').",
    { path: z.string().describe("Relativní cesta k souboru od vault root") },
    async ({ path: relativePath }) => {
      if (!relativePath.endsWith(".md")) {
        return {
          content: [{ type: "text" as const, text: `Error: vault_read podporuje pouze .md soubory. Zadáno: ${relativePath}` }],
          isError: true,
        };
      }
      const abs = resolveSafePath(relativePath);
      const [content, stats] = await Promise.all([
        readFile(abs, "utf-8"),
        stat(abs),
      ]);
      const meta = [
        `<!-- vault_read: ${relativePath} -->`,
        `<!-- lastModified: ${stats.mtime.toISOString()} | lines: ${content.split("\n").length} -->`,
        "",
      ].join("\n");
      return { content: [{ type: "text" as const, text: meta + content }] };
    }
  );
}
