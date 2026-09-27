import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  apply,
  HANDOFF_FILENAME,
  normalizeSaveArgs,
  parseHandoffText,
  parsePorcelainStatus,
} from '../src/index.js'
import {
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
  rm,
} from 'node:fs/promises'

const execFileAsync = promisify(execFile)

function versionOf(info) {
  return String(info.mtimeMs) + ':' + String(info.size)
}

function isInside(parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

function createFakeContext(mode = 'workspace-write') {
  const tools = new Map()

  const fsService = {
    async resolve(input, options = {}) {
      const cwd = options.cwd || process.cwd()
      const absolute = path.resolve(cwd, input)
      return { targetKey: absolute, displayPath: absolute }
    },
    async stat(target) {
      try {
        const info = await stat(target.targetKey)
        return {
          version: versionOf(info),
          type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
          size: info.size,
        }
      } catch (error) {
        if (error && error.code === 'ENOENT') return undefined
        throw error
      }
    },
    async readText(target) {
      return await readFile(target.targetKey, 'utf8')
    },
    async listDir(target) {
      const entries = await readdir(target.targetKey, { withFileTypes: true })
      const result = []
      for (const entry of entries) {
        const child = path.join(target.targetKey, entry.name)
        let info
        try {
          info = await stat(child)
        } catch {
          info = undefined
        }
        result.push({
          name: entry.name,
          type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
          target: { targetKey: child, displayPath: child },
          ...(info ? { version: versionOf(info), size: info.size } : {}),
        })
      }
      return result.sort((a, b) => a.name.localeCompare(b.name))
    },
    async writeText(target, body, expected, _signal, policy) {
      if (policy && policy.mode === 'read-only') {
        const error = new Error('sandbox denied write in read-only mode')
        error.code = 'FS_SANDBOX_DENIED'
        throw error
      }
      if (policy && policy.mode === 'workspace-write' && !isInside(policy.workspaceRoot, target.targetKey)) {
        const error = new Error('sandbox denied write outside workspace')
        error.code = 'FS_SANDBOX_DENIED'
        throw error
      }

      let beforeInfo
      let beforeText = null
      try {
        beforeInfo = await stat(target.targetKey)
        beforeText = await readFile(target.targetKey, 'utf8')
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error
      }

      if (expected && expected.kind === 'createIfAbsent' && beforeInfo) {
        throw new Error('expected absent file')
      }
      if (expected && expected.kind === 'replaceIfVersion') {
        if (!beforeInfo || versionOf(beforeInfo) !== expected.version) {
          throw new Error('stale file version')
        }
      }

      await writeFile(target.targetKey, body, 'utf8')
      const afterInfo = await stat(target.targetKey)
      return {
        operation: beforeInfo ? 'update' : 'create',
        version: versionOf(afterInfo),
        before: beforeText,
        after: body,
      }
    },
  }

  return {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error('duplicate tool')
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    fs: fsService,
    sandboxPolicy: {
      resolve({ session }) {
        return {
          mode,
          workspaceRoot: session.header.cwd,
          sessionId: session.id || 'test',
        }
      },
    },
    emit() {},
    _tools: tools,
  }
}

function toolExec(cwd) {
  return {
    callId: 'test-call',
    signal: new AbortController().signal,
    agent: {
      session: {
        id: 'test-session',
        header: { cwd },
      },
    },
  }
}

async function initGit(cwd) {
  await execFileAsync('git', ['init'], { cwd, windowsHide: true })
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd, windowsHide: true })
  await execFileAsync('git', ['config', 'user.name', 'Workspace Handoff Test'], { cwd, windowsHide: true })
  await writeFile(path.join(cwd, 'README.md'), '# Fixture\n', 'utf8')
  await execFileAsync('git', ['add', 'README.md'], { cwd, windowsHide: true })
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd, windowsHide: true })
}

test('normalizes save arguments and removes duplicate list items', () => {
  const value = normalizeSaveArgs({
    objective: '  ship plugin  ',
    status: 'active',
    summary: '  implemented tools  ',
    next_steps: ['test', 'test', 'publish'],
    blockers: [],
    evidence: ['node --test'],
  })
  assert.equal(value.objective, 'ship plugin')
  assert.equal(value.summary, 'implemented tools')
  assert.deepEqual(value.nextSteps, ['test', 'publish'])
})

test('parses porcelain status counts without reading file names', () => {
  assert.deepEqual(
    parsePorcelainStatus('M  staged.txt\n M changed.txt\n?? new.txt\nUU conflict.txt\n'),
    {
      clean: false,
      staged: 2,
      unstaged: 2,
      untracked: 1,
      conflicts: 1,
    },
  )
})

test('rejects malformed handoff documents', () => {
  assert.throws(
    () => parseHandoffText('{"version":2}'),
    /unsupported handoff version/u,
  )
})

test('registers three tools and performs a real save/load/digest cycle', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'dsh-workspace-handoff-'))
  try {
    await initGit(cwd)
    // A real porcelain line for this change begins with a space (\" M README.md\").
    // This catches accidental .trim() calls that would turn it into a staged change.
    await writeFile(path.join(cwd, 'README.md'), '# Fixture\\nchanged\\n', 'utf8')
    const ctx = createFakeContext('workspace-write')
    apply(ctx)

    assert.deepEqual(
      [...ctx._tools.keys()].sort(),
      ['project_digest', 'project_handoff_load', 'project_handoff_save'],
    )

    const exec = toolExec(cwd)
    const beforeDigest = await ctx._tools.get('project_digest').execute({}, exec)
    assert.equal(beforeDigest.git.staged, 0)
    assert.equal(beforeDigest.git.unstaged, 1)

    const save = await ctx._tools.get('project_handoff_save').execute({
      objective: 'Publish an open-source DSH plugin',
      status: 'active',
      summary: 'Implemented the first working version.',
      next_steps: ['Run Desktop compatibility check', 'Publish to GitHub'],
      blockers: [],
      evidence: ['node --test passes'],
    }, exec)

    assert.equal(save.operation, 'create')
    assert.equal(save.sandboxMode, 'workspace-write')
    assert.equal(save.handoff.git.available, true)
    assert.equal(save.handoff.git.clean, false)
    assert.equal(save.handoff.git.staged, undefined)

    const onDisk = JSON.parse(await readFile(path.join(cwd, HANDOFF_FILENAME), 'utf8'))
    assert.equal(onDisk.version, 1)
    assert.equal(onDisk.objective, 'Publish an open-source DSH plugin')

    const loaded = await ctx._tools.get('project_handoff_load').execute({}, exec)
    assert.equal(loaded.found, true)
    assert.equal(loaded.handoff.status, 'active')
    assert.deepEqual(loaded.handoff.nextSteps, [
      'Run Desktop compatibility check',
      'Publish to GitHub',
    ])

    const digest = await ctx._tools.get('project_digest').execute({}, exec)
    assert.equal(digest.workspace, cwd)
    assert.equal(digest.git.available, true)
    assert.equal(digest.git.unstaged, 1)
    assert.equal(digest.git.untracked, 1)
    assert.ok(digest.root.hints.includes('README.md'))
    assert.equal(digest.handoff.found, true)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('save obeys a read-only DSH sandbox policy', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'dsh-workspace-handoff-ro-'))
  try {
    const ctx = createFakeContext('read-only')
    apply(ctx)
    await assert.rejects(
      ctx._tools.get('project_handoff_save').execute({
        objective: 'Do not write',
        status: 'active',
        summary: 'Read-only policy is active.',
      }, toolExec(cwd)),
      /sandbox denied write/u,
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
