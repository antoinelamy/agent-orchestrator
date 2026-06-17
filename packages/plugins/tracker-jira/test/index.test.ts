import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:child_process
// ---------------------------------------------------------------------------
const { acliMock } = vi.hoisted(() => ({ acliMock: vi.fn() }));

vi.mock("node:child_process", () => {
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: acliMock,
  });
  return { execFile };
});

import { create, manifest } from "../src/index.js";
import { adfToText, buildBaseUrl, jqlString } from "../src/acli-utils.js";
import type { ProjectConfig } from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const project: ProjectConfig = {
  name: "test",
  repo: "acme/repo",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
  tracker: { plugin: "jira", site: "acme", projectKey: "PROJ" },
};

function mockAcli(result: unknown) {
  acliMock.mockResolvedValueOnce({ stdout: JSON.stringify(result) });
}

function mockAcliRaw(stdout: string) {
  acliMock.mockResolvedValueOnce({ stdout });
}

function mockAcliError(msg = "Command failed") {
  acliMock.mockRejectedValueOnce(new Error(msg));
}

const sampleIssue = {
  key: "PROJ-123",
  self: "https://acme.atlassian.net/rest/api/3/issue/10001",
  fields: {
    summary: "Fix login bug",
    description: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Users can't log in with SSO" }],
        },
      ],
    },
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    assignee: { displayName: "Alice", emailAddress: "alice@acme.com", accountId: "a1" },
    labels: ["bug", "priority-high"],
    issuetype: { name: "Bug" },
    priority: { id: "2", name: "High" },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tracker-jira plugin", () => {
  let tracker: ReturnType<typeof create>;

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = create({ site: "acme", projectKey: "PROJ" });
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("jira");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("jira");
    });
  });

  // ---- getIssue ----------------------------------------------------------

  describe("getIssue", () => {
    it("returns Issue with correct fields", async () => {
      mockAcli(sampleIssue);
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue).toEqual({
        id: "PROJ-123",
        title: "Fix login bug",
        description: "Users can't log in with SSO",
        url: "https://acme.atlassian.net/browse/PROJ-123",
        state: "in_progress",
        labels: ["bug", "priority-high"],
        assignee: "Alice",
        priority: 2,
      });
    });

    it("invokes acli with view + --json + fields", async () => {
      mockAcli(sampleIssue);
      await tracker.getIssue("PROJ-123", project);
      expect(acliMock).toHaveBeenCalledWith(
        "acli",
        expect.arrayContaining(["jira", "workitem", "view", "PROJ-123", "--json"]),
        expect.any(Object),
      );
    });

    it("maps done statusCategory to closed", async () => {
      mockAcli({
        ...sampleIssue,
        fields: { ...sampleIssue.fields, status: { statusCategory: { key: "done" } } },
      });
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.state).toBe("closed");
    });

    it("maps new statusCategory to open", async () => {
      mockAcli({
        ...sampleIssue,
        fields: { ...sampleIssue.fields, status: { statusCategory: { key: "new" } } },
      });
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.state).toBe("open");
    });

    it("handles a plain-string description", async () => {
      mockAcli({ ...sampleIssue, fields: { ...sampleIssue.fields, description: "plain text" } });
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.description).toBe("plain text");
    });

    it("handles missing description gracefully", async () => {
      mockAcli({ ...sampleIssue, fields: { ...sampleIssue.fields, description: null } });
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.description).toBe("");
    });

    it("handles missing assignee", async () => {
      mockAcli({ ...sampleIssue, fields: { ...sampleIssue.fields, assignee: null } });
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.assignee).toBeUndefined();
    });

    it("falls back to email when displayName is absent", async () => {
      mockAcli({
        ...sampleIssue,
        fields: { ...sampleIssue.fields, assignee: { emailAddress: "bob@acme.com" } },
      });
      const issue = await tracker.getIssue("PROJ-123", project);
      expect(issue.assignee).toBe("bob@acme.com");
    });

    it("derives browse URL from self when no site is configured", async () => {
      const noSiteTracker = create();
      const noSiteProject = { ...project, tracker: { plugin: "jira" } };
      mockAcli(sampleIssue);
      const issue = await noSiteTracker.getIssue("PROJ-123", noSiteProject);
      expect(issue.url).toBe("https://acme.atlassian.net/browse/PROJ-123");
    });

    it("propagates acli CLI errors", async () => {
      mockAcliError("issue not found");
      await expect(tracker.getIssue("PROJ-999", project)).rejects.toThrow("issue not found");
    });

    it("throws on malformed JSON response", async () => {
      mockAcliRaw("not json{");
      await expect(tracker.getIssue("PROJ-123", project)).rejects.toThrow();
    });
  });

  // ---- isCompleted -------------------------------------------------------

  describe("isCompleted", () => {
    it("returns true for done items", async () => {
      mockAcli({ key: "PROJ-1", fields: { status: { statusCategory: { key: "done" } } } });
      expect(await tracker.isCompleted("PROJ-1", project)).toBe(true);
    });

    it("returns false for in-progress items", async () => {
      mockAcli({
        key: "PROJ-1",
        fields: { status: { statusCategory: { key: "indeterminate" } } },
      });
      expect(await tracker.isCompleted("PROJ-1", project)).toBe(false);
    });

    it("falls back to status name when no statusCategory", async () => {
      mockAcli({ key: "PROJ-1", fields: { status: { name: "Resolved" } } });
      expect(await tracker.isCompleted("PROJ-1", project)).toBe(true);
    });
  });

  // ---- issueUrl ----------------------------------------------------------

  describe("issueUrl", () => {
    it("builds URL from bare site name", () => {
      expect(tracker.issueUrl("PROJ-42", project)).toBe(
        "https://acme.atlassian.net/browse/PROJ-42",
      );
    });

    it("uses a host-style site verbatim", () => {
      const t = create({ site: "acme.atlassian.net" });
      expect(t.issueUrl("PROJ-42", project)).toBe("https://acme.atlassian.net/browse/PROJ-42");
    });

    it("uses a full base URL verbatim", () => {
      const t = create({ site: "https://jira.acme.com" });
      expect(t.issueUrl("PROJ-42", project)).toBe("https://jira.acme.com/browse/PROJ-42");
    });

    it("falls back to project.tracker.site when instance config has none", () => {
      const t = create();
      expect(t.issueUrl("PROJ-42", project)).toBe("https://acme.atlassian.net/browse/PROJ-42");
    });

    it("throws when no site is configured", () => {
      const t = create();
      const noSite = { ...project, tracker: { plugin: "jira" } };
      expect(() => t.issueUrl("PROJ-42", noSite)).toThrow("requires a 'site'");
    });
  });

  // ---- issueLabel --------------------------------------------------------

  describe("issueLabel", () => {
    it("extracts the key from a browse URL", () => {
      expect(tracker.issueLabel!("https://acme.atlassian.net/browse/PROJ-42", project)).toBe(
        "PROJ-42",
      );
    });

    it("falls back to the last URL segment", () => {
      expect(tracker.issueLabel!("https://example.com/foo/PROJ-7", project)).toBe("PROJ-7");
    });
  });

  // ---- branchName --------------------------------------------------------

  describe("branchName", () => {
    it("includes the Jira key", () => {
      expect(tracker.branchName("PROJ-42", project)).toBe("feat/PROJ-42");
    });

    it("honors a custom branchPrefix from config", () => {
      const t = create({ site: "acme", projectKey: "PROJ", branchPrefix: "feature" });
      expect(t.branchName("PROJ-42", project)).toBe("feature/PROJ-42");
    });

    it("trims a trailing slash from branchPrefix", () => {
      const t = create({ site: "acme", branchPrefix: "feature/" });
      expect(t.branchName("PROJ-42", project)).toBe("feature/PROJ-42");
    });

    it("falls back to feat when branchPrefix is empty", () => {
      const t = create({ site: "acme", branchPrefix: "" });
      expect(t.branchName("PROJ-42", project)).toBe("feat/PROJ-42");
    });

    it("honors a branchTemplate with a {key} placeholder", () => {
      const t = create({ site: "acme", branchTemplate: "agents/{key}-wip" });
      expect(t.branchName("PROJ-42", project)).toBe("agents/PROJ-42-wip");
    });

    it("branchTemplate takes precedence over branchPrefix", () => {
      const t = create({ site: "acme", branchPrefix: "feature", branchTemplate: "x/{key}" });
      expect(t.branchName("PROJ-42", project)).toBe("x/PROJ-42");
    });
  });

  // ---- generatePrompt ----------------------------------------------------

  describe("generatePrompt", () => {
    it("includes key, title and URL", async () => {
      mockAcli(sampleIssue);
      const prompt = await tracker.generatePrompt("PROJ-123", project);
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("https://acme.atlassian.net/browse/PROJ-123");
      expect(prompt).toContain("PROJ-123");
    });

    it("includes labels and description", async () => {
      mockAcli(sampleIssue);
      const prompt = await tracker.generatePrompt("PROJ-123", project);
      expect(prompt).toContain("bug, priority-high");
      expect(prompt).toContain("Users can't log in with SSO");
    });

    it("omits labels section when none", async () => {
      mockAcli({ ...sampleIssue, fields: { ...sampleIssue.fields, labels: [] } });
      const prompt = await tracker.generatePrompt("PROJ-123", project);
      expect(prompt).not.toContain("Labels:");
    });

    it("omits description section when empty", async () => {
      mockAcli({ ...sampleIssue, fields: { ...sampleIssue.fields, description: null } });
      const prompt = await tracker.generatePrompt("PROJ-123", project);
      expect(prompt).not.toContain("## Description");
    });
  });

  // ---- listIssues --------------------------------------------------------

  describe("listIssues", () => {
    it("returns mapped issues from a bare array", async () => {
      mockAcli([sampleIssue, { ...sampleIssue, key: "PROJ-456" }]);
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe("PROJ-123");
      expect(issues[1].id).toBe("PROJ-456");
    });

    it("handles a Jira-style { issues: [] } response", async () => {
      mockAcli({ issues: [sampleIssue] });
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe("PROJ-123");
    });

    it("scopes by project and excludes Done by default", async () => {
      mockAcli([]);
      await tracker.listIssues!({}, project);
      const jql = (acliMock.mock.calls[0][1] as string[])[acliMock.mock.calls[0][1].indexOf("--jql") + 1];
      expect(jql).toContain('project = "PROJ"');
      expect(jql).toContain("statusCategory != Done");
    });

    it("filters to Done for closed state", async () => {
      mockAcli([]);
      await tracker.listIssues!({ state: "closed" }, project);
      const args = acliMock.mock.calls[0][1] as string[];
      const jql = args[args.indexOf("--jql") + 1];
      expect(jql).toContain("statusCategory = Done");
    });

    it("omits status clause for all state", async () => {
      mockAcli([]);
      await tracker.listIssues!({ state: "all" }, project);
      const args = acliMock.mock.calls[0][1] as string[];
      const jql = args[args.indexOf("--jql") + 1];
      expect(jql).not.toContain("statusCategory");
    });

    it("adds label and assignee clauses", async () => {
      mockAcli([]);
      await tracker.listIssues!({ labels: ["bug"], assignee: "alice@acme.com" }, project);
      const args = acliMock.mock.calls[0][1] as string[];
      const jql = args[args.indexOf("--jql") + 1];
      expect(jql).toContain('labels in ("bug")');
      expect(jql).toContain('assignee = "alice@acme.com"');
    });

    it("respects custom limit", async () => {
      mockAcli([]);
      await tracker.listIssues!({ limit: 5 }, project);
      expect(acliMock).toHaveBeenCalledWith(
        "acli",
        expect.arrayContaining(["--limit", "5"]),
        expect.any(Object),
      );
    });

    it("applies a config-level label filter to every query", async () => {
      const t = create({ site: "acme", projectKey: "PROJ", labels: ["backlog", "ready"] });
      mockAcli([]);
      await t.listIssues!({}, project);
      const args = acliMock.mock.calls[0][1] as string[];
      const jql = args[args.indexOf("--jql") + 1];
      expect(jql).toContain('labels in ("backlog", "ready")');
    });

    it("ANDs config labels with a runtime label filter", async () => {
      const t = create({ site: "acme", projectKey: "PROJ", labels: ["backlog"] });
      mockAcli([]);
      await t.listIssues!({ labels: ["bug"] }, project);
      const args = acliMock.mock.calls[0][1] as string[];
      const jql = args[args.indexOf("--jql") + 1];
      // Two distinct clauses, ANDed: runtime narrows within configured labels.
      expect(jql).toContain('labels in ("bug")');
      expect(jql).toContain('labels in ("backlog")');
      expect(jql).toContain(" AND ");
    });

    it("accepts a single-string config label", async () => {
      const t = create({ site: "acme", labels: "backlog" });
      mockAcli([]);
      await t.listIssues!({}, project);
      const args = acliMock.mock.calls[0][1] as string[];
      const jql = args[args.indexOf("--jql") + 1];
      expect(jql).toContain('labels in ("backlog")');
    });

    it("reads labels from project.tracker when instance config has none", async () => {
      const t = create();
      const labeledProject = {
        ...project,
        tracker: { plugin: "jira", site: "acme", projectKey: "PROJ", labels: ["triage"] },
      };
      mockAcli([]);
      await t.listIssues!({}, labeledProject);
      const args = acliMock.mock.calls[0][1] as string[];
      const jql = args[args.indexOf("--jql") + 1];
      expect(jql).toContain('labels in ("triage")');
    });
  });

  // ---- updateIssue -------------------------------------------------------

  describe("updateIssue", () => {
    it("transitions to Done when closing", async () => {
      mockAcliRaw("");
      await tracker.updateIssue!("PROJ-1", { state: "closed" }, project);
      expect(acliMock).toHaveBeenCalledWith(
        "acli",
        ["jira", "workitem", "transition", "--key", "PROJ-1", "--status", "Done", "--yes"],
        expect.any(Object),
      );
    });

    it("transitions to In Progress for in_progress state", async () => {
      mockAcliRaw("");
      await tracker.updateIssue!("PROJ-1", { state: "in_progress" }, project);
      expect(acliMock).toHaveBeenCalledWith(
        "acli",
        expect.arrayContaining(["transition", "--status", "In Progress"]),
        expect.any(Object),
      );
    });

    it("uses a configured doneStatus", async () => {
      const t = create({ site: "acme", doneStatus: "Closed" });
      mockAcliRaw("");
      await t.updateIssue!("PROJ-1", { state: "closed" }, project);
      expect(acliMock).toHaveBeenCalledWith(
        "acli",
        expect.arrayContaining(["--status", "Closed"]),
        expect.any(Object),
      );
    });

    it("replaces labels via edit --labels", async () => {
      mockAcliRaw("");
      await tracker.updateIssue!("PROJ-1", { labels: ["a", "b"] }, project);
      expect(acliMock).toHaveBeenCalledWith(
        "acli",
        ["jira", "workitem", "edit", "--key", "PROJ-1", "--labels", "a,b", "--yes"],
        expect.any(Object),
      );
    });

    it("removes labels via --remove-labels", async () => {
      mockAcliRaw("");
      await tracker.updateIssue!("PROJ-1", { removeLabels: ["old"] }, project);
      expect(acliMock).toHaveBeenCalledWith(
        "acli",
        expect.arrayContaining(["--remove-labels", "old"]),
        expect.any(Object),
      );
    });

    it("adds a comment", async () => {
      mockAcliRaw("");
      await tracker.updateIssue!("PROJ-1", { comment: "Working on this" }, project);
      expect(acliMock).toHaveBeenCalledWith(
        "acli",
        ["jira", "workitem", "comment", "create", "--key", "PROJ-1", "--body", "Working on this"],
        expect.any(Object),
      );
    });

    it("performs multiple updates in one call", async () => {
      acliMock.mockResolvedValue({ stdout: "" });
      await tracker.updateIssue!(
        "PROJ-1",
        { state: "closed", labels: ["done"], comment: "Done!" },
        project,
      );
      expect(acliMock).toHaveBeenCalledTimes(3);
    });
  });

  // ---- statusMapping -----------------------------------------------------

  describe("statusMapping", () => {
    const statusMap = {
      "agent:backlog": "Selected for Development",
      "agent:in-progress": "In Progress",
      "merged-unverified": "QA",
      "agent:done": "Done",
    };

    function jqlFromLastCall(): string {
      const args = acliMock.mock.calls[0][1] as string[];
      return args[args.indexOf("--jql") + 1];
    }

    describe("listIssues", () => {
      it("selects a mapped lifecycle label by status, not by label", async () => {
        const t = create({ site: "acme", projectKey: "PROJ", statusMapping: statusMap });
        mockAcli([]);
        await t.listIssues!({ state: "open", labels: ["agent:backlog"] }, project);
        const jql = jqlFromLastCall();
        expect(jql).toContain('status in ("Selected for Development")');
        expect(jql).not.toContain('labels in ("agent:backlog")');
      });

      it("keeps unmapped labels as a label clause", async () => {
        const t = create({ site: "acme", projectKey: "PROJ", statusMapping: statusMap });
        mockAcli([]);
        await t.listIssues!({ labels: ["agent:backlog", "needs-triage"] }, project);
        const jql = jqlFromLastCall();
        expect(jql).toContain('status in ("Selected for Development")');
        expect(jql).toContain('labels in ("needs-triage")');
      });

      it("reads statusMapping from project.tracker (dashboard create(undefined) path)", async () => {
        const t = create();
        const projWithMapping = {
          ...project,
          tracker: { plugin: "jira", site: "acme", projectKey: "PROJ", statusMapping: statusMap },
        };
        mockAcli([]);
        await t.listIssues!({ labels: ["agent:backlog"] }, projWithMapping);
        expect(jqlFromLastCall()).toContain('status in ("Selected for Development")');
      });
    });

    describe("updateIssue", () => {
      it("transitions instead of editing labels when claiming", async () => {
        const t = create({ site: "acme", projectKey: "PROJ", statusMapping: statusMap });
        acliMock.mockResolvedValue({ stdout: "" });
        await t.updateIssue!(
          "PROJ-1",
          { labels: ["agent:in-progress"], removeLabels: ["agent:backlog"], comment: "Claimed" },
          project,
        );
        expect(acliMock).toHaveBeenCalledWith(
          "acli",
          ["jira", "workitem", "transition", "--key", "PROJ-1", "--status", "In Progress", "--yes"],
          expect.any(Object),
        );
        expect(acliMock).toHaveBeenCalledWith(
          "acli",
          ["jira", "workitem", "comment", "create", "--key", "PROJ-1", "--body", "Claimed"],
          expect.any(Object),
        );
        // No label edits — mapped labels are status-driven, mapped removes are no-ops.
        const editedLabels = acliMock.mock.calls.some(
          (c) => (c[1] as string[]).includes("--labels") || (c[1] as string[]).includes("--remove-labels"),
        );
        expect(editedLabels).toBe(false);
        expect(acliMock).toHaveBeenCalledTimes(2); // transition + comment
      });

      it("transitions to the merged-unverified status on merge", async () => {
        const t = create({ site: "acme", projectKey: "PROJ", statusMapping: statusMap });
        acliMock.mockResolvedValue({ stdout: "" });
        await t.updateIssue!(
          "PROJ-1",
          { labels: ["merged-unverified"], removeLabels: ["agent:backlog", "agent:in-progress"] },
          project,
        );
        expect(acliMock).toHaveBeenCalledWith(
          "acli",
          expect.arrayContaining(["transition", "--status", "QA"]),
          expect.any(Object),
        );
        expect(acliMock).toHaveBeenCalledTimes(1); // only the transition
      });

      it("still edits unmapped labels alongside a mapped transition", async () => {
        const t = create({ site: "acme", projectKey: "PROJ", statusMapping: statusMap });
        acliMock.mockResolvedValue({ stdout: "" });
        await t.updateIssue!("PROJ-1", { labels: ["agent:in-progress", "needs-design"] }, project);
        expect(acliMock).toHaveBeenCalledWith(
          "acli",
          expect.arrayContaining(["transition", "--status", "In Progress"]),
          expect.any(Object),
        );
        expect(acliMock).toHaveBeenCalledWith(
          "acli",
          expect.arrayContaining(["--labels", "needs-design"]),
          expect.any(Object),
        );
      });

      it("lets an explicit state win over a mapped label", async () => {
        const t = create({ site: "acme", projectKey: "PROJ", statusMapping: statusMap });
        acliMock.mockResolvedValue({ stdout: "" });
        await t.updateIssue!("PROJ-1", { state: "closed", labels: ["agent:in-progress"] }, project);
        const transitions = acliMock.mock.calls.filter((c) =>
          (c[1] as string[]).includes("transition"),
        );
        expect(transitions).toHaveLength(1);
        expect(transitions[0][1]).toEqual(expect.arrayContaining(["--status", "Done"]));
      });

      it("falls back to label edits when no statusMapping is configured", async () => {
        const t = create({ site: "acme" });
        acliMock.mockResolvedValue({ stdout: "" });
        await t.updateIssue!("PROJ-1", { labels: ["agent:in-progress"] }, project);
        expect(acliMock).toHaveBeenCalledWith(
          "acli",
          expect.arrayContaining(["--labels", "agent:in-progress"]),
          expect.any(Object),
        );
      });
    });
  });

  // ---- createIssue -------------------------------------------------------

  describe("createIssue", () => {
    it("creates an item and fetches full details", async () => {
      mockAcli({ key: "PROJ-999" });
      mockAcli({ ...sampleIssue, key: "PROJ-999", fields: { ...sampleIssue.fields, summary: "New" } });

      const issue = await tracker.createIssue!(
        { title: "New", description: "Body" },
        project,
      );
      expect(issue).toMatchObject({ id: "PROJ-999", title: "New" });
      expect(acliMock).toHaveBeenNthCalledWith(
        1,
        "acli",
        expect.arrayContaining([
          "create",
          "--project",
          "PROJ",
          "--type",
          "Task",
          "--summary",
          "New",
        ]),
        expect.any(Object),
      );
    });

    it("passes labels and assignee", async () => {
      mockAcli({ key: "PROJ-1000" });
      mockAcli({ ...sampleIssue, key: "PROJ-1000" });
      await tracker.createIssue!(
        { title: "Bug", description: "Crash", labels: ["bug"], assignee: "alice@acme.com" },
        project,
      );
      expect(acliMock).toHaveBeenNthCalledWith(
        1,
        "acli",
        expect.arrayContaining(["--label", "bug", "--assignee", "alice@acme.com"]),
        expect.any(Object),
      );
    });

    it("uses a configured defaultIssueType", async () => {
      const t = create({ site: "acme", projectKey: "PROJ", defaultIssueType: "Story" });
      mockAcli({ key: "PROJ-1" });
      mockAcli({ ...sampleIssue, key: "PROJ-1" });
      await t.createIssue!({ title: "X", description: "" }, project);
      expect(acliMock).toHaveBeenNthCalledWith(
        1,
        "acli",
        expect.arrayContaining(["--type", "Story"]),
        expect.any(Object),
      );
    });

    it("throws when projectKey is missing", async () => {
      const t = create();
      const noKey = { ...project, tracker: { plugin: "jira" } };
      await expect(
        t.createIssue!({ title: "X", description: "" }, noKey),
      ).rejects.toThrow("projectKey");
    });

    it("throws when key cannot be parsed from output", async () => {
      mockAcli({ unexpected: true });
      await expect(
        tracker.createIssue!({ title: "X", description: "" }, project),
      ).rejects.toThrow("Failed to parse work item key");
    });
  });

  // ---- preflight ---------------------------------------------------------

  describe("preflight", () => {
    it("resolves when acli is installed and authenticated", async () => {
      mockAcliRaw("acli version 1.3.19-stable"); // --version
      mockAcliRaw("Logged in"); // auth status
      await expect(tracker.preflight!({} as never)).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// acli-utils unit tests
// ---------------------------------------------------------------------------

describe("acli-utils", () => {
  describe("adfToText", () => {
    it("returns strings unchanged", () => {
      expect(adfToText("hello")).toBe("hello");
    });

    it("returns empty string for null/undefined", () => {
      expect(adfToText(null)).toBe("");
      expect(adfToText(undefined)).toBe("");
    });

    it("flattens a paragraph doc", () => {
      const doc = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Hi there" }] }],
      };
      expect(adfToText(doc).trim()).toBe("Hi there");
    });

    it("renders bullet lists with dashes", () => {
      const doc = {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              { type: "listItem", content: [{ type: "text", text: "one" }] },
              { type: "listItem", content: [{ type: "text", text: "two" }] },
            ],
          },
        ],
      };
      const text = adfToText(doc);
      expect(text).toContain("- one");
      expect(text).toContain("- two");
    });
  });

  describe("buildBaseUrl", () => {
    it("expands a bare site to an atlassian.net host", () => {
      expect(buildBaseUrl("acme")).toBe("https://acme.atlassian.net");
    });

    it("prefixes https for a host", () => {
      expect(buildBaseUrl("acme.atlassian.net")).toBe("https://acme.atlassian.net");
    });

    it("keeps a full URL and strips trailing slash", () => {
      expect(buildBaseUrl("https://jira.acme.com/")).toBe("https://jira.acme.com");
    });
  });

  describe("jqlString", () => {
    it("quotes and escapes", () => {
      expect(jqlString('a"b')).toBe('"a\\"b"');
    });
  });
});
