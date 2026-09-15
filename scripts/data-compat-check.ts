/**
 * Does an older build damage files a newer one wrote?
 *
 * Each case writes a file the way a future version might, runs it through the
 * code an older build would use, and checks what is left on disk.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MediaMetaSchema, MEDIA_META_VERSION } from '@shared/schemas/media-meta'
import { TaxonomyFileSchema } from '@shared/schemas/taxonomy'
import { LibraryJsonSchema } from '@shared/schemas/library'
import { SettingsSchema } from '@shared/schemas/app-config'
import { readSidecar, writeSidecar } from '../src/main/services/library/sidecar'
import { setAsideUnreadable, withUnknownKeys } from '../src/main/util/persisted'

const dir = mkdtempSync(join(tmpdir(), 'fsm-downgrade-'))
let failures = 0
const check = (name: string, ok: boolean, detail?: unknown): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`, ok ? '' : JSON.stringify(detail))
}

// 1. A sidecar of today's version, with fields a newer build added.
const sidecarPath = join(dir, 'clip.mp4.meta.json')
writeFileSync(
  sidecarPath,
  JSON.stringify({
    schemaVersion: MEDIA_META_VERSION,
    id: '11111111-1111-4111-8111-111111111111',
    fileFingerprint: { size: 10, blake3Head: 'abc', futureHash: 'keep me' },
    title: 'Clip',
    tags: ['vr'],
    scriptVersions: [
      { id: '22222222-2222-4222-8222-222222222222', name: 'main', files: { main: 'clip.funscript' }, futureField: 'keep me too' }
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    futureTopLevel: { anything: true }
  })
)
const read = await readSidecar(sidecarPath)
if (!read.ok) {
  check('sidecar with unknown fields reads', false, read)
} else {
  check('sidecar with unknown fields reads', true)
  // An edit an older build would make: rename, then save.
  await writeSidecar(sidecarPath, { ...read.meta, title: 'Renamed' })
  const after = JSON.parse(readFileSync(sidecarPath, 'utf8'))
  check('unknown top-level field survives an edit', after.futureTopLevel?.anything === true, after)
  check('unknown nested field survives an edit', after.fileFingerprint?.futureHash === 'keep me', after.fileFingerprint)
  check('unknown field inside a list item survives', after.scriptVersions?.[0]?.futureField === 'keep me too', after.scriptVersions)
  check('the edit itself landed', after.title === 'Renamed', after.title)
}

// 2. A sidecar from a future schema version: read must refuse, nothing written.
const futurePath = join(dir, 'future.mp4.meta.json')
const futureBody = JSON.stringify({ schemaVersion: MEDIA_META_VERSION + 1, id: 'x', brandNew: 1 })
writeFileSync(futurePath, futureBody)
const futureRead = await readSidecar(futurePath)
check('newer sidecar is reported as newer', !futureRead.ok && futureRead.error === 'newer', futureRead)
check('newer sidecar is untouched', readFileSync(futurePath, 'utf8') === futureBody)

// 3. Taxonomy and library.json keep unknown fields through a parse.
const tax = TaxonomyFileSchema.parse({
  schemaVersion: 1,
  entities: { tags: [{ name: 'vr', aliases: [], futureColor: 'red' }] },
  futureSection: { kept: true }
})
check('taxonomy keeps an unknown section', (tax as Record<string, unknown>).futureSection !== undefined, tax)
check(
  'taxonomy keeps an unknown field on an entity',
  (tax.entities.tags[0] as Record<string, unknown>).futureColor === 'red',
  tax.entities.tags[0]
)
const lib = LibraryJsonSchema.parse({ schemaVersion: 1, futureIndexHints: [1, 2] })
check('library.json keeps an unknown field', (lib as Record<string, unknown>).futureIndexHints !== undefined, lib)

// 4. Settings are strict, so unknown keys come back on the way out.
const rawSettings = {
  schemaVersion: 1,
  ui: { theme: 'dark', futureUiFlag: true },
  futureSection: { deep: { value: 5 } }
}
const parsedSettings = SettingsSchema.parse(rawSettings)
check('strict parsing drops the unknown keys', (parsedSettings as Record<string, unknown>).futureSection === undefined)
const toWrite = withUnknownKeys(parsedSettings, rawSettings) as Record<string, unknown>
check('unknown settings section is put back', JSON.stringify(toWrite.futureSection) === '{"deep":{"value":5}}', toWrite.futureSection)
check('unknown key inside a known section is put back', (toWrite.ui as Record<string, unknown>).futureUiFlag === true, toWrite.ui)
check('the known value still wins', (toWrite.ui as Record<string, unknown>).theme === 'dark', toWrite.ui)

// 5. A file that cannot be read is moved aside rather than replaced.
const broken = join(dir, 'taxonomy.json')
writeFileSync(broken, '{"schemaVersion":99,"entities":"not what this build expects"}')
await setAsideUnreadable(broken)
check('unreadable file is moved aside', !existsSync(broken) && existsSync(`${broken}.unreadable`))
check(
  'the moved copy still holds the data',
  readFileSync(`${broken}.unreadable`, 'utf8').includes('"schemaVersion":99')
)

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
