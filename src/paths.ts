import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Source } from "./parse.ts";

export interface CollectOptions {
  claudeCode?: boolean;
  codex?: boolean;
  includeCorrupted?: boolean;
  includeSubagents?: boolean;
  includeHistory?: boolean;
}

export function getClaudeRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export function getCodexRoot(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function getConfigRoot(): string {
  return getClaudeRoot();
}

export function sourceOfPath(filePath: string): Source {
  const codexRoot = getCodexRoot();
  return filePath.startsWith(codexRoot + "/") || filePath === codexRoot
    ? "codex"
    : "claude-code";
}

const CODEX_PATTERNS = [
  "sessions/*/*/*/rollout-*.jsonl",
  "archived_sessions/rollout-*.jsonl",
];

export async function collectLogFiles(
  opts: CollectOptions = {},
): Promise<string[]> {
  const {
    claudeCode = true,
    codex = true,
    includeCorrupted = true,
    includeSubagents = true,
    includeHistory = true,
  } = opts;

  const seen = new Set<string>();

  if (claudeCode) {
    const root = getClaudeRoot();
    const patterns: string[] = [];
    if (includeHistory) patterns.push("history.jsonl");
    patterns.push("projects/*/*.jsonl");
    if (includeSubagents) patterns.push("projects/*/*/subagents/*.jsonl");
    if (includeCorrupted) {
      patterns.push("corrupted-sessions-backup/*/*.jsonl");
      if (includeSubagents) {
        patterns.push("corrupted-sessions-backup/*/*/subagents/*.jsonl");
      }
    }
    await scanPatterns(root, patterns, seen);
  }

  if (codex) {
    const root = getCodexRoot();
    const patterns = [...CODEX_PATTERNS];
    if (includeHistory) patterns.push("history.jsonl");
    await scanPatterns(root, patterns, seen);
  }

  return [...seen];
}

async function scanPatterns(
  root: string,
  patterns: string[],
  into: Set<string>,
): Promise<void> {
  for (const p of patterns) {
    try {
      await walkPattern(root, p.split("/"), into);
    } catch {
      // Root may not exist (e.g. no codex installed); skip silently.
    }
  }
}

async function walkPattern(
  base: string,
  segments: string[],
  into: Set<string>,
): Promise<void> {
  if (segments.length === 0) return;
  const head = segments[0]!;
  const rest = segments.slice(1);
  const isLeaf = rest.length === 0;

  if (!head.includes("*")) {
    const next = join(base, head);
    if (isLeaf) {
      try {
        await access(next);
        into.add(next);
      } catch {}
      return;
    }
    await walkPattern(next, rest, into);
    return;
  }

  const regex = segmentToRegex(head);
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!regex.test(entry.name)) continue;
    const next = join(base, entry.name);
    if (isLeaf) {
      if (entry.isFile()) into.add(next);
    } else if (entry.isDirectory()) {
      await walkPattern(next, rest, into);
    }
  }
}

function segmentToRegex(seg: string): RegExp {
  const escaped = seg
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}
