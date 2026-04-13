import { homedir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";

export interface CollectOptions {
  includeCorrupted?: boolean;
  includeSubagents?: boolean;
  includeHistory?: boolean;
}

export function getConfigRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export async function collectLogFiles(
  root: string,
  opts: CollectOptions = {},
): Promise<string[]> {
  const {
    includeCorrupted = true,
    includeSubagents = true,
    includeHistory = true,
  } = opts;

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

  const seen = new Set<string>();
  for (const p of patterns) {
    const glob = new Glob(p);
    for await (const match of glob.scan({ cwd: root, absolute: true })) {
      seen.add(match);
    }
  }
  return [...seen];
}
