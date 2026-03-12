import path from "node:path";

export const VAULT_PATH = (process.env.VAULT_PATH ?? "C:\\CODE\\vault").replace(/\\/g, "/");

// ZÁKON II — pouze tyto cesty jsou zapisovatelné
const MUTABLE_PREFIXES = [
  "onboarding/session_state.md",
  "chronicles/",
  "memory/",
];

// ZÁKON X — detekce secrets
const SECRET_PATTERNS = [
  /(?:password|passwd|secret|token|api_key)\s*[:=]\s*\S{8,}/i,
  /eyJ[A-Za-z0-9+/]{20,}/,   // JWT
  /sk-[A-Za-z0-9]{20,}/,     // API key pattern
];

// ZÁKON IV — výjimky z limitu 100 řádků
const LINE_LIMIT_EXCEPTIONS = ["chronicles/", "memory/"];

export function resolveSafePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\//, "");
  const abs = path.resolve(VAULT_PATH, normalized);
  const vaultAbs = path.resolve(VAULT_PATH);
  if (!abs.startsWith(vaultAbs + path.sep) && abs !== vaultAbs) {
    throw new Error(`Path traversal blocked: ${relativePath}`);
  }
  return abs;
}

export function assertWritable(relativePath: string): void {
  const norm = relativePath.replace(/\\/g, "/").replace(/^\//, "");
  const allowed = MUTABLE_PREFIXES.some(p => norm === p || norm.startsWith(p));
  if (!allowed) {
    throw new Error(
      `ZÁKON II — write blocked: "${relativePath}" je immutable.\n` +
      `Zapisovatelné cesty: ${MUTABLE_PREFIXES.join(", ")}`
    );
  }
}

export function validateFrontmatter(content: string): void {
  if (!/^---\n[\s\S]*?\n---/.test(content)) {
    throw new Error(
      "ZÁKON III — chybí YAML frontmatter.\n" +
      "Každý .md soubor musí začínat: ---\\ntitle: ...\\ncreated: ...\\n---"
    );
  }
}

export function scanForSecrets(content: string): void {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      throw new Error("ZÁKON X — detekován možný secret. Vault nikdy neukládá credentials.");
    }
  }
}

export function validateLineCount(content: string, relativePath: string): void {
  const norm = relativePath.replace(/\\/g, "/");
  const isException = LINE_LIMIT_EXCEPTIONS.some(p => norm.startsWith(p));
  const lines = content.split("\n").length;
  if (!isException && lines > 100) {
    throw new Error(
      `ZÁKON IV — ${lines} řádků překračuje limit 100 pro "${relativePath}".\n` +
      "Rozděl na card-files a zachovej linky."
    );
  }
}
