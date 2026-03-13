import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as tls from "node:tls";
import * as net from "node:net";

// Credentials z env
const GMAIL_USER = process.env.GMAIL_USER ?? "";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD ?? "";

// ── Minimal IMAP client ────────────────────────────────────────────────────────

class ImapClient {
  private socket!: tls.TLSSocket;
  private buffer = "";
  private seq = 1;
  private resolvers: Map<number, (lines: string[]) => void> = new Map();
  private pendingLines: string[] = [];
  private currentTag = 0;

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = tls.connect({ host: "imap.gmail.com", port: 993 }, () => {
        this.socket.on("data", (chunk) => this.onData(chunk.toString()));
        // Wait for greeting
        setTimeout(resolve, 500);
      });
      this.socket.on("error", reject);
    });
  }

  private onData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\r\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      this.pendingLines.push(line);
      // Check if this line is a tagged response
      for (const [tag, resolver] of this.resolvers) {
        if (line.startsWith(`A${tag} OK`) || line.startsWith(`A${tag} NO`) || line.startsWith(`A${tag} BAD`)) {
          const captured = [...this.pendingLines];
          this.pendingLines = [];
          this.resolvers.delete(tag);
          resolver(captured);
          break;
        }
      }
    }
  }

  async cmd(command: string): Promise<string[]> {
    const tag = this.seq++;
    return new Promise((resolve) => {
      this.resolvers.set(tag, resolve);
      this.socket.write(`A${tag} ${command}\r\n`);
    });
  }

  async login(user: string, password: string): Promise<boolean> {
    const resp = await this.cmd(`LOGIN "${user}" "${password}"`);
    return resp.some(l => l.includes("OK") && l.includes("LOGIN"));
  }

  async selectInbox(): Promise<number> {
    const resp = await this.cmd("SELECT INBOX");
    const existsLine = resp.find(l => l.includes("EXISTS"));
    return existsLine ? parseInt(existsLine.match(/\* (\d+) EXISTS/)?.[1] ?? "0") : 0;
  }

  async search(criteria: string): Promise<number[]> {
    const resp = await this.cmd(`SEARCH ${criteria}`);
    const searchLine = resp.find(l => l.startsWith("* SEARCH"));
    if (!searchLine) return [];
    return searchLine.replace("* SEARCH", "").trim().split(" ")
      .filter(Boolean).map(Number).filter(n => !isNaN(n));
  }

  async fetchHeaders(uid: number): Promise<Record<string, string>> {
    const resp = await this.cmd(`FETCH ${uid} (BODY[HEADER.FIELDS (FROM TO SUBJECT DATE)])`);
    const headers: Record<string, string> = {};
    let inBody = false;
    for (const line of resp) {
      if (line.includes("BODY[HEADER")) { inBody = true; continue; }
      if (line === ")" || line.startsWith(")")) { inBody = false; continue; }
      if (inBody && line.includes(":")) {
        const [key, ...rest] = line.split(":");
        headers[key.trim().toLowerCase()] = rest.join(":").trim();
      }
    }
    return headers;
  }

  async fetchBody(uid: number, maxBytes = 4096): Promise<string> {
    const resp = await this.cmd(`FETCH ${uid} (BODY[TEXT]<0.${maxBytes}>)`);
    let inBody = false;
    const parts: string[] = [];
    for (const line of resp) {
      if (line.includes("BODY[TEXT]")) { inBody = true; continue; }
      if (inBody && (line === ")" || line.match(/^A\d+ OK/))) break;
      if (inBody) parts.push(line);
    }
    return parts.join("\n").replace(/=\r?\n/g, "").replace(/=[0-9A-F]{2}/g, (m) =>
      String.fromCharCode(parseInt(m.slice(1), 16))
    );
  }

  async logout(): Promise<void> {
    try { await this.cmd("LOGOUT"); } catch {}
    this.socket.destroy();
  }
}

// ── Register ──────────────────────────────────────────────────────────────────

export function register(server: McpServer): void {

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    // Register placeholder tools that explain the missing config
    server.tool(
      "vault_gmail_search",
      "Prohledá Gmail. Vyžaduje GMAIL_USER a GMAIL_APP_PASSWORD env vars.",
      { query: z.string() },
      async () => ({ content: [{ type: "text" as const, text: "Nastavte GMAIL_USER a GMAIL_APP_PASSWORD v MCP server env vars." }] })
    );
    return;
  }

  // Tool 1 — search emails
  server.tool(
    "vault_gmail_search",
    "Prohledá Gmail schránku. Vrátí seznam emailů odpovídajících dotazu. " +
    "Podporuje: 'from:xxx', 'subject:xxx', 'after:2024/01/01', 'is:unread', kombinace.",
    {
      query:  z.string().describe("Gmail search query — stejná syntaxe jako v Gmail UI"),
      limit:  z.number().min(1).max(50).optional().default(10),
    },
    async ({ query, limit = 10 }) => {
      const imap = new ImapClient();
      try {
        await imap.connect();
        const ok = await imap.login(GMAIL_USER, GMAIL_APP_PASSWORD);
        if (!ok) throw new Error("Login selhal — zkontroluj GMAIL_APP_PASSWORD");

        await imap.selectInbox();
        // Convert Gmail-style query to IMAP search (basic)
        let imapCriteria = "ALL";
        if (query.startsWith("from:")) imapCriteria = `FROM "${query.slice(5)}"`;
        else if (query.startsWith("subject:")) imapCriteria = `SUBJECT "${query.slice(8)}"`;
        else if (query.includes("is:unread")) imapCriteria = "UNSEEN";
        else imapCriteria = `TEXT "${query}"`;

        const uids = (await imap.search(imapCriteria)).slice(-limit).reverse();
        if (uids.length === 0) return { content: [{ type: "text" as const, text: "Žádné emaily nenalezeny." }] };

        const results: string[] = [`## Gmail search: "${query}"\nNalezeno: ${uids.length} emailů\n`];
        for (const uid of uids) {
          const h = await imap.fetchHeaders(uid);
          results.push(`**#${uid}** | Od: ${h.from ?? "?"} | ${h.subject ?? "(bez předmětu)"} | ${h.date ?? ""}`);
        }
        return { content: [{ type: "text" as const, text: results.join("\n") }] };
      } finally {
        await imap.logout();
      }
    }
  );

  // Tool 2 — read email body
  server.tool(
    "vault_gmail_read",
    "Přečte tělo konkrétního emailu podle UID (z vault_gmail_search).",
    {
      uid:       z.number().describe("Email UID z výsledků vault_gmail_search"),
      max_chars: z.number().optional().default(3000),
    },
    async ({ uid, max_chars = 3000 }) => {
      const imap = new ImapClient();
      try {
        await imap.connect();
        await imap.login(GMAIL_USER, GMAIL_APP_PASSWORD);
        await imap.selectInbox();
        const headers = await imap.fetchHeaders(uid);
        const body = await imap.fetchBody(uid, max_chars);
        const text = [
          `## Email #${uid}`,
          `**Od:** ${headers.from ?? "?"}`,
          `**Předmět:** ${headers.subject ?? "(bez předmětu)"}`,
          `**Datum:** ${headers.date ?? "?"}`,
          `---`,
          body.slice(0, max_chars),
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      } finally {
        await imap.logout();
      }
    }
  );
}
