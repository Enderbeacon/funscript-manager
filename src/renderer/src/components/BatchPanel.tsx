import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import type { NameField } from '@shared/schemas/media-meta'
import type { MediaListItem } from '@shared/schemas/media-index'
import NameChips, { KIND_COLOR, type Taxonomy } from './NameChips'
import { NAME_FIELDS_UI } from '../filters'

/**
 * Batch editing, in the detail panel's place.
 *
 * The rule that matters: **nothing is applied that was not touched.** A field
 * the user did not open stays as it is on all forty media. Names are added and
 * removed rather than set, and a chip only some of the selection carries is
 * drawn dashed — pressing ✕ on it removes it everywhere, which is a decision,
 * not a side effect of the panel needing a single value to show.
 */

export interface BatchEditPayload {
  add: Partial<Record<NameField, string[]>>
  remove: Partial<Record<NameField, string[]>>
  rating?: number | null
  favorite?: boolean
}

export default function BatchPanel({
  selection,
  selectionCount,
  taxonomy,
  busy,
  onApply,
  onApplyPostLink,
  onClose
}: {
  /** The rows themselves, so shared values can be shown without another fetch. */
  selection: MediaListItem[]
  /**
   * How many media are selected, which is not always how many rows are in
   * `selection`: "select all" reaches past the pages that have been fetched.
   * Everything the panel says about the selection is counted against this.
   */
  selectionCount: number
  taxonomy: Taxonomy | null
  busy: boolean
  onApply: (edit: BatchEditPayload) => void
  /** Read one post and fold its metadata into everything selected. */
  onApplyPostLink: (url: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [postUrl, setPostUrl] = useState('')
  const [add, setAdd] = useState<Partial<Record<NameField, string[]>>>({})
  const [remove, setRemove] = useState<Partial<Record<NameField, string[]>>>({})
  const [rating, setRating] = useState<number | null | undefined>(undefined)
  /** undefined = leave it alone; true/false = set it that way on all of them. */
  const [favorite, setFavorite] = useState<boolean | undefined>(undefined)

  // Only tags are on the list rows; the other kinds need the sidecar, and the
  // panel refuses to guess at what it cannot see.
  const tagState = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of selection) {
      for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    const shared: string[] = []
    const partial: string[] = []
    // Against the real count, not the rows in hand: a tag on all 200 loaded of
    // 1400 selected is one the panel has no grounds to call shared.
    for (const [tag, n] of counts) (n === selectionCount ? shared : partial).push(tag)
    return { shared: shared.sort(), partial: partial.sort() }
  }, [selection, selectionCount])

  const existing = [...tagState.shared, ...tagState.partial]

  const setField = (
    setter: typeof setAdd,
    field: NameField,
    names: string[]
  ): void => setter((cur) => ({ ...cur, [field]: names }))

  const apply = (): void =>
    onApply({
      add,
      remove,
      ...(rating !== undefined ? { rating } : {}),
      ...(favorite !== undefined ? { favorite } : {})
    })

  const dirty =
    Object.values(add).some((v) => v && v.length > 0) ||
    Object.values(remove).some((v) => v && v.length > 0) ||
    rating !== undefined ||
    favorite !== undefined

  return (
    <div className="panel batch-panel">
      <div className="panel-head">
        <span className="grow">{t('media.batch.title', { count: selectionCount })}</span>
        <button
          className="panel-close"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <X size={14} />
        </button>
      </div>

      <div className="panel-body">
        <p className="settings-hint">{t('media.batch.hint')}</p>

        <div className="lab">{t('media.batch.currentTags')}</div>
        <div className="chips compact readonly">
          {existing.length === 0 && <span className="fempty">{t('media.batch.noTags')}</span>}
          {existing.map((tag) => (
            <span key={tag} className={`chip${tagState.partial.includes(tag) ? ' partial' : ''}`}>
              <i className="chip-dot" style={{ background: KIND_COLOR.tags }} />
              {tag}
              <button
                className="chip-x"
                onClick={() => setField(setRemove, 'tags', [...(remove.tags ?? []), tag])}
                aria-label={t('media.batch.removeEverywhere')}
                title={t('media.batch.removeEverywhere')}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
        {tagState.partial.length > 0 && (
          <div className="mixed-note">{t('media.batch.partialNote')}</div>
        )}

        {(remove.tags ?? []).length > 0 && (
          <>
            <div className="lab">{t('media.batch.willRemove')}</div>
            <NameChips
              field="tags"
              names={remove.tags ?? []}
              taxonomy={taxonomy}
              compact
              onChange={(names) => setField(setRemove, 'tags', names)}
            />
          </>
        )}

        <div className="lab">{t('media.batch.willAdd')}</div>
        {NAME_FIELDS_UI.map((field) => (
          <div className="mrow" key={field}>
            <span className="mk">
              <i className="chip-dot" style={{ background: KIND_COLOR[field] }} />
              {t(`media.filter.kind.${field}`)}
            </span>
            <NameChips
              field={field}
              names={add[field] ?? []}
              taxonomy={taxonomy}
              compact
              onChange={(names) => setField(setAdd, field, names)}
            />
          </div>
        ))}

        {/* Three states, because two would be a lie: leaving it alone is the
            default, and "off" has to be sayable without being the default. */}
        <div className="lab">{t('media.batch.favorite')}</div>
        <div className="flogic batch-tri">
          {([undefined, true, false] as const).map((value) => (
            <button
              key={String(value)}
              className={favorite === value ? 'on' : ''}
              aria-pressed={favorite === value}
              onClick={() => setFavorite(value)}
            >
              {t(
                value === undefined
                  ? 'media.batch.favoriteUntouched'
                  : value
                    ? 'media.batch.favoriteOn'
                    : 'media.batch.favoriteOff'
              )}
            </button>
          ))}
        </div>

        {/* Its own field and its own button: this reads a post and merges what
            it says, which is not the same kind of act as the edits above and
            does not wait for Apply. */}
        <div className="lab">{t('media.batch.fromPost')}</div>
        <div className="row">
          <input
            className="search grow"
            value={postUrl}
            disabled={busy}
            placeholder={t('media.batch.fromPostPlaceholder')}
            onChange={(e) => setPostUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && postUrl.trim()) onApplyPostLink(postUrl.trim())
            }}
          />
          <button
            className="ghost"
            disabled={busy || !postUrl.trim()}
            onClick={() => onApplyPostLink(postUrl.trim())}
          >
            {t('media.batch.fromPostApply', { count: selectionCount })}
          </button>
        </div>
        <div className="mixed-note">{t('media.batch.fromPostHint')}</div>

        <div className="lab">{t('media.info.rating')}</div>
        <div className="fstars">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              className={`fstar${(rating ?? 0) >= n ? ' on' : ''}`}
              onClick={() => setRating(rating === n ? null : n)}
            >
              ★
            </button>
          ))}
          <span className="funit">
            {rating === undefined
              ? t('media.batch.ratingUntouched')
              : rating === null
                ? t('media.batch.ratingCleared')
                : ''}
          </span>
        </div>
      </div>

      <div className="panel-foot">
        <button className="primary grow" disabled={!dirty || busy} onClick={apply}>
          {t('media.batch.apply', { count: selectionCount })}
        </button>
        <button
          className="ghost"
          disabled={busy}
          onClick={() => {
            setAdd({})
            setRemove({})
            setRating(undefined)
            setFavorite(undefined)
          }}
        >
          {t('media.batch.reset')}
        </button>
      </div>
    </div>
  )
}
