---
"@aoagents/ao-plugin-tracker-jira": minor
"@aoagents/ao-core": minor
"@aoagents/ao-cli": minor
---

Add a Jira tracker plugin that drives the official Atlassian CLI (`acli`).

The plugin maps Jira work items to AO issues via `acli jira workitem` commands
(view, search, create, edit, transition, comment), flattens Atlassian Document
Format (ADF) descriptions to plain text, and derives `browse` URLs from a `site`
config value. It is registered as a built-in tracker and is also available
on-demand through the plugin registry. Authentication is handled globally by
`acli auth login`.

Supports config-level issue filtering via `projectKey` (scopes `listIssues` and
is required by `createIssue`) and `labels` (a string or string[] persistent
label filter ANDed into every `listIssues` query, narrowed further by any
runtime label filter).

Adds an optional per-project `statusMapping` that maps AO lifecycle labels
(`agent:backlog`, `agent:in-progress`, `merged-unverified`, `agent:done`) to
Jira workflow status names. When set, the backlog poller's label-based
selection/marking is translated to JQL `status` filters and workflow
transitions instead of label edits — so the agent lifecycle is driven by Jira
status, not tags. Unmapped labels fall back to label behavior, keeping the
default label-based flow unchanged.
