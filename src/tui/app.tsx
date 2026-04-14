import { homedir } from "node:os";
import React, { useEffect, useMemo, useState } from "react";
import { Box, render, Text, useInput, useWindowSize } from "ink";
import { collectLogFiles } from "../paths.ts";
import type { LogEntry, Role, Source } from "../parse.ts";
import { compileRegex, parseDateOrNull, type Filters } from "../filters.ts";
import { runSearch } from "./engine.ts";

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
  const [results, setResults] = useState<LogEntry[]>([]);
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
    if (key.escape || (key.ctrl && input === "c")) {
      onQuit();
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
      onSelect({
        project: sel.project || process.cwd(),
        sessionId: sel.kind === "session" ? sel.sessionId : null,
        source: sel.source,
        dangerously,
      });
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
    6,
    Math.min(16, Math.floor(remaining * 0.42)),
  );
  const resultsHeight = Math.max(6, remaining - previewHeight);
  const itemsPerRow = 2;
  const viewportItems = Math.max(3, Math.floor(resultsHeight / itemsPerRow));

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

  const selectedEntry = results[selected] ?? null;

  return (
    <Box flexDirection="column" width={width}>
      <Header
        query={query}
        setQuery={setQuery}
        totalFiles={files.length}
        role={role}
        sourceFilter={sourceFilter}
        cwdOnly={cwdOnly}
        dangerously={dangerously}
        projectText={projectText}
        resultCount={results.length}
        searching={searching}
        elapsedMs={elapsedMs}
        truncated={truncated}
        width={width}
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
        totalCount={results.length}
      />
      <Preview
        entry={selectedEntry}
        regex={regex}
        height={previewHeight}
        width={width - 4}
      />
      <Footer dangerously={dangerously} />
    </Box>
  );
}

function Header(props: {
  query: string;
  setQuery: (s: string) => void;
  totalFiles: number;
  role: Role | null;
  sourceFilter: Source | null;
  cwdOnly: boolean;
  dangerously: boolean;
  projectText: string | null;
  resultCount: number;
  searching: boolean;
  elapsedMs: number;
  truncated: boolean;
  width: number;
}) {
  const projectChip = props.cwdOnly
    ? `cwd:${shortenPath(process.cwd())}`
    : props.projectText
      ? `path:${props.projectText}`
      : "all";

  const stat = props.searching
    ? "searching…"
    : props.query.trim().length < 2
      ? `${props.totalFiles} files indexed`
      : `${props.resultCount}${props.truncated ? "+" : ""} matches · ${props.elapsedMs}ms`;

  const sourceLabel = props.sourceFilter ?? "both";
  const sourceColorName = sourceColor(props.sourceFilter);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Box>
        <Text color="cyan" bold>
          cc-history
        </Text>
        <Text dimColor> · claude-code + codex log search </Text>
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
        <Text dimColor>source: </Text>
        <Text color={sourceColorName}>{sourceLabel}</Text>
        <Text dimColor>   role: </Text>
        <Text color={roleColor(props.role)}>{props.role ?? "all"}</Text>
        <Text dimColor>   project: </Text>
        <Text color="cyan">{projectChip}</Text>
        <Text dimColor>   --dangerously: </Text>
        <Text color={props.dangerously ? "red" : "gray"}>
          {props.dangerously ? "ON" : "off"}
        </Text>
      </Box>
    </Box>
  );
}

function ResultsList(props: {
  results: LogEntry[];
  startIndex: number;
  selectedIndex: number;
  regex: RegExp | null;
  width: number;
  emptyHint: string;
  totalCount: number;
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
      {props.results.map((entry, i) => {
        const absoluteIdx = props.startIndex + i;
        const isSelected = absoluteIdx === props.selectedIndex;
        return (
          <ResultItem
            key={`r-${absoluteIdx}`}
            entry={entry}
            regex={props.regex}
            width={props.width}
            selected={isSelected}
          />
        );
      })}
    </Box>
  );
}

function ResultItem(props: {
  entry: LogEntry;
  regex: RegExp | null;
  width: number;
  selected: boolean;
}) {
  const { entry, regex, width, selected } = props;
  const ts = formatCompactTimestamp(entry.timestamp);
  const projectDisp = truncate(shortenPath(entry.project), 28);
  const sessionDisp =
    entry.kind === "session" ? entry.sessionId.slice(0, 8) : "history ";
  const role = entry.role;
  const rColor = roleColor(role);
  const marker = selected ? "▸" : " ";
  const markerColor = selected ? "magenta" : undefined;
  const sidechain = entry.kind === "session" && entry.isSidechain ? " ↪" : "";
  const srcTag = sourceLabel(entry.source);
  const srcColorName = sourceColor(entry.source);

  const snippetWidth = Math.max(20, width - 4);
  const snippet = makeSnippet(entry.text, regex, snippetWidth);

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text>
        <Text color={markerColor} bold={selected}>
          {marker}{" "}
        </Text>
        <Text color="gray">{ts}</Text>
        <Text> </Text>
        <Text color={srcColorName} bold>
          {srcTag.padEnd(6)}
        </Text>
        <Text color="cyan" bold={selected}>
          {projectDisp.padEnd(28)}
        </Text>
        <Text> </Text>
        <Text color="yellow">{sessionDisp}</Text>
        <Text> </Text>
        <Text color={rColor}>{role}</Text>
        <Text dimColor>{sidechain}</Text>
      </Text>
      <Text>
        <Text>{"  "}</Text>
        <Text dimColor>{snippet.prefix}</Text>
        <HighlightedSpans text={snippet.slice} regex={regex} />
        <Text dimColor>{snippet.suffix}</Text>
      </Text>
    </Box>
  );
}

function Preview(props: {
  entry: LogEntry | null;
  regex: RegExp | null;
  height: number;
  width: number;
}) {
  const { entry, regex, height, width } = props;
  if (!entry) {
    return (
      <Box
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        height={height}
      >
        <Text dimColor>No selection. Type to search, ↓ to pick a result.</Text>
      </Box>
    );
  }
  const ts = formatFullTimestamp(entry.timestamp);
  const projectDisp = shortenPath(entry.project);
  const sessionDisp =
    entry.kind === "session" ? entry.sessionId : "(history entry)";

  const bodyLines = Math.max(1, height - 5);
  const rawLines = entry.text.split("\n");
  const contentLines = centerOnMatch(rawLines, regex, bodyLines);
  const truncatedLines = rawLines.length > bodyLines;

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
          {sourceLabel(entry.source)}
        </Text>
        <Text> · </Text>
        <Text color="gray">{ts}</Text>
        <Text> · </Text>
        <Text color="cyan">{projectDisp}</Text>
      </Text>
      <Text>
        <Text color="yellow">{sessionDisp}</Text>
        <Text> · </Text>
        <Text color={roleColor(entry.role)}>{entry.role}</Text>
        {entry.kind === "session" && entry.gitBranch ? (
          <Text dimColor> · {entry.gitBranch}</Text>
        ) : null}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {contentLines.map((line, i) => (
          <Text key={`pv-${i}`}>
            <HighlightedSpans
              text={truncate(line.replace(/\t/g, "  "), width - 4)}
              regex={regex}
            />
          </Text>
        ))}
        {truncatedLines ? <Text dimColor>… ({rawLines.length} lines)</Text> : null}
      </Box>
    </Box>
  );
}

function Footer(props: { dangerously: boolean }) {
  return (
    <Box paddingX={1}>
      <Text dimColor>
        ↑↓ nav · Enter resume · Tab role · Ctrl+B source · Ctrl+P cwd · Ctrl+D dangerously{props.dangerously ? "✓" : ""} · Esc quit
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

function formatCompactTimestamp(ts: Date | null): string {
  if (!ts || Number.isNaN(ts.getTime())) return "                ";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ` +
    `${pad(ts.getHours())}:${pad(ts.getMinutes())}`
  );
}

function formatFullTimestamp(ts: Date | null): string {
  if (!ts || Number.isNaN(ts.getTime())) return "(no timestamp)";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ` +
    `${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`
  );
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

function sourceLabel(source: Source): string {
  return source === "claude-code" ? "claude" : "codex";
}
