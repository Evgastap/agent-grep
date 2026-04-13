export type Role = "user" | "assistant" | "system" | "tool" | "unknown";

export interface HistoryEntry {
  kind: "history";
  text: string;
  timestamp: Date;
  project: string;
  sessionId: null;
  role: "user";
}

export interface SessionEntry {
  kind: "session";
  text: string;
  timestamp: Date | null;
  project: string;
  sessionId: string;
  role: Role;
  agentId?: string;
  isSidechain: boolean;
  gitBranch?: string;
  uuid?: string;
}

export type LogEntry = HistoryEntry | SessionEntry;

export function parseEntry(rawLine: string): LogEntry | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  if (typeof o.display === "string" && typeof o.project === "string") {
    const ts =
      typeof o.timestamp === "number"
        ? new Date(o.timestamp)
        : typeof o.timestamp === "string"
          ? new Date(o.timestamp)
          : new Date(0);
    return {
      kind: "history",
      text: o.display,
      timestamp: ts,
      project: o.project,
      sessionId: null,
      role: "user",
    };
  }

  if (typeof o.sessionId === "string" && o.message && typeof o.message === "object") {
    const msg = o.message as Record<string, unknown>;
    const text = extractMessageText(msg);
    const role = normalizeRole((o.type as string) ?? (msg.role as string));
    return {
      kind: "session",
      text,
      timestamp: typeof o.timestamp === "string" ? new Date(o.timestamp) : null,
      project: typeof o.cwd === "string" ? o.cwd : "",
      sessionId: o.sessionId,
      role,
      agentId: typeof o.agentId === "string" ? o.agentId : undefined,
      isSidechain: Boolean(o.isSidechain),
      gitBranch: typeof o.gitBranch === "string" ? o.gitBranch : undefined,
      uuid: typeof o.uuid === "string" ? o.uuid : undefined,
    };
  }

  return null;
}

function normalizeRole(r: string | undefined): Role {
  switch (r) {
    case "user":
    case "assistant":
    case "system":
    case "tool":
      return r;
    default:
      return "unknown";
  }
}

function extractMessageText(msg: Record<string, unknown>): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const p of content) {
    if (typeof p === "string") {
      parts.push(p);
      continue;
    }
    if (!p || typeof p !== "object") continue;
    const part = p as Record<string, unknown>;
    switch (part.type) {
      case "text":
        if (typeof part.text === "string") parts.push(part.text);
        break;
      case "tool_use": {
        const name = typeof part.name === "string" ? part.name : "tool";
        const input = part.input ? JSON.stringify(part.input) : "";
        parts.push(`[${name}] ${input}`);
        break;
      }
      case "tool_result": {
        const c = part.content;
        if (typeof c === "string") {
          parts.push(c);
        } else if (Array.isArray(c)) {
          for (const x of c) {
            if (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string") {
              parts.push((x as { text: string }).text);
            }
          }
        }
        break;
      }
      case "thinking":
        if (typeof part.thinking === "string") parts.push(part.thinking);
        break;
    }
  }
  return parts.join("\n");
}
