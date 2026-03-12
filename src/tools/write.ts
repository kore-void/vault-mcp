import { readFile, writeFile, appendFile, access } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  resolveSafePath,
  assertWritable,
  validateFrontmatter,
  scanForSecrets,
  validateLineCount,
} from "../guards/laws.js";

function currentMonthFile(): string {
  const d = new Date();
  return `chronicles/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}.md`;
}

export function register(server: McpServer): void {

  server.tool(
    "vault_update_session",
    "Přepíše onboarding/session_state.md. Musí obsahovat platný frontmatter. Volej po každé major session.",
    { content: z.string().describe("Celý obsah session_state.md včetně frontmatter") },
    async ({ content }) => {
      assertWritable("onboarding/session_state.md");
      validateFrontmatter(content);
      scanForSecrets(content);
      const abs = resolveSafePath("onboarding/session_state.md");
      await writeFile(abs, content, "utf-8");
      return { content: [{ type: "text" as const, text: "session_state.md aktualizován." }] };
    }
  );

  server.tool(
    "vault_chronicle",
    "Přidá entry do aktuálního měsíčního chronicles logu (chronicles/YYYY-MM.md). Formát: krátký popis co se stalo.",
    { entry: z.string().describe("Krátký popis události (1 věta)") },
    async ({ entry }) => {
      const monthFile = currentMonthFile();
      assertWritable(monthFile);
      scanForSecrets(entry);
      const abs = resolveSafePath(monthFile);
      const ts = new Date().toISOString().replace("T", " ").substring(0, 16);
      const line = `\n| ${ts} | vault-mcp | ${entry} |`;
      try {
        await access(abs);
        await appendFile(abs, line, "utf-8");
      } catch {
        return {
          content: [{ type: "text" as const, text: `Chronicles soubor ${monthFile} neexistuje — vytvoř ho nejdřív přes vault_read pro ověření.` }],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: `Přidáno do ${monthFile}: ${ts} — ${entry}` }] };
    }
  );

  server.tool(
    "vault_memory",
    "Přepíše soubor v adresáři memory/ (např. 'memory/global_memory.md'). Musí obsahovat platný frontmatter.",
    {
      file:    z.string().describe("Relativní cesta v rámci memory/ (např. 'memory/nautilus_memory.md')"),
      content: z.string().describe("Celý obsah souboru včetně frontmatter"),
    },
    async ({ file, content }) => {
      if (!file.startsWith("memory/")) {
        return {
          content: [{ type: "text" as const, text: `vault_memory: cesta musí začínat 'memory/'. Zadáno: ${file}` }],
          isError: true,
        };
      }
      assertWritable(file);
      validateFrontmatter(content);
      scanForSecrets(content);
      validateLineCount(content, file);
      const abs = resolveSafePath(file);
      await writeFile(abs, content, "utf-8");
      return { content: [{ type: "text" as const, text: `${file} aktualizován.` }] };
    }
  );
}
