import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { VAULT_PATH } from "../guards/laws.js";

const TAVILY_KEY = process.env.TAVILY_API_KEY ?? "";

// ── Types ─────────────────────────────────────────────────────────

interface Paper {
  title:    string;
  authors:  string;
  year:     string;
  url:      string;
  abstract: string;
  doi?:     string;
}

interface SearchResult {
  title:   string;
  url:     string;
  snippet: string;
  score?:  number;
}

// ── Tavily Search API ─────────────────────────────────────────────

async function tavilySearch(query: string, maxResults = 8, searchDepth: "basic" | "advanced" = "basic"): Promise<SearchResult[]> {
  if (!TAVILY_KEY) throw new Error("TAVILY_API_KEY není nastaven");
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key:      TAVILY_KEY,
      query,
      max_results:  maxResults,
      search_depth: searchDepth,
      include_answer: false,
      include_raw_content: false,
    }),
  });
  if (!resp.ok) throw new Error(`Tavily ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { results?: Array<{ title: string; url: string; content: string; score: number }> };
  return (data.results ?? []).map(r => ({
    title:   r.title,
    url:     r.url,
    snippet: r.content?.slice(0, 300) ?? "",
    score:   r.score,
  }));
}

// ── Jina Reader — libovolná stránka jako markdown (free) ──────────

async function jinaFetch(url: string, maxChars = 12000): Promise<string> {
  const resp = await fetch(`https://r.jina.ai/${url}`, {
    headers: {
      "Accept":          "text/markdown",
      "X-Return-Format": "markdown",
      "User-Agent":      "vault-mcp/1.0",
    },
  });
  if (!resp.ok) throw new Error(`Jina ${resp.status} for ${url}`);
  return (await resp.text()).slice(0, maxChars);
}

// ── arXiv (free) ─────────────────────────────────────────────────

async function arxivSearch(query: string, n: number): Promise<Paper[]> {
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=${n}&sortBy=relevance`;
  const xml  = await (await fetch(url, { headers: { "User-Agent": "vault-mcp/1.0" } })).text();
  const papers: Paper[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e       = m[1];
    const title   = e.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim().replace(/\s+/g, " ") ?? "";
    const id      = e.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() ?? "";
    const year    = e.match(/<published>(\d{4})/)?.[1] ?? "";
    const abs     = e.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim().replace(/\s+/g, " ").slice(0, 350) ?? "";
    const authors = [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)]
      .slice(0, 3).map(a => a[1].trim()).join(", ");
    if (title) papers.push({ title, authors, year, url: id, abstract: abs });
  }
  return papers;
}

// ── Semantic Scholar (free) ───────────────────────────────────────

async function s2Search(query: string, n: number): Promise<Paper[]> {
  const url  = `https://api.semanticscholar.org/graph/v1/paper/search` +
    `?query=${encodeURIComponent(query)}&limit=${n}` +
    `&fields=title,authors,year,externalIds,abstract,url`;
  const resp = await fetch(url, { headers: { "User-Agent": "vault-mcp/1.0" } });
  if (!resp.ok) throw new Error(`S2 ${resp.status}`);
  const data = await resp.json() as { data?: any[] };
  return (data.data ?? []).map((p): Paper => ({
    title:    p.title ?? "",
    authors:  (p.authors ?? []).slice(0, 3).map((a: any) => a.name).join(", "),
    year:     String(p.year ?? ""),
    doi:      p.externalIds?.DOI,
    url:      p.url ?? "",
    abstract: (p.abstract ?? "").slice(0, 350),
  }));
}

// ── Format ────────────────────────────────────────────────────────

function formatPapers(papers: Paper[]): string {
  return papers.map(p =>
    `**${p.title}** (${p.year}) — ${p.authors}\n` +
    `${p.doi ? `DOI: https://doi.org/${p.doi}` : p.url}\n` +
    `> ${p.abstract}`
  ).join("\n\n");
}

// ── Register ──────────────────────────────────────────────────────

export function register(server: McpServer): void {

  // Tool 1 — Tavily web search + academic DB
  server.tool(
    "vault_web_search",
    "Prohledá web přes Tavily Search API + akademické DB (Semantic Scholar + arXiv). " +
    "sources='web' = Tavily, 'academic' = S2+arXiv, 'all' = obojí.",
    {
      query:   z.string().describe("Vyhledávací dotaz"),
      sources: z.enum(["web", "academic", "all"]).optional().default("all"),
      depth:   z.enum(["basic", "advanced"]).optional().default("basic")
               .describe("basic = rychlé, advanced = hlubší (více tokenů)"),
    },
    async ({ query, sources = "all", depth = "basic" }) => {
      const parts: string[] = [`## Search: "${query}"\n`];

      if (sources === "web" || sources === "all") {
        const results = await tavilySearch(query, 8, depth).catch((e: Error) => {
          parts.push(`### Web\n_Tavily error: ${e.message}_`);
          return [] as SearchResult[];
        });
        if (results.length > 0) {
          parts.push("### Web (Tavily)\n" +
            results.map((r, i) =>
              `${i + 1}. **${r.title}**${r.score ? ` [score: ${r.score.toFixed(2)}]` : ""}\n   ${r.url}\n   ${r.snippet}`
            ).join("\n\n")
          );
        }
      }

      if (sources === "academic" || sources === "all") {
        const [ss, ax] = await Promise.allSettled([
          s2Search(query, 6),
          arxivSearch(`all:${query}`, 6),
        ]);
        const ssPapers = ss.status === "fulfilled" ? ss.value : [];
        const axPapers = ax.status === "fulfilled" ? ax.value : [];
        if (ssPapers.length > 0) parts.push("### Semantic Scholar\n" + formatPapers(ssPapers));
        if (axPapers.length > 0) parts.push("### arXiv\n" + formatPapers(axPapers));
        if (ssPapers.length === 0 && axPapers.length === 0)
          parts.push("### Academic\n_Zadne vysledky_");
      }

      return { content: [{ type: "text" as const, text: parts.join("\n\n") }] };
    }
  );

  // Tool 2 — Jina Reader (free, no key)
  server.tool(
    "vault_fetch_page",
    "Nacte plny obsah webove stranky jako markdown pres Jina Reader (r.jina.ai). " +
    "Funguje pro JS-heavy stranky, arXiv papery, Wikipedia, news. Zdarma.",
    {
      url:       z.string().describe("URL stranky nebo PDF"),
      max_chars: z.number().min(500).max(12000).optional().default(6000),
    },
    async ({ url, max_chars = 6000 }) => {
      const content = await jinaFetch(url, max_chars);
      return { content: [{ type: "text" as const, text: `## ${url}\n\n${content}` }] };
    }
  );

  // Tool 3 — academic papers with domain filter
  server.tool(
    "vault_search_papers",
    "Hleda akademicke papery na arXiv + Semantic Scholar s DOI/URL pro citacni chain.",
    {
      query:  z.string().describe("Vyzkumny dotaz"),
      domain: z.enum(["ai", "neuroscience", "psychology", "physics", "biology", "all"])
               .optional().default("all"),
      limit:  z.number().min(1).max(20).optional().default(8),
    },
    async ({ query, domain = "all", limit = 8 }) => {
      const catMap: Record<string, string> = {
        ai: "cs.AI", neuroscience: "q-bio.NC", psychology: "q-bio.NC",
        physics: "physics", biology: "q-bio", all: "",
      };
      const cat     = catMap[domain] ?? "";
      const axQuery = cat ? `cat:${cat}+AND+all:${encodeURIComponent(query)}` : `all:${encodeURIComponent(query)}`;
      const [ssR, axR] = await Promise.allSettled([
        s2Search(query, limit),
        arxivSearch(axQuery, limit),
      ]);
      const ss = ssR.status === "fulfilled" ? ssR.value : [];
      const ax = axR.status === "fulfilled" ? axR.value : [];
      const parts = [`## Papers: "${query}" [${domain}]\n`];
      if (ss.length > 0) parts.push("### Semantic Scholar\n" + formatPapers(ss));
      if (ax.length > 0) parts.push("### arXiv\n" + formatPapers(ax));
      if (ss.length === 0 && ax.length === 0) parts.push("_Zadne vysledky_");
      return { content: [{ type: "text" as const, text: parts.join("\n\n") }] };
    }
  );

  // Tool 4 — save to vault/knowledge/
  server.tool(
    "vault_save_research",
    "Ulozi research findings do vault/knowledge/{domain}/{filename}.md s auto-frontmatter.",
    {
      domain:   z.string().describe("Subdomena (napr. 'xenology', 'ai', 'theology')"),
      filename: z.string().describe("Nazev souboru bez .md"),
      content:  z.string().describe("Obsah v markdown"),
      tags:     z.array(z.string()).optional().default([]),
    },
    async ({ domain, filename, content, tags = [] }) => {
      const safeDomain   = domain.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
      const safeFilename = filename.replace(/[^a-z0-9_-]/gi, "_").toLowerCase() + ".md";
      const dir          = path.join(VAULT_PATH, "knowledge", safeDomain);
      const abs          = path.join(dir, safeFilename);
      const now          = new Date().toISOString().split("T")[0];
      const full = content.startsWith("---")
        ? content
        : `---\ntitle: "${filename}"\ncreated: ${now}\nupdated: ${now}\nstatus: active\ntags: [${["research", safeDomain, ...tags].join(", ")}]\n---\n\n${content}`;
      await mkdir(dir, { recursive: true });
      await writeFile(abs, full, "utf-8");
      return { content: [{ type: "text" as const, text: `Ulozeno: knowledge/${safeDomain}/${safeFilename}` }] };
    }
  );
}
