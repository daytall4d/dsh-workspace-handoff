# Security

## Scope

Workspace Handoff has no network client and no third-party runtime dependency. It writes only `.dsh-handoff.json` through the active DeepSeek Harness filesystem and sandbox services.

## Reporting

Please open a GitHub security advisory for a vulnerability that could:

- write outside the active DSH workspace policy,
- execute unintended commands,
- collect project or conversation data without an explicit tool call,
- or corrupt an existing handoff through a stale overwrite.

Do not include real credentials or private project contents in a public issue.
