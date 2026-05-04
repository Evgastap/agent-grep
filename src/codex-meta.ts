import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { CodexContext } from "./parse.ts";
import { getCodexRoot } from "./paths.ts";

const cache = new Map<string, CodexContext>();

const sessionIdToPath = new Map<string, string>();
const rootCache = new Map<string, CodexContext>();

let spawnEdges: Map<string, string> | null = null;
let threadMeta: Map<string, { cwd: string; gitBranch?: string }> | null = null;

export async function getCodexContext(filePath: string): Promise<CodexContext> {
  const cached = cache.get(filePath);
  if (cached) return cached;
  const ctx = await loadCodexContext(filePath);
  cache.set(filePath, ctx);
  return ctx;
}

export function buildCodexSessionIndex(files: string[]): void {
  sessionIdToPath.clear();
  rootCache.clear();
  spawnEdges = null;
  threadMeta = null;
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const sid = extractSessionIdFromPath(f);
    if (sid) sessionIdToPath.set(sid, f);
  }
}

export async function resolveCodexRoot(
  ctx: CodexContext,
): Promise<CodexContext> {
  const cached = rootCache.get(ctx.sessionId);
  if (cached) return cached;

  let current = ctx;
  const visited = new Set<string>([ctx.sessionId]);

  while (true) {
    const parentId = current.forkedFromId ?? (await getParentFromSqlite(current.sessionId));
    if (!parentId || visited.has(parentId)) break;
    const parentPath = sessionIdToPath.get(parentId);
    if (!parentPath) break;
    const parentCtx = await getCodexContext(parentPath);
    if (!parentCtx.sessionId || parentCtx.sessionId === current.sessionId) break;
    visited.add(parentId);
    current = parentCtx;
  }

  rootCache.set(ctx.sessionId, current);
  return current;
}

async function getParentFromSqlite(childId: string): Promise<string | undefined> {
  const edges = await loadSpawnEdges();
  return edges.get(childId);
}

export async function getThreadMeta(sessionId: string): Promise<{ cwd: string; gitBranch?: string } | undefined> {
  const meta = await loadThreadMeta();
  return meta.get(sessionId);
}

async function loadSpawnEdges(): Promise<Map<string, string>> {
  if (spawnEdges) return spawnEdges;
  spawnEdges = new Map();

  const dbPath = join(getCodexRoot(), "state_5.sqlite");
  try {
    await access(dbPath);
  } catch {
    return spawnEdges;
  }

  const rows = await querySqlite(
    dbPath,
    "SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges",
  );
  for (const row of rows) {
    if (row.length >= 2 && row[0] && row[1]) {
      spawnEdges.set(row[1], row[0]);
    }
  }

  // Older sessions may not be in thread_spawn_edges but have the parent
  // embedded in the threads.source JSON column.
  const sourceRows = await querySqlite(
    dbPath,
    "SELECT id, source FROM threads WHERE source LIKE '%thread_spawn%'",
  );
  for (const row of sourceRows) {
    const childId = row[0];
    if (!childId || spawnEdges.has(childId)) continue;
    try {
      const src = JSON.parse(row[1] ?? "");
      const parentId = src?.subagent?.thread_spawn?.parent_thread_id;
      if (typeof parentId === "string") {
        spawnEdges.set(childId, parentId);
      }
    } catch {}
  }

  return spawnEdges;
}

async function loadThreadMeta(): Promise<Map<string, { cwd: string; gitBranch?: string }>> {
  if (threadMeta) return threadMeta;
  threadMeta = new Map();

  const dbPath = join(getCodexRoot(), "state_5.sqlite");
  try {
    await access(dbPath);
  } catch {
    return threadMeta;
  }

  const rows = await querySqlite(
    dbPath,
    "SELECT id, cwd, git_branch FROM threads",
  );
  for (const row of rows) {
    if (row.length >= 2 && row[0]) {
      threadMeta.set(row[0], {
        cwd: row[1] ?? "",
        gitBranch: row[2] || undefined,
      });
    }
  }
  return threadMeta;
}

function querySqlite(dbPath: string, sql: string): Promise<string[][]> {
  return new Promise((resolve) => {
    execFile(
      "sqlite3",
      ["-separator", "\x1f", dbPath, sql],
      { timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve([]);
          return;
        }
        const rows = stdout.trim().split("\n").map((line) => line.split("\x1f"));
        resolve(rows);
      },
    );
  });
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
        const sessionId =
          typeof payload.id === "string" ? payload.id : fallback.sessionId;

        let project = typeof payload.cwd === "string" ? payload.cwd : "";
        if (!project) {
          const meta = await getThreadMeta(sessionId);
          if (meta) project = meta.cwd;
        }

        return {
          sessionId,
          project,
          forkedFromId:
            typeof payload.forked_from_id === "string"
              ? payload.forked_from_id
              : undefined,
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
