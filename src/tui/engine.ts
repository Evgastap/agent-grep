import {
  parseEntry,
  type HistoryEntry,
  type Role,
  type SessionEntry,
  type Source,
} from "../parse.ts";
import { streamMatches } from "../search.ts";
import { sourceOfPath } from "../paths.ts";
import {
  buildCodexSessionIndex,
  getCodexContext,
  resolveCodexRoot,
} from "../codex-meta.ts";
import {
  compileRegex,
  passesFilters,
  type Filters,
} from "../filters.ts";

export interface SessionMatch {
  timestamp: Date | null;
  role: Role;
  text: string;
  isSidechain: boolean;
}

export interface SessionGroupRow {
  kind: "session";
  key: string;
  source: Source;
  sessionId: string;
  project: string;
  gitBranch?: string;
  matchCount: number;
  firstMatchTime: Date | null;
  lastMatchTime: Date | null;
  matches: SessionMatch[];
}

export interface HistoryRow {
  kind: "history";
  key: string;
  entry: HistoryEntry;
}

export type ResultRow = SessionGroupRow | HistoryRow;

const MAX_MATCHES_PER_GROUP = 25;

export interface SearchParams {
  query: string;
  files: string[];
  ignoreCase: boolean;
  fixed: boolean;
  filters: Filters;
  sourceFilter?: Source | null;
  signal: AbortSignal;
  maxRawMatches?: number;
  onBatch: (rows: ResultRow[]) => void;
}

export async function runSearch(opts: SearchParams): Promise<{
  total: number;
  truncated: boolean;
}> {
  const maxRaw = opts.maxRawMatches ?? 5000;

  let regex: RegExp;
  try {
    regex = compileRegex(opts.query, {
      ignoreCase: opts.ignoreCase,
      fixed: opts.fixed,
    });
  } catch {
    return { total: 0, truncated: false };
  }

  const scopedFiles = scopeFilesByProject(opts.files, opts.filters.project);
  buildCodexSessionIndex(scopedFiles);

  const groups = new Map<string, SessionGroupRow>();
  const historyRows: HistoryRow[] = [];
  let rawCount = 0;
  let truncated = false;
  let dirty = false;

  const snapshot = (): ResultRow[] => {
    const rows: ResultRow[] = [...groups.values(), ...historyRows];
    rows.sort((a, b) => rowTime(b) - rowTime(a));
    return rows;
  };

  const flushTimer = setInterval(() => {
    if (dirty) {
      opts.onBatch(snapshot());
      dirty = false;
    }
  }, 50);

  try {
    for await (const raw of streamMatches({
      query: opts.query,
      files: scopedFiles,
      caseInsensitive: opts.ignoreCase,
      fixedStrings: opts.fixed,
      signal: opts.signal,
    })) {
      if (opts.signal.aborted) break;

      const source = sourceOfPath(raw.filePath);
      if (opts.sourceFilter && opts.sourceFilter !== source) continue;

      let ctx = undefined;
      if (source === "codex") {
        const fileCtx = await getCodexContext(raw.filePath);
        if (opts.signal.aborted) break;
        ctx = await resolveCodexRoot(fileCtx);
      }
      if (opts.signal.aborted) break;

      const entry = parseEntry(raw.rawLine, source, ctx);
      if (!entry) continue;
      if (!passesFilters(entry, regex, opts.filters)) continue;

      rawCount++;
      if (entry.kind === "history") {
        historyRows.push({
          kind: "history",
          key: `history:${source}:${raw.filePath}:${rawCount}`,
          entry,
        });
      } else {
        upsertSessionMatch(groups, entry);
      }

      dirty = true;
      if (rawCount >= maxRaw) {
        truncated = true;
        break;
      }
    }
  } finally {
    clearInterval(flushTimer);
    if (!opts.signal.aborted) {
      opts.onBatch(snapshot());
    }
  }

  return { total: rawCount, truncated };
}

function upsertSessionMatch(
  groups: Map<string, SessionGroupRow>,
  entry: SessionEntry,
): void {
  const key = `session:${entry.source}:${entry.sessionId}`;
  let group = groups.get(key);
  if (!group) {
    group = {
      kind: "session",
      key,
      source: entry.source,
      sessionId: entry.sessionId,
      project: entry.project,
      gitBranch: entry.gitBranch,
      matchCount: 0,
      firstMatchTime: null,
      lastMatchTime: null,
      matches: [],
    };
    groups.set(key, group);
  }

  group.matchCount++;
  if (!group.project && entry.project) group.project = entry.project;
  if (!group.gitBranch && entry.gitBranch) group.gitBranch = entry.gitBranch;

  const ts = entry.timestamp;
  if (ts) {
    const t = ts.getTime();
    if (!group.firstMatchTime || t < group.firstMatchTime.getTime()) {
      group.firstMatchTime = ts;
    }
    if (!group.lastMatchTime || t > group.lastMatchTime.getTime()) {
      group.lastMatchTime = ts;
    }
  }

  const match: SessionMatch = {
    timestamp: ts,
    role: entry.role,
    text: entry.text,
    isSidechain: entry.isSidechain,
  };

  // Keep matches newest-first, cap the list.
  if (group.matches.length === 0) {
    group.matches.push(match);
  } else {
    const headTime = group.matches[0]?.timestamp?.getTime() ?? 0;
    const mTime = ts?.getTime() ?? 0;
    if (mTime >= headTime) {
      group.matches.unshift(match);
    } else {
      // Insert in sorted position (small lists — linear is fine).
      let inserted = false;
      for (let i = 0; i < group.matches.length; i++) {
        const existing = group.matches[i]?.timestamp?.getTime() ?? 0;
        if (mTime >= existing) {
          group.matches.splice(i, 0, match);
          inserted = true;
          break;
        }
      }
      if (!inserted) group.matches.push(match);
    }
  }
  if (group.matches.length > MAX_MATCHES_PER_GROUP) {
    group.matches.length = MAX_MATCHES_PER_GROUP;
  }
}

function rowTime(row: ResultRow): number {
  if (row.kind === "session") {
    return row.lastMatchTime ? row.lastMatchTime.getTime() : 0;
  }
  return row.entry.timestamp ? row.entry.timestamp.getTime() : 0;
}

// Claude Code file paths embed a dash-encoded form of the project directory,
// e.g. ~/.claude/projects/-Users-evgeny-Documents-code-agent-grep/....jsonl.
// When the user restricts by project, drop claude-code files whose encoded
// path can't possibly match the needle — this cuts ripgrep's input from
// thousands of files to a handful. Codex files don't encode the project in
// the path, so we leave them alone and let passesFilters sort them out.
function scopeFilesByProject(
  files: string[],
  project: string | undefined,
): string[] {
  if (!project) return files;
  const needle = project.toLowerCase();
  const dashNeedle = needle.replace(/\//g, "-");
  return files.filter((f) => {
    const lower = f.toLowerCase();
    if (lower.includes("/.codex/")) return true;
    return lower.includes(dashNeedle) || lower.includes(needle);
  });
}
