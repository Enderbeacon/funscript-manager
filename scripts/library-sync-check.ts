import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { ioFaults, ioCalls, ioGates, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import Database, { sqliteFaults, pragmas } from 'better-sqlite3'
import { watched } from 'chokidar'
import { LibraryIndexDb, isIndexCorruption } from '../src/main/services/db/index-db'
import { readDirectory } from '../src/main/services/library/directory-reader'
import {
  startLibrary, stopLibrary, startAllLibraries, libraryIndexesReady, librariesReady,
  requestSync, internalHandle, editMedia, libraryEvents, listMedia
} from '../src/main/services/library/library-manager'
import { libraries } from '../src/main/services/config/config-service'
import { probeCalls } from '../src/main/services/library/probe'

const fixture = await mkdtemp(join(tmpdir(), 'fsmgr-library-sync-'))
const root = join(fixture, 'external-library')
const libraryId = randomUUID()
const library = { id: libraryId, name: 'External fixture', rootPath: root }
const warnings: unknown[][] = []
const originalWarn = console.warn
const originalError = console.error
console.warn = (...args) => warnings.push(args)
console.error = (...args) => warnings.push(args)
let checks = 0
const check = (name: string): void => { checks++; console.log(`PASS: ${name}`) }
async function put(path: string, content = path): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
function handle() { return internalHandle(libraryId) }
async function settleDirectoryTimes(directory: string): Promise<void> {
  const old = new Date(Date.now() - 60_000)
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory() && !item.name.startsWith('.')) await settleDirectoryTimes(join(directory, item.name))
  }
  await utimes(directory, old, old)
}
try {
  for (let folder = 0; folder < 12; folder++) {
    for (let file = 0; file < 12; file++) await put(join(root, `folder-${folder}`, `Clip-${folder}-${file}.mp4`))
  }
  await startLibrary(library)
  assert.equal(handle().db.listIndexed().length, 144)
  const keepId = handle().db.findIdByRelPath('folder-0/Clip-0-0.mp4')!
  await editMedia(libraryId, keepId, (meta) => ({ ...meta, tags: ['keep'], userMeta: { notes: 'survive restart' } }))
  await settleDirectoryTimes(root)
  await requestSync(libraryId, false)
  assert.ok(handle().db.scanCache.counters.directoriesRead >= 13)
  check('first reconciliation indexes all fixture media and builds persistent snapshots')
  await stopLibrary(libraryId)
  ioCalls.length = 0
  pragmas.length = 0
  await startLibrary(library)
  assert.equal(handle().db.listIndexed().length, 144)
  assert.equal(handle().db.scanCache.counters.directoriesRead, 0)
  assert.ok(handle().db.scanCache.counters.directoriesReused >= 13)
  assert.equal(handle().db.scanCache.counters.sidecarsRead, 0)
  assert.ok(!pragmas.some((sql) => sql.includes('quick_check')))
  assert.ok(!ioCalls.some((call) => call.operation === 'readFile' && call.path.endsWith('.meta.json')))
  const kept = await handle().store.read(join(root, 'folder-0/Clip-0-0.mp4'))
  assert.ok(kept.ok && kept.meta.tags.includes('keep') && kept.meta.userMeta.notes === 'survive restart')
  check('warm restart reuses all 13 directory listings and metadata without full index checks or JSON reads')

  const changing = join(root, 'folder-1')
  await put(join(changing, 'Added.mp4'))
  const watch = watched.findLast((item) => item.paths.includes(root))
  watch.handlers.all('add', join(changing, 'Added.mp4'))
  await requestSync(libraryId, false)
  assert.ok(handle().db.findIdByRelPath('folder-1/Added.mp4'))
  assert.ok(handle().db.scanCache.counters.directoriesReused >= 12)
  check('watcher events invalidate the changed directory while retaining unrelated listings')

  const editedPath = join(root, 'folder-2/Clip-2-0.mp4')
  const sidecarPath = handle().store.locate(editedPath)
  const raw = JSON.parse(await readFile(sidecarPath, 'utf8'))
  await writeFile(sidecarPath, JSON.stringify({ ...raw, title: 'Changed outside the app' }))
  await requestSync(libraryId, false)
  const reread = await handle().store.read(editedPath)
  assert.ok(reread.ok && reread.meta.title === 'Changed outside the app')
  check('file-content changes are read even when the containing directory list is cached')

  ioCalls.length = 0
  await requestSync(libraryId)
  assert.ok(handle().db.scanCache.counters.directoriesRead >= 13)
  assert.ok(ioCalls.some((call) => call.operation === 'readFile' && call.path.endsWith('.meta.json')))
  check('manual rescan bypasses directory and sidecar snapshots')

  const rowsBefore = handle().db.listIndexed()
  const sidecarBefore = await readFile(sidecarPath, 'utf8')
  const failures: string[] = []
  const onFailure = (event) => { if (event.libraryId === libraryId) failures.push(event.code) }
  libraryEvents.on('sync-failed', onFailure)
  ioFaults.set(`opendir:${root}`, 'EIO')
  try { await requestSync(libraryId) } finally { ioFaults.clear() }
  assert.deepEqual(handle().db.listIndexed(), rowsBefore)
  assert.equal(await readFile(sidecarPath, 'utf8'), sidecarBefore)
  assert.ok(failures.includes('library_unavailable'))
  check('a simulated disconnected drive keeps every indexed entry and sidecar')

  ioFaults.set(`readdir:${join(root, 'folder-3')}`, 'EACCES')
  try { await requestSync(libraryId) } finally { ioFaults.clear() }
  assert.deepEqual(handle().db.listIndexed(), rowsBefore)
  assert.ok(!failures.includes('index_rebuilt'))
  libraryEvents.off('sync-failed', onFailure)
  check('an unreadable subtree aborts cleanup instead of deleting its entries or rebuilding the index')

  const indexPath = join(root, '.fsmgr-cache/index.db')
  await stopLibrary(libraryId)
  for (const code of ['SQLITE_BUSY', 'SQLITE_IOERR', 'SQLITE_CANTOPEN', 'SQLITE_READONLY']) {
    sqliteFaults.set(indexPath, code)
    assert.throws(() => LibraryIndexDb.open(root), (error) => error.code === code)
    const db = LibraryIndexDb.open(root)
    assert.equal(db.listIndexed().length, 145)
    db.close()
  }
  check('busy, I/O, unavailable and read-only errors never delete a healthy index')
  assert.equal(isIndexCorruption({ code: 'SQLITE_CORRUPT_VTAB' }), true)
  assert.equal(isIndexCorruption({ code: 'SQLITE_BUSY' }), false)
  const damagedRoot = join(fixture, 'damaged')
  const damagedIndex = join(damagedRoot, '.fsmgr-cache/index.db')
  await put(damagedIndex, 'Not a SQLite database')
  const repaired = LibraryIndexDb.open(damagedRoot)
  assert.deepEqual(repaired.listIndexed(), [])
  repaired.close()
  check('confirmed file corruption still recreates the disposable index')

  await startLibrary(library)
  const cachedDir = join(root, 'folder-4')
  await settleDirectoryTimes(cachedDir)
  await requestSync(libraryId, false)
  handle().db.scanCache.flush()
  const direct = new Database(indexPath)
  direct.prepare('UPDATE scan_directory SET observed_at = ? WHERE path = ?')
    .run(Date.now() - 25 * 60 * 60 * 1000, cachedDir)
  ioCalls.length = 0
  await requestSync(libraryId, false)
  assert.ok(ioCalls.some((call) => call.operation === 'readdir' && call.path === cachedDir))
  direct.close()
  check('old directory snapshots expire even without a watcher event')

  const originalList = handle().db.listMedia.bind(handle().db)
  handle().db.listMedia = (...args) => {
    handle().db.listMedia = originalList
    throw Object.assign(new Error('Injected damaged query page'), { code: 'SQLITE_CORRUPT_VTAB' })
  }
  assert.equal(listMedia({ offset: 0, limit: 10 }).total, 0)
  await requestSync(libraryId, false)
  assert.equal(handle().db.listIndexed().length, 145)
  check('all-library queries recover corruption in the affected index without a startup page sweep')
  await stopLibrary(libraryId)

  // Cache-schema additions must not stamp the main index as incompatible and
  // force an otherwise unnecessary media reindex after an upgrade/downgrade.
  const legacy = new Database(indexPath)
  legacy.exec('DROP TABLE scan_directory; DROP TABLE scan_sidecar;')
  const version = legacy.pragma('user_version', { simple: true })
  legacy.close()
  const upgraded = LibraryIndexDb.open(root)
  assert.equal(upgraded.listIndexed().length, 145)
  upgraded.close()
  const after = new Database(indexPath)
  assert.equal(after.pragma('user_version', { simple: true }), version)
  after.close()
  check('adding scan caches preserves existing media rows and the compatible index version')

  const secondRoot = join(fixture, 'second-library')
  await put(join(secondRoot, 'Second.mp4'))
  const second = { id: randomUUID(), rootPath: secondRoot, name: 'Second fixture' }
  // Hold directory iteration after indexes are open; cached listings must be
  // available while the background reconciliation is still pending.
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let opens = 0
  ioGates.set(`opendir:${root}`, () => ++opens >= 2 ? gate : undefined)
  let completed = false
  const startup = startAllLibraries([library, second])
  void startup.then(() => { completed = true })
  await libraryIndexesReady()
  assert.equal(internalHandle(libraryId).db.listIndexed().length, 145)
  assert.ok(internalHandle(second.id))
  assert.equal(completed, false)
  release()
  await startup
  ioGates.clear()
  await librariesReady()
  await stopLibrary(second.id)
  check('startup opens all existing indexes before waiting for sequential background scans')

  const reconnectRoot = join(fixture, 'reconnected-library')
  const reconnect = { id: randomUUID(), rootPath: reconnectRoot, name: 'Reconnect fixture' }
  libraries.push(reconnect)
  await assert.rejects(() => startLibrary(reconnect), (error) => error.code === 'library_unavailable')
  assert.equal(existsSync(reconnectRoot), false)
  await put(join(reconnectRoot, 'Unprobeable.mp4'))
  await requestSync(reconnect.id)
  assert.equal(internalHandle(reconnect.id).db.listIndexed().length, 1)
  const attempts = probeCalls.filter((path) => path.endsWith('Unprobeable.mp4')).length
  await requestSync(reconnect.id)
  assert.equal(probeCalls.filter((path) => path.endsWith('Unprobeable.mp4')).length, attempts)
  await stopLibrary(reconnect.id)
  check('an offline library can be rescanned after reconnecting without re-adding it or recreating a missing root')
  check('an unsupported media probe is remembered rather than rerun on every startup')
  console.log(`Completed ${checks} library sync checks.`)
} finally {
  ioFaults.clear()
  ioGates.clear()
  console.warn = originalWarn
  console.error = originalError
  await stopLibrary(libraryId)
  const rel = relative(tmpdir(), fixture)
  if (rel.startsWith('fsmgr-library-sync-') && !isAbsolute(rel)) await rm(fixture, { recursive: true, force: true })
}
