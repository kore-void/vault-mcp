import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import * as contextTool   from "./tools/context.js";
import * as readTool      from "./tools/read.js";
import * as searchTool    from "./tools/search.js";
import * as listTool      from "./tools/list.js";
import * as writeTool     from "./tools/write.js";
import * as staticRes     from "./resources/static.js";
import * as skillPrompts  from "./prompts/skills.js";
import { VAULT_PATH }     from "./guards/laws.js";

const server = new McpServer({
  name:    "vault",
  version: "1.0.0",
});

// Tools — model-controlled
contextTool.register(server);
readTool.register(server);
searchTool.register(server);
listTool.register(server);
writeTool.register(server);

// Resources — application-driven
staticRes.register(server);

// Prompts — user-controlled (slash commandy v Claude Code)
skillPrompts.register(server);

const transport = new StdioServerTransport();

process.stderr.write(`[vault-mcp] Starting. VAULT_PATH=${VAULT_PATH}\n`);

await server.connect(transport);
