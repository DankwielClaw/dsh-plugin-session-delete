import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deleteSessionCore, validateSessionId } from '../src/index.js'

const ID = 'session-12345678-1234-1234-1234-123456789abc'

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gunthe-session-delete-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const dir = path.join(home, 'sessions', 'project', ID)
  const log = path.join(dir, 'session.v3.jsonl.zstd')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(log, `${JSON.stringify({ header: { id: ID } })}\n`)
  const projection = new Map([[ID, { rows: {} }]])
  const workspace = { sessionIds: [ID], async detachSession(id) { this.sessionIds = this.sessionIds.filter((value) => value !== id) } }
  const registry = {
    archivedSessionIds: [ID], pinnedSessionIds: [ID], list() { return [workspace] },
    async unarchiveSession(id) { this.archivedSessionIds = this.archivedSessionIds.filter((value) => value !== id) },
    async unpinSession(id) { this.pinnedSessionIds = this.pinnedSessionIds.filter((value) => value !== id) },
  }
  const tracker = { writers: new Map(), pending: new Map(), openHandles: new Set() }
  const ctx = {
    sessionPersistence: {
      tracker, coldLogMemo: new Map([[ID, {}]]),
      async stat(id) { return id === ID ? { header: { id } } : undefined },
      async resolveCurrentLog(id) { return id === ID ? log : undefined },
      async readStoredLog(file, expectedId) {
        const row = JSON.parse((await fs.readFile(file, 'utf8')).split(/\r?\n/, 1)[0])
        if (row?.header?.id !== expectedId) throw new Error('header mismatch')
        return { meta: row.header }
      },
    },
    sessionProjectionCache: { requireTable() { return projection }, markClean() {} },
    workspaceRegistry: registry,
    get(name) { if (name === 'agents' || name === 'sessions') return new Map() },
    async waterfall(_event, _request, fallback) { return fallback() },
    emit() {},
  }
  return { home, dir, log, projection, workspace, registry, tracker, ctx, async cleanup() { process.env.DSH_HOME = previousHome; await fs.rm(home, { recursive: true, force: true }) } }
}

test('validates IDs and rejects traversal', () => {
  assert.equal(validateSessionId(ID), ID)
  for (const value of ['../x', '/tmp/x', 'a/b', '..', '']) assert.throws(() => validateSessionId(value))
})

test('requires archive before permanent delete', async () => {
  const f = await fixture(); f.registry.archivedSessionIds = []
  await assert.rejects(deleteSessionCore(f.ctx, ID), { code: 'ARCHIVE_REQUIRED' })
  assert.equal((await fs.stat(f.dir)).isDirectory(), true); await f.cleanup()
})

test('deletes exact verified artifact and all accounting', async () => {
  const f = await fixture(); const result = await deleteSessionCore(f.ctx, ID)
  assert.equal(result.status, 'complete'); assert.equal(f.projection.has(ID), false)
  assert.deepEqual(f.workspace.sessionIds, []); assert.deepEqual(f.registry.archivedSessionIds, []); assert.deepEqual(f.registry.pinnedSessionIds, [])
  await assert.rejects(fs.stat(f.dir)); assert.equal(f.ctx.sessionPersistence.coldLogMemo.has(ID), false)
  const tombstone = JSON.parse(await fs.readFile(path.join(f.home, 'session-delete-tombstones', `${ID}.json`), 'utf8'))
  assert.equal(tombstone.status, 'complete'); assert.deepEqual(tombstone.steps, { files: true, projection: true, workspace: true }); await f.cleanup()
})

test('refuses resident, active, writer, pending and open-handle sessions', async () => {
  for (const mode of ['resident', 'activity', 'writer', 'pending', 'handle']) {
    const f = await fixture()
    if (mode === 'resident') f.ctx.get = (name) => name === 'sessions' ? new Map([[ID, {}]]) : new Map()
    if (mode === 'activity') f.ctx.waterfall = async () => [{ kind: 'turn' }]
    if (mode === 'writer') f.tracker.writers.set(ID, {})
    if (mode === 'pending') f.tracker.pending.set(ID, {})
    if (mode === 'handle') f.tracker.openHandles.add({ id: ID })
    await assert.rejects(deleteSessionCore(f.ctx, ID), { code: 'SESSION_ACTIVE' })
    assert.equal((await fs.stat(f.dir)).isDirectory(), true); await f.cleanup()
  }
})

test('rejects mismatched stored header without deleting', async () => {
  const f = await fixture(); await fs.writeFile(f.log, `${JSON.stringify({ header: { id: 'session-other' } })}\n`)
  await assert.rejects(deleteSessionCore(f.ctx, ID), { code: 'HEADER_MISMATCH' })
  assert.equal((await fs.stat(f.dir)).isDirectory(), true); await f.cleanup()
})

test('coalesces concurrent deletion requests by session id', async () => {
  const f = await fixture(); let stats = 0
  const original = f.ctx.sessionPersistence.stat
  f.ctx.sessionPersistence.stat = async (...args) => { stats += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return original(...args) }
  const [a, b] = await Promise.all([deleteSessionCore(f.ctx, ID), deleteSessionCore(f.ctx, ID)])
  assert.deepEqual(a, b); assert.equal(stats, 1); await f.cleanup()
})

test('records partial failure and resumes after files are gone', async () => {
  const f = await fixture(); const workingTable = f.ctx.sessionProjectionCache.requireTable()
  f.ctx.sessionProjectionCache.requireTable = () => ({ async delete() { throw new Error('storage unavailable') } })
  await assert.rejects(deleteSessionCore(f.ctx, ID), { code: 'PARTIAL_DELETE' })
  let tombstone = JSON.parse(await fs.readFile(path.join(f.home, 'session-delete-tombstones', `${ID}.json`), 'utf8'))
  assert.equal(tombstone.status, 'partial'); assert.equal(tombstone.failedStep, 'projection'); assert.equal(tombstone.steps.files, true)
  f.ctx.sessionProjectionCache.requireTable = () => workingTable
  const result = await deleteSessionCore(f.ctx, ID)
  assert.equal(result.status, 'complete')
  tombstone = JSON.parse(await fs.readFile(path.join(f.home, 'session-delete-tombstones', `${ID}.json`), 'utf8'))
  assert.deepEqual(tombstone.steps, { files: true, projection: true, workspace: true }); await f.cleanup()
})
