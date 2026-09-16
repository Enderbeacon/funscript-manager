import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Clock,
  Download,
  ExternalLink,
  FolderOpen,
  Image as ImageIcon,
  Newspaper,
  Pause,
  Play,
  RotateCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import type { DownloadJob, DownloadProgress, DownloadState } from '@shared/schemas/download'
import HosterBadge, { hosterName } from '../components/HosterBadge'
import { ScriptPairingPrompt } from '../components/ScriptPairing'
import { ipcInvoke, ipcOn } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'
import { verifyDownload } from '../verifyDownload'
import { formatBytes, formatClock, formatEta } from '../format'
import { useRemoteImage } from '../useRemoteImage'
import { useSurface } from '../surfaces'

/**
 * The download queue. The job list comes from main on every change;
 * byte counts and rates arrive separately as a batched 4 Hz progress event, so
 * a fast download does not re-fetch the whole list 60 times a second.
 *
 * Picking what to download happens on the posts page. This panel answers one
 * question — how is it going — and puts the action for a stuck job in the row
 * that is stuck, not in a settings page the user has to go find.
 */

type Filter = 'all' | 'active' | 'waiting' | 'problem' | 'done'

const IN_FILTER: Record<Exclude<Filter, 'all'>, Set<DownloadState>> = {
  active: new Set<DownloadState>(['running']),
  waiting: new Set<DownloadState>(['pending', 'paused']),
  problem: new Set<DownloadState>(['failed', 'cooling']),
  done: new Set<DownloadState>(['done'])
}

export default function DownloadsPage({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const { z, front, raise } = useSurface('downloads', onClose)
  const [jobs, setJobs] = useState<DownloadJob[]>([])
  const [live, setLive] = useState<Record<string, DownloadProgress>>({})
  const [filter, setFilter] = useState<Filter>('all')
  const [error, setError] = useState<string | null>(null)

  const loadJobs = useCallback(async () => {
    try {
      const { jobs: list } = await ipcInvoke('download:list')
      setJobs(list)
    } catch (e) {
      setError(toMessage(e))
    }
  }, [toMessage])

  useEffect(() => {
    void loadJobs()
    const offChanged = ipcOn('event:downloads-changed', () => void loadJobs())
    const offProgress = ipcOn('event:download-progress', ({ jobs: list }) =>
      setLive((cur) => {
        const next = { ...cur }
        for (const p of list) next[p.id] = p
        return next
      })
    )
    return () => {
      offChanged()
      offProgress()
    }
  }, [loadJobs])

  const act = useCallback(
    async (
      channel: 'download:pause' | 'download:resume' | 'download:retry' | 'download:cancel',
      id: string
    ) => {
      try {
        await ipcInvoke(channel, { id })
        setError(null)
      } catch (e) {
        setError(toMessage(e))
      }
    },
    [toMessage]
  )

  const counts = useMemo(
    () => ({
      all: jobs.length,
      active: jobs.filter((j) => IN_FILTER.active.has(j.state)).length,
      waiting: jobs.filter((j) => IN_FILTER.waiting.has(j.state)).length,
      problem: jobs.filter((j) => IN_FILTER.problem.has(j.state)).length,
      done: jobs.filter((j) => IN_FILTER.done.has(j.state)).length
    }),
    [jobs]
  )

  const shown = filter === 'all' ? jobs : jobs.filter((j) => IN_FILTER[filter].has(j.state))
  const running = jobs.filter((j) => j.state === 'running')
  const speed = running.reduce((sum, j) => sum + (live[j.id]?.speedBytesPerSec ?? 0), 0)

  return (
    <div
      className={`download-queue-overlay${front ? '' : ' behind'}`}
      style={{ zIndex: z }}
      onPointerDown={raise}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="download-queue-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('nav.downloads')}
      >
        <header className="download-queue-head">
          <div>
            <h1>
              <Download size={19} />
              {t('nav.downloads')}
            </h1>
            <div className="download-queue-summary">
              {t('downloads.summary', { count: running.length })}
              {speed > 0 && ` · ${formatBytes(Math.round(speed))}/s`}
            </div>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} title={t('common.close')}>
            <X size={17} />
          </button>
        </header>

        {error && <div className="error-banner download-queue-error">{error}</div>}

        <div className="download-queue-body">
          <ScriptPairingPrompt />
          <div className="dl-tabs">
            {(['all', 'active', 'waiting', 'problem', 'done'] as Filter[]).map((key) => (
              <button
                key={key}
                className={`dl-tab${filter === key ? ' on' : ''}`}
                onClick={() => setFilter(key)}
              >
                {t(`downloads.filter.${key}`)} {counts[key]}
              </button>
            ))}
            {counts.done > 0 && (
              <button
                className="ghost dl-clear"
                onClick={() => void ipcInvoke('download:clearFinished').catch(() => {})}
              >
                {t('downloads.clearFinished')}
              </button>
            )}
          </div>

          <div className="download-queue-list">
            {shown.length === 0 ? (
              <div className="empty">{t('downloads.empty')}</div>
            ) : (
              shown.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  progress={job.state === 'running' ? (live[job.id] ?? null) : null}
                  onPause={() => void act('download:pause', job.id)}
                  onResume={() => void act('download:resume', job.id)}
                  onRetry={() => void act('download:retry', job.id)}
                  onCancel={() => void act('download:cancel', job.id)}
                />
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

function JobRow({
  job,
  progress,
  onPause,
  onResume,
  onRetry,
  onCancel
}: {
  job: DownloadJob
  /** Live sample while running; null otherwise (the row falls back to stored bytes). */
  progress: DownloadProgress | null
  onPause: () => void
  onResume: () => void
  onRetry: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const thumb = useRemoteImage(job.postThumb)
  const bytes = progress?.bytesDownloaded ?? job.bytesDownloaded
  const total = progress?.totalBytes ?? job.totalBytes
  const percent = total && total > 0 ? Math.min(100, (bytes / total) * 100) : null
  const barClass =
    job.state === 'done'
      ? 'done'
      : job.state === 'cooling'
        ? 'warn'
        : job.state === 'failed'
          ? 'fail'
          : ''

  return (
    <div className={`job ${job.state}`}>
      <div className="job-thumb sfw">
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : <ImageIcon size={15} />}
      </div>

      <div className="job-main">
        <div className="job-top">
          <HosterBadge hoster={job.hoster} />
          <span className="job-name" title={job.sourceUrl}>
            {job.fileName}
          </span>
          <span className="job-meta">
            <span>
              {formatBytes(bytes)}
              {total ? ` / ${formatBytes(total)}` : ''}
            </span>
            {job.state === 'running' && progress && (
              <>
                <span>{formatBytes(Math.round(progress.speedBytesPerSec))}/s</span>
                {progress.etaSec !== null && <span>{formatEta(progress.etaSec)}</span>}
              </>
            )}
            {job.state === 'done' && <span className="ok-text">{t('downloads.state.done')}</span>}
          </span>
        </div>

        <div className={`job-bar${percent === null && job.state === 'running' ? ' unknown' : ''} ${barClass}`}>
          <span style={{ width: `${percent ?? (job.state === 'done' ? 100 : 4)}%` }} />
        </div>

        <div className="job-sub">
          {/* Which post a file belongs to. A queue of twelve files named after
              content hashes is otherwise unreadable. */}
          {job.postTitle && (
            <span className="job-from" title={job.postTitle}>
              <Newspaper size={12} />
              {job.postTitle}
            </span>
          )}
          {job.state === 'cooling' && job.cooldownUntil && (
            <span className="warn-text">
              <Clock size={12} />
              {t(job.error === 'host_busy' ? 'downloads.busyCooling' : 'downloads.quotaCooling', {
                hoster: hosterName(job.hoster),
                time: formatClock(job.cooldownUntil)
              })}
            </span>
          )}
          {job.attempts > 0 && job.state !== 'done' && (
            <span>{t('downloads.attempts', { count: job.attempts })}</span>
          )}
          {/* Every failure code has a sentence; an unmapped one is a gap in the
              bundle, not something to show the user raw. */}
          {job.error && job.state === 'failed' && (
            <span className="fail-text">
              <TriangleAlert size={12} />
              {t(`downloads.jobError.${job.error}`, {
                defaultValue: t('downloads.jobError.unknown')
              })}
              <a className="fail-open" href={job.sourceUrl} target="_blank" rel="noreferrer">
                {t('downloads.openSource')}
              </a>
            </span>
          )}
          {job.duplicateOf && (
            <span title={job.duplicateOf}>{t('downloads.duplicateOf', { file: job.duplicateOf })}</span>
          )}
          {job.state === 'done' && job.filePath && (
            <span className="job-path" title={job.filePath}>
              <FolderOpen size={12} />
              {job.filePath}
            </span>
          )}
        </div>
      </div>

      <div className="job-tools">
        {(job.state === 'running' || job.state === 'pending') && (
          <button className="icon-btn" onClick={onPause} title={t('downloads.pause')}>
            <Pause size={15} />
          </button>
        )}
        {/* A cooling job resumes on its own; the button is for a user who knows
            the quota is back and would rather not wait. */}
        {(job.state === 'paused' || job.state === 'cooling') && (
          <button
            className="icon-btn"
            onClick={onResume}
            title={job.state === 'cooling' ? t('downloads.resumeNow') : t('downloads.resume')}
          >
            {job.state === 'cooling' ? <RotateCw size={15} /> : <Play size={15} />}
          </button>
        )}
        {/* A check only a person can pass: retrying alone would stop at it again. */}
        {job.state === 'failed' && job.error === 'verification_required' && (
          <button className="ghost sm job-verify" onClick={() => verifyDownload(job.id, t)}>
            <ShieldCheck size={14} />
            {t('downloads.verify')}
          </button>
        )}
        {job.state === 'failed' && (
          <button className="icon-btn" onClick={onRetry} title={t('downloads.retry')}>
            <RotateCw size={15} />
          </button>
        )}
        {job.postUrl && (
          <a
            className="icon-btn"
            href={job.postUrl}
            target="_blank"
            rel="noreferrer"
            title={t('posts.openPost')}
          >
            <ExternalLink size={15} />
          </a>
        )}
        <button
          className="icon-btn"
          onClick={onCancel}
          title={job.state === 'done' ? t('downloads.removeRecord') : t('downloads.cancel')}
        >
          {job.state === 'done' ? <Trash2 size={15} /> : <X size={15} />}
        </button>
      </div>
    </div>
  )
}
