import { createReadStream } from "node:fs";
import type { CodexContext } from "./parse.ts";

const cache = new Map<string, CodexContext>();

export async function getCodexContext(filePath: string): Promise<CodexContext> {
  const cached = cache.get(filePath);
  if (cached) return cached;
  const ctx = await loadCodexContext(filePath);
  cache.set(filePath, ctx);
  return ctx;
}

const MAX_FIRST_LINE_BYTES = 2 * 1024 * 1024;

async function loadCodexContext(filePath: string): Promise<CodexContext> {
  const fallback: CodexContext = {
    sessionId: extractSessionIdFromPath(filePath),
    project: "",
  };

  const firstLine = await readFirstLine(filePath);
  if (!firstLine) return fallback;

  try {
    const obj = JSON.parse(firstLine);
    if (
      obj &&
      typeof obj === "object" &&
      (obj as { type?: unknown }).type === "session_meta"
    ) {
      const payload = (obj as { payload?: Record<string, unknown> }).payload;
      if (payload && typeof payload === "object") {
        return {
          sessionId:
            typeof payload.id === "string" ? payload.id : fallback.sessionId,
          project: typeof payload.cwd === "string" ? payload.cwd : "",
        };
      }
    }
  } catch {
    // Corrupt first line — fall back.
  }

  return fallback;
}

async function readFirstLine(filePath: string): Promise<string | null> {
  let stream: ReturnType<typeof createReadStream> | null = null;
  try {
    stream = createReadStream(filePath);
    stream.on("error", () => {});
    const decoder = new TextDecoder();
    let buffer = "";
    let totalBytes = 0;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      totalBytes += chunk.byteLength;
      buffer += decoder.decode(chunk, { stream: true });
      const nl = buffer.indexOf("\n");
      if (nl !== -1) return buffer.slice(0, nl);
      if (totalBytes > MAX_FIRST_LINE_BYTES) return null;
    }
    buffer += decoder.decode();
    const nl = buffer.indexOf("\n");
    return nl === -1 ? (buffer || null) : buffer.slice(0, nl);
  } catch {
    return null;
  } finally {
    try {
      stream?.destroy();
    } catch {}
  }
}

function extractSessionIdFromPath(filePath: string): string {
  const m = filePath.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return m ? m[1] ?? "" : "";
}
