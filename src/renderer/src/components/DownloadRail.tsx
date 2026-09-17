import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Download, List, Pause, Play, RotateCw, X } from 'lucide-react'
import type { DownloadJob, DownloadProgress } from '@shared/schemas/download'
import HosterBadge, { hosterName } from './HosterBadge'
import { ScriptPairingPrompt } from './ScriptPairing'
import { ipcInvoke, ipcOn } from '../ipc'
import { formatBytes, formatClock } from '../format'
import { UNFINISHED, inQueueOrder } from '../downloadOrder'
import { showToast } from '../toasts'
import { useErrorMessage } from '../useErrorMessage'

/**
 * The queue at a glance, beside the posts page. Deliberately narrow: one row
 * per job, source mark, a bar, and the one number that matters for its state.
 *
 * The mark is the source's real logo rather than a colour swatch — "quota used
 * up" is unreadable until you can see whose quota, which is exactly what a
 * plain coloured square failed to say.
 */

/** A glance, not the queue: the full list is one click away. */
const RAIL_ROWS = 6

type JobAction = 'download:pause' | 'download:resume' | 'download:cancel'

export default function DownloadRail({
  onOpenQueue
}: {
  onOpenQueue: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [jobs, setJobs] = useState<DownloadJob[]>([])
  const [live, setLive] = useState<Record<string, DownloadProgress>>({})

  const load = useCallback(() => {
    ipcInvoke('download:list')
      .then(({ jobs: list }) => setJobs(list))
      .catch(() => {})
  }, [])

  useEffect(() => {
    load()
    const offChanged = ipcOn('event:downloads-changed', load)
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
  }, [load])

  const act = useCallback(
    async (channel: JobAction, id: string) => {
      try {
        await ipcInvoke(channel, { id })
      } catch (e) {
        showToast({ message: toMessage(e) })
      }
    },
    [toMessage]
  )

  const active = jobs.filter((j) => UNFINISHED.has(j.state))
  // Rows left over after the unfinished ones go to what just finished: "did
  // that land?" is the question people ask right after starting something.
  const shown = inQueueOrder(jobs).slice(0, RAIL_ROWS)
  const speed = active.reduce((sum, j) => sum + (live[j.id]?.speedBytesPerSec ?? 0), 0)

  return (
    <aside className="rail" data-tour="posts-queue">
      <div className="rail-head">
        <Download size={13} />
        {t('nav.downloads')}
      </div>

      <ScriptPairingPrompt />

      {shown.length === 0 ? (
        <div className="rail-empty">{t('downloads.empty')}</div>
      ) : (
        shown.map((job) => {
          const p = live[job.id]
          const bytes = p?.bytesDownloaded ?? job.bytesDownloaded
          const total = p?.totalBytes ?? job.totalBytes
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
            <div className="mini" key={job.id}>
              <div className="mini-top">
                <HosterBadge hoster={job.hoster} markOnly />
                <span className="mini-name" title={`${job.fileName} · ${hosterName(job.hoster)}`}>
                  {job.fileName}
                </span>
                {UNFINISHED.has(job.state) && (
                  <span className="mini-tools">
                    {job.state === 'running' || job.state === 'pending' ? (
                      <button
                        className="icon-btn"
                        type="button"
                        onClick={() => void act('download:pause', job.id)}
                        title={t('downloads.pause')}
                      >
                        <Pause size={12} />
                      </button>
                    ) : (
                      <button
                        className="icon-btn"
                        type="button"
                        onClick={() => void act('download:resume', job.id)}
                        title={job.state === 'cooling' ? t('downloads.resumeNow') : t('downloads.resume')}
                      >
                        {job.state === 'cooling' ? <RotateCw size={12} /> : <Play size={12} />}
                      </button>
                    )}
                    <button
                      className="icon-btn"
                      type="button"
                      onClick={() => void act('download:cancel', job.id)}
                      title={t('downloads.cancel')}
                    >
                      <X size={12} />
                    </button>
                  </span>
                )}
              </div>
              <div className={`mini-bar ${barClass}`}>
                <span style={{ width: `${percent ?? (job.state === 'done' ? 100 : 6)}%` }} />
              </div>
              <div className="mini-sub">
                {job.state === 'cooling' && job.cooldownUntil ? (
                  <span className="warn-text">
                    {t(job.error === 'host_busy' ? 'downloads.busyCooling' : 'downloads.quotaCooling', {
                      hoster: hosterName(job.hoster),
                      time: formatClock(job.cooldownUntil)
                    })}
                  </span>
                ) : job.state === 'failed' ? (
                  <span className="fail-text">
                    {t(`downloads.jobError.${job.error}`, { defaultValue: job.error ?? '' })}
                  </span>
                ) : job.state === 'done' ? (
                  <span className="ok-text">{t('downloads.state.done')}</span>
                ) : (
                  <>
                    <span>
                      {formatBytes(bytes)}
                      {total ? ` / ${formatBytes(total)}` : ''}
                    </span>
                    {p && p.speedBytesPerSec > 0 && (
                      <span className="mini-right">{formatBytes(Math.round(p.speedBytesPerSec))}/s</span>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })
      )}

      <div className="rail-foot">
        <Activity size={13} />
        {t('posts.railSummary', { count: active.length })}
        {speed > 0 && ` · ${formatBytes(Math.round(speed))}/s`}
      </div>
      <button className="rail-open" type="button" onClick={onOpenQueue}>
        <List size={13} />
        {t('posts.openDownloads')}
      </button>
    </aside>
  )
}
