import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { watched } from 'chokidar'
import {
  startLibrary, stopLibrary, requestSync, internalHandle, editMedia,
  addScriptVersion, findWantedMatches, runLibraryTask, updateScriptVersion, deleteScriptVersion
} from '../src/main/services/library/library-manager'
import { applyScriptMatches, previewScriptMatches, setScriptFolders } from '../src/main/services/library/script-match-service'
import { scriptFamilies, rankScriptCandidates, automaticScriptTarget, suggestedScriptTarget } from '../src/main/services/library/script-matching'
import { setBusy } from '../src/main/services/downloaders/queue'
import { ScriptMatchPreviewSchema } from '@shared/schemas/script-match'
import { MediaMetaSchema } from '@shared/schemas/media-meta'
import { LibraryStateFile } from '../src/main/services/library/library-state-file'

const fixture = await mkdtemp(join(tmpdir(), 'fsmgr-script-match-fixture-'))
const root = join(fixture, 'library')
const external = join(fixture, 'separate-scripts')
const libraryId = randomUUID()
let checks = 0
const check = (name: string): void => { checks++; console.log(`PASS: ${name}`) }
async function put(path: string, content = path): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
function id(path: string): string {
  const found = internalHandle(libraryId).db.findIdByRelPath(path)
  assert.ok(found, `Entry not indexed: ${path}`)
  return found
}
async function meta(path: string) {
  const read = await internalHandle(libraryId).store.read(join(root, path))
  assert.ok(read.ok)
  return read.meta
}
try {
  await put(join(root, 'videos', 'Scene.mp4'))
  await put(join(root, 'scripts', 'Scene.funscript'), 'main data')
  await put(join(root, 'scripts', 'Scene.roll.funscript'), 'roll data')
  await startLibrary({ id: libraryId, name: 'Fixture', rootPath: root })
  let scene = await meta('videos/Scene.mp4')
  assert.equal(scene.scriptVersions.length, 1)
  assert.equal(scene.scriptVersions[0]!.files.main, '../scripts/Scene.funscript')
  assert.equal(scene.scriptVersions[0]!.files.roll, '../scripts/Scene.roll.funscript')
  assert.equal(internalHandle(libraryId).db.findIdByRelPath('scripts/Scene.mp4'), null)
  check('startup scan links identical names across folders, preserving multi-axis files in place')
  await requestSync(libraryId)
  assert.equal((await meta('videos/Scene.mp4')).scriptVersions.length, 1)
  check('repeated scans do not duplicate versions or recreate placeholders')
  const previewOne = previewScriptMatches(libraryId)
  const previewTwo = previewScriptMatches(libraryId)
  assert.equal(previewOne, previewTwo)
  await previewOne
  check('concurrent review refreshes share a single library walk')

  await put(join(root, 'videos', 'Other Scene.mp4'))
  await requestSync(libraryId)
  await addScriptVersion(libraryId, id('videos/Other Scene.mp4'), {
    name: 'Manual', files: { main: join(root, 'scripts/Scene.funscript') }
  })
  await editMedia(libraryId, id('videos/Scene.mp4'), (m) => ({ ...m, scriptVersions: [] }))
  // A matching video appears in the script's own directory after the manual assignment.
  await put(join(root, 'scripts', 'Scene.mp4'))
  await requestSync(libraryId)
  assert.equal((await meta('scripts/Scene.mp4')).scriptVersions.length, 0)
  assert.equal((await meta('videos/Scene.mp4')).scriptVersions.length, 0)
  assert.equal((await meta('videos/Other Scene.mp4')).scriptVersions[0]!.name, 'Manual')
  check('local and global scans preserve a manual cross-folder assignment')

  await put(join(root, 'videos-a', 'Twin.mp4'))
  await put(join(root, 'videos-b', 'Twin.mkv'))
  await put(join(root, 'scripts', 'Twin.funscript'))
  await requestSync(libraryId)
  let preview = ScriptMatchPreviewSchema.parse(await previewScriptMatches(libraryId))
  let twin = preview.groups.find((g) => g.scriptPath.endsWith('Twin.funscript'))!
  assert.equal(twin.candidates.length, 2)
  assert.equal(twin.suggestedMediaId, null)
  assert.equal((await meta('videos-a/Twin.mp4')).scriptVersions.length, 0)
  check('identical video names in different directories remain ambiguous')
  let result = await applyScriptMatches(libraryId, [
    { groupId: twin.id, mediaId: id('videos-b/Twin.mkv') },
    { groupId: twin.id, mediaId: id('videos-a/Twin.mp4') },
    { groupId: 'stale-or-forged', mediaId: id('videos-a/Twin.mp4') }
  ])
  assert.deepEqual(result, { applied: 1, skipped: 2, failed: 0 })
  assert.equal((await meta('videos-b/Twin.mkv')).scriptVersions.length, 1)
  check('batch confirmation respects the chosen target and rejects duplicate or stale choices')

  await put(join(root, 'videos', 'My Scene.mp4'))
  await put(join(root, 'fuzzy', 'My_Scene.funscript'))
  await requestSync(libraryId)
  const fuzzyId = id('fuzzy/My_Scene.mp4')
  await editMedia(libraryId, fuzzyId, (m) => ({
    ...m, title: 'A carried title', tags: ['kept-tag'],
    sources: [{ type: 'other', url: 'https://example.com/source' }],
    userMeta: { rating: 4, favorite: true, notes: 'placeholder notes' }
  }))
  await editMedia(libraryId, id('videos/My Scene.mp4'), (m) => ({
    ...m, userMeta: { rating: 5, notes: 'video notes' }
  }))
  await updateScriptVersion(libraryId, fuzzyId, (await meta('fuzzy/My_Scene.mp4')).scriptVersions[0]!.id,
    { notes: 'kept version note', author: 'Fixture author' })
  assert.ok((await findWantedMatches(libraryId, fuzzyId)).some((m) => m.mediaId === id('videos/My Scene.mp4')))
  preview = await previewScriptMatches(libraryId)
  const fuzzy = preview.groups.find((g) => g.id === fuzzyId)!
  assert.equal(fuzzy.candidates[0]!.kind, 'similar')
  assert.equal((await meta('videos/My Scene.mp4')).scriptVersions.length, 0)
  result = await applyScriptMatches(libraryId, [{ groupId: fuzzy.id, mediaId: id('videos/My Scene.mp4') }])
  assert.equal(result.applied, 1)
  const carried = await meta('videos/My Scene.mp4')
  assert.equal(carried.title, 'A carried title')
  assert.deepEqual(carried.tags, ['kept-tag'])
  assert.equal(carried.sources[0]!.url, 'https://example.com/source')
  assert.equal(carried.scriptVersions[0]!.notes, 'kept version note')
  assert.ok(carried.scriptAuthors.includes('Fixture author'))
  assert.equal(carried.userMeta.rating, 5)
  assert.equal(carried.userMeta.favorite, true)
  assert.equal(carried.userMeta.notes, 'video notes\n\nplaceholder notes')
  check('fuzzy review and missing-video suggestions share rules; merge retains metadata and version notes')

  await put(join(root, 'scripts', 'Dismissed.funscript'))
  await requestSync(libraryId)
  setBusy(true)
  await put(join(root, 'videos', 'Dismissed.mp4'))
  await requestSync(libraryId)
  const dismissedId = id('scripts/Dismissed.mp4')
  await editMedia(libraryId, dismissedId, (m) => ({ ...m, wanted: { ...m.wanted!, dismissed: [id('videos/Dismissed.mp4')] } }))
  setBusy(false)
  await requestSync(libraryId)
  assert.equal((await meta('videos/Dismissed.mp4')).scriptVersions.length, 0)
  check('an explicitly dismissed pairing is not linked automatically')

  await put(join(root, 'videos', 'External.mp4'))
  await put(join(external, 'nested', 'External.funscript'), 'external main')
  await put(join(external, 'nested', 'External.roll.funscript'), 'external roll')
  await requestSync(libraryId)
  await setScriptFolders(libraryId, [external, external])
  assert.deepEqual((await LibraryStateFile.load(root)).scriptFolders, [external])
  assert.ok(watched.at(-1).paths.includes(external))
  assert.equal(watched.at(-1).options.followSymlinks, false)
  await requestSync(libraryId)
  assert.equal((await meta('videos/External.mp4')).scriptVersions.length, 0)
  preview = await previewScriptMatches(libraryId)
  const outside = preview.groups.find((g) => g.copy && g.scriptPath.endsWith('External.funscript'))!
  assert.equal(outside.files.length, 2)
  result = await applyScriptMatches(libraryId, [{ groupId: outside.id, mediaId: id('videos/External.mp4') }])
  assert.equal(result.applied, 1)
  const imported = (await meta('videos/External.mp4')).scriptVersions[0]!
  for (const [axis, file] of Object.entries(imported.files)) {
    assert.ok(file)
    const copy = resolve(root, 'videos', file)
    const rel = relative(root, copy)
    assert.ok(!rel.startsWith('..') && !isAbsolute(rel))
    assert.equal(await readFile(copy, 'utf8'), axis === 'main' ? 'external main' : 'external roll')
  }
  assert.equal(await readFile(join(external, 'nested/External.funscript'), 'utf8'), 'external main')
  assert.equal(imported.importedFrom!.main, join(external, 'nested/External.funscript'))
  assert.equal((await previewScriptMatches(libraryId)).groups.some((g) => g.id === outside.id), false)
  check('external folders persist, are watched recursively, import only on confirmation and do not reimport')

  await put(join(root, 'videos', 'Rollback.mp4'))
  await put(join(external, 'nested', 'Rollback.funscript'), 'rollback main')
  await put(join(external, 'nested', 'Rollback.roll.funscript'), 'rollback roll')
  await requestSync(libraryId)
  preview = await previewScriptMatches(libraryId)
  const rollback = preview.groups.find((g) => g.scriptPath.endsWith('Rollback.funscript'))!
  const store = internalHandle(libraryId).store
  const originalWrite = store.write.bind(store)
  const originalWarn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args) => warnings.push(args)
  store.write = async (mediaPath, meta) => {
    if (mediaPath.endsWith('Rollback.mp4')) throw new Error('Injected sidecar write failure')
    return originalWrite(mediaPath, meta)
  }
  try {
    result = await applyScriptMatches(libraryId, [{ groupId: rollback.id, mediaId: id('videos/Rollback.mp4') }])
    assert.equal(result.failed, 1)
    assert.equal(warnings.length, 1)
    assert.equal((await meta('videos/Rollback.mp4')).scriptVersions.length, 0)
    const managedDirs = await readdir(join(root, '.fsmgr/scripts'))
    for (const folder of managedDirs) {
      const files = await readdir(join(root, '.fsmgr/scripts', folder))
      assert.equal(files.some((file) => file.startsWith('Rollback')), false)
    }
    assert.equal(await readFile(join(external, 'nested/Rollback.funscript'), 'utf8'), 'rollback main')
  } finally {
    store.write = originalWrite
    console.warn = originalWarn
  }
  check('failed sidecar writes roll back imported files and preserve every original')
  await rename(external, `${external}-offline`)
  preview = await previewScriptMatches(libraryId)
  assert.ok(preview.unreachable.includes(external))
  assert.ok(existsSync(resolve(root, 'videos', imported.files.main!)))
  await setScriptFolders(libraryId, [])
  assert.ok(existsSync(resolve(root, 'videos', imported.files.main!)))
  check('offline or removed source folders leave imported scripts playable')

  await put(join(root, 'videos', 'Late.mp4'))
  await requestSync(libraryId)
  await put(join(root, 'scripts', 'Late.funscript'))
  await put(join(root, 'scripts', 'Late.pitch.funscript'))
  await requestSync(libraryId)
  assert.ok((await meta('videos/Late.mp4')).scriptVersions[0]!.files.pitch)
  check('scripts arriving after the video are linked across folders')
  const lateVersion = (await meta('videos/Late.mp4')).scriptVersions[0]!
  await updateScriptVersion(libraryId, id('videos/Late.mp4'), lateVersion.id, { notes: 'keep during axis fill' })
  await put(join(root, 'scripts', 'Late.roll.funscript'))
  await requestSync(libraryId)
  const filled = (await meta('videos/Late.mp4')).scriptVersions
  assert.equal(filled.length, 1)
  assert.equal(filled[0]!.id, lateVersion.id)
  assert.equal(filled[0]!.files.roll, '../scripts/Late.roll.funscript')
  assert.equal(filled[0]!.notes, 'keep during axis fill')
  check('secondary axes arriving later fill the existing cross-folder version without changing its identity')

  await put(join(root, 'scripts', 'Missing.funscript'))
  await requestSync(libraryId)
  setBusy(true)
  await put(join(root, 'videos', 'Missing.mp4'))
  await requestSync(libraryId)
  setBusy(false)
  await unlink(join(root, 'videos/Missing.mp4'))
  await requestSync(libraryId)
  assert.equal((await findWantedMatches(libraryId, id('scripts/Missing.mp4'))).length, 0)
  check('videos that are missing on disk are not suggested')

  await put(join(root, 'videos', 'Queue One.mp4'))
  await put(join(root, 'videos', 'Queue Two.mp4'))
  await put(join(root, 'scripts', 'Queue_One.funscript'))
  await put(join(root, 'scripts', 'Queue_Two.funscript'))
  await requestSync(libraryId)
  preview = await previewScriptMatches(libraryId)
  const first = preview.groups.find((g) => g.scriptPath.endsWith('Queue_One.funscript'))!
  const second = preview.groups.find((g) => g.scriptPath.endsWith('Queue_Two.funscript'))!
  const queued = runLibraryTask(libraryId, async () => {
    await unlink(join(root, 'scripts/Queue_One.funscript'))
  })
  warnings.length = 0
  console.warn = (...args) => warnings.push(args)
  try {
    result = await applyScriptMatches(libraryId, [
      { groupId: first.id, mediaId: id('videos/Queue One.mp4') },
      { groupId: second.id, mediaId: id('videos/Queue Two.mp4') }
    ])
    assert.equal(warnings.length, 1)
  } finally {
    console.warn = originalWarn
  }
  await queued
  assert.equal(result.failed, 1)
  assert.equal(result.applied, 1)
  assert.ok((await meta('videos/Queue Two.mp4')).scriptVersions.length)
  check('a disappeared source fails independently and does not abort the rest of a batch')

  const family = scriptFamilies(join(root, 'pure'), ['Clip.funscript', 'Clip.roll.funscript'], false)[0]!
  const rank = rankScriptCandidates(family, [
    { mediaId: randomUUID(), filePath: 'else/Clip.mp4', directory: join(root, 'else') },
    { mediaId: randomUUID(), filePath: 'else/Clip.mkv', directory: join(root, 'else') }
  ], 'affixes')
  assert.equal(automaticScriptTarget(family, rank), null)
  assert.equal(suggestedScriptTarget(rank), null)
  assert.equal(scriptFamilies(root, ['Clip.roll.funscript'], false).length, 0)
  assert.equal(scriptFamilies(root, ['Clip.funscript', 'Clip.main.funscript'], false).length, 0)
  assert.equal(scriptFamilies(join(root, 'other'), ['Clip.funscript'], false)[0]!.id === family.id, false)
  check('ambiguous owners, missing main axes and duplicate axis aliases never get silently combined')

  // Source metadata must survive old-build-style round trips too.
  assert.deepEqual(MediaMetaSchema.parse(await meta('videos/External.mp4')).scriptVersions[0]!.importedFrom, imported.importedFrom)
  await assert.rejects(() => setScriptFolders(libraryId, [root]))
  await assert.rejects(() => setScriptFolders(libraryId, [fixture]))
  await assert.rejects(() => setScriptFolders(libraryId, ['relative/folder']))
  check('import provenance round-trips and invalid search roots are rejected')

  await rename(`${external}-offline`, external)
  await deleteScriptVersion(libraryId, id('videos/External.mp4'), imported.id)
  assert.equal(existsSync(resolve(root, 'videos', imported.files.main!)), false)
  assert.equal(await readFile(join(external, 'nested/External.funscript'), 'utf8'), 'external main')
  check('deleting an imported version removes library copies and leaves source files intact')

  await put(join(root, 'families', 'Variants.funscript'))
  await put(join(root, 'families', 'Variants_soft.funscript'))
  await requestSync(libraryId)
  assert.ok(internalHandle(libraryId).db.findIdByRelPath('families/Variants.mp4'))
  assert.equal(internalHandle(libraryId).db.findIdByRelPath('families/Variants_soft.mp4'), null)
  assert.equal((await meta('families/Variants.mp4')).scriptVersions.length, 2)
  check('script variants get one placeholder without duplicate ownership')
  console.log(`Completed ${checks} script matching checks.`)
} finally {
  setBusy(false)
  await stopLibrary(libraryId)
  const rel = relative(tmpdir(), fixture)
  if (rel.startsWith('fsmgr-script-match-fixture-') && !isAbsolute(rel)) {
    await rm(fixture, { recursive: true, force: true })
  }
}
