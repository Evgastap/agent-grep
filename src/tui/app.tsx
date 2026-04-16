import { homedir } from "node:os";
import React, { useEffect, useMemo, useState } from "react";
import { Box, render, Text, useInput, useWindowSize } from "ink";
import { collectLogFiles } from "../paths.ts";
import type { Role, Source } from "../parse.ts";
import { compileRegex, parseDateOrNull, type Filters } from "../filters.ts";
import {
  runSearch,
  type ResultRow,
  type SessionGroupRow,
  type HistoryRow,
} from "./engine.ts";

const HOME = homedir();

export interface TuiOptions {
  initialQuery: string;
  ignoreCase: boolean;
  fixed: boolean;
  initialProject?: string;
  initialRole?: Role;
  initialSource?: Source | null;
  since?: string;
  until?: string;
  claudeCode: boolean;
  codex: boolean;
  includeCorrupted: boolean;
  includeSubagents: boolean;
  includeHistory: boolean;
  dangerously: boolean;
}

export interface LaunchIntent {
  project: string;
  sessionId: string | null;
  source: Source;
  dangerously: boolean;
}

const ROLE_CYCLE: (Role | null)[] = [null, "user", "assistant", "tool"];
const SOURCE_CYCLE: (Source | null)[] = [null, "claude-code", "codex"];

export async function runTui(opts: TuiOptions): Promise<LaunchIntent | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (intent: LaunchIntent | null) => {
      if (resolved) return;
      resolved = true;
      app.unmount();
      resolve(intent);
    };
    const app = render(
      <App opts={opts} onSelect={(i) => finish(i)} onQuit={() => finish(null)} />,
      { alternateScreen: true, exitOnCtrlC: false },
    );
    app.waitUntilExit().then(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    });
  });
}

interface AppProps {
  opts: TuiOptions;
  onSelect: (intent: LaunchIntent) => void;
  onQuit: () => void;
}

function App({ opts, onSelect, onQuit }: AppProps) {
  const { columns, rows } = useWindowSize();

  const [files, setFiles] = useState<string[] | null>(null);
  const [filesErr, setFilesErr] = useState<string | null>(null);
  const [query, setQuery] = useState(opts.initialQuery);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [truncated, setTruncated] = useState(false);

  const [role, setRole] = useState<Role | null>(opts.initialRole ?? null);
  const [sourceFilter, setSourceFilter] = useState<Source | null>(
    opts.initialSource ?? null,
  );
  const projectText = opts.initialProject ?? null;
  const [cwdOnly, setCwdOnly] = useState(false);
  const [dangerously, setDangerously] = useState(opts.dangerously);

  useEffect(() => {
    (async () => {
      try {
        const list = await collectLogFiles({
          claudeCode: opts.claudeCode,
          codex: opts.codex,
          includeCorrupted: opts.includeCorrupted,
          includeSubagents: opts.includeSubagents,
          includeHistory: opts.includeHistory,
        });
        setFiles(list);
      } catch (err) {
        setFilesErr((err as Error).message);
      }
    })();
  }, []);

  useEffect(() => {
    if (!files) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSelected(0);
      setSearching(false);
      setTruncated(false);
      setElapsedMs(0);
      return;
    }

    const ac = new AbortController();
    const start = Date.now();
    const timer = setTimeout(async () => {
      setSearching(true);
      setResults([]);
      setSelected(0);
      setTruncated(false);
      const filters: Filters = {
        project: cwdOnly
          ? process.cwd()
          : projectText ?? undefined,
        role,
        since: parseDateOrNull(opts.since),
        until: parseDateOrNull(opts.until),
      };
      try {
        const out = await runSearch({
          query: q,
          files,
          ignoreCase: opts.ignoreCase,
          fixed: opts.fixed,
          filters,
          sourceFilter,
          signal: ac.signal,
          onBatch: (r) => {
            if (!ac.signal.aborted) setResults(r);
          },
        });
        if (!ac.signal.aborted) setTruncated(out.truncated);
      } finally {
        if (!ac.signal.aborted) {
          setSearching(false);
          setElapsedMs(Date.now() - start);
        }
      }
    }, 180);

    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [
    query,
    files,
    role,
    sourceFilter,
    projectText,
    cwdOnly,
    opts.ignoreCase,
    opts.fixed,
    opts.since,
    opts.until,
  ]);

  useEffect(() => {
    if (selected >= results.length) {
      setSelected(Math.max(0, results.length - 1));
    }
  }, [results.length, selected]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onQuit();
      return;
    }
    if (key.escape) {
      if (query.length > 0) {
        setQuery("");
      } else {
        onQuit();
      }
      return;
    }
    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((s) => Math.min(Math.max(0, results.length - 1), s + 1));
      return;
    }
    if (key.pageUp) {
      setSelected((s) => Math.max(0, s - 10));
      return;
    }
    if (key.pageDown) {
      setSelected((s) => Math.min(Math.max(0, results.length - 1), s + 10));
      return;
    }
    if (key.tab) {
      setRole((r) => {
        const idx = ROLE_CYCLE.indexOf(r);
        return ROLE_CYCLE[(idx + 1) % ROLE_CYCLE.length] ?? null;
      });
      return;
    }
    if (key.ctrl && input === "p") {
      setCwdOnly((v) => !v);
      return;
    }
    if (key.ctrl && input === "d") {
      setDangerously((v) => !v);
      return;
    }
    if (key.ctrl && input === "b") {
      setSourceFilter((s) => {
        const idx = SOURCE_CYCLE.indexOf(s);
        return SOURCE_CYCLE[(idx + 1) % SOURCE_CYCLE.length] ?? null;
      });
      return;
    }
    if (key.return) {
      const sel = results[selected];
      if (!sel) return;
      onSelect(buildLaunchIntent(sel, dangerously));
      return;
    }
  });

  const width = Math.max(40, columns);
  const height = Math.max(16, rows);
  const headerLines = 4;
  const footerLines = 2;
  const frameOverhead = 4;
  const remaining = Math.max(
    10,
    height - headerLines - footerLines - frameOverhead,
  );
  const previewHeight = Math.max(
    8,
    Math.min(18, Math.floor(remaining * 0.5)),
  );
  // One line per row, plus the blank line between.
  const rowStride = 2;
  const resultsHeight = Math.max(6, remaining - previewHeight);
  const viewportItems = Math.max(3, Math.floor(resultsHeight / rowStride));

  const visibleStart = Math.max(
    0,
    Math.min(
      selected - Math.floor(viewportItems / 2),
      Math.max(0, results.length - viewportItems),
    ),
  );
  const visibleEnd = Math.min(results.length, visibleStart + viewportItems);
  const visibleResults = results.slice(visibleStart, visibleEnd);

  const regex = useMemo(() => {
    try {
      return compileRegex(query, {
        ignoreCase: opts.ignoreCase,
        fixed: opts.fixed,
      });
    } catch {
      return null;
    }
  }, [query, opts.ignoreCase, opts.fixed]);

  if (filesErr) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Error loading log files: {filesErr}</Text>
        <Text dimColor>Press Esc to quit.</Text>
      </Box>
    );
  }

  if (!files) {
    return (
      <Box padding={1}>
        <Text dimColor>Loading conversation logs…</Text>
      </Box>
    );
  }

  const selectedRow = results[selected] ?? null;
  const totalMatches = results.reduce(
    (acc, r) => acc + (r.kind === "session" ? r.matchCount : 1),
    0,
  );

  return (
    <Box flexDirection="column" width={width}>
      <Header
        query={query}
        setQuery={setQuery}
        totalFiles={files.length}
        role={role}
        sourceFilter={sourceFilter}
        cwdOnly={cwdOnly}
        projectText={projectText}
        rowCount={results.length}
        totalMatches={totalMatches}
        searching={searching}
        elapsedMs={elapsedMs}
        truncated={truncated}
      />
      <ResultsList
        results={visibleResults}
        startIndex={visibleStart}
        selectedIndex={selected}
        regex={regex}
        width={width - 4}
        emptyHint={
          query.trim().length < 2
            ? "type at least 2 characters to search"
            : searching
              ? "searching…"
              : "no matches"
        }
      />
      <Preview
        row={selectedRow}
        regex={regex}
        height={previewHeight}
        width={width - 4}
      />
      <Footer dangerously={dangerously} />
    </Box>
  );
}

function buildLaunchIntent(row: ResultRow, dangerously: boolean): LaunchIntent {
  if (row.kind === "session") {
    return {
      project: row.project || process.cwd(),
      sessionId: row.sessionId,
      source: row.source,
      dangerously,
    };
  }
  return {
    project: row.entry.project || process.cwd(),
    sessionId: null,
    source: row.entry.source,
    dangerously,
  };
}

function Header(props: {
  query: string;
  setQuery: (s: string) => void;
  totalFiles: number;
  role: Role | null;
  sourceFilter: Source | null;
  cwdOnly: boolean;
  projectText: string | null;
  rowCount: number;
  totalMatches: number;
  searching: boolean;
  elapsedMs: number;
  truncated: boolean;
}) {
  const projectChip = props.cwdOnly
    ? `cwd`
    : props.projectText
      ? `path:${truncate(props.projectText, 24)}`
      : "all";

  let stat: string;
  if (props.searching) {
    stat = "searching…";
  } else if (props.query.trim().length < 2) {
    stat = `${props.totalFiles} files indexed`;
  } else if (props.rowCount === 0) {
    stat = "no matches";
  } else {
    const suffix = props.truncated ? "+" : "";
    const sessionWord = props.rowCount === 1 ? "session" : "sessions";
    stat = `${props.rowCount}${suffix} ${sessionWord} · ${props.totalMatches}${suffix} matches · ${props.elapsedMs}ms`;
  }

  const sourceLabel = props.sourceFilter ?? "both sources";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Box>
        <Text color="cyan" bold>
          agent-grep
        </Text>
        <Text dimColor> · session search</Text>
        <Box flexGrow={1}>
          <Text> </Text>
        </Box>
        <Text dimColor>{stat}</Text>
      </Box>
      <Box>
        <Text color="magenta">❯ </Text>
        <SearchInput
          value={props.query}
          onChange={props.setQuery}
          placeholder="type to search conversation logs…"
        />
      </Box>
      <Box>
        <Text dimColor>  </Text>
        <Text color={sourceColor(props.sourceFilter)}>{sourceLabel}</Text>
        <Text dimColor>  ·  </Text>
        <Text color={roleColor(props.role)}>{props.role ?? "all roles"}</Text>
        <Text dimColor>  ·  </Text>
        <Text color="cyan">{projectChip}</Text>
      </Box>
    </Box>
  );
}

function ResultsList(props: {
  results: ResultRow[];
  startIndex: number;
  selectedIndex: number;
  regex: RegExp | null;
  width: number;
  emptyHint: string;
}) {
  if (props.results.length === 0) {
    return (
      <Box
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        flexDirection="column"
      >
        <Text dimColor>{props.emptyHint}</Text>
      </Box>
    );
  }
  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      flexDirection="column"
    >
      {props.results.map((row, i) => {
        const absoluteIdx = props.startIndex + i;
        const isSelected = absoluteIdx === props.selectedIndex;
        return (
          <ResultItem
            key={row.key}
            row={row}
            regex={props.regex}
            width={props.width}
            selected={isSelected}
          />
        );
      })}
    </Box>
  );
}

const PROJECT_COL = 26;
const TIME_COL = 9;
const COUNT_COL = 6;
// marker(2) + dot(2) + project + 2 + time + 2 + count + 1 = 17 + project
const FIXED_LEFT = 2 + 2 + PROJECT_COL + 2 + TIME_COL + 2 + COUNT_COL + 1;

function ResultItem(props: {
  row: ResultRow;
  regex: RegExp | null;
  width: number;
  selected: boolean;
}) {
  const { row, regex, width, selected } = props;
  const marker = selected ? "▸ " : "  ";
  const markerColor = selected ? "magenta" : undefined;

  const { projectDisp, relative, countStr, countColor, snippetSrc, roleOfSnippet } =
    describeRow(row);

  const snippetWidth = Math.max(20, width - FIXED_LEFT - 2);
  const snippet = makeSnippet(snippetSrc, regex, snippetWidth);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text wrap="truncate-end">
        <Text color={markerColor} bold={selected}>
          {marker}
        </Text>
        <Text color={sourceColor(row.kind === "session" ? row.source : row.entry.source)}>
          ●{" "}
        </Text>
        <Text color={selected ? "cyan" : "white"} bold={selected}>
          {padEnd(projectDisp, PROJECT_COL)}
        </Text>
        <Text>  </Text>
        <Text color="gray">{padEnd(relative, TIME_COL)}</Text>
        <Text>  </Text>
        <Text color={countColor}>{padEnd(countStr, COUNT_COL)}</Text>
        <Text> </Text>
        <Text color={roleColor(roleOfSnippet)} dimColor={!selected}>
          {snippet.prefix}
        </Text>
        <HighlightedSpans text={snippet.slice} regex={regex} />
        <Text dimColor>{snippet.suffix}</Text>
      </Text>
    </Box>
  );
}

function describeRow(row: ResultRow): {
  projectDisp: string;
  relative: string;
  countStr: string;
  countColor: string;
  snippetSrc: string;
  roleOfSnippet: Role;
} {
  if (row.kind === "session") {
    const latest = row.matches[0];
    return {
      projectDisp: truncate(projectLabel(row.project), PROJECT_COL),
      relative: formatRelativeTime(row.lastMatchTime),
      countStr: `×${row.matchCount}`,
      countColor: row.matchCount >= 5 ? "yellow" : "gray",
      snippetSrc: latest?.text ?? "",
      roleOfSnippet: latest?.role ?? "unknown",
    };
  }
  return {
    projectDisp: truncate(`${projectLabel(row.entry.project)} · history`, PROJECT_COL),
    relative: formatRelativeTime(row.entry.timestamp),
    countStr: "",
    countColor: "gray",
    snippetSrc: row.entry.text,
    roleOfSnippet: "user",
  };
}

function Preview(props: {
  row: ResultRow | null;
  regex: RegExp | null;
  height: number;
  width: number;
}) {
  const { row, regex, height, width } = props;
  if (!row) {
    return (
      <Box
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        height={height}
      >
        <Text dimColor>type to search, ↓ to pick a result, Enter to resume</Text>
      </Box>
    );
  }
  if (row.kind === "session") {
    return <SessionPreview row={row} regex={regex} height={height} width={width} />;
  }
  return <HistoryPreview row={row} regex={regex} height={height} width={width} />;
}

function SessionPreview(props: {
  row: SessionGroupRow;
  regex: RegExp | null;
  height: number;
  width: number;
}) {
  const { row, regex, height, width } = props;
  const projectDisp = projectLabel(row.project);
  const branchDisp = row.gitBranch ?? "";
  const spanDisp = describeSpan(row.firstMatchTime, row.lastMatchTime);

  const bodyLines = Math.max(1, height - 4);
  const shown = row.matches.slice(0, bodyLines);
  const hidden = row.matchCount - shown.length;

  const timeW = 9;
  const roleW = 10;
  // width here is already (outer - 4). The SessionPreview box eats another 4
  // (border + padding). Reserve columns for ellipses on top of the snippet.
  const snippetW = Math.max(20, width - 4 - (timeW + 2 + roleW + 2) - 2);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      height={height}
    >
      <Text>
        <Text color={sourceColor(row.source)} bold>
          ●{" "}
        </Text>
        <Text color="cyan" bold>
          {projectDisp}
        </Text>
        {branchDisp ? (
          <>
            <Text dimColor>  on  </Text>
            <Text color="green">{branchDisp}</Text>
          </>
        ) : null}
        <Text dimColor>  ·  </Text>
        <Text color="yellow">{row.matchCount} matches</Text>
        <Text dimColor>  ·  </Text>
        <Text color="gray">{spanDisp}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {shown.map((m, i) => (
          <Text key={`m-${i}`} wrap="truncate-end">
            <Text color="gray">{padEnd(formatShortTime(m.timestamp), timeW)}</Text>
            <Text>  </Text>
            <Text color={roleColor(m.role)}>{padEnd(m.role, roleW)}</Text>
            <Text>  </Text>
            <SnippetText
              text={m.text}
              regex={regex}
              width={snippetW}
            />
          </Text>
        ))}
        {hidden > 0 ? (
          <Text dimColor>
            … {hidden} more match{hidden === 1 ? "" : "es"} in this session
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

function HistoryPreview(props: {
  row: HistoryRow;
  regex: RegExp | null;
  height: number;
  width: number;
}) {
  const { row, regex, height, width } = props;
  const entry = row.entry;
  const projectDisp = projectLabel(entry.project);
  const stamp = formatStampMinute(entry.timestamp);

  const bodyLines = Math.max(1, height - 4);
  const raw = stripBracketedSeconds(entry.text).split("\n");
  const contentLines = centerOnMatch(raw, regex, bodyLines);
  const extra = raw.length > bodyLines ? raw.length - contentLines.length : 0;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      height={height}
    >
      <Text>
        <Text color={sourceColor(entry.source)} bold>
          ●{" "}
        </Text>
        <Text color="cyan" bold>
          {projectDisp}
        </Text>
        <Text dimColor>  ·  </Text>
        <Text color="magenta">history</Text>
        <Text dimColor>  ·  </Text>
        <Text color="gray">{stamp}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {contentLines.map((line, i) => (
          <Text key={`pv-${i}`} wrap="truncate-end">
            <HighlightedSpans
              text={truncate(line.replace(/\t/g, "  "), Math.max(10, width - 6))}
              regex={regex}
            />
          </Text>
        ))}
        {extra > 0 ? (
          <Text dimColor>… {extra} more line{extra === 1 ? "" : "s"}</Text>
        ) : null}
      </Box>
    </Box>
  );
}

function SnippetText(props: {
  text: string;
  regex: RegExp | null;
  width: number;
}) {
  const snippet = makeSnippet(props.text, props.regex, props.width);
  return (
    <>
      <Text dimColor>{snippet.prefix}</Text>
      <HighlightedSpans text={snippet.slice} regex={props.regex} />
      <Text dimColor>{snippet.suffix}</Text>
    </>
  );
}

function Footer(props: { dangerously: boolean }) {
  return (
    <Box paddingX={1}>
      <Text dimColor>
        ↑↓ nav · Enter resume · Tab role · Ctrl+B source · Ctrl+P cwd · Ctrl+D dangerously
        {props.dangerously ? " ✓" : ""} · Esc quit
      </Text>
    </Box>
  );
}

function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  useInput((input, key) => {
    if (key.ctrl || key.meta) return;
    if (
      key.upArrow ||
      key.downArrow ||
      key.leftArrow ||
      key.rightArrow ||
      key.pageUp ||
      key.pageDown ||
      key.tab ||
      key.return ||
      key.escape
    ) {
      return;
    }
    if (key.backspace || key.delete) {
      if (value.length > 0) onChange(value.slice(0, -1));
      return;
    }
    if (!input) return;
    if (!/^[\x20-\x7e]+$/.test(input)) return;
    onChange(value + input);
  });

  const showPlaceholder = value.length === 0;
  return (
    <Text>
      <Text dimColor={showPlaceholder}>
        {showPlaceholder ? placeholder ?? "" : value}
      </Text>
      <Text inverse>{" "}</Text>
    </Text>
  );
}

function HighlightedSpans({
  text,
  regex,
}: {
  text: string;
  regex: RegExp | null;
}) {
  if (!regex) return <Text>{text}</Text>;
  const g = new RegExp(
    regex.source,
    regex.flags.includes("g") ? regex.flags : regex.flags + "g",
  );
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = g.exec(text)) !== null) {
    if (m.index > lastIndex) {
      nodes.push(<Text key={`hl-p-${n++}`}>{text.slice(lastIndex, m.index)}</Text>);
    }
    nodes.push(
      <Text key={`hl-m-${n++}`} inverse color="yellow">
        {m[0]}
      </Text>,
    );
    lastIndex = m.index + m[0].length;
    if (m[0].length === 0) g.lastIndex++;
  }
  if (lastIndex < text.length) {
    nodes.push(<Text key={`hl-p-${n++}`}>{text.slice(lastIndex)}</Text>);
  }
  return <Text>{nodes}</Text>;
}

function makeSnippet(
  text: string,
  regex: RegExp | null,
  maxWidth: number,
): { prefix: string; slice: string; suffix: string } {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return { prefix: "", slice: "(empty)", suffix: "" };
  if (!regex) {
    return {
      prefix: "",
      slice: flat.length > maxWidth ? flat.slice(0, maxWidth - 1) + "…" : flat,
      suffix: "",
    };
  }
  const m = flat.match(regex);
  if (!m || m.index === undefined) {
    return {
      prefix: "",
      slice: flat.length > maxWidth ? flat.slice(0, maxWidth - 1) + "…" : flat,
      suffix: "",
    };
  }
  const contextBefore = Math.floor((maxWidth - m[0].length) / 2);
  const start = Math.max(0, m.index - contextBefore);
  const end = Math.min(flat.length, start + maxWidth);
  const realStart = Math.max(0, end - maxWidth);
  return {
    prefix: realStart > 0 ? "…" : "",
    slice: flat.slice(realStart, end),
    suffix: end < flat.length ? "…" : "",
  };
}

function centerOnMatch(
  lines: string[],
  regex: RegExp | null,
  maxLines: number,
): string[] {
  if (lines.length <= maxLines) return lines;
  if (!regex) return lines.slice(0, maxLines);
  const matchIdx = lines.findIndex((l) => regex.test(l));
  if (matchIdx < 0) return lines.slice(0, maxLines);
  const half = Math.floor(maxLines / 2);
  const start = Math.max(0, Math.min(matchIdx - half, lines.length - maxLines));
  return lines.slice(start, start + maxLines);
}

const MONTHS_SHORT = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

function formatRelativeTime(ts: Date | null): string {
  if (!ts || Number.isNaN(ts.getTime())) return "—";
  const diffMs = Date.now() - ts.getTime();
  if (diffMs < 0) return formatShortDate(ts);
  const s = Math.floor(diffMs / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return formatShortDate(ts);
}

function formatShortDate(ts: Date): string {
  const month = MONTHS_SHORT[ts.getMonth()] ?? "???";
  const day = ts.getDate();
  const thisYear = new Date().getFullYear();
  if (ts.getFullYear() === thisYear) return `${month} ${day}`;
  return `${month} ${day} '${String(ts.getFullYear()).slice(-2)}`;
}

function formatShortTime(ts: Date | null): string {
  if (!ts || Number.isNaN(ts.getTime())) return "—";
  const rel = formatRelativeTime(ts);
  if (rel !== "just now" && !rel.endsWith("ago")) return rel;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(ts.getHours())}:${pad(ts.getMinutes())}`;
}

function formatStampMinute(ts: Date | null): string {
  if (!ts || Number.isNaN(ts.getTime())) return "(no timestamp)";
  const month = MONTHS_SHORT[ts.getMonth()] ?? "???";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${month} ${ts.getDate()} ${pad(ts.getHours())}:${pad(ts.getMinutes())}`;
}

function describeSpan(first: Date | null, last: Date | null): string {
  if (!first && !last) return "";
  if (!first || !last) return formatShortDate((first ?? last) as Date);
  const sameMinute =
    Math.abs(last.getTime() - first.getTime()) < 60_000 &&
    first.getHours() === last.getHours() &&
    first.getMinutes() === last.getMinutes();
  if (sameMinute) return formatStampMinute(last);
  return `${formatStampMinute(first)} → ${formatStampMinute(last)}`;
}

function projectLabel(p: string): string {
  if (!p) return "(no-project)";
  const short = shortenPath(p);
  const parts = short.split("/");
  return parts[parts.length - 1] || short;
}

function shortenPath(p: string): string {
  if (!p) return "(no-project)";
  if (p.startsWith(HOME)) return "~" + p.slice(HOME.length);
  return p;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}

function padEnd(s: string, max: number): string {
  if (s.length >= max) return s.slice(0, max);
  return s + " ".repeat(max - s.length);
}

const BRACKETED_STAMP =
  /\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2}\]/g;
function stripBracketedSeconds(text: string): string {
  return text.replace(BRACKETED_STAMP, "[$1 $2]");
}

function roleColor(role: Role | null | undefined): string {
  switch (role) {
    case "user":
      return "green";
    case "assistant":
      return "blue";
    case "system":
      return "magenta";
    case "tool":
      return "yellow";
    default:
      return "white";
  }
}

function sourceColor(source: Source | null | undefined): string {
  switch (source) {
    case "claude-code":
      return "cyan";
    case "codex":
      return "magenta";
    default:
      return "white";
  }
}
