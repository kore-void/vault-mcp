# vault-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that connects Claude Code (or any MCP client) to a local markdown knowledge vault.

Your vault is a directory of `.md` files — project docs, knowledge crystals, session state, chronicles. `vault-mcp` exposes it as structured tools so AI agents can read, search, and write to it with guardrails.

## Features

- **`vault_context`** — Load `AGENTS.md` + `session_state.md` in one call (L0 onboarding)
- **`vault_read`** — Read any `.md` file by relative path
- **`vault_search`** — Full-text search across all markdown files, with optional pillar filter
- **`vault_list`** — List files with frontmatter metadata (title, status, updated)
- **`vault_update_session`** — Overwrite `onboarding/session_state.md`
- **`vault_chronicle`** — Append an entry to the current month's chronicle log
- **`vault_memory`** — Overwrite files in `memory/` directory

### Built-in Guards

| Guard | Rule |
|-------|------|
| **ZÁKON II** — Immutability | Only `chronicles/`, `memory/`, `onboarding/session_state.md` are writable |
| **ZÁKON III** — Frontmatter | Write operations require valid YAML frontmatter |
| **ZÁKON IV** — Line limit | Max 100 lines per doc (exceptions: `chronicles/`, `memory/`) |
| **ZÁKON X** — No secrets | Blocks writes containing passwords, tokens, JWTs, API keys |

## Prerequisites

- Node.js 18+
- Claude Code (or any MCP-compatible client)

## Installation

```bash
git clone https://github.com/kore-void/vault-mcp.git
cd vault-mcp
npm install
npm run build
```

## Vault Structure

Your vault directory needs at minimum:

```
vault/
├── AGENTS.md                    # Identity + project context (used by vault_context)
├── LAWS.md                      # Governance rules
├── INDEX.md                     # Navigation map
├── onboarding/
│   └── session_state.md         # Active work state (used by vault_context)
├── chronicles/
│   └── YYYY-MM.md               # Monthly dev logs (appended by vault_chronicle)
└── memory/                      # Persistent agent memory files
```

> `AGENTS.md` and `onboarding/session_state.md` are required for `vault_context` to work.

## Configuration

By default, vault-mcp looks for your vault at `C:\CODE\vault`.

Override with the `VAULT_PATH` environment variable:

```bash
VAULT_PATH=/path/to/your/vault node dist/index.js
```

## Register with Claude Code

```bash
# Default vault path (C:\CODE\vault)
claude mcp add vault node /path/to/vault-mcp/dist/index.js

# Custom vault path
claude mcp add vault \
  --env VAULT_PATH=/path/to/your/vault \
  node /path/to/vault-mcp/dist/index.js
```

Verify:

```bash
claude mcp list
# vault: node /path/to/vault-mcp/dist/index.js - ✓ Connected
```

## MCP Prompts (slash commands in Claude Code)

| Command | Description |
|---------|-------------|
| `/mcp__vault__onboard` | Load vault context for a new session |
| `/mcp__vault__juice` | Save session summary to vault (session_state + chronicle) |
| `/mcp__vault__search` | Interactive vault search with context |

## Usage with Claude Code

Add to your `CLAUDE.md`:

```markdown
## Vault — Primary Source of Truth

MCP server "vault" is always available — use its tools as a knowledge base.

**Session start:** Call `vault_context()` — returns AGENTS.md + session_state in 1 call.
**During work:** `vault_search(query)` before any assumption. Never guess what you know.
**Session end:** `vault_update_session()` + `vault_chronicle()` to save the session.
```

## Development

```bash
npm run dev    # Run with tsx (no build needed)
npm run build  # Compile TypeScript → dist/
npm start      # Run compiled dist/index.js
```

## License

MIT — see [LICENSE](LICENSE)
