/**
 * Shared helpers for the Jira tracker plugin that uses the `acli` CLI
 * (the official Atlassian Command Line Interface).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Run the `acli` CLI with the given args and return trimmed stdout. */
export async function acli(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("acli", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`acli ${args.slice(0, 3).join(" ")} failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

export function parseJSON<T>(raw: string, context: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${context}: expected JSON but got: ${raw.slice(0, 200)}`, { cause: err });
  }
}

/**
 * Build the base URL of a Jira site from a `site` config value.
 *
 * Accepts:
 *   - a bare site name:   "mycompany"            → https://mycompany.atlassian.net
 *   - a host:             "mycompany.atlassian.net" → https://mycompany.atlassian.net
 *   - a full base URL:    "https://jira.acme.com"   → https://jira.acme.com
 */
export function buildBaseUrl(site: string): string {
  const s = site.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(s)) return s;
  if (s.includes(".")) return `https://${s}`;
  return `https://${s}.atlassian.net`;
}

/** Best-effort origin extraction from a Jira REST `self` URL. */
export function originFromSelf(self: string | undefined): string | undefined {
  if (!self) return undefined;
  try {
    return new URL(self).origin;
  } catch {
    return undefined;
  }
}

/** Quote and escape a JQL string literal. */
export function jqlString(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

/**
 * Flatten an Atlassian Document Format (ADF) value into plain text.
 *
 * Jira Cloud's REST v3 API (which `acli --json` mirrors) returns rich-text
 * fields like `description` as a nested ADF document rather than a string.
 * This walks the common node types so the agent prompt gets readable text.
 * Handles a plain string or null/undefined transparently.
 */
export function adfToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);

  const node = value as { type?: string; text?: string; content?: unknown[] };

  if (node.type === "text" && typeof node.text === "string") return node.text;
  if (node.type === "hardBreak" || node.type === "rule") return "\n";

  const children = Array.isArray(node.content) ? node.content : [];

  if (node.type === "bulletList" || node.type === "orderedList") {
    return children.map((item) => `- ${adfToText(item).trim()}`).join("\n") + "\n";
  }

  const joined = children.map(adfToText).join("");

  if (node.type === "paragraph" || node.type === "heading" || node.type === "codeBlock") {
    return joined + "\n";
  }

  return joined;
}
