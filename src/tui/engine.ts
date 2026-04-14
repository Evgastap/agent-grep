import { parseEntry, type LogEntry, type Source } from "../parse.ts";
import { streamMatches } from "../search.ts";
import { sourceOfPath } from "../paths.ts";
import { getCodexContext } from "../codex-meta.ts";
import {
  compileRegex,
  passesFilters,
  type Filters,
} from "../filters.ts";

export interface SearchParams {
  query: string;
  files: string[];
  ignoreCase: boolean;
  fixed: boolean;
  filters: Filters;
  sourceFilter?: Source | null;
  signal: AbortSignal;
  maxResults?: number;
  onBatch: (results: LogEntry[]) => void;
}

export async function runSearch(opts: SearchParams): Promise<{
  total: number;
  truncated: boolean;
}> {
  const max = opts.maxResults ?? 500;

  let regex: RegExp;
  try {
    regex = compileRegex(opts.query, {
      ignoreCase: opts.ignoreCase,
      fixed: opts.fixed,
    });
  } catch {
    return { total: 0, truncated: false };
  }

  const results: LogEntry[] = [];
  let dirty = false;
  let truncated = false;

  const flushTimer = setInterval(() => {
    if (dirty) {
      opts.onBatch(results.slice());
      dirty = false;
    }
  }, 40);

  try {
    for await (const raw of streamMatches({
      query: opts.query,
      files: opts.files,
      caseInsensitive: opts.ignoreCase,
      fixedStrings: opts.fixed,
      signal: opts.signal,
    })) {
      if (opts.signal.aborted) break;

      const source = sourceOfPath(raw.filePath);
      if (opts.sourceFilter && opts.sourceFilter !== source) continue;

      const ctx =
        source === "codex" ? await getCodexContext(raw.filePath) : undefined;
      if (opts.signal.aborted) break;

      const entry = parseEntry(raw.rawLine, source, ctx);
      if (!entry) continue;
      if (!passesFilters(entry, regex, opts.filters)) continue;

      results.push(entry);
      dirty = true;
      if (results.length >= max) {
        truncated = true;
        break;
      }
    }
  } finally {
    clearInterval(flushTimer);
    if (!opts.signal.aborted) {
      results.sort((a, b) => {
        const ta = a.timestamp ? a.timestamp.getTime() : 0;
        const tb = b.timestamp ? b.timestamp.getTime() : 0;
        return tb - ta;
      });
      opts.onBatch(results);
    }
  }

  return { total: results.length, truncated };
}
