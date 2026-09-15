import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import type { SubtitleCue, SubtitleTrack } from '@shared/schemas/playback'
import { getSettings, updateSettings } from '../config/config-service'
import { resolveFfmpeg } from '../deps/binaries'
import { findByAbsPath, getMediaDetail } from '../library/library-manager'
import { setVideoIntent, videoIntent } from './internal/surface'

/**
 * Where the built-in picture's subtitles come from, and what they say.
 *
 * Everything ends up as plain lines with a start and an end, because the look
 * is the user's to set: one font size and colour applied to every subtitle is
 * the point, and a file that carries its own styling would otherwise ignore
 * both. So `.ass` positioning, karaoke and sign typesetting are dropped here
 * rather than half-honoured on screen.
 *
 * The picture cannot use these files directly. A `<video>` accepts WebVTT and
 * nothing else, and even then styles it its own way, so the lines are handed
 * to the renderer as data and drawn as ordinary text over the picture.
 */

/** Text-based codecs. Anything else in a container is pictures, not lines. */
const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'])

/** `Stream #0:2[0x3](jpn): Subtitle: subrip (default)` */
const SUBTITLE_STREAM = /Stream #\d+:(\d+)(?:\[[^\]]*\])?(?:\(([^)]+)\))?:\s*Subtitle:\s*([\w-]+)/

/** ffmpeg keeps a stream's own name in the metadata block under its line. */
const STREAM_TITLE = /^\s*title\s*:\s*(.+?)\s*$/

/** Reading a subtitle out of a container is a header read plus a decode. */
const EXTRACT_TIMEOUT_MS = 30_000

/**
 * Every subtitle available for one video.
 *
 * Files next to the video come from the library index, which found them while
 * scanning — the same list the detail panel shows. Tracks inside the video
 * cost an ffmpeg run, so they come second and an unreadable file simply
 * contributes none.
 */
export async function listSubtitleTracks(videoPath: string): Promise<SubtitleTrack[]> {
  const tracks: SubtitleTrack[] = []
  tracks.push(...(await companionTracks(videoPath)))
  tracks.push(...(await embeddedTracks(videoPath)))
  return tracks
}

async function companionTracks(videoPath: string): Promise<SubtitleTrack[]> {
  const found = findByAbsPath(videoPath)
  if (!found) return []
  const detail = await getMediaDetail(found.libraryId, found.mediaId).catch(() => null)
  if (!detail) return []
  const dir = dirname(resolve(found.libraryRoot, found.mediaRelPath))
  return detail.subtitles.map((sub) => {
    const abs = resolve(dir, sub.path)
    return {
      id: `file:${abs.toLowerCase()}`,
      origin: 'companion' as const,
      path: abs,
      streamIndex: null,
      language: sub.language,
      // The language marker if the file carried one, the file name otherwise:
      // several unmarked subtitles beside one video are told apart by name and
      // by nothing else.
      label: sub.language ?? basename(abs)
    }
  })
}

async function embeddedTracks(videoPath: string): Promise<SubtitleTrack[]> {
  const banner = await ffmpegBanner(videoPath)
  if (!banner) return []
  const tracks: SubtitleTrack[] = []
  const lines = banner.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const match = SUBTITLE_STREAM.exec(lines[i] ?? '')
    if (!match) continue
    const index = match[1] ?? ''
    const codec = (match[3] ?? '').toLowerCase()
    if (!TEXT_SUBTITLE_CODECS.has(codec)) continue
    // The stream's own name, when it has one, is the only thing that tells
    // two tracks of the same language apart ("Japanese" / "Japanese (signs)").
    let title: string | null = null
    for (let j = i + 1; j < lines.length && /^\s{4,}/.test(lines[j] ?? ''); j++) {
      const named = STREAM_TITLE.exec(lines[j] ?? '')
      if (named) {
        title = named[1] ?? null
        break
      }
    }
    // ffmpeg reports the three-letter code. Reduced to the two-letter one
    // here so a track inside the video and a file beside it are marked the
    // same way — which is what lets one remembered choice cover both.
    const language = (match[2] ?? '').toLowerCase()
    const named = LANGUAGE_ALIASES[language] ?? language
    const lang = named && named !== 'und' ? named : null
    tracks.push({
      id: `embedded:${index}`,
      origin: 'embedded',
      path: videoPath,
      streamIndex: Number(index),
      language: lang,
      label: title ?? lang ?? `#${index}`
    })
  }
  return tracks
}

/** A subtitle the user pointed at, which is outside the library by definition. */
export function pickedTrack(path: string): SubtitleTrack {
  return {
    id: `file:${path.toLowerCase()}`,
    origin: 'picked',
    path,
    streamIndex: null,
    language: null,
    label: basename(path)
  }
}

/**
 * Two ways to write the same language.
 *
 * A file beside the video is marked the way its author typed it (`en`,
 * `zh-CN`); a track inside a container is marked the way ffmpeg reports it,
 * which is the three-letter code (`eng`, `chi`). Remembering "Japanese" has to
 * survive moving between the two, so both are reduced to the same key.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  eng: 'en',
  jpn: 'ja',
  chi: 'zh',
  zho: 'zh',
  kor: 'ko',
  fra: 'fr',
  fre: 'fr',
  deu: 'de',
  ger: 'de',
  spa: 'es',
  rus: 'ru',
  ita: 'it',
  por: 'pt',
  nld: 'nl',
  dut: 'nl'
}

function languageKey(language: string | null): string {
  const base = (language ?? '').toLowerCase().split(/[-_]/)[0] ?? ''
  return LANGUAGE_ALIASES[base] ?? base
}

/**
 * The subtitle to start a video with, going by what was chosen last.
 *
 * A language rather than a file, because the next video has different files
 * and usually the same languages. Nothing matching means no subtitle: turning
 * one on that the user did not ask for is worse than showing none.
 */
export async function autoSubtitleFor(videoPath: string): Promise<SubtitleTrack | null> {
  const { subtitles } = (await getSettings()).playback
  if (!subtitles.on) return null
  const tracks = await listSubtitleTracks(videoPath)
  const want = languageKey(subtitles.language)
  return tracks.find((track) => languageKey(track.language) === want) ?? null
}

/**
 * Put the remembered language on the video that just started.
 *
 * Off the critical path: finding out what a file offers can mean reading the
 * whole container, and the video is not going to wait for that. By the time it
 * answers the user may have moved on or chosen a subtitle by hand, so it lands
 * only if the picture is still on the file this was asked about.
 */
export async function applyRememberedSubtitle(videoPath: string): Promise<void> {
  const track = await autoSubtitleFor(videoPath).catch(() => null)
  const intent = videoIntent()
  if (!track || intent.subtitle !== null || intent.media?.path !== videoPath) return
  setVideoIntent({ subtitle: track })
}

/** Keep the choice for the next video: which language, or none at all. */
export async function rememberSubtitleChoice(track: SubtitleTrack | null): Promise<void> {
  const current = (await getSettings()).playback.subtitles
  const next = track
    ? { ...current, on: true, language: track.language ?? '' }
    : { ...current, on: false }
  await updateSettings({ playback: { subtitles: next } })
}

/** The lines of one track, in order. An unreadable track gives none. */
export async function loadSubtitleCues(track: SubtitleTrack): Promise<SubtitleCue[]> {
  const raw =
    track.streamIndex === null
      ? await readSubtitleFile(track.path)
      : await extractSubtitle(track.path, track.streamIndex)
  if (raw === null) return []
  const format = track.streamIndex === null ? extname(track.path).toLowerCase() : '.vtt'
  const cues =
    format === '.ass' || format === '.ssa'
      ? parseAss(raw)
      : format === '.vtt'
        ? parseVtt(raw)
        : parseSrt(raw)
  return cues.filter((cue) => cue.text !== '' && cue.endMs > cue.startMs).sort((a, b) => a.startMs - b.startMs)
}

async function readSubtitleFile(path: string): Promise<string | null> {
  try {
    return decodeText(await readFile(path))
  } catch {
    return null
  }
}

/**
 * Bytes to text without being told the encoding.
 *
 * Subtitle files carry no encoding declaration and are routinely not UTF-8:
 * a Chinese `.srt` off a forum is as likely to be GB18030, and decoded as
 * UTF-8 it is a screenful of replacement characters rather than an error. So
 * UTF-8 is tried strictly first and anything that is not valid UTF-8 is read
 * as GB18030, which also covers the traditional-Chinese range.
 */
export function decodeText(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2))
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2))
  }
  const body =
    buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      ? buffer.subarray(3)
      : buffer
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(body)
    } catch {
      return body.toString('latin1')
    }
  }
}

/** `00:01:02,500` / `0:01:02.50` / `01:02.500` → milliseconds. */
function toMs(stamp: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(stamp.trim())
  if (!match) return null
  const ms = Number((match[4] ?? '0').padEnd(3, '0'))
  return ((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + ms
}

/**
 * Markup out, line breaks kept.
 *
 * `<i>`, `<font color=…>` and the rest are the file's idea of how it should
 * look; the settings panel is the user's, and only one of the two can win.
 */
function cleanText(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
    .trim()
}

/** Blocks separated by a blank line; the arrow line carries the times. */
function parseCueBlocks(text: string, arrow: RegExp): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const at = lines.findIndex((line) => arrow.test(line))
    if (at === -1) continue
    const times = arrow.exec(lines[at] ?? '')
    if (!times) continue
    const startMs = toMs(times[1] ?? '')
    const endMs = toMs(times[2] ?? '')
    if (startMs === null || endMs === null) continue
    cues.push({ startMs, endMs, text: cleanText(lines.slice(at + 1).join('\n')) })
  }
  return cues
}

const ARROW = /([\d:.,]+)\s*-->\s*([\d:.,]+)/

export function parseSrt(text: string): SubtitleCue[] {
  return parseCueBlocks(text, ARROW)
}

export function parseVtt(text: string): SubtitleCue[] {
  // The header block, NOTE and STYLE carry no arrow, so they fall away with
  // everything else that is not a cue.
  return parseCueBlocks(text, ARROW)
}

/**
 * The `[Events]` section of an ASS/SSA file, as plain lines.
 *
 * Only the times and the text are read. Column order is taken from the
 * `Format:` line rather than assumed — it is free to differ, and the text is
 * always the last column, which is also why it is the only one allowed to
 * contain commas.
 */
export function parseAss(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  let columns: string[] | null = null
  let inEvents = false
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      inEvents = trimmed.toLowerCase() === '[events]'
      continue
    }
    if (!inEvents) continue
    if (/^Format\s*:/i.test(trimmed)) {
      columns = trimmed
        .slice(trimmed.indexOf(':') + 1)
        .split(',')
        .map((name) => name.trim().toLowerCase())
      continue
    }
    if (!/^Dialogue\s*:/i.test(trimmed) || !columns) continue
    const start = columns.indexOf('start')
    const end = columns.indexOf('end')
    const textAt = columns.indexOf('text')
    if (start === -1 || end === -1 || textAt === -1) continue
    // Split off exactly as many fields as there are columns: the last one
    // keeps its commas, which dialogue regularly contains.
    const fields = trimmed.slice(trimmed.indexOf(':') + 1).split(',')
    const head = fields.slice(0, textAt)
    const body = fields.slice(textAt).join(',')
    if (head.length < textAt) continue
    const startMs = toMs(head[start] ?? '')
    const endMs = toMs(head[end] ?? '')
    if (startMs === null || endMs === null) continue
    cues.push({ startMs, endMs, text: cleanAss(body) })
  }
  return cues
}

/**
 * An ASS line's text, with the typesetting taken out.
 *
 * A line whose override block draws a shape (`\p1`) is a sign or a mask, not
 * dialogue — its "text" is a list of coordinates, so it is dropped rather
 * than printed.
 */
function cleanAss(text: string): string {
  if (/\{[^}]*\\p[1-9]/.test(text)) return ''
  return cleanText(
    text
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
  )
}

/** `ffmpeg -i` with no output prints what the file contains and exits. */
async function ffmpegBanner(path: string): Promise<string | null> {
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) return null
  return new Promise((done) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(ffmpeg, ['-hide_banner', '-i', path], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      })
    } catch {
      done(null)
      return
    }
    let text = ''
    const timer = setTimeout(() => proc.kill(), 20_000)
    proc.stderr?.on('data', (chunk: Buffer) => (text += chunk.toString()))
    proc.on('error', () => {
      clearTimeout(timer)
      done(null)
    })
    proc.on('close', () => {
      clearTimeout(timer)
      done(text || null)
    })
  })
}

/** One track out of a container, as WebVTT on stdout. */
async function extractSubtitle(videoPath: string, streamIndex: number): Promise<string | null> {
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) return null
  return new Promise((done) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(
        ffmpeg,
        ['-hide_banner', '-loglevel', 'error', '-i', videoPath, '-map', `0:${streamIndex}`, '-f', 'webvtt', '-'],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      )
    } catch {
      done(null)
      return
    }
    const chunks: Buffer[] = []
    const timer = setTimeout(() => proc.kill(), EXTRACT_TIMEOUT_MS)
    proc.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.on('error', () => {
      clearTimeout(timer)
      done(null)
    })
    proc.on('close', () => {
      clearTimeout(timer)
      done(chunks.length > 0 ? decodeText(Buffer.concat(chunks)) : null)
    })
  })
}
