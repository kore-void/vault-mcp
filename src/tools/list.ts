import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VAULT_PATH } from "../guards/laws.js";

const SKIP_DIRS = [".git", ".obsidian", "node_modules", "archive"];

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    if (key) fm[key] = val;
  }
  return fm;
}

const PILLAR_ROOTS: Record<string, string> = {
  nautilus:   "projects/nautilus",
  voidaudio:  "projects/voidaudio",
  kontraktor: "projects/kontraktor",
  knowledge:  "knowledge",
  experts:    "experts",
  chronicles: "chronicles",
};

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
    "vault_list",
    "Vypíše docs z vaultu s frontmatter metadaty. Bez filtru vrátí root + projects overview.",
    {
      pillar: z.enum(["nautilus", "voidaudio", "kontraktor", "knowledge", "experts", "chronicles"])
               .optional()
               .describe("Filtr sekce vaultu"),
    },
    async ({ pillar }) => {
      const root = pillar
        ? path.join(VAULT_PATH, PILLAR_ROOTS[pillar])
        : VAULT_PATH;
      const files = await walkMd(root);
      const rows: string[] = ["| Soubor | Titul | Status | Updated |", "|--------|-------|--------|---------|"];
      await Promise.all(files.slice(0, 60).map(async (abs) => {
        try {
          const content = await readFile(abs, "utf-8");
          const fm = parseFrontmatter(content);
          const rel = path.relative(VAULT_PATH, abs).replace(/\\/g, "/");
          rows.push(`| ${rel} | ${fm.title ?? "—"} | ${fm.status ?? "—"} | ${fm.updated ?? "—"} |`);
        } catch { /* přeskočit */ }
      }));
      const out = `## Vault docs${pillar ? ` — ${pillar}` : ""} (${files.length} souborů)\n\n` + rows.join("\n");
      return { content: [{ type: "text" as const, text: out }] };
    }
  );
}
