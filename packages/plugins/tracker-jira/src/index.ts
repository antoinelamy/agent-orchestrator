/**
 * tracker-jira plugin — Jira work items as an issue tracker.
 *
 * Uses the official Atlassian CLI (`acli`) for all Jira interactions.
 * The CLI authenticates globally (`acli auth login`) against a single Jira
 * site, so commands do not take a site argument. The `site` config is only
 * used to construct human-facing `browse` URLs.
 *
 * Config (project `tracker` block):
 *   - site:              Jira site for URL building, e.g. "mycompany" or
 *                        "mycompany.atlassian.net" or "https://jira.acme.com"
 *   - projectKey:        default project key for `listIssues` / `createIssue`
 *   - labels:            persistent label filter (string or string[]) ANDed
 *                        into every `listIssues` query
 *   - defaultIssueType:  work item type for `createIssue` (default "Task")
 *   - doneStatus:        transition target for state "closed" (default "Done")
 *   - reopenStatus:      transition target for state "open" (default "To Do")
 *   - inProgressStatus:  transition target for state "in_progress"
 *                        (default "In Progress")
 */

import {
  memoizeAsync,
  type PluginModule,
  type Tracker,
  type Issue,
  type IssueFilters,
  type IssueUpdate,
  type CreateIssueInput,
  type ProjectConfig,
} from "@aoagents/ao-core";

import {
  acli,
  parseJSON,
  buildBaseUrl,
  originFromSelf,
  jqlString,
  adfToText,
} from "./acli-utils.js";

// ---------------------------------------------------------------------------
// Raw acli/Jira JSON shapes (subset of the Jira REST v3 issue representation)
// ---------------------------------------------------------------------------

interface JiraStatus {
  name?: string;
  statusCategory?: { key?: string };
}

interface JiraUser {
  displayName?: string;
  emailAddress?: string;
  accountId?: string;
}

interface JiraIssueData {
  key: string;
  self?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    status?: JiraStatus;
    assignee?: JiraUser | null;
    labels?: string[];
    issuetype?: { name?: string };
    priority?: { id?: string; name?: string };
  };
}

/** Fields requested from acli for full issue mapping. */
const ISSUE_FIELDS = "summary,status,assignee,description,issuetype,labels,priority";

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function mapState(status: JiraStatus | undefined): Issue["state"] {
  const category = status?.statusCategory?.key;
  if (category === "done") return "closed";
  if (category === "indeterminate") return "in_progress";
  if (category === "new") return "open";

  // Fallback: classify by status name when statusCategory is absent.
  const name = (status?.name ?? "").toLowerCase();
  if (name.includes("done") || name.includes("closed") || name.includes("resolved")) {
    return "closed";
  }
  if (name.includes("progress")) return "in_progress";
  return "open";
}

function toIssue(data: JiraIssueData, baseUrl: string | undefined): Issue {
  const f = data.fields ?? {};
  const url = baseUrl ? `${baseUrl}/browse/${data.key}` : data.key;
  const priorityId = f.priority?.id;
  return {
    id: data.key,
    title: f.summary ?? "",
    description: adfToText(f.description).trim(),
    url,
    state: mapState(f.status),
    labels: Array.isArray(f.labels) ? f.labels : [],
    assignee: f.assignee?.displayName ?? f.assignee?.emailAddress ?? undefined,
    priority: priorityId && /^\d+$/.test(priorityId) ? Number(priorityId) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Normalize a `labels` config value (string or string[]) to a clean array. */
function readStringArray(value: unknown): string[] | undefined {
  const raw = typeof value === "string" ? [value] : value;
  if (!Array.isArray(raw)) return undefined;
  const items = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  return items.length > 0 ? items : undefined;
}

// ---------------------------------------------------------------------------
// acli auth check (shared across calls in the same process)
// ---------------------------------------------------------------------------

async function checkAcliAuth(): Promise<void> {
  return memoizeAsync("acli-cli-auth", async () => {
    try {
      await acli(["--version"]);
    } catch {
      throw new Error(
        "Atlassian CLI (acli) is not installed. Install it: https://developer.atlassian.com/cloud/acli/",
      );
    }
    try {
      await acli(["auth", "status"]);
    } catch {
      throw new Error("Atlassian CLI (acli) is not authenticated. Run: acli auth login");
    }
  });
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createJiraTracker(config?: Record<string, unknown>): Tracker {
  const instanceSite = readString(config?.site);
  const instanceProjectKey = readString(config?.projectKey);
  const instanceLabels = readStringArray(config?.labels);
  const defaultIssueType = readString(config?.defaultIssueType) ?? "Task";
  const doneStatus = readString(config?.doneStatus) ?? "Done";
  const reopenStatus = readString(config?.reopenStatus) ?? "To Do";
  const inProgressStatus = readString(config?.inProgressStatus) ?? "In Progress";

  function resolveSite(project: ProjectConfig): string | undefined {
    return instanceSite ?? readString(project.tracker?.site);
  }

  function resolveProjectKey(project: ProjectConfig): string | undefined {
    return instanceProjectKey ?? readString(project.tracker?.projectKey);
  }

  /** Persistent label filter from config, ANDed into every listIssues query. */
  function resolveConfigLabels(project: ProjectConfig): string[] {
    return instanceLabels ?? readStringArray(project.tracker?.labels) ?? [];
  }

  function requireProjectKey(project: ProjectConfig): string {
    const key = resolveProjectKey(project);
    if (!key) {
      throw new Error(
        "Jira tracker requires a 'projectKey' in the tracker config for this operation",
      );
    }
    return key;
  }

  /** Base URL for browse links: configured site wins, else derive from `self`. */
  function baseUrlFor(project: ProjectConfig, self?: string): string | undefined {
    const site = resolveSite(project);
    if (site) return buildBaseUrl(site);
    return originFromSelf(self);
  }

  return {
    name: "jira",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const raw = await acli([
        "jira",
        "workitem",
        "view",
        identifier,
        "--json",
        "--fields",
        ISSUE_FIELDS,
      ]);
      const data = parseJSON<JiraIssueData>(raw, `getIssue for ${identifier}`);
      return toIssue(data, baseUrlFor(project, data.self));
    },

    async isCompleted(identifier: string, _project: ProjectConfig): Promise<boolean> {
      const raw = await acli([
        "jira",
        "workitem",
        "view",
        identifier,
        "--json",
        "--fields",
        "status",
      ]);
      const data = parseJSON<JiraIssueData>(raw, `isCompleted for ${identifier}`);
      return mapState(data.fields?.status) === "closed";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const site = resolveSite(project);
      if (!site) {
        throw new Error(
          "Jira tracker requires a 'site' in the tracker config to build issue URLs " +
            "(e.g. site: mycompany or mycompany.atlassian.net)",
        );
      }
      return `${buildBaseUrl(site)}/browse/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      const match = url.match(/\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/);
      if (match) return match[1];
      const parts = url.split("/");
      const last = parts[parts.length - 1];
      return last || url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      // Keep the Jira key intact so Jira auto-links the branch/PR to the issue.
      return `feat/${identifier}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on Jira work item ${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this work item. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const clauses: string[] = [];

      const projectKey = resolveProjectKey(project);
      if (projectKey) clauses.push(`project = ${jqlString(projectKey)}`);

      if (filters.state === "closed") {
        clauses.push("statusCategory = Done");
      } else if (filters.state !== "all") {
        // default + "open"
        clauses.push("statusCategory != Done");
      }

      if (filters.labels && filters.labels.length > 0) {
        clauses.push(`labels in (${filters.labels.map(jqlString).join(", ")})`);
      }

      // Persistent label filter from config — separate AND clause so a runtime
      // label filter narrows within the configured labels rather than replacing them.
      const configLabels = resolveConfigLabels(project);
      if (configLabels.length > 0) {
        clauses.push(`labels in (${configLabels.map(jqlString).join(", ")})`);
      }

      if (filters.assignee) {
        clauses.push(`assignee = ${jqlString(filters.assignee)}`);
      }

      const jql = `${clauses.join(" AND ")}${clauses.length ? " " : ""}ORDER BY created DESC`;

      const raw = await acli([
        "jira",
        "workitem",
        "search",
        "--jql",
        jql,
        "--json",
        "--limit",
        String(filters.limit ?? 30),
        "--fields",
        ISSUE_FIELDS,
      ]);

      // acli search may return a bare array or a Jira-style { issues: [...] }.
      const parsed = parseJSON<JiraIssueData[] | { issues?: JiraIssueData[] }>(raw, "listIssues");
      const issues = Array.isArray(parsed) ? parsed : (parsed.issues ?? []);
      return issues.map((data) => toIssue(data, baseUrlFor(project, data.self)));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      _project: ProjectConfig,
    ): Promise<void> {
      if (update.state) {
        const status =
          update.state === "closed"
            ? doneStatus
            : update.state === "in_progress"
              ? inProgressStatus
              : reopenStatus;
        await acli([
          "jira",
          "workitem",
          "transition",
          "--key",
          identifier,
          "--status",
          status,
          "--yes",
        ]);
      }

      if (update.removeLabels && update.removeLabels.length > 0) {
        await acli([
          "jira",
          "workitem",
          "edit",
          "--key",
          identifier,
          "--remove-labels",
          update.removeLabels.join(","),
          "--yes",
        ]);
      }

      // Jira's `edit --labels` replaces the label set (no native add flag).
      if (update.labels && update.labels.length > 0) {
        await acli([
          "jira",
          "workitem",
          "edit",
          "--key",
          identifier,
          "--labels",
          update.labels.join(","),
          "--yes",
        ]);
      }

      if (update.assignee) {
        await acli([
          "jira",
          "workitem",
          "edit",
          "--key",
          identifier,
          "--assignee",
          update.assignee,
          "--yes",
        ]);
      }

      if (update.comment) {
        await acli([
          "jira",
          "workitem",
          "comment",
          "create",
          "--key",
          identifier,
          "--body",
          update.comment,
        ]);
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const args = [
        "jira",
        "workitem",
        "create",
        "--project",
        requireProjectKey(project),
        "--type",
        defaultIssueType,
        "--summary",
        input.title,
        "--description",
        input.description ?? "",
        "--json",
      ];

      if (input.labels && input.labels.length > 0) {
        args.push("--label", input.labels.join(","));
      }

      if (input.assignee) {
        args.push("--assignee", input.assignee);
      }

      const raw = await acli(args);
      const created = parseJSON<{ key?: string; issue?: { key?: string } }>(raw, "createIssue");
      const key = created.key ?? created.issue?.key;
      if (!key) {
        throw new Error(`Failed to parse work item key from acli output: ${raw.slice(0, 200)}`);
      }

      return this.getIssue(key, project);
    },

    async preflight(): Promise<void> {
      await checkAcliAuth();
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "jira",
  slot: "tracker" as const,
  description: "Tracker plugin: Jira work items",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): Tracker {
  return createJiraTracker(config);
}

export default { manifest, create } satisfies PluginModule<Tracker>;
