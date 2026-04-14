#!/usr/bin/env node
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { runPrint } from "./print.ts";
import { USAGE } from "./format.ts";
import type { Source } from "./parse.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "ignore-case": { type: "boolean", short: "i" },
    fixed: { type: "boolean", short: "F" },
    project: { type: "string", short: "p" },
    role: { type: "string", short: "r" },
    since: { type: "string" },
    until: { type: "string" },
    limit: { type: "string", short: "n" },
    "no-corrupted": { type: "boolean" },
    "no-subagents": { type: "boolean" },
    "no-history": { type: "boolean" },
    "no-codex": { type: "boolean" },
    "no-claude-code": { type: "boolean" },
    source: { type: "string" },
    json: { type: "boolean" },
    files: { type: "boolean" },
    stats: { type: "boolean" },
    "no-color": { type: "boolean" },
    print: { type: "boolean", short: "P" },
    dangerously: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const query = positionals.join(" ");
const limit = values.limit ? Number.parseInt(values.limit, 10) : undefined;
if (limit !== undefined && (Number.isNaN(limit) || limit <= 0)) {
  console.error(`ccgrep: invalid --limit: ${values.limit}`);
  process.exit(2);
}

let sourceFilter: Source | null = null;
if (values.source) {
  if (values.source === "claude-code" || values.source === "claude") {
    sourceFilter = "claude-code";
  } else if (values.source === "codex") {
    sourceFilter = "codex";
  } else if (values.source !== "both" && values.source !== "all") {
    console.error(`ccgrep: invalid --source: ${values.source} (expected claude-code|codex|both)`);
    process.exit(2);
  }
}

const claudeCode = !values["no-claude-code"] && sourceFilter !== "codex";
const codex = !values["no-codex"] && sourceFilter !== "claude-code";
if (!claudeCode && !codex) {
  console.error("ccgrep: at least one source must be enabled");
  process.exit(2);
}

const isTTY = Boolean(process.stdout.isTTY);
const color = !values["no-color"] && !process.env.NO_COLOR && isTTY;
const width =
  process.stdout.columns && process.stdout.columns > 40
    ? process.stdout.columns
    : 120;

const forcePrint = values.print || values.json || values.files || !isTTY;

if (forcePrint) {
  if (!query) {
    console.error("ccgrep: query required in print mode (pipe/--print/--json/--files)");
    console.error("       try: ccgrep --help");
    process.exit(2);
  }
  const code = await runPrint({
    query,
    ignoreCase: values["ignore-case"],
    fixed: values.fixed,
    project: values.project,
    role: values.role,
    source: sourceFilter ?? undefined,
    since: values.since,
    until: values.until,
    limit,
    claudeCode,
    codex,
    includeCorrupted: !values["no-corrupted"],
    includeSubagents: !values["no-subagents"],
    includeHistory: !values["no-history"],
    json: values.json,
    files: values.files,
    stats: values.stats,
    color,
    width,
  });
  process.exit(code);
}

const { runTui } = await import("./tui/app.tsx");
const intent = await runTui({
  initialQuery: query,
  ignoreCase: values["ignore-case"] ?? true,
  fixed: values.fixed ?? false,
  initialProject: values.project,
  initialRole: values.role as import("./parse.ts").Role | undefined,
  initialSource: sourceFilter,
  since: values.since,
  until: values.until,
  claudeCode,
  codex,
  includeCorrupted: !values["no-corrupted"],
  includeSubagents: !values["no-subagents"],
  includeHistory: !values["no-history"],
  dangerously: values.dangerously ?? false,
});

if (!intent) {
  process.exit(0);
}

const { bin, args: launchArgs } = buildLaunchCommand(intent);
const child = spawn(bin, launchArgs, {
  cwd: intent.project,
  stdio: "inherit",
});
const code = await new Promise<number>((resolve) => {
  child.once("close", (c) => resolve(c ?? 0));
  child.once("error", (err) => {
    console.error(`ccgrep: failed to launch ${bin}: ${err.message}`);
    resolve(1);
  });
});
process.exit(code);

function buildLaunchCommand(intent: {
  sessionId: string | null;
  source: Source;
  dangerously: boolean;
}): { bin: string; args: string[] } {
  if (intent.source === "codex") {
    const args: string[] = ["resume"];
    if (intent.sessionId) args.push(intent.sessionId);
    return { bin: "codex", args };
  }
  const args: string[] = [];
  if (intent.sessionId) args.push("--resume", intent.sessionId);
  if (intent.dangerously) args.push("--dangerously-skip-permissions");
  return { bin: "claude", args };
}
