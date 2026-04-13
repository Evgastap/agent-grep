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

const CHUNK_SIZE = 500;

export async function* runRipgrep(opts: SearchOptions): AsyncGenerator<RawMatch> {
  const baseArgs = ["--json", "--no-messages", "--no-config"];
  if (opts.caseInsensitive) baseArgs.push("-i");
  if (opts.fixedStrings) baseArgs.push("-F");
  baseArgs.push("-e", opts.query);

  for (let i = 0; i < opts.files.length; i += CHUNK_SIZE) {
    if (opts.signal?.aborted) return;
    const chunk = opts.files.slice(i, i + CHUNK_SIZE);
    if (chunk.length === 0) continue;

    const proc = Bun.spawn(["rg", ...baseArgs, ...chunk], {
      stdout: "pipe",
      stderr: "ignore",
    });

    const onAbort = () => {
      try {
        proc.kill();
      } catch {}
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        if (opts.signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const match = parseRgEvent(line);
          if (match) yield match;
        }
      }
      if (buffer && !opts.signal?.aborted) {
        const match = parseRgEvent(buffer);
        if (match) yield match;
      }
    } finally {
      reader.releaseLock();
      opts.signal?.removeEventListener("abort", onAbort);
      try {
        proc.kill();
      } catch {}
      await proc.exited.catch(() => {});
    }
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
