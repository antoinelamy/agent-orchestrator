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
