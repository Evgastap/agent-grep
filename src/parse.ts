export type Role = "user" | "assistant" | "system" | "tool" | "unknown";
export type Source = "claude-code" | "codex";

export interface HistoryEntry {
  kind: "history";
  source: "claude-code";
  text: string;
  timestamp: Date;
  project: string;
  sessionId: null;
  role: "user";
}

export interface SessionEntry {
  kind: "session";
  source: Source;
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

export interface CodexContext {
  sessionId: string;
  project: string;
}

export function parseEntry(
  rawLine: string,
  source: Source = "claude-code",
  codexCtx?: CodexContext,
): LogEntry | null {
  if (source === "codex") return parseCodexEntry(rawLine, codexCtx);
  return parseClaudeEntry(rawLine);
}

function parseJSON(rawLine: string): Record<string, unknown> | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (!obj || typeof obj !== "object") return null;
    return obj as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseClaudeEntry(rawLine: string): LogEntry | null {
  const o = parseJSON(rawLine);
  if (!o) return null;

  if (typeof o.display === "string" && typeof o.project === "string") {
    const ts =
      typeof o.timestamp === "number"
        ? new Date(o.timestamp)
        : typeof o.timestamp === "string"
          ? new Date(o.timestamp)
          : new Date(0);
    return {
      kind: "history",
      source: "claude-code",
      text: o.display,
      timestamp: ts,
      project: o.project,
      sessionId: null,
      role: "user",
    };
  }

  if (typeof o.sessionId === "string" && o.message && typeof o.message === "object") {
    const msg = o.message as Record<string, unknown>;
    const text = extractClaudeMessageText(msg);
    const role = normalizeRole((o.type as string) ?? (msg.role as string));
    return {
      kind: "session",
      source: "claude-code",
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

export function parseCodexEntry(
  rawLine: string,
  ctx?: CodexContext,
): LogEntry | null {
  const o = parseJSON(rawLine);
  if (!o) return null;

  if (typeof o.session_id === "string" && typeof o.text === "string") {
    const ts =
      typeof o.ts === "number"
        ? new Date(o.ts * 1000)
        : typeof o.ts === "string"
          ? new Date(o.ts)
          : null;
    return {
      kind: "session",
      source: "codex",
      text: o.text,
      timestamp: ts,
      project: "",
      sessionId: o.session_id,
      role: "user",
      isSidechain: false,
    };
  }

  if (!ctx) return null;
  if (o.type === "session_meta") return null;
  if (o.type !== "response_item") return null;

  const payload = o.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return null;

  const timestamp =
    typeof o.timestamp === "string" ? new Date(o.timestamp) : null;

  const base = {
    kind: "session" as const,
    source: "codex" as const,
    timestamp,
    project: ctx.project,
    sessionId: ctx.sessionId,
    isSidechain: false,
  };

  switch (payload.type) {
    case "message": {
      const text = extractCodexContent(payload.content);
      const rawRole = typeof payload.role === "string" ? payload.role : "";
      const role = rawRole === "developer" ? "system" : normalizeRole(rawRole);
      return { ...base, text, role };
    }
    case "reasoning": {
      const summary = extractCodexContent(payload.summary);
      const content = extractCodexContent(payload.content);
      const text = [summary, content].filter(Boolean).join("\n");
      if (!text) return null;
      return { ...base, text: `[reasoning] ${text}`, role: "assistant" };
    }
    case "function_call":
    case "custom_tool_call": {
      const name = typeof payload.name === "string" ? payload.name : "tool";
      const args =
        typeof payload.arguments === "string" ? payload.arguments : "";
      return {
        ...base,
        text: `[${name}] ${args}`,
        role: "assistant",
      };
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const output = payload.output;
      let text = "";
      if (typeof output === "string") {
        text = output;
      } else if (output && typeof output === "object") {
        const o2 = output as Record<string, unknown>;
        text =
          typeof o2.content === "string"
            ? o2.content
            : typeof o2.output === "string"
              ? o2.output
              : JSON.stringify(output);
      }
      return { ...base, text, role: "tool" };
    }
    case "local_shell_call": {
      const action = payload.action as Record<string, unknown> | undefined;
      const cmd =
        action && typeof action === "object"
          ? JSON.stringify(action)
          : "(shell)";
      return { ...base, text: `[shell] ${cmd}`, role: "assistant" };
    }
    case "web_search_call": {
      return { ...base, text: "[web_search]", role: "assistant" };
    }
    default:
      return null;
  }
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

function extractClaudeMessageText(msg: Record<string, unknown>): string {
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

function extractCodexContent(content: unknown): string {
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
    if (typeof part.text === "string") {
      parts.push(part.text);
      continue;
    }
    if (part.type === "input_image" && typeof part.image_url === "string") {
      parts.push(`[image]`);
    }
  }
  return parts.join("\n");
}
