import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// MCP Prompts → stávají se slash commandy v Claude Code:
// /mcp__vault__onboard   /mcp__vault__juice   /mcp__vault__search

export function register(server: McpServer): void {

  server.prompt(
    "onboard",
    "Načte vault kontext pro novou session — zavolá vault_context() a shrne stav.",
    {},
    async () => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            "Zavolej vault_context() a přečti výsledek.",
            "Pak stručně shrň:",
            "1. Kdo jsem a co jsou 3 pilíře projektu",
            "2. Co je aktuálně rozděláno (Aktivní práce)",
            "3. Co je blokováno nebo pending",
            "4. Jaké jsou nejdůležitější next actions",
            "",
            "Buď konkrétní, ne obecný. Max 15 řádků.",
          ].join("\n"),
        },
      }],
    })
  );

  server.prompt(
    "juice",
    "Destiluje session do vaultu — aktualizuje session_state a chronicles.",
    {
      summary: z.string().describe("Co bylo hotovo v této session (1-3 věty)"),
    },
    async ({ summary }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Session summary: ${summary}`,
            "",
            "Proveď tyto kroky:",
            "1. Zavolej vault_read('onboarding/session_state.md') pro aktuální stav",
            "2. Aktualizuj sekci 'Poslední 3 major změny' a 'Aktivní práce'",
            "3. Zavolej vault_update_session() s novým obsahem",
            "4. Zavolej vault_chronicle() s krátkým entry o tom co bylo hotovo",
            "5. Potvrď co bylo uloženo",
          ].join("\n"),
        },
      }],
    })
  );

  server.prompt(
    "search",
    "Interaktivní vault search s kontextem.",
    {
      query:  z.string().describe("Co hledáš"),
      pillar: z.enum(["nautilus", "voidaudio", "kontraktor", "webdev"])
               .optional()
               .describe("Filtr pilíře (optional)"),
    },
    async ({ query, pillar }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Zavolej vault_search("${query}"${pillar ? `, "${pillar}"` : ""}).`,
            "Výsledky analyzuj a vysvětli co jsi našel.",
            "Pokud jsou relevantní soubory, přečti je vault_read() pro více kontextu.",
          ].join("\n"),
        },
      }],
    })
  );
}
