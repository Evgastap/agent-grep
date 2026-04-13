import { collectLogFiles, getConfigRoot } from "./paths.ts";
import { parseEntry, type Role } from "./parse.ts";
import { runRipgrep } from "./search.ts";
import { formatEntry } from "./format.ts";
import {
  compileRegex,
  parseDateOrNull,
  passesFilters,
  type Filters,
} from "./filters.ts";

export interface PrintOptions {
  query: string;
  ignoreCase?: boolean;
  fixed?: boolean;
  project?: string;
  role?: string;
  since?: string;
  until?: string;
  limit?: number;
  includeCorrupted?: boolean;
  includeSubagents?: boolean;
  includeHistory?: boolean;
  json?: boolean;
  files?: boolean;
  stats?: boolean;
  color?: boolean;
  width?: number;
}

export async function runPrint(opts: PrintOptions): Promise<number> {
  const color = opts.color ?? false;
  const width = opts.width ?? 120;

  const root = getConfigRoot();
  const files = await collectLogFiles(root, {
    includeCorrupted: opts.includeCorrupted,
    includeSubagents: opts.includeSubagents,
    includeHistory: opts.includeHistory,
  });

  if (files.length === 0) {
    process.stderr.write(`ccgrep: no log files found under ${root}\n`);
    return 1;
  }

  let regex: RegExp;
  try {
    regex = compileRegex(opts.query, { ignoreCase: opts.ignoreCase, fixed: opts.fixed });
  } catch (err) {
    process.stderr.write(`ccgrep: invalid regex: ${(err as Error).message}\n`);
    return 2;
  }

  const filters: Filters = {
    project: opts.project,
    role: (opts.role as Role | undefined) ?? null,
    since: parseDateOrNull(opts.since),
    until: parseDateOrNull(opts.until),
  };

  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  let count = 0;
  let scanned = 0;
  const matchedFiles = new Set<string>();

  for await (const raw of runRipgrep({
    query: opts.query,
    files,
    caseInsensitive: opts.ignoreCase,
    fixedStrings: opts.fixed,
  })) {
    scanned++;
    const entry = parseEntry(raw.rawLine);
    if (!entry) continue;
    if (!passesFilters(entry, regex, filters)) continue;

    matchedFiles.add(raw.filePath);

    if (!opts.files) {
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({
            file: raw.filePath,
            line: raw.lineNumber,
            ...entry,
            timestamp:
              entry.timestamp instanceof Date ? entry.timestamp.toISOString() : null,
          }) + "\n",
        );
      } else {
        process.stdout.write(formatEntry(entry, regex, { color, width }) + "\n");
      }
    }

    count++;
    if (count >= limit) break;
  }

  if (opts.files) {
    for (const f of matchedFiles) process.stdout.write(f + "\n");
  }

  if (opts.stats) {
    const c = color ? "\x1b[2m" : "";
    const r = color ? "\x1b[0m" : "";
    process.stderr.write(
      `${c}— ${count} matches across ${matchedFiles.size} files (${scanned} raw, ${files.length} files scanned)${r}\n`,
    );
  }

  if (count === 0) {
    if (!opts.json && !opts.files) {
      const c = color ? "\x1b[2m" : "";
      const r = color ? "\x1b[0m" : "";
      process.stderr.write(`${c}no matches${r}\n`);
    }
    return 1;
  }

  return 0;
}
