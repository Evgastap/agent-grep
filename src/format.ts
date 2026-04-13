import { homedir } from "node:os";
import type { LogEntry } from "./parse.ts";

const HOME = homedir();

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  redBg: "\x1b[41;97m",
};

export interface FormatOptions {
  color: boolean;
  width: number;
}

export function formatEntry(
  entry: LogEntry,
  regex: RegExp,
  opts: FormatOptions,
): string {
  const c = opts.color ? ANSI : emptyAnsi();
  const ts = formatTimestamp(entry.timestamp);
  const project = shortenProject(entry.project);
  const session =
    entry.kind === "session" ? entry.sessionId.slice(0, 8) : "prompt";
  const role = entry.role;
  const roleColor = roleAnsi(role, c);
  const sidechain = entry.kind === "session" && entry.isSidechain ? " ↪" : "";

  const header =
    `${c.dim}${ts}${c.reset} ` +
    `${c.cyan}${project}${c.reset} ` +
    `${c.yellow}${session}${c.reset} ` +
    `${roleColor}${role}${c.reset}${c.dim}${sidechain}${c.reset}`;

  const snippet = makeSnippet(entry.text, regex, opts.width - 4, c);
  return `${header}\n  ${snippet}`;
}

function formatTimestamp(ts: Date | null): string {
  if (!ts || Number.isNaN(ts.getTime())) return "                ";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ` +
    `${pad(ts.getHours())}:${pad(ts.getMinutes())}`
  );
}

function shortenProject(p: string): string {
  if (!p) return "(no-project)";
  if (p.startsWith(HOME)) return "~" + p.slice(HOME.length);
  return p;
}

function roleAnsi(role: string, c: typeof ANSI): string {
  switch (role) {
    case "user":
      return c.green;
    case "assistant":
      return c.blue;
    case "system":
      return c.magenta;
    case "tool":
      return c.yellow;
    default:
      return c.reset;
  }
}

function makeSnippet(
  text: string,
  regex: RegExp,
  maxWidth: number,
  c: typeof ANSI,
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return `${c.dim}(empty)${c.reset}`;

  const m = flat.match(regex);
  if (!m || m.index === undefined) {
    return truncate(flat, maxWidth);
  }

  const matchStart = m.index;
  const matchEnd = matchStart + m[0].length;
  const contextBefore = Math.floor((maxWidth - m[0].length) / 2);
  const start = Math.max(0, matchStart - contextBefore);
  const end = Math.min(flat.length, start + maxWidth);
  const realStart = Math.max(0, end - maxWidth);

  const prefix = realStart > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  const slice = flat.slice(realStart, end);

  const localStart = matchStart - realStart;
  const localEnd = matchEnd - realStart;
  if (localStart < 0 || localEnd > slice.length) {
    return prefix + highlightAll(slice, regex, c) + suffix;
  }

  const before = slice.slice(0, localStart);
  const match = slice.slice(localStart, localEnd);
  const after = slice.slice(localEnd);
  return (
    prefix +
    before +
    `${c.redBg}${match}${c.reset}` +
    highlightAll(after, regex, c) +
    suffix
  );
}

function highlightAll(s: string, regex: RegExp, c: typeof ANSI): string {
  const g = new RegExp(
    regex.source,
    regex.flags.includes("g") ? regex.flags : regex.flags + "g",
  );
  return s.replace(g, (m) => `${c.redBg}${m}${c.reset}`);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function emptyAnsi(): typeof ANSI {
  const out = {} as Record<keyof typeof ANSI, string>;
  for (const k of Object.keys(ANSI) as (keyof typeof ANSI)[]) out[k] = "";
  return out as typeof ANSI;
}

export const USAGE = `ccgrep — search Claude Code and Codex conversation logs

Usage:
  ccgrep                   Launch interactive TUI (default when TTY)
  ccgrep [options] <query> Launch TUI prefilled, or print when piped

Search options:
  -i, --ignore-case        Case-insensitive search (default ON in TUI)
  -F, --fixed              Treat query as a literal string (not regex)
  -p, --project <glob>     Filter by project path substring
  -r, --role <role>        Filter by role (user|assistant|system|tool)
      --source <src>       Limit to one source: claude-code | codex | both
      --since <date>       Only matches after date (ISO or YYYY-MM-DD)
      --until <date>       Only matches before date
  -n, --limit <n>          Stop after N results (print mode)

Source options:
      --no-claude-code     Skip ~/.claude (respects $CLAUDE_CONFIG_DIR)
      --no-codex           Skip ~/.codex (respects $CODEX_HOME)
      --no-corrupted       Skip corrupted-sessions-backup/ (claude only)
      --no-subagents       Skip subagent transcripts (claude only)
      --no-history         Skip ~/.claude/history.jsonl

Launcher (TUI only):
      --dangerously        Pass --dangerously-skip-permissions to claude on launch

Output:
  -P, --print              Force non-interactive print mode
      --json               Emit JSON lines (implies --print)
      --files              Print matching file paths only (implies --print)
      --stats              Print counts after results
      --no-color           Disable ANSI colors
  -h, --help               Show this help

TUI keys:
  type…                    Live search across all logs
  ↑ / ↓                    Navigate results
  Enter                    Open: cd into project and resume the session
                           claude entries → claude --resume <id>
                           codex entries  → codex resume <id>
  Tab                      Cycle role filter (all→user→assistant→tool)
  Ctrl+B                   Cycle source filter (both→claude-code→codex)
  Ctrl+P                   Toggle project filter (all / current cwd)
  Ctrl+D                   Toggle --dangerously-skip-permissions (claude only)
  Esc                      Quit

Examples:
  ccgrep                               # interactive, both sources
  ccgrep --source codex firestore      # TUI, codex only, pre-filled
  ccgrep -P -i -r user "firebase auth" # force print
  ccgrep --json --no-codex "pnpm" | jq .
`;
