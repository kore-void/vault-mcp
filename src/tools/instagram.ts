import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "..", "..", "instagram", "ig_bridge.py");

const IG_USER     = process.env.IG_USER ?? "";
const IG_PASSWORD = process.env.IG_PASSWORD ?? "";

// ── Volání Python bridge ───────────────────────────────────────────────────────

function callBridge(args: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, IG_USER, IG_PASSWORD };
    const proc = spawn("python", [BRIDGE, JSON.stringify(args)], { env });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      try {
        const result = JSON.parse(stdout.trim());
        if (result.error) reject(new Error(result.error));
        else resolve(result);
      } catch {
        reject(new Error(stderr || stdout || `Exit code ${code}`));
      }
    });
  });
}

function formatResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// ── Register ──────────────────────────────────────────────────────────────────

export function register(server: McpServer): void {

  // Tool 1 — profil konkurenta
  server.tool(
    "vault_ig_profile",
    "Načte profil Instagram účtu — followers, bio, počet postů, verified status.",
    { username: z.string().describe("Instagram username bez @") },
    async ({ username }) => {
      const data = await callBridge({ cmd: "profile", username });
      const p = data as Record<string, unknown>;
      const text = [
        `## @${p.username} — Instagram profil`,
        `**Jméno:** ${p.full_name}`,
        `**Followers:** ${(p.followers as number).toLocaleString()}  |  **Following:** ${p.following}  |  **Posty:** ${p.posts}`,
        `**Verified:** ${p.is_verified ? "✓" : "—"}  |  **Soukromý:** ${p.is_private ? "Ano" : "Ne"}`,
        `**Bio:** ${p.bio || "—"}`,
        `**Web:** ${p.external_url || "—"}`,
        `**URL:** ${p.profile_url}`,
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // Tool 2 — posledni posty
  server.tool(
    "vault_ig_posts",
    "Načte posledních N postů Instagram profilu s počty liků a komentářů.",
    {
      username: z.string().describe("Instagram username bez @"),
      limit:    z.number().min(1).max(50).optional().default(12),
    },
    async ({ username, limit = 12 }) => {
      const data = await callBridge({ cmd: "posts", username, limit }) as { posts: Record<string, unknown>[] };
      const lines = [`## @${username} — posledních ${data.posts.length} postů\n`];
      for (const p of data.posts) {
        lines.push(
          `**${p.taken_at}** | ❤️ ${p.likes}  💬 ${p.comments}\n` +
          `${p.caption || "(bez popisku)"}\n${p.url}\n`
        );
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // Tool 3 — porovnání konkurence
  server.tool(
    "vault_ig_compare",
    "Porovná více Instagram účtů vedle sebe — followers, posty, engagement odhad.",
    {
      usernames: z.array(z.string()).min(2).max(10)
        .describe("Seznam Instagram usernames k porovnání"),
    },
    async ({ usernames }) => {
      const data = await callBridge({ cmd: "compare", usernames }) as { comparison: Record<string, unknown>[] };
      const sorted = data.comparison.sort((a, b) => (b.followers as number) - (a.followers as number));
      const lines = ["## Instagram — porovnání konkurence\n"];
      lines.push("| Účet | Followers | Posty | Verified | Est. engagement/post |");
      lines.push("|------|-----------|-------|----------|---------------------|");
      for (const c of sorted) {
        if (c.error) {
          lines.push(`| @${c.username} | — | — | — | Chyba: ${c.error} |`);
        } else {
          lines.push(`| @${c.username} | ${(c.followers as number).toLocaleString()} | ${c.posts} | ${c.verified ? "✓" : "—"} | ~${c.engagement_est} |`);
        }
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // Tool 4 — top posty dle engagementu
  server.tool(
    "vault_ig_top_posts",
    "Načte top posty profilu seřazené dle liků nebo engagement score. " +
    "Ideální pro analýzu co funguje konkurenci.",
    {
      username: z.string().describe("Instagram username"),
      limit:    z.number().optional().default(20).describe("Kolik postů prohledat"),
      sort_by:  z.enum(["likes", "engagement"]).optional().default("engagement"),
    },
    async ({ username, limit = 20, sort_by = "engagement" }) => {
      const data = await callBridge({ cmd: "top_posts", username, limit, sort_by }) as { top_posts: Record<string, unknown>[] };
      const lines = [`## @${username} — TOP posty (${sort_by})\n`];
      data.top_posts.forEach((p, i) => {
        lines.push(
          `**#${i + 1}** ❤️ ${p.likes}  💬 ${p.comments}  score: ${p.score}\n` +
          `${p.caption || "(bez popisku)"}\n${p.url}\n${p.taken_at}\n`
        );
      });
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // Tool 5 — hashtag analýza
  server.tool(
    "vault_ig_hashtag",
    "Načte top posty pod hashtagy relevantní pro tvou niku — kdo dominuje, co funguje.",
    {
      tag:   z.string().describe("Hashtag bez # (napr. 'fitness', 'czechfood')"),
      limit: z.number().optional().default(10),
    },
    async ({ tag, limit = 10 }) => {
      const data = await callBridge({ cmd: "hashtag", tag, limit }) as { posts: Record<string, unknown>[] };
      const lines = [`## #${tag} — top ${data.posts.length} postů\n`];
      for (const p of data.posts) {
        lines.push(
          `**@${p.author}** | ❤️ ${p.likes}  💬 ${p.comments}\n` +
          `${p.caption || "(bez popisku)"}\n${p.url}\n`
        );
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // Tool 6 — watchlist management
  server.tool(
    "vault_ig_watchlist_add",
    "Přidá Instagram účty do monitorovacího watchlistu. Použij pro sledování konkurence v dané nice.",
    {
      usernames: z.array(z.string()).min(1).max(20).describe("Seznam usernames k přidání"),
      niche:     z.string().optional().default("general").describe("Označení niky (napr. 'audio', 'music_production')"),
    },
    async ({ usernames, niche = "general" }) => {
      const data = await callBridge({ cmd: "watchlist_add", usernames, niche }) as Record<string, unknown>;
      return { content: [{ type: "text" as const, text:
        `Přidáno: ${(data.added as string[]).join(", ") || "—"}\n` +
        `Přeskočeno (již sledováno): ${(data.skipped as string[]).join(", ") || "—"}\n` +
        `Celkem ve watchlistu: ${data.total}`
      }] };
    }
  );

  server.tool(
    "vault_ig_watchlist_remove",
    "Odebere Instagram účet z watchlistu.",
    { username: z.string().describe("Username k odebrání") },
    async ({ username }) => {
      const data = await callBridge({ cmd: "watchlist_remove", username }) as Record<string, unknown>;
      return { content: [{ type: "text" as const, text:
        data.removed ? `@${username} odebrán z watchlistu. Zbývá: ${data.total}` : `@${username} nebyl ve watchlistu.`
      }] };
    }
  );

  server.tool(
    "vault_ig_watchlist_list",
    "Zobrazí aktuální watchlist — všechny sledované Instagram účty s nikami.",
    {},
    async () => {
      const data = await callBridge({ cmd: "watchlist_list" }) as { accounts: Record<string, unknown>[], total: number };
      if (!data.total) return { content: [{ type: "text" as const, text: "Watchlist je prázdný. Přidej účty přes vault_ig_watchlist_add." }] };
      const lines = [`## Instagram Watchlist (${data.total} účtů)\n`];
      const byNiche: Record<string, string[]> = {};
      for (const a of data.accounts) {
        const n = (a.niche as string) || "general";
        if (!byNiche[n]) byNiche[n] = [];
        byNiche[n].push(`@${a.username}`);
      }
      for (const [niche, accounts] of Object.entries(byNiche)) {
        lines.push(`**${niche}:** ${accounts.join("  ")}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // Tool 7 — snapshot
  server.tool(
    "vault_ig_snapshot",
    "Snapshottuje všechny watchlist účty — profil + posledních 12 postů. Výsledek se ukládá pro pozdější report.",
    {
      niche: z.string().optional().describe("Snapshottuj jen určitou niku (volitelné)"),
    },
    async ({ niche }) => {
      const args: Record<string, unknown> = { cmd: "snapshot" };
      if (niche) args.niche = niche;
      const data = await callBridge(args) as Record<string, unknown>;
      if ((data as Record<string, unknown>).error) {
        return { content: [{ type: "text" as const, text: `Chyba: ${data.error}` }] };
      }
      return { content: [{ type: "text" as const, text:
        `Snapshot uložen: ${data.snapshot_file}\n` +
        `Čas: ${data.timestamp}\n` +
        `Úspěšně: ${data.scraped} účtů  |  Chyby: ${data.errors}`
      }] };
    }
  );

  // Tool 8 — report
  server.tool(
    "vault_ig_report",
    "Porovná poslední 2 snapshoty — kdo nejvíc rostl, kdo přidal nové posty, engagement delta. " +
    "Vyžaduje alespoň 2 předchozí snapshot.",
    {},
    async () => {
      const data = await callBridge({ cmd: "report" }) as Record<string, unknown>;
      if ((data as Record<string, unknown>).error) {
        return { content: [{ type: "text" as const, text: `Chyba: ${data.error}` }] };
      }
      const topG = data.top_growers as Record<string, unknown>[];
      const mostA = data.most_active as Record<string, unknown>[];

      const lines = [
        `## Instagram Monitor Report`,
        `**Období:** ${data.period}`,
        `**Sledováno:** ${data.accounts_tracked} účtů\n`,
        `### Top 5 nejrychleji rostoucích`,
        ...topG.map(c =>
          `- **@${c.username}** +${c.follower_delta} followers (${c.follower_delta_pct}%)  |  ${c.followers?.toLocaleString()} celkem`
        ),
        `\n### Nejaktivnější (nové posty)`,
        ...mostA.map(c =>
          `- **@${c.username}** ${c.new_posts} nových postů  |  engagement delta: ${c.engagement_delta}`
        ),
      ];

      // Nové posty s detailem
      const withPosts = (data.all_changes as Record<string, unknown>[]).filter(c => (c.new_posts as number) > 0);
      if (withPosts.length) {
        lines.push(`\n### Nové posty (detail)`);
        for (const c of withPosts.slice(0, 5)) {
          const posts = c.new_posts_detail as Record<string, unknown>[];
          lines.push(`**@${c.username}:**`);
          for (const p of posts) {
            lines.push(`  ❤️ ${p.likes}  💬 ${p.comments}  ${p.url}\n  ${(p.caption as string || "").slice(0, 100)}`);
          }
        }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // Tool 9 — trending hashtags
  server.tool(
    "vault_ig_trending",
    "Analyzuje trending hashtags v dané nice — kdo dominuje, jaký content funguje, top posty.",
    {
      tags:  z.array(z.string()).min(1).max(10).describe("Seznam hashtagů k analýze (bez #)"),
      limit: z.number().optional().default(8).describe("Postů na hashtag"),
    },
    async ({ tags, limit = 8 }) => {
      const data = await callBridge({ cmd: "trending_hashtags", tags, limit }) as Record<string, unknown>;
      const topAuthors = data.top_authors as Record<string, unknown>[];
      const topPosts   = data.top_posts   as Record<string, unknown>[];

      const lines = [
        `## Trending analýza — #${(data.tags_analyzed as string[]).join(" #")}`,
        `Celkem ${data.total_posts} postů analyzováno\n`,
        `### Top autoři (napříč tagy)`,
        ...topAuthors.map((a, i) => `${i + 1}. @${a.username} — ${a.appearances}× ve výsledcích`),
        `\n### Top posty dle engagementu`,
        ...topPosts.map((p, i) =>
          `**#${i + 1}** @${p.author} | ❤️ ${p.likes}  💬 ${p.comments}  score: ${p.score}\n` +
          `#${p.hashtag}  ${p.url}\n${(p.caption as string || "").slice(0, 120)}`
        ),
      ];

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );
}
