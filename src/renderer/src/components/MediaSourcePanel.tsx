import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, X } from 'lucide-react'
import type { MediaSourceKind, MediaSourceProfile, Settings } from '@shared/schemas/app-config'
import type { IpcOutput } from '@shared/ipc/contract'
import { askConfirm } from '../dialogs'
import { ipcInvoke, ipcOn } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'
import { playerLabel } from '../playerLabel'

/**
 * The video players, and which one is in use.
 *
 * One player is current and it is the only one connected, so picking is the
 * only control here — no connect button, no auto-connect switch. The current
 * player is attached to whenever it is running, and pressing play is what
 * starts one that is not.
 */

type SourceStatus = IpcOutput<'playback:sources'>[number]

/** What the "add" sheet offers. The built-in picture is always in the list
 *  already and cannot be added a second time. */
const KINDS: MediaSourceKind[] = ['mpv', 'mpc-hc', 'heresphere']

/** Ports the players listen on out of the box. */
const DEFAULT_PORT: Record<MediaSourceKind, number> = {
  internal: 13579,
  mpv: 13579,
  'mpc-hc': 13579,
  heresphere: 23554
}

function kindLabel(kind: MediaSourceKind): string {
  switch (kind) {
    case 'internal': return 'Built-in'
    case 'mpv': return 'mpv'
    case 'mpc-hc': return 'MPC-HC'
    case 'heresphere': return 'HereSphere'
  }
}

function makeProfile(kind: MediaSourceKind, taken: string[]): MediaSourceProfile {
  const base = kindLabel(kind)
  let name = base
  for (let n = 2; taken.includes(name); n++) name = `${base} ${n}`
  return {
    id: crypto.randomUUID(),
    name,
    kind,
    exePath: '',
    host: '127.0.0.1',
    port: DEFAULT_PORT[kind]
  }
}

/** What the row says on its right: the player's own situation, in a word. */
function stateKey(status: SourceStatus | undefined): string {
  if (!status) return 'offline'
  if (status.playing) return 'playing'
  if (status.state === 'connected') return status.path ? 'paused' : 'ready'
  if (status.state === 'connecting') return 'connecting'
  // The built-in picture is not "not running" when it is down — there is no
  // program to run. It is simply not open.
  if (status.kind === 'internal') return 'closed'
  return status.capabilities.launch ? 'notRunning' : 'offline'
}

function dotClass(status: SourceStatus | undefined, current: boolean): string {
  if (!current) return ''
  if (!status) return ''
  if (status.state === 'connected') return 'ok'
  if (status.state === 'connecting') return 'warn'
  return status.state === 'error' ? 'err' : ''
}

export default function MediaSourcePanel({
  onClose
}: {
  onClose?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [sources, setSources] = useState<MediaSourceProfile[]>([])
  const [status, setStatus] = useState<SourceStatus[]>([])
  const [currentId, setCurrentId] = useState<string>('')
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  /** Built-in player only: does closing the picture stop the sound too? */
  const [keepPlaying, setKeepPlayingState] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    ipcInvoke('settings:get')
      .then((s: Settings) => {
        setSources(s.playback.sources)
        setCurrentId(s.playback.currentSourceId)
        setKeepPlayingState(s.playback.keepPlayingWhenClosed)
      })
      .catch((e) => setError(toMessage(e)))
    ipcInvoke('playback:sources').then(setStatus).catch(() => {})
    const off = ipcOn('event:playback-sources', setStatus)
    return () => {
      off()
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [toMessage])

  /** Typing in a field should not write settings.json on every keystroke. */
  const save = (next: MediaSourceProfile[], delay = 400): void => {
    setSources(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void ipcInvoke('settings:update', { playback: { sources: next } }).catch((e) =>
        setError(toMessage(e))
      )
    }, delay)
  }

  const setKeepPlaying = (keep: boolean): void => {
    setKeepPlayingState(keep)
    void ipcInvoke('settings:update', {
      playback: { keepPlayingWhenClosed: keep }
    }).catch((e) => setError(toMessage(e)))
  }

  const update = (id: string, patch: Partial<MediaSourceProfile>): void => {
    save(sources.map((source) => (source.id === id ? { ...source, ...patch } : source)))
  }

  const choose = async (id: string): Promise<void> => {
    if (id === currentId || busy) return
    setBusy(true)
    setCurrentId(id)
    setError(null)
    try {
      setStatus(await ipcInvoke('playback:setCurrentSource', { id }))
    } catch (e) {
      setError(toMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const add = (kind: MediaSourceKind): void => {
    const profile = makeProfile(kind, sources.map((s) => s.name))
    save([...sources, profile], 0)
    setAdding(false)
  }

  const remove = async (source: MediaSourceProfile): Promise<void> => {
    const ok = await askConfirm({
      message: t('players.removeConfirm', { name: source.name }),
      confirmLabel: t('players.remove'),
      danger: true
    })
    if (!ok) return
    const next = sources.filter((item) => item.id !== source.id)
    save(next, 0)
    // The list decides the fallback: dropping the current player leaves the
    // first one in use, and the main side has to be told before it is asked.
    if (source.id === currentId && next[0]) await choose(next[0].id)
  }

  const browse = async (source: MediaSourceProfile): Promise<void> => {
    const { path } = await ipcInvoke('dialog:pickFile', { title: kindLabel(source.kind) })
    if (path) update(source.id, { exePath: path })
  }

  return (
    <section className="media-source">
      <header className="sp-header">
        <div>
          <h1>{t('players.title')}</h1>
          <div className="sp-now">{t('players.hint')}</div>
        </div>
        {onClose && (
          <button className="icon-btn" title={t('common.close')} onClick={onClose}>
            <X size={17} />
          </button>
        )}
      </header>

      {error && <div className="error-banner sp-error">{error}</div>}

      <div className="ms-list" data-tour="sources-list">
        {sources.length === 0 && <p className="settings-hint">{t('players.empty')}</p>}

        {sources.map((source) => {
          const live = status.find((item) => item.id === source.id)
          const current = source.id === currentId
          return (
            <div
              key={source.id}
              className={`ms-row${current ? ' on' : ''}`}
              onClick={() => void choose(source.id)}
            >
              <div className="ms-head">
                <span className={`ms-radio${current ? ' on' : ''}`} />
                {/* The built-in player is not one the user added, so it has no
                    name of theirs to show and nothing to rename. Its label is
                    translated copy, and the kind beside it would only say the
                    same word twice. */}
                {source.kind === 'internal' ? (
                  <span className="ms-fixed-name">{playerLabel(source, t)}</span>
                ) : (
                  <>
                    <input
                      className="ms-name"
                      value={source.name}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => update(source.id, { name: e.target.value })}
                      onBlur={(e) => {
                        if (!e.target.value.trim()) {
                          update(source.id, { name: kindLabel(source.kind) })
                        }
                      }}
                    />
                    <span className="ms-kind">{kindLabel(source.kind)}</span>
                  </>
                )}
                <span className="ms-state">
                  <span className={`conn-dot ${dotClass(live, current)}`} />
                  {t(`players.state.${current ? stateKey(live) : 'standby'}`)}
                </span>
              </div>

              {current && (
                <div className="ms-body" onClick={(e) => e.stopPropagation()}>
                  {source.kind === 'internal' ? (
                    <label className="ms-toggle">
                      <input
                        type="checkbox"
                        checked={keepPlaying}
                        onChange={(e) => setKeepPlaying(e.target.checked)}
                      />
                      <span>
                        <b>{t('players.keepPlaying')}</b>
                        <i>{t('players.keepPlayingHint')}</i>
                      </span>
                    </label>
                  ) : source.kind === 'mpv' ? (
                    <label className="ms-field">
                      <span>{t('players.exePath')}</span>
                      <input
                        className="settings-input"
                        value={source.exePath}
                        placeholder={t('players.exePathPlaceholder')}
                        onChange={(e) => update(source.id, { exePath: e.target.value })}
                      />
                      <button className="ghost" onClick={() => void browse(source)}>
                        {t('settings.browse')}
                      </button>
                    </label>
                  ) : (
                    <label className="ms-field">
                      <span>{t('players.address')}</span>
                      <input
                        className="settings-input"
                        value={source.host}
                        onChange={(e) => update(source.id, { host: e.target.value })}
                      />
                      <input
                        className="settings-input port"
                        type="number"
                        min={1}
                        max={65535}
                        value={source.port}
                        onChange={(e) => {
                          const port = Number(e.target.value)
                          if (Number.isFinite(port)) update(source.id, { port })
                        }}
                      />
                    </label>
                  )}

                  {source.kind === 'mpc-hc' && (
                    <label className="ms-field">
                      <span>{t('players.exePathOptional')}</span>
                      <input
                        className="settings-input"
                        value={source.exePath}
                        placeholder={t('players.exePathPlaceholder')}
                        onChange={(e) => update(source.id, { exePath: e.target.value })}
                      />
                      <button className="ghost" onClick={() => void browse(source)}>
                        {t('settings.browse')}
                      </button>
                    </label>
                  )}

                  <p className="settings-hint">{t(`players.about.${source.kind}`)}</p>

                  {/* The built-in picture is part of the app, not something
                      the user added, so there is nothing to remove. */}
                  {source.kind !== 'internal' && (
                    <div className="row">
                      <div className="grow" />
                      <button
                        className="ghost icon"
                        title={t('players.remove')}
                        onClick={() => void remove(source)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <footer className="sp-add" data-tour="sources-add">
        <button className="ghost" onClick={() => setAdding(true)}>
          <Plus size={15} />
          {t('players.add')}
        </button>
      </footer>

      {adding && (
        <div
          className="sp-sheet"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setAdding(false)
          }}
        >
          <div className="sp-sheet-card" role="dialog" aria-modal="true" aria-label={t('players.choose')}>
            <h2>{t('players.choose')}</h2>
            <div className="sp-sheet-options">
              {KINDS.map((kind) => (
                <button key={kind} className="sp-sheet-option" onClick={() => add(kind)}>
                  {kindLabel(kind)}
                </button>
              ))}
            </div>
            <button className="ghost sp-sheet-cancel" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
