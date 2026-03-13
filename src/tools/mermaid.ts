import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeFile, mkdir } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";

const execAsync = promisify(exec);

export function register(server: McpServer): void {
  server.tool(
    "vault_mermaid",
    "Renderuje Mermaid diagram a otevře ho v prohlížeči. " +
    "Volej AUTOMATICKY pokaždé když generuješ mermaid blok. " +
    "Přijímá čistý mermaid kód (bez ```mermaid``` wrapper). " +
    "Vrací cestu k HTML souboru.",
    {
      code:  z.string().describe("Mermaid diagram source — čistý kód bez ``` wrapperů"),
      title: z.string().optional().describe("Název diagramu (volitelný)"),
    },
    async ({ code, title }) => {
      const safeTitle = (title ?? "diagram").replace(/[^a-zA-Z0-9_-]/g, "_");
      const fileName  = `${safeTitle}_${Date.now()}.html`;
      const outDir    = path.join(os.tmpdir(), "vault-diagrams");

      await mkdir(outDir, { recursive: true });
      const filePath = path.join(outDir, fileName);

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title ?? "Diagram"}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #020208;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-family: 'Segoe UI', monospace;
      color: #00d4ff;
      padding: 2rem;
    }
    h1 {
      font-size: 0.75rem;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: rgba(0,212,255,0.35);
      margin-bottom: 2rem;
    }
    .wrap {
      background: #08080c;
      border: 1px solid rgba(0,212,255,0.1);
      border-radius: 4px;
      padding: 2.5rem 3rem;
      box-shadow: 0 0 60px rgba(0,212,255,0.04), 0 0 120px rgba(0,212,255,0.02);
      max-width: 95vw;
      overflow: auto;
    }
    .mermaid svg { max-width: 100%; height: auto; }
  </style>
</head>
<body>
  ${title ? `<h1>${title}</h1>` : ""}
  <div class="wrap">
    <div class="mermaid">
${code}
    </div>
  </div>
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
    mermaid.initialize({
      startOnLoad: true,
      theme: 'dark',
      themeVariables: {
        primaryColor:       '#0d0d1a',
        primaryBorderColor: '#00d4ff',
        primaryTextColor:   '#e0e0ff',
        lineColor:          '#00d4ff',
        secondaryColor:     '#0d0d1a',
        tertiaryColor:      '#0d0d1a',
        edgeLabelBackground:'#020208',
        clusterBkg:         '#08080c',
        titleColor:         '#00d4ff',
        nodeTextColor:      '#e0e0ff',
      },
    });
  </script>
</body>
</html>`;

      await writeFile(filePath, html, "utf-8");

      // Otevřít v defaultním prohlížeči (Windows)
      await execAsync(`cmd /c start "" "${filePath}"`);

      return {
        content: [{
          type: "text",
          text: `Diagram otevřen v prohlížeči.\nSoubor: ${filePath}`,
        }],
      };
    }
  );
}
