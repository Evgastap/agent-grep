import type { LogEntry, Role } from "./parse.ts";

export interface Filters {
  project?: string;
  role?: Role | null;
  since?: Date | null;
  until?: Date | null;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileRegex(
  query: string,
  opts: { ignoreCase?: boolean; fixed?: boolean },
): RegExp {
  const flags = opts.ignoreCase ? "i" : "";
  const pattern = opts.fixed ? escapeRegex(query) : query;
  return new RegExp(pattern, flags);
}

export function parseDateOrNull(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function passesFilters(
  entry: LogEntry,
  regex: RegExp,
  filters: Filters,
): boolean {
  if (!regex.test(entry.text)) return false;

  if (filters.project) {
    const needle = filters.project.toLowerCase();
    if (!entry.project.toLowerCase().includes(needle)) return false;
  }

  if (filters.role && entry.role !== filters.role) return false;

  if (filters.since || filters.until) {
    const ts = entry.timestamp;
    if (!ts || Number.isNaN(ts.getTime())) return false;
    if (filters.since && ts < filters.since) return false;
    if (filters.until && ts > filters.until) return false;
  }

  return true;
}
