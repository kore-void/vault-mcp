import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chromium } from "playwright-core";
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { VAULT_PATH } from "../guards/laws.js";

// Chrome path on Windows — použijeme nainstalovaný Chrome místo downloadu
const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.CHROME_PATH ?? "",
].filter(Boolean);

async function launchBrowser(headless = true) {
  const executablePath = CHROME_PATHS.find(p => p.length > 0);
  return chromium.launch({
    executablePath,
    headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
}

// ── Register ──────────────────────────────────────────────────────────────────

export function register(server: McpServer): void {

  // Tool 1 — full JS render fetch
  server.tool(
    "vault_browser_fetch",
    "Načte stránku přes Playwright (plný JS render, SPA, lazy-load). " +
    "Lepší než Jina pro stránky které vyžadují JS nebo autentizaci. " +
    "Vrací čistý text nebo HTML dle parametru.",
    {
      url:        z.string().describe("URL stránky"),
      wait_for:   z.enum(["load", "networkidle", "domcontentloaded"]).optional().default("networkidle"),
      output:     z.enum(["text", "html", "markdown"]).optional().default("text"),
      max_chars:  z.number().min(500).max(50000).optional().default(8000),
      screenshot: z.boolean().optional().default(false)
        .describe("Ulož screenshot do vault/screenshots/"),
    },
    async ({ url, wait_for = "networkidle", output = "text", max_chars = 8000, screenshot = false }) => {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.setExtraHTTPHeaders({ "Accept-Language": "cs,en;q=0.9" });
        await page.goto(url, { waitUntil: wait_for as any, timeout: 30000 });

        let content = "";
        if (output === "html") {
          content = await page.content();
        } else if (output === "markdown") {
          // Základní HTML→markdown konverze přes innerText + heading detection
          content = await page.evaluate(() => {
            const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4"))
              .map(h => ({ tag: h.tagName, text: (h as HTMLElement).innerText.trim() }));
            const body = document.body.innerText || "";
            return body;
          });
        } else {
          content = await page.evaluate(() => document.body.innerText || "");
        }
        content = content.slice(0, max_chars);

        let screenshotInfo = "";
        if (screenshot) {
          const dir = path.join(VAULT_PATH, "screenshots");
          await mkdir(dir, { recursive: true });
          const fname = `${Date.now()}-${url.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.png`;
          await page.screenshot({ path: path.join(dir, fname), fullPage: false });
          screenshotInfo = `\n\n[Screenshot: vault/screenshots/${fname}]`;
        }

        return {
          content: [{
            type: "text" as const,
            text: `## ${url}\n_Načteno přes Playwright (${output}, ${wait_for})_\n\n${content}${screenshotInfo}`,
          }],
        };
      } finally {
        await browser.close();
      }
    }
  );

  // Tool 2 — screenshot (visual analysis)
  server.tool(
    "vault_browser_screenshot",
    "Pořídí screenshot stránky. Vhodné pro vizuální analýzu, UI audit, debug layoutu. " +
    "Uloží PNG do vault/screenshots/ a vrátí cestu.",
    {
      url:       z.string().describe("URL stránky"),
      full_page: z.boolean().optional().default(false).describe("Celá stránka nebo jen viewport"),
      width:     z.number().optional().default(1280),
      height:    z.number().optional().default(800),
    },
    async ({ url, full_page = false, width = 1280, height = 800 }) => {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.setViewportSize({ width, height });
        await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

        const dir = path.join(VAULT_PATH, "screenshots");
        await mkdir(dir, { recursive: true });
        const fname = `${Date.now()}-${url.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.png`;
        const fpath = path.join(dir, fname);
        await page.screenshot({ path: fpath, fullPage: full_page });

        return {
          content: [{
            type: "text" as const,
            text: `Screenshot uložen: vault/screenshots/${fname}\nURL: ${url}\nRozměry: ${width}x${height}, fullPage: ${full_page}`,
          }],
        };
      } finally {
        await browser.close();
      }
    }
  );

  // Tool 3 — structured data extract (table, list, specific selector)
  server.tool(
    "vault_browser_extract",
    "Extrahuje strukturovaná data ze stránky pomocí CSS selektoru. " +
    "Ideální pro tabulky, seznamy, produkty, výsledky vyhledávání. " +
    "Vrací JSON array nalezených prvků.",
    {
      url:      z.string().describe("URL stránky"),
      selector: z.string().describe("CSS selektor (napr. 'table tr', '.product-card', 'h2.title')"),
      attrs:    z.array(z.string()).optional().default(["textContent"])
        .describe("Atributy k extrakci: 'textContent', 'href', 'src', 'data-*'"),
      limit:    z.number().optional().default(50),
    },
    async ({ url, selector, attrs = ["textContent"], limit = 50 }) => {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

        const data = await page.evaluate(
          ({ sel, attributes, lim }: { sel: string; attributes: string[]; lim: number }) => {
            const els = Array.from(document.querySelectorAll(sel)).slice(0, lim);
            return els.map(el => {
              const obj: Record<string, string> = {};
              for (const attr of attributes) {
                if (attr === "textContent") {
                  obj.text = (el as HTMLElement).innerText?.trim() ?? "";
                } else if (attr === "href") {
                  obj.href = (el as HTMLAnchorElement).href ?? "";
                } else if (attr === "src") {
                  obj.src = (el as HTMLImageElement).src ?? "";
                } else {
                  obj[attr] = el.getAttribute(attr) ?? "";
                }
              }
              return obj;
            });
          },
          { sel: selector, attributes: attrs, lim: limit }
        );

        return {
          content: [{
            type: "text" as const,
            text: `## Extrakce: ${selector}\nURL: ${url}\nNalezeno: ${data.length} prvků\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``,
          }],
        };
      } finally {
        await browser.close();
      }
    }
  );

  // Tool 4 — execute custom JS on page
  server.tool(
    "vault_browser_eval",
    "Spustí vlastní JavaScript na stránce po načtení. " +
    "Nejvýkonnější nástroj — může dělat cokoliv co jde v browseru. " +
    "Vrací výsledek jako JSON string.",
    {
      url:    z.string().describe("URL stránky"),
      script: z.string().describe("JS kód k spuštění — musí vracet serializovatelnou hodnotu"),
    },
    async ({ url, script }) => {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
        const result = await page.evaluate(script);
        return {
          content: [{
            type: "text" as const,
            text: `## JS Eval: ${url}\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
          }],
        };
      } finally {
        await browser.close();
      }
    }
  );
}
