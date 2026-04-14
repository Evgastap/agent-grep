import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export interface SearchOptions {
  query: string;
  files: string[];
  caseInsensitive?: boolean;
  fixedStrings?: boolean;
  signal?: AbortSignal;
}

export interface RawMatch {
  filePath: string;
  lineNumber: number;
  rawLine: string;
}

type Backend =
  | { kind: "rg"; bin: string }
  | { kind: "grep"; bin: string };

const CHUNK_SIZE = 500;

let cachedBackend: Backend | null = null;

async function resolveBackend(): Promise<Backend> {
  if (cachedBackend) return cachedBackend;

  try {
    const mod = (await import("@vscode/ripgrep")) as { rgPath?: string };
    if (mod.rgPath && existsSync(mod.rgPath)) {
      cachedBackend = { kind: "rg", bin: mod.rgPath };
      return cachedBackend;
    }
  } catch {
    // package not installed — fall through
  }

  if (await commandRuns("rg")) {
    cachedBackend = { kind: "rg", bin: "rg" };
    return cachedBackend;
  }

  if (await commandRuns("grep")) {
    cachedBackend = { kind: "grep", bin: "grep" };
    return cachedBackend;
  }

  throw new Error(
    "ccgrep: no search backend found — install ripgrep or grep on PATH",
  );
}

function commandRuns(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, ["--version"], { stdio: "ignore" });
    proc.once("close", (code) => resolve(code === 0));
    proc.once("error", () => resolve(false));
  });
}

export async function* streamMatches(opts: SearchOptions): AsyncGenerator<RawMatch> {
  const backend = await resolveBackend();
  if (backend.kind === "rg") {
    yield* runWithRipgrep(backend.bin, opts);
  } else {
    yield* runWithGrep(backend.bin, opts);
  }
}

async function* runWithRipgrep(
  bin: string,
  opts: SearchOptions,
): AsyncGenerator<RawMatch> {
  const baseArgs = ["--json", "--no-messages", "--no-config"];
  if (opts.caseInsensitive) baseArgs.push("-i");
  if (opts.fixedStrings) baseArgs.push("-F");
  baseArgs.push("-e", opts.query);

  for (let i = 0; i < opts.files.length; i += CHUNK_SIZE) {
    if (opts.signal?.aborted) return;
    const chunk = opts.files.slice(i, i + CHUNK_SIZE);
    if (chunk.length === 0) continue;

    yield* runChunk(bin, [...baseArgs, ...chunk], opts.signal, parseRgEvent);
  }
}

async function* runWithGrep(
  bin: string,
  opts: SearchOptions,
): AsyncGenerator<RawMatch> {
  const baseArgs = ["-H", "-n", "-a", "-s"];
  if (opts.caseInsensitive) baseArgs.push("-i");
  if (opts.fixedStrings) baseArgs.push("-F");
  else baseArgs.push("-E");
  baseArgs.push("-e", opts.query, "--");

  for (let i = 0; i < opts.files.length; i += CHUNK_SIZE) {
    if (opts.signal?.aborted) return;
    const chunk = opts.files.slice(i, i + CHUNK_SIZE);
    if (chunk.length === 0) continue;

    yield* runChunk(bin, [...baseArgs, ...chunk], opts.signal, parseGrepLine);
  }
}

async function* runChunk(
  bin: string,
  args: string[],
  signal: AbortSignal | undefined,
  parseLine: (line: string) => RawMatch | null,
): AsyncGenerator<RawMatch> {
  const proc = spawn(bin, args, {
    stdio: ["ignore", "pipe", "ignore"],
  });
  proc.on("error", () => {});

  const onAbort = () => {
    try {
      proc.kill();
    } catch {}
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const exited = new Promise<void>((resolve) => {
    proc.once("close", () => resolve());
    proc.once("error", () => resolve());
  });

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for await (const value of proc.stdout as AsyncIterable<Buffer>) {
      if (signal?.aborted) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const match = parseLine(line);
        if (match) yield match;
      }
    }
    buffer += decoder.decode();
    if (buffer && !signal?.aborted) {
      const match = parseLine(buffer);
      if (match) yield match;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      proc.kill();
    } catch {}
    await exited;
  }
}

interface RgMatchEvent {
  type: "match";
  data: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}

function parseRgEvent(line: string): RawMatch | null {
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (!ev || typeof ev !== "object") return null;
  const e = ev as Partial<RgMatchEvent>;
  if (e.type !== "match" || !e.data) return null;

  const filePath = e.data.path?.text ?? "";
  const rawLine = (e.data.lines?.text ?? "").replace(/\n$/, "");
  const lineNumber = e.data.line_number ?? 0;
  if (!rawLine) return null;
  return { filePath, lineNumber, rawLine };
}

function parseGrepLine(line: string): RawMatch | null {
  const i1 = line.indexOf(":");
  if (i1 === -1) return null;
  const i2 = line.indexOf(":", i1 + 1);
  if (i2 === -1) return null;
  const filePath = line.slice(0, i1);
  const lineNumber = Number.parseInt(line.slice(i1 + 1, i2), 10);
  if (Number.isNaN(lineNumber) || lineNumber <= 0) return null;
  const rawLine = line.slice(i2 + 1);
  if (!rawLine) return null;
  return { filePath, lineNumber, rawLine };
}
