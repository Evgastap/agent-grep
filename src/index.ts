#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { runPrint } from "./print.ts";
import { USAGE } from "./format.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
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

const isTTY = Boolean(process.stdout.isTTY);
const color = !values["no-color"] && !process.env.NO_COLOR && isTTY;
const width =
  process.stdout.columns && process.stdout.columns > 40
    ? process.stdout.columns
    : 120;

const forcePrint =
  values.print || values.json || values.files || !isTTY;

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
    since: values.since,
    until: values.until,
    limit,
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
  since: values.since,
  until: values.until,
  includeCorrupted: !values["no-corrupted"],
  includeSubagents: !values["no-subagents"],
  includeHistory: !values["no-history"],
  dangerously: values.dangerously ?? false,
});

if (!intent) {
  process.exit(0);
}

const args: string[] = [];
if (intent.sessionId) args.push("--resume", intent.sessionId);
if (intent.dangerously) args.push("--dangerously-skip-permissions");

const proc = Bun.spawn(["claude", ...args], {
  cwd: intent.project,
  stdio: ["inherit", "inherit", "inherit"],
});
const code = await proc.exited;
process.exit(code ?? 0);
