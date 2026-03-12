import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VAULT_PATH } from "../guards/laws.js";

const PILLAR_DIRS: Record<string, string[]> = {
  nautilus:   ["projects/nautilus", "knowledge/nautilus"],
  voidaudio:  ["projects/voidaudio", "knowledge/voidaudio"],
  kontraktor: ["projects/kontraktor", "knowledge/webdev"],
  webdev:     ["projects/kontraktor", "knowledge/webdev"],
};

const SKIP_DIRS = [".git", ".obsidian", "node_modules", "archive"];

async function walkMd(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return results; }
  await Promise.all(entries.map(async (e) => {
    if (e.isDirectory() && !SKIP_DIRS.includes(e.name)) {
      results.push(...await walkMd(path.join(dir, e.name)));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      results.push(path.join(dir, e.name));
    }
  }));
  return results;
}

export function register(server: McpServer): void {
  server.tool(
    "vault_search",
    "Prohledá vault full-text. Vrátí úryvky s čísly řádků. Volitelně filtruj dle pilíře.",
    {
      query:  z.string().describe("Hledaný výraz (case-insensitive)"),
      pillar: z.enum(["nautilus", "voidaudio", "kontraktor", "webdev"])
               .optional()
               .describe("Filtr dle pilíře projektu"),
    },
    async ({ query, pillar }) => {
      const allFiles = await walkMd(VAULT_PATH);
      const q = query.toLowerCase();
      let files = allFiles;
      if (pillar && PILLAR_DIRS[pillar]) {
        const dirs = PILLAR_DIRS[pillar].map(d => path.join(VAULT_PATH, d));
        files = allFiles.filter(f => dirs.some(d => f.startsWith(d)));
      }
      const results: string[] = [];
      await Promise.all(files.map(async (abs) => {
        if (results.length >= 20) return;
        try {
          const content = await readFile(abs, "utf-8");
          const lines = content.split("\n");
          const rel = path.relative(VAULT_PATH, abs).replace(/\\/g, "/");
          lines.forEach((line, i) => {
            if (results.length >= 20) return;
            if (line.toLowerCase().includes(q)) {
              const ctx = lines.slice(Math.max(0, i - 1), i + 3).join("\n");
              results.push(`### ${rel}:${i + 1}\n\`\`\`\n${ctx}\n\`\`\``);
            }
          });
        } catch { /* přeskočit nepřístupné */ }
      }));
      const out = results.length > 0
        ? `Nalezeno ${results.length} výsledků pro "${query}":\n\n` + results.join("\n\n")
        : `Nenalezeno nic pro "${query}"${pillar ? ` v pilíři ${pillar}` : ""}.`;
      return { content: [{ type: "text" as const, text: out }] };
    }
  );
}
