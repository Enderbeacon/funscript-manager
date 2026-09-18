import { useTranslation } from 'react-i18next'
import { Pin } from 'lucide-react'

export interface TagRow {
  name: string
  depth: number
  pinned: boolean
  pinnedAt: number | null
  countWithDescendants: number
}

/**
 * Every tag in the library, for picking one that is not pinned — and for
 * pinning it, so next time it is in the row above.
 */
export default function VrTags({
  tags,
  picked,
  onPick,
  onPin
}: {
  tags: TagRow[]
  picked: string[]
  onPick: (name: string) => void
  onPin: (tag: TagRow) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  if (tags.length === 0) return <div className="vr-empty">{t('vr.noTags')}</div>

  return (
    <div className="vr-scroll">
      <div className="vr-taglist">
        {tags.map((tag) => (
          <div key={tag.name} className={`vr-tag${picked.includes(tag.name) ? ' on' : ''}`}>
            <button className="vr-tag-name" onClick={() => onPick(tag.name)}>
              <span>{tag.name}</span>
              <span className="vr-tag-count">{tag.countWithDescendants}</span>
            </button>
            <button
              className={`vr-tag-pin${tag.pinned ? ' on' : ''}`}
              aria-label={t(tag.pinned ? 'vr.unpin' : 'vr.pin')}
              aria-pressed={tag.pinned}
              onClick={() => onPin(tag)}
            >
              <Pin size={22} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
