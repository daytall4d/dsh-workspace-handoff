# DSH Workspace Handoff

[中文说明](./README.zh-CN.md)

A small, auditable DeepSeek Harness Profile Bundle for **continuing real project work across sessions and agents**.

It adds three model-facing tools:

- `project_digest` — a compact workspace snapshot: Git branch/change counts, recent commits, useful root files, and the latest handoff.
- `project_handoff_save` — saves a structured handoff to `.dsh-handoff.json`.
- `project_handoff_load` — loads and validates that handoff in a later session.

The plugin does **not** upload project data, scrape chat history, run a background service, or require an API key.

## Why this exists

Long-running Harness work often spans multiple conversations or agents. Session history is useful, but the durable state a new agent actually needs is usually much smaller:

- What are we trying to finish?
- What changed?
- What has been verified?
- What should happen next?
- What is blocked?
- Which Git revision was the handoff made against?

Workspace Handoff turns that state into one explicit, inspectable project file instead of another hidden memory store.

It is intentionally different from:

- **MCP memory systems** — those are general/user-level knowledge stores; this is one workspace, one small file, and can be version-controlled.
- **Ralph handoff** — Ralph owns internal iteration state; this plugin is for ordinary interactive Harness sessions and independent agents.
- **Chat export/summarization** — no conversation history is copied automatically.

## Install

### DeepSeek Harness Desktop

Open **Plugins**, choose the install action, and use the Git package spec:

```text
github:daytall4d/dsh-workspace-handoff
```

The equivalent repository URL is:

```text
https://github.com/daytall4d/dsh-workspace-handoff.git
```

The package is a normal DSH Profile Bundle. Its `dsh.bundle.patch` mounts the Host plugin through Cordis.

### DSH CLI

For a non-Desktop profile:

```sh
dsh plugin --profile web add github:daytall4d/dsh-workspace-handoff
```

Then restart the profile if that surface does not use live recomposition.

## Use

At the beginning of a continuation session:

```text
Call project_digest and tell me where this project currently stands.
```

Before switching sessions or handing work to another agent:

```text
Save a project handoff for the work we just completed. Include the concrete next steps and verification evidence.
```

In a fresh session:

```text
Call project_handoff_load and continue from the saved handoff.
```

A saved file looks like this:

```json
{
  "version": 1,
  "objective": "Ship the first public plugin release",
  "status": "active",
  "summary": "Implemented and tested the three DSH tools.",
  "nextSteps": [
    "Publish the repository",
    "Install from the GitHub spec on Desktop"
  ],
  "blockers": [],
  "evidence": [
    "node --test: 5/5 passing",
    "DSH Web profile booted with the plugin active"
  ],
  "updatedAt": "2026-09-27T00:00:00.000Z",
  "git": {
    "available": true,
    "branch": "main",
    "head": "0123456789ab",
    "clean": false
  }
}
```

## Design

### Project-local by default

The plugin writes exactly one file in the active session workspace:

```text
.dsh-handoff.json
```

It does not create a global database. Teams may commit the file when the handoff is useful to collaborators, or keep it untracked when it is only local working state.

### DSH sandbox is respected

`project_handoff_save` resolves the active session policy through `ctx.sandboxPolicy` and writes through `ctx.fs.writeText`.

That means:

- `read-only` mode rejects the write.
- `workspace-write` confines it to the workspace.
- the save uses a create/replace version guard so a concurrent change fails closed instead of being silently overwritten.

### Minimal host access

The plugin has no third-party runtime dependencies and no network code.

The only host process it invokes is `git`, with an argv-based `execFile` call (no shell), to read bounded metadata:

- repository root
- branch and HEAD
- staged / unstaged / untracked / conflict counts
- three recent commit subjects

If Git is unavailable or the workspace is not a repository, the tools still work and report Git metadata as unavailable.

### No automatic secret collection

Only fields explicitly supplied to `project_handoff_save` are persisted, plus the small Git snapshot above. The plugin never copies arbitrary project file contents or chat transcripts into the handoff.

## Package layout

```text
.
├─ cordis.patch.yml
├─ icon.svg
├─ locale/
│  ├─ en.json
│  └─ zh.json
├─ src/
│  └─ index.js
└─ test/
   └─ plugin.test.js
```

There is no build step. The published source is the runtime source.

## Verification

The initial release was validated on Windows against the packaged **DeepSeek Harness 0.1.7-rc.2** runtime, not only against mocks.

Checks performed:

1. `node --check src/index.js`
2. `node --test` — save/load/digest integration, Git parsing, malformed data, and read-only sandbox behavior.
3. Installed the local package through the real DSH plugin manager into an isolated test profile.
4. Confirmed `--dump-config` includes the `workspace-handoff` bundle row.
5. Booted a real DSH Web profile with the plugin active; startup completed without an inactive-plugin warning.

Run locally:

```sh
npm test
npm run check
```

## Compatibility

The plugin intentionally imports no private DSH package implementation. It consumes the stable Cordis services supplied by the base profile:

- `tools`
- `fs`
- `sandboxPolicy`

This keeps the package small and avoids pulling a second copy of DSH internals into the Host process.

Currently tested:

| Platform | DSH runtime | Result |
| --- | --- | --- |
| Windows 11 | 0.1.7-rc.2 | Pass |

Additional DSH versions and platforms are welcome in issues/PRs.

## Development

Clone the repository and run:

```sh
npm test
```

For local DSH testing, install the repository path into an isolated profile:

```sh
dsh plugin --profile web add .
dsh web --no-open --port 0
```

## Roadmap

Useful follow-ups that keep the plugin focused:

- optional handoff history with a strict bounded count
- a diff between saved Git HEAD and current HEAD
- a small Desktop UI card for viewing the handoff without invoking the model
- compatibility CI against published DSH runtime releases

## License

MIT

[![powered by dsh](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
