import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export const name = 'workspace-handoff'
export const inject = ['tools', 'fs', 'sandboxPolicy']

export const HANDOFF_FILENAME = '.dsh-handoff.json'
export const HANDOFF_VERSION = 1
export const MAX_HANDOFF_BYTES = 128 * 1024
export const HANDOFF_STATUSES = ['active', 'blocked', 'complete']

const MAX_OBJECTIVE_CHARS = 500
const MAX_SUMMARY_CHARS = 4000
const MAX_LIST_ITEMS = 20
const MAX_LIST_ITEM_CHARS = 1000
const MAX_ROOT_ENTRIES = 40
const RECENT_COMMIT_LIMIT = 3

const PROJECT_HINT_NAMES = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'README.zh-CN.md',
  'package.json',
  'pnpm-workspace.yaml',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
  '.gitignore',
])

const EMPTY_PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

const SAVE_PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    objective: {
      type: 'string',
      description: 'The stable project objective or current milestone.',
    },
    status: {
      type: 'string',
      enum: HANDOFF_STATUSES,
      description: 'active = work remains, blocked = external/user input is needed, complete = this objective is done.',
    },
    summary: {
      type: 'string',
      description: 'What was actually completed or learned. Keep it concise and concrete.',
    },
    next_steps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Concrete next actions for a fresh session or agent, in priority order.',
    },
    blockers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Known blockers, missing decisions, or external dependencies.',
    },
    evidence: {
      type: 'array',
      items: { type: 'string' },
      description: 'Useful verification evidence such as tests run, files changed, or commands/results.',
    },
  },
  required: ['objective', 'status', 'summary'],
}

const GENERIC_OBJECT_OUTPUT = {
  type: 'object',
}

function renderJson(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function assertPlainObject(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(label + ' must be an object')
  }
  return value
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(label + ' contains unsupported field: ' + key)
    }
  }
}

function requireTrimmedString(value, label, maxChars) {
  if (typeof value !== 'string') {
    throw new TypeError(label + ' must be a string')
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new TypeError(label + ' must not be empty')
  }
  if (trimmed.length > maxChars) {
    throw new TypeError(label + ' must be at most ' + maxChars + ' characters')
  }
  return trimmed
}

function normalizeStringArray(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new TypeError(label + ' must be an array of strings')
  }
  if (value.length > MAX_LIST_ITEMS) {
    throw new TypeError(label + ' must contain at most ' + MAX_LIST_ITEMS + ' items')
  }
  const result = []
  const seen = new Set()
  for (let index = 0; index < value.length; index++) {
    const item = requireTrimmedString(value[index], label + '[' + index + ']', MAX_LIST_ITEM_CHARS)
    if (seen.has(item)) continue
    seen.add(item)
    result.push(item)
  }
  return result
}

function requireStatus(value) {
  if (typeof value !== 'string' || !HANDOFF_STATUSES.includes(value)) {
    throw new TypeError('status must be one of: ' + HANDOFF_STATUSES.join(', '))
  }
  return value
}

export function normalizeSaveArgs(args) {
  const value = assertPlainObject(args, 'arguments')
  assertOnlyKeys(
    value,
    new Set(['objective', 'status', 'summary', 'next_steps', 'blockers', 'evidence']),
    'arguments',
  )
  return {
    objective: requireTrimmedString(value.objective, 'objective', MAX_OBJECTIVE_CHARS),
    status: requireStatus(value.status),
    summary: requireTrimmedString(value.summary, 'summary', MAX_SUMMARY_CHARS),
    nextSteps: normalizeStringArray(value.next_steps, 'next_steps'),
    blockers: normalizeStringArray(value.blockers, 'blockers'),
    evidence: normalizeStringArray(value.evidence, 'evidence'),
  }
}

function normalizeStoredGit(value) {
  if (value === undefined) return undefined
  const git = assertPlainObject(value, 'handoff.git')
  assertOnlyKeys(git, new Set(['available', 'branch', 'head', 'clean']), 'handoff.git')
  if (typeof git.available !== 'boolean') throw new TypeError('handoff.git.available must be a boolean')
  if (!git.available) return { available: false }
  const branch = requireTrimmedString(git.branch, 'handoff.git.branch', 500)
  const head = requireTrimmedString(git.head, 'handoff.git.head', 100)
  if (typeof git.clean !== 'boolean') throw new TypeError('handoff.git.clean must be a boolean')
  return { available: true, branch, head, clean: git.clean }
}

export function parseHandoffText(text) {
  if (typeof text !== 'string') throw new TypeError('handoff file must be UTF-8 text')
  if (Buffer.byteLength(text, 'utf8') > MAX_HANDOFF_BYTES) {
    throw new TypeError('handoff file is larger than ' + MAX_HANDOFF_BYTES + ' bytes')
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new TypeError('handoff file is not valid JSON: ' + error.message)
  }
  const value = assertPlainObject(parsed, 'handoff')
  assertOnlyKeys(
    value,
    new Set(['version', 'objective', 'status', 'summary', 'nextSteps', 'blockers', 'evidence', 'updatedAt', 'git']),
    'handoff',
  )
  if (value.version !== HANDOFF_VERSION) {
    throw new TypeError('unsupported handoff version: ' + String(value.version))
  }
  const updatedAt = requireTrimmedString(value.updatedAt, 'handoff.updatedAt', 100)
  if (Number.isNaN(Date.parse(updatedAt))) {
    throw new TypeError('handoff.updatedAt must be an ISO date-time string')
  }
  const result = {
    version: HANDOFF_VERSION,
    objective: requireTrimmedString(value.objective, 'handoff.objective', MAX_OBJECTIVE_CHARS),
    status: requireStatus(value.status),
    summary: requireTrimmedString(value.summary, 'handoff.summary', MAX_SUMMARY_CHARS),
    nextSteps: normalizeStringArray(value.nextSteps, 'handoff.nextSteps'),
    blockers: normalizeStringArray(value.blockers, 'handoff.blockers'),
    evidence: normalizeStringArray(value.evidence, 'handoff.evidence'),
    updatedAt,
  }
  const git = normalizeStoredGit(value.git)
  if (git !== undefined) result.git = git
  return result
}

export function parsePorcelainStatus(text) {
  const lines = String(text)
    .split(/\r?\n/u)
    .filter(Boolean)
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicts = 0

  for (const line of lines) {
    const x = line[0] || ' '
    const y = line[1] || ' '
    if (x === '?' && y === '?') {
      untracked++
      continue
    }
    if (x === '!' && y === '!') continue
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      conflicts++
    }
    if (x !== ' ') staged++
    if (y !== ' ') unstaged++
  }

  return {
    clean: lines.length === 0,
    staged,
    unstaged,
    untracked,
    conflicts,
  }
}

function requireAgentWorkspace(exec) {
  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd
    : undefined
  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    throw new Error('Workspace Handoff requires a calling Harness agent with a session workspace.')
  }
  return cwd
}

function ensureNoArgs(args) {
  const value = assertPlainObject(args, 'arguments')
  if (Object.keys(value).length !== 0) {
    throw new TypeError('this tool accepts no arguments')
  }
}

function emitObserved(ctx, target, observation, exec) {
  if (typeof ctx.emit === 'function') {
    ctx.emit('fs/observed', target, observation, exec)
  }
}

async function resolveHandoffTarget(ctx, exec, cwdOverride) {
  const cwd = cwdOverride || requireAgentWorkspace(exec)
  return await ctx.fs.resolve(HANDOFF_FILENAME, { cwd, signal: exec.signal })
}

async function readHandoff(ctx, exec) {
  const cwd = requireAgentWorkspace(exec)
  const target = await resolveHandoffTarget(ctx, exec, cwd)
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    emitObserved(ctx, target, { kind: 'absent' }, exec)
    return {
      found: false,
      path: target.displayPath,
      handoff: null,
    }
  }
  if (info.type !== 'file') {
    throw new Error(HANDOFF_FILENAME + ' exists but is not a regular file')
  }
  if (typeof info.size === 'number' && info.size > MAX_HANDOFF_BYTES) {
    throw new Error(HANDOFF_FILENAME + ' is too large to be a valid handoff')
  }
  const text = await ctx.fs.readText(target, exec.signal)
  emitObserved(ctx, target, { kind: 'present', version: info.version }, exec)
  return {
    found: true,
    path: target.displayPath,
    handoff: parseHandoffText(text),
  }
}

function compactGitForHandoff(git) {
  if (!git || git.available !== true) return { available: false }
  return {
    available: true,
    branch: git.branch,
    head: git.head,
    clean: git.clean,
  }
}

async function saveHandoff(ctx, args, exec) {
  const cwd = requireAgentWorkspace(exec)
  const session = exec.agent.session
  const policy = ctx.sandboxPolicy.resolve({ session })
  const target = await resolveHandoffTarget(ctx, exec, policy.workspaceRoot || cwd)
  const before = await ctx.fs.stat(target, exec.signal)
  if (before !== undefined && before.type !== 'file') {
    throw new Error(HANDOFF_FILENAME + ' exists but is not a regular file')
  }

  const normalized = normalizeSaveArgs(args)
  const git = await gitSnapshot(cwd, exec.signal)
  const handoff = {
    version: HANDOFF_VERSION,
    objective: normalized.objective,
    status: normalized.status,
    summary: normalized.summary,
    nextSteps: normalized.nextSteps,
    blockers: normalized.blockers,
    evidence: normalized.evidence,
    updatedAt: new Date().toISOString(),
    git: compactGitForHandoff(git),
  }
  const body = JSON.stringify(handoff, null, 2) + '\n'
  if (Buffer.byteLength(body, 'utf8') > MAX_HANDOFF_BYTES) {
    throw new Error('generated handoff exceeds the maximum size')
  }

  const intent = before === undefined
    ? { kind: 'createIfAbsent' }
    : { kind: 'replaceIfVersion', version: before.version }

  const outcome = await ctx.fs.writeText(target, body, intent, exec.signal, policy)
  emitObserved(ctx, target, { kind: 'present', version: outcome.version }, exec)

  return {
    path: target.displayPath,
    operation: outcome.operation,
    sandboxMode: policy.mode,
    handoff,
  }
}

async function runGit(cwd, args, signal) {
  const options = {
    cwd,
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  }
  if (signal !== undefined) options.signal = signal
  const result = await execFile('git', args, options)
  // Porcelain status uses a leading space to distinguish unstaged changes.
  // Remove only final line breaks; never trim the beginning of stdout.
  return String(result.stdout).replace(/[\\r\\n]+$/u, '')
}

function isAbortError(error) {
  return error && typeof error === 'object' && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
}

export async function gitSnapshot(cwd, signal) {
  try {
    const root = await runGit(cwd, ['rev-parse', '--show-toplevel'], signal)
    let branch
    try {
      branch = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)
    } catch (error) {
      if (isAbortError(error)) throw error
      branch = '(detached)'
    }

    const head = await runGit(cwd, ['rev-parse', '--short=12', 'HEAD'], signal)
    const statusText = await runGit(cwd, ['status', '--porcelain=v1'], signal)
    const status = parsePorcelainStatus(statusText)
    const logText = await runGit(
      cwd,
      ['log', '-' + String(RECENT_COMMIT_LIMIT), '--pretty=format:%h%x09%s'],
      signal,
    )
    const recentCommits = logText.length === 0
      ? []
      : logText.split(/\r?\n/u).map((line) => {
          const tab = line.indexOf('\t')
          return tab < 0
            ? { hash: line.trim(), subject: '' }
            : { hash: line.slice(0, tab).trim(), subject: line.slice(tab + 1).trim() }
        })

    return {
      available: true,
      root,
      branch,
      head,
      clean: status.clean,
      staged: status.staged,
      unstaged: status.unstaged,
      untracked: status.untracked,
      conflicts: status.conflicts,
      recentCommits,
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    return {
      available: false,
      reason: 'Git is unavailable or the workspace is not a Git worktree.',
    }
  }
}

async function listWorkspaceRoot(ctx, exec) {
  const cwd = requireAgentWorkspace(exec)
  const rootTarget = await ctx.fs.resolve('.', { cwd, signal: exec.signal })
  const entries = await ctx.fs.listDir(rootTarget, exec.signal)
  const names = entries
    .map((entry) => entry.name)
    .filter((entry) => typeof entry === 'string')
    .sort((a, b) => a.localeCompare(b))
  return {
    entries: names.slice(0, MAX_ROOT_ENTRIES),
    truncated: names.length > MAX_ROOT_ENTRIES,
    hints: names.filter((entry) => PROJECT_HINT_NAMES.has(entry)),
  }
}

async function buildDigest(ctx, exec) {
  const cwd = requireAgentWorkspace(exec)
  const [git, root, handoff] = await Promise.all([
    gitSnapshot(cwd, exec.signal),
    listWorkspaceRoot(ctx, exec),
    readHandoff(ctx, exec),
  ])
  return {
    workspace: cwd,
    git,
    root,
    handoff,
  }
}

function toolDefinition(nameValue, description, parameters, execute, render) {
  return {
    name: nameValue,
    description,
    parameters,
    output: {
      schema: GENERIC_OBJECT_OUTPUT,
      render: render || ((_args, value) => renderJson(value)),
    },
    execute,
  }
}

export function apply(ctx) {
  ctx.tools.register(toolDefinition(
    'project_digest',
    'Get a compact project-local continuity snapshot for the current Harness workspace: Git branch/change counts, recent commits, useful root files, and the latest saved handoff. Use it at the start of a new session or after switching workspaces.',
    EMPTY_PARAMETERS_SCHEMA,
    async (args, exec) => {
      ensureNoArgs(args)
      return await buildDigest(ctx, exec)
    },
  ))

  ctx.tools.register(toolDefinition(
    'project_handoff_load',
    'Load and validate .dsh-handoff.json from the current Harness workspace. The file is project-local and designed for continuing work in another session or agent.',
    EMPTY_PARAMETERS_SCHEMA,
    async (args, exec) => {
      ensureNoArgs(args)
      return await readHandoff(ctx, exec)
    },
  ))

  ctx.tools.register(toolDefinition(
    'project_handoff_save',
    'Save a concise, auditable cross-session handoff to .dsh-handoff.json in the current Harness workspace. It records only the fields supplied here plus a small Git snapshot; it never copies chat history, credentials, or arbitrary file contents. The write obeys the current DSH filesystem sandbox.',
    SAVE_PARAMETERS_SCHEMA,
    async (args, exec) => await saveHandoff(ctx, args, exec),
    (_args, value) => [{
      type: 'text',
      text: 'Saved project handoff to ' + value.path
        + ' (' + value.operation + ', status=' + value.handoff.status
        + ', sandbox=' + value.sandboxMode + ').',
    }],
  ))
}

