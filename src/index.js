import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

export const name = 'gunthe-session-delete'
export const inject = ['sessionPersistence', 'sessionProjectionCache', 'workspaceRegistry', 'connection']

const API_PATH = '/api/gunthe-session-delete/delete'
const CSRF_HEADER = 'x-gunthe-plugin'
const CSRF_VALUE = 'session-delete'
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/
const inFlight = new Map()

export class DeleteError extends Error {
  constructor(message, status = 500, code = 'DELETE_FAILED', details) {
    super(message); this.status = status; this.code = code; this.details = details
  }
}

const dshHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const tombstoneRoot = () => path.join(dshHome(), 'session-delete-tombstones')

export function validateSessionId(value) {
  const id = String(value || '').trim()
  if (!SAFE_SESSION_ID.test(id) || id === '.' || id === '..') throw new DeleteError('Invalid session ID.', 400, 'INVALID_SESSION_ID')
  return id
}

function trackerState(persistence, id) {
  const tracker = persistence?.tracker
  return {
    writerHeld: tracker?.writers?.has?.(id) === true,
    pending: tracker?.pending?.has?.(id) === true,
    handles: [...(tracker?.openHandles ?? [])].filter((handle) => handle?.id === id),
  }
}

function liveState(ctx, id) {
  const agents = ctx.get?.('agents'); const sessions = ctx.get?.('sessions')
  return {
    agent: typeof agents?.get === 'function' ? agents.get(id) : undefined,
    session: typeof sessions?.get === 'function' ? sessions.get(id) : undefined,
  }
}

async function assertInactive(ctx, id) {
  const activity = await ctx.waterfall?.('workspace/session-activity', { sessionId: id }, () => Promise.resolve([])) ?? []
  const live = liveState(ctx, id); const tracker = trackerState(ctx.sessionPersistence, id)
  if (activity.length || live.agent || live.session || tracker.writerHeld || tracker.pending || tracker.handles.length) {
    throw new DeleteError('Session is active or held by Gunthe. Archive it, restart Gunthe, and delete it before reopening.', 409, 'SESSION_ACTIVE', { activityCount: activity.length, openHandles: tracker.handles.length })
  }
}

async function writeAtomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temp, file)
}

async function loadTombstone(id) {
  const file = path.join(tombstoneRoot(), `${id}.json`)
  try { return { file, value: JSON.parse(await fs.readFile(file, 'utf8')) } }
  catch (error) { if (error?.code === 'ENOENT') return { file, value: undefined }; throw error }
}

async function saveTombstone(file, value) {
  const next = { ...value, updatedAt: new Date().toISOString() }
  await writeAtomicJson(file, next); return next
}

async function verifyArtifact(persistence, file, expectedId) {
  if (!/\.jsonl(?:\.zstd)?$/i.test(file)) throw new DeleteError('Unsupported session artifact.', 409, 'UNSUPPORTED_ARTIFACT')
  if (typeof persistence.readStoredLog !== 'function') throw new DeleteError('Persistence validation API is unavailable.', 500, 'PERSISTENCE_API_UNAVAILABLE')
  try {
    const stored = await persistence.readStoredLog(file, expectedId)
    if (stored?.meta?.id !== expectedId && stored?.header?.id !== expectedId) throw new DeleteError('Stored header ID does not match the selected session.', 409, 'HEADER_MISMATCH')
  } catch (error) {
    if (error instanceof DeleteError) throw error
    throw new DeleteError(`Session artifact validation failed: ${error?.message ?? String(error)}`, 409, 'HEADER_MISMATCH')
  }
}

async function resolveSessionDirectory(persistence, id) {
  const log = await persistence.resolveCurrentLog?.(id)
  if (!log) throw new DeleteError('Session artifact was not found.', 404, 'SESSION_NOT_FOUND')
  const absolute = path.resolve(log); await verifyArtifact(persistence, absolute, id)
  const directory = path.dirname(absolute); const info = await fs.lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new DeleteError('Unsafe session directory.', 409, 'UNSAFE_PATH')
  const realRoot = await fs.realpath(path.resolve(dshHome(), 'sessions')); const realDirectory = await fs.realpath(directory)
  if (!realDirectory.startsWith(`${realRoot}${path.sep}`)) throw new DeleteError('Session directory escaped the storage root.', 409, 'UNSAFE_PATH')
  const realLog = await fs.realpath(absolute)
  if (path.dirname(realLog) !== realDirectory) throw new DeleteError('Session artifact escaped its directory.', 409, 'UNSAFE_PATH')
  return { log: realLog, directory: realDirectory }
}

async function removeProjection(cache, id) {
  const table = typeof cache?.requireTable === 'function' ? cache.requireTable() : cache?.table
  if (!table?.delete) throw new DeleteError('Projection cache removal is unavailable.', 500, 'PROJECTION_API_UNAVAILABLE')
  await table.delete(id)
}

async function cleanWorkspace(registry, id) {
  for (const workspace of registry.list?.() ?? []) if (workspace.sessionIds?.includes(id)) await workspace.detachSession(id)
  if (registry.archivedSessionIds?.includes(id)) await registry.unarchiveSession(id)
  if (registry.pinnedSessionIds?.includes(id)) await registry.unpinSession(id)
}

async function assertTombstoneArtifactSafe(artifact, filesAlreadyRemoved) {
  if (!artifact || typeof artifact.directory !== 'string' || typeof artifact.log !== 'string') throw new DeleteError('Invalid deletion tombstone path.', 409, 'INVALID_TOMBSTONE')
  const root = path.resolve(dshHome(), 'sessions')
  const realRoot = await fs.realpath(root)
  const directory = path.resolve(artifact.directory)
  const relative = path.relative(realRoot, directory)
  const logDirectory = path.dirname(path.resolve(artifact.log))
  if (relative.startsWith('..') || path.isAbsolute(relative) || path.relative(directory, logDirectory) !== '') throw new DeleteError('Deletion tombstone escaped the storage root.', 409, 'INVALID_TOMBSTONE')
  if (!filesAlreadyRemoved) {
    const info = await fs.lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new DeleteError('Unsafe tombstone directory.', 409, 'INVALID_TOMBSTONE')
    const realDirectory = await fs.realpath(directory)
    if (!realDirectory.startsWith(`${realRoot}${path.sep}`)) throw new DeleteError('Tombstone directory escaped the storage root.', 409, 'INVALID_TOMBSTONE')
  }
}

async function runDelete(ctx, id) {
  const prior = await loadTombstone(id)
  let tombstone = prior.value
  if (!tombstone) {
    if (!ctx.workspaceRegistry.archivedSessionIds?.includes(id)) throw new DeleteError('Archive the session before permanently deleting it.', 409, 'ARCHIVE_REQUIRED')
    await assertInactive(ctx, id)
    const stored = await ctx.sessionPersistence.stat(id)
    if (!stored) throw new DeleteError('Session was not found.', 404, 'SESSION_NOT_FOUND')
    if (stored.header?.id !== id) throw new DeleteError('Persistence identity mismatch.', 409, 'HEADER_MISMATCH')
    const artifact = await resolveSessionDirectory(ctx.sessionPersistence, id)
    tombstone = await saveTombstone(prior.file, { schema: 'gunthe-session-delete/v1', sessionId: id, createdAt: new Date().toISOString(), artifact, steps: { files: false, projection: false, workspace: false } })
  } else if (tombstone.sessionId !== id || tombstone.schema !== 'gunthe-session-delete/v1') {
    throw new DeleteError('Invalid deletion tombstone.', 409, 'INVALID_TOMBSTONE')
  }
  const artifact = tombstone.artifact
  await assertTombstoneArtifactSafe(artifact, tombstone.steps?.files === true)
  const fail = async (step, error) => {
    tombstone = await saveTombstone(prior.file, { ...tombstone, status: 'partial', failedStep: step, error: String(error?.message ?? error) })
    throw new DeleteError(`Permanent deletion stopped during ${step}; retry is safe.`, 500, 'PARTIAL_DELETE', { step })
  }
  if (!tombstone.steps.files) try {
    await assertInactive(ctx, id); await fs.rm(artifact.directory, { recursive: true, force: false }); ctx.sessionPersistence.coldLogMemo?.delete?.(id)
    tombstone.steps.files = true; tombstone = await saveTombstone(prior.file, { ...tombstone, status: 'deleting', error: undefined })
  } catch (error) { await fail('files', error) }
  if (!tombstone.steps.projection) try {
    await removeProjection(ctx.sessionProjectionCache, id); tombstone.steps.projection = true; tombstone = await saveTombstone(prior.file, tombstone)
  } catch (error) { await fail('projection', error) }
  if (!tombstone.steps.workspace) try {
    await cleanWorkspace(ctx.workspaceRegistry, id); tombstone.steps.workspace = true; tombstone = await saveTombstone(prior.file, tombstone)
  } catch (error) { await fail('workspace', error) }
  tombstone = await saveTombstone(prior.file, { ...tombstone, status: 'complete', completedAt: new Date().toISOString(), error: undefined, failedStep: undefined })
  ctx.emit('api-session/removed', id)
  return { sessionId: id, status: tombstone.status }
}

export async function deleteSessionCore(ctx, rawId) {
  const id = validateSessionId(rawId); const current = inFlight.get(id); if (current) return current
  const operation = runDelete(ctx, id).finally(() => inFlight.delete(id)); inFlight.set(id, operation); return operation
}

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

async function readRequestJson(request) {
  try {
    const body = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
    return body
  } catch { throw new DeleteError('Invalid JSON body.', 400, 'INVALID_BODY') }
}

export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: API_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        if (request.headers.get(CSRF_HEADER) !== CSRF_VALUE) throw new DeleteError('Missing plugin request header.', 403, 'FORBIDDEN')
        const body = await readRequestJson(request)
        return jsonResponse(200, { ok: true, data: await deleteSessionCore(ctx, body.sessionId) })
      } catch (error) {
        return jsonResponse(error?.status ?? 500, { ok: false, error: { code: error?.code ?? 'DELETE_FAILED', message: error?.message ?? String(error), details: error?.details } })
      }
    },
  }), 'gunthe-session-delete: authenticated delete route')
}
