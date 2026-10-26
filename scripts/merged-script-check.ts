import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { ioCalls, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { parseFunscript, parseFunscriptAxes } from '../src/shared/funscript'
import { SCRIPT_AXIS_KEYS, MediaMetaSchema } from '../src/shared/schemas/media-meta'
import {
  startLibrary, stopLibrary, internalHandle, requestSync, getMediaDetail,
  updateScriptVersion, addScriptVersion, mergeWantedInto
} from '../src/main/services/library/library-manager'
import { planRename, renameMedia } from '../src/main/services/library/media-lifecycle'
import { effectiveScriptVersion } from '../src/main/services/library/script-axes'
import { prepareSession } from '../src/main/services/playback/playback-session'
import { loadScriptFile, loadScriptFiles } from '../src/script-player/infrastructure/scripts/load-scripts'

const fixture = await mkdtemp(join(tmpdir(), 'fsmgr-merged-check-'))
const root = join(fixture, 'library')
const libraryId = randomUUID()
let checks = 0
const check = (name: string): void => { checks++; console.log(`PASS: ${name}`) }
const actions = (pos: number) => [{ at: 0, pos }, { at: 1000, pos: 100 - pos }]
const merged = JSON.stringify({ actions: actions(10), axes: [
  { id: 'L1', actions: actions(20) }, { id: 'L2', actions: actions(30) },
  { id: 'R0', actions: actions(40) }, { id: 'R1', actions: actions(45) },
  { id: 'R2', actions: actions(35) }
] })
async function put(path: string, text = 'media'): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}
const handle = () => internalHandle(libraryId)
async function meta(path: string) {
  const read = await handle().store.read(join(root, path))
  assert.ok(read.ok)
  return read.meta
}
function resolved(version: { files: Partial<Record<(typeof SCRIPT_AXIS_KEYS)[number], string>> }, mediaPath: string) {
  return Object.fromEntries(Object.entries(version.files).map(([axis, path]) => [axis, join(dirname(join(root, mediaPath)), path!)]))
}
try {
  assert.deepEqual(parseFunscript(JSON.stringify({ inverted: true, actions: [
    { at: 2, pos: -20 }, { at: 1, pos: 20 }, { at: 1, pos: 30 },
    { at: -1, pos: 10 }, { at: 3, pos: 'bad' }
  ] }))?.actions, [{ at: 1, pos: 70 }, { at: 2, pos: 100 }])
  assert.equal(parseFunscript('{broken'), null)
  assert.deepEqual(Object.keys(parseFunscriptAxes(merged)).sort(), [...SCRIPT_AXIS_KEYS].sort())
  const channels = parseFunscriptAxes(JSON.stringify({ inverted: true, actions: actions(1), channels: {
    stroke: { actions: actions(11) }, roll: { actions: actions(22), inverted: false },
    R2: actions(33), unknown: { actions: actions(5) }, constructor: { actions: actions(5) }
  } }))
  assert.equal(channels.main?.actions[0]?.pos, 89)
  assert.equal(channels.roll?.actions[0]?.pos, 22)
  assert.equal(channels.pitch?.actions[0]?.pos, 67)
  assert.equal(Object.keys(channels).length, 3)
  assert.equal(parseFunscript('\uFEFF' + JSON.stringify({ channels: { stroke: { actions: actions(8) } } }))?.actions[0]?.pos, 8)
  const malformed = parseFunscriptAxes(JSON.stringify({ actions: actions(9), axes: [
    null, { id: 'R1', actions: [{ at: -1, pos: 5 }] }, { id: 'unknown', actions: actions(5) }
  ] }))
  assert.deepEqual(Object.keys(malformed), ['main'])
  check('single-axis normalization and merged axes/channels handle aliases, inversion, BOM and invalid tracks')

  await put(join(root, 'Old.mp4'))
  await put(join(root, 'Old.funscript'), merged)
  const oldVersionId = randomUUID()
  const now = new Date().toISOString()
  const legacy = MediaMetaSchema.parse({ schemaVersion: 3, id: randomUUID(),
    fileFingerprint: { size: 5, blake3Head: 'legacy' }, mediaInfo: { durationMs: 1000 },
    scriptVersions: [{ id: oldVersionId, name: 'Existing', isDefault: true, files: { main: 'Old.funscript' } }],
    createdAt: now, updatedAt: now })
  await put(join(root, 'Old.mp4.meta.json'), JSON.stringify(legacy))
  await put(join(root, 'New.mp4'))
  await put(join(root, 'New.funscript'), merged)
  await put(join(root, 'Waiting.funscript'), merged)
  await startLibrary({ id: libraryId, name: 'Merged fixture', rootPath: root })
  const oldId = handle().db.findIdByRelPath('Old.mp4')!
  const old = await meta('Old.mp4')
  assert.equal(old.scriptVersions[0]!.id, oldVersionId)
  for (const path of ['Old.mp4', 'New.mp4', 'Waiting.mp4']) {
    const saved = await meta(path)
    assert.equal(saved.scriptVersions.length, 1)
    assert.equal(Object.keys(saved.scriptVersions[0]!.files).length, 6)
    const detail = await getMediaDetail(libraryId, saved.id)
    assert.equal(detail?.scriptVersions[0]?.isMultiAxis, true)
    assert.equal(detail?.scriptVersions[0]?.files.length, 1)
    assert.equal(detail?.scriptVersions[0]?.axes.length, 6)
  }
  const oldWritten = JSON.parse(await readFile(join(root, 'Old.mp4.meta.json'), 'utf8'))
  assert.equal(Object.keys(oldWritten.scriptVersions[0].fileAxes).length, 6)
  check('new media, existing main-only sidecars and script-only entries discover all six axes')

  await requestSync(libraryId)
  assert.equal((await meta('Old.mp4')).scriptVersions.length, 1)
  const version = (await meta('Old.mp4')).scriptVersions[0]!
  const loaded = await loadScriptFiles(resolved(version, 'Old.mp4'), version.fileAxes)
  const expected = parseFunscriptAxes(merged)
  for (const axis of SCRIPT_AXIS_KEYS) assert.deepEqual(loaded[axis]?.script, expected[axis])
  assert.deepEqual((await loadScriptFile(join(root, 'Old.funscript'), 'roll', true))?.script, expected.roll)
  const staged = await prepareSession(root, join(root, 'Old.mp4'), version)
  assert.equal(Object.keys(staged).length, 6)
  for (const axis of SCRIPT_AXIS_KEYS) assert.deepEqual(parseFunscript(await readFile(staged[axis]!, 'utf8')), expected[axis])
  assert.equal(await readFile(join(root, 'Old.funscript'), 'utf8'), merged)
  check('internal loading and MFP staging select each axis data while preserving the source')

  await put(join(root, 'Alternative.funscript'), JSON.stringify({ actions: actions(3) }))
  assert.equal((await loadScriptFile(join(root, 'Alternative.funscript'), 'roll', true))?.script.actions[0]?.pos, 3)
  await addScriptVersion(libraryId, oldId, { name: 'Alternative', files: { main: join(root, 'Alternative.funscript') } })
  const withAlternative = await meta('Old.mp4')
  const alternative = withAlternative.scriptVersions.find(v => v.name === 'Alternative')!
  const effective = effectiveScriptVersion(withAlternative, alternative)
  const borrowed = await loadScriptFiles(resolved(effective, 'Old.mp4'), effective.fileAxes)
  assert.equal(borrowed.main?.script.actions[0]?.pos, 3)
  assert.deepEqual(borrowed.roll?.script, expected.roll)
  check('single-axis alternatives borrow embedded tracks without replacing their own main track')

  await updateScriptVersion(libraryId, oldId, oldVersionId, { axisAssignments: { roll: 'pitch', pitch: 'roll' } })
  const remapped = (await meta('Old.mp4')).scriptVersions.find(v => v.id === oldVersionId)!
  const swapped = await loadScriptFiles(resolved(remapped, 'Old.mp4'), remapped.fileAxes)
  assert.deepEqual(swapped.roll?.script, expected.pitch)
  assert.deepEqual(swapped.pitch?.script, expected.roll)
  await requestSync(libraryId)
  assert.equal((await meta('Old.mp4')).scriptVersions.find(v => v.id === oldVersionId)!.fileAxes?.roll, 'pitch')
  check('axis corrections retain source-track selectors after another scan')

  const newId = handle().db.findIdByRelPath('New.mp4')!
  const plan = await planRename(libraryId, newId, 'Renamed.mp4', true)
  assert.equal(plan.items.filter(item => item.kind === 'script').length, 1)
  await renameMedia(libraryId, newId, 'Renamed.mp4', true)
  const renamed = (await meta('Renamed.mp4')).scriptVersions[0]!
  assert.ok(Object.values(renamed.files).every(file => file === 'Renamed.funscript'))
  assert.equal(Object.keys(await loadScriptFiles(resolved(renamed, 'Renamed.mp4'), renamed.fileAxes)).length, 6)
  check('renaming a six-axis version moves the physical file once and preserves every axis')

  await put(join(root, 'Target.mp4'))
  await requestSync(libraryId)
  const wantedId = handle().db.findIdByRelPath('Waiting.mp4')!
  await mergeWantedInto(libraryId, handle().db.findIdByRelPath('Target.mp4')!, [wantedId])
  assert.equal(Object.keys((await meta('Target.mp4')).scriptVersions[0]!.files).length, 6)
  check('merging a script-only entry into media preserves every shared-file axis')

  // A separate axis file takes priority over the track in the merged source.
  await put(join(root, 'Renamed.roll.funscript'), JSON.stringify({ actions: actions(7) }))
  await requestSync(libraryId)
  const explicit = (await meta('Renamed.mp4')).scriptVersions[0]!
  assert.equal(explicit.files.roll, 'Renamed.roll.funscript')
  assert.equal(explicit.fileAxes?.roll, undefined)
  assert.equal((await loadScriptFiles(resolved(explicit, 'Renamed.mp4'), explicit.fileAxes)).roll?.script.actions[0]?.pos, 7)
  check('separate axis companions override embedded defaults without corrupting their track selection')

  await stopLibrary(libraryId)
  ioCalls.length = 0
  await startLibrary({ id: libraryId, name: 'Merged fixture', rootPath: root })
  assert.equal(Object.keys((await meta('Target.mp4')).scriptVersions[0]!.files).length, 6)
  assert.ok(!ioCalls.some(call => call.operation === 'readFile' && call.path.endsWith('.funscript')))
  check('persisted axis metadata survives restart without rereading unchanged scripts')

  await put(join(root, 'Channels.mp4'))
  await put(join(root, 'Channels.funscript'), JSON.stringify({ channels: {
    stroke: { actions: actions(12) }, pitch: { actions: actions(24) }
  } }))
  await requestSync(libraryId)
  const channelVersion = (await meta('Channels.mp4')).scriptVersions[0]!
  assert.equal(channelVersion.fileAxes?.pitch, 'pitch')
  assert.equal((await loadScriptFiles(resolved(channelVersion, 'Channels.mp4'), channelVersion.fileAxes)).main?.script.actions[0]?.pos, 12)
  await put(join(root, 'Channels.funscript'), JSON.stringify({ actions: actions(18) }))
  await requestSync(libraryId)
  assert.deepEqual(Object.keys((await meta('Channels.mp4')).scriptVersions[0]!.files), ['main'])
  await put(join(root, 'Channels.funscript'), merged)
  await requestSync(libraryId)
  assert.equal(Object.keys((await meta('Channels.mp4')).scriptVersions[0]!.files).length, 6)
  check('channel-only scripts load and file replacement refreshes cached embedded axes')

  if (process.argv[3]) {
    const source = await readFile(process.argv[3])
    const hash = createHash('sha256').update(source).digest('hex')
    await put(join(root, 'Sample.mp4'))
    await put(join(root, 'Sample.funscript'), source.toString('utf8'))
    await requestSync(libraryId)
    const sample = (await meta('Sample.mp4')).scriptVersions[0]!
    const axes = parseFunscriptAxes(source.toString('utf8'))
    const actual = await loadScriptFiles(resolved(sample, 'Sample.mp4'), sample.fileAxes)
    const sampleStaged = await prepareSession(root, join(root, 'Sample.mp4'), sample)
    for (const axis of SCRIPT_AXIS_KEYS) {
      assert.deepEqual(actual[axis]?.script, axes[axis])
      assert.deepEqual(parseFunscript(await readFile(sampleStaged[axis]!, 'utf8')), axes[axis])
    }
    assert.equal(createHash('sha256').update(await readFile(process.argv[3])).digest('hex'), hash)
    check(`supplied sample loads and stages all axes unchanged: ${JSON.stringify(Object.fromEntries(SCRIPT_AXIS_KEYS.map(axis => [axis, actual[axis]?.script.actions.length])))}`)
  }
  console.log(`${checks} merged-script checks passed`)
} finally {
  await stopLibrary(libraryId).catch(() => {})
  const rel = relative(tmpdir(), fixture)
  if (rel.startsWith('fsmgr-merged-check-') && !isAbsolute(rel)) await rm(fixture, { recursive: true, force: true })
}
