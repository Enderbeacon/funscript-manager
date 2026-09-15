import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { FILTER_FIELDS, FILTER_OPERATORS, type FilterGroup, type FilterNode, type FilterRule } from '@shared/schemas/taxonomy'
import Select from './Select'
import { newRule } from '../filters'
import { useEscape } from '../useEscape'

/**
 * The condition builder for advanced search.
 *
 * A rule is a field, an operator and a value; a group is a rule list plus
 * all-or-any; groups nest. That is the entire model, which is why the UI can
 * be this literal — anything the builder can draw, the query engine can run.
 *
 * Which operators a field accepts is decided here rather than left open: a
 * "greater than" on a tag has no meaning, and offering it invites a filter
 * that silently matches everything.
 */

const OPS_BY_FIELD: Record<string, (typeof FILTER_OPERATORS)[number][]> = {
  tags: ['includes', 'excludes', 'isEmpty', 'isNotEmpty'],
  videoAuthors: ['includes', 'excludes', 'isEmpty', 'isNotEmpty'],
  scriptAuthors: ['includes', 'excludes', 'isEmpty', 'isNotEmpty'],
  studios: ['includes', 'excludes', 'isEmpty', 'isNotEmpty'],
  playlists: ['includes', 'excludes', 'isEmpty', 'isNotEmpty'],
  title: ['contains'],
  sourceUrl: ['contains'],
  durationMs: ['gt', 'lt', 'between'],
  fileSize: ['gt', 'lt', 'between'],
  rating: ['is', 'gt', 'lt'],
  scriptCount: ['is', 'gt', 'lt'],
  favorite: ['is', 'isNot'],
  multiAxis: ['is', 'isNot'],
  missing: ['is', 'isNot'],
  wanted: ['is', 'isNot'],
  addedAt: ['gt', 'lt']
}

/**
 * Folders are missing on purpose. A folder rule names a library as well as a
 * path, which is a value nobody can type; the sidebar's folder list is where
 * that choice is made.
 */
const BUILDER_FIELDS = FILTER_FIELDS.filter((field) => field !== 'folder')

/** Fields whose value is a plain name the user types. */
const NAME_FIELDS = new Set(['tags', 'videoAuthors', 'scriptAuthors', 'studios', 'playlists'])
const BOOL_FIELDS = new Set(['favorite', 'multiAxis', 'missing', 'wanted'])

function isGroup(node: FilterNode): node is FilterGroup {
  return node.kind === 'group'
}

export default function ConditionBuilder({
  initial,
  matchCount,
  onPreview,
  onApply,
  onSave,
  onClose
}: {
  initial: FilterNode | null
  /** Live count for what is currently in the builder; null while unknown. */
  matchCount: number | null
  onPreview: (filter: FilterNode | null) => void
  onApply: (filter: FilterNode | null) => void
  onSave: (filter: FilterNode) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [root, setRoot] = useState<FilterGroup>(
    initial && isGroup(initial) ? initial : { kind: 'group', match: 'all', children: initial ? [initial] : [] }
  )

  useEscape(onClose)

  const update = (next: FilterGroup): void => {
    setRoot(next)
    onPreview(next.children.length > 0 ? next : null)
  }

  /** Replace the node at `path`, or drop it when `next` is null. */
  const replaceAt = (group: FilterGroup, path: number[], next: FilterNode | null): FilterGroup => {
    const [head, ...rest] = path
    if (head === undefined) return group
    const children = [...group.children]
    if (rest.length === 0) {
      if (next === null) children.splice(head, 1)
      else children[head] = next
    } else {
      const child = children[head]
      if (child && isGroup(child)) children[head] = replaceAt(child, rest, next)
    }
    return { ...group, children }
  }

  const renderRule = (rule: FilterRule, path: number[]): React.JSX.Element => {
    const ops = OPS_BY_FIELD[rule.field] ?? ['is']
    const needsValue = rule.op !== 'isEmpty' && rule.op !== 'isNotEmpty'
    const set = (patch: Partial<FilterRule>): void => update(replaceAt(root, path, { ...rule, ...patch }))

    return (
      <div className="crow" key={path.join('.')}>
        <Select
          className="cfield"
          value={rule.field}
          options={BUILDER_FIELDS.map((f) => ({ value: f, label: t(`media.field.${f}`) }))}
          onChange={(field) => {
            const allowed = OPS_BY_FIELD[field] ?? ['is']
            set({ field, op: allowed.includes(rule.op) ? rule.op : allowed[0]!, value: '' })
          }}
        />
        <Select
          className="cop"
          value={rule.op}
          options={ops.map((op) => ({ value: op, label: t(`media.op.${op}`) }))}
          onChange={(op) => set({ op })}
        />
        {needsValue &&
          (BOOL_FIELDS.has(rule.field) ? (
            <Select
              className="cvalue"
              value={rule.value === false ? 'false' : 'true'}
              options={[
                { value: 'true', label: t('common.yes') },
                { value: 'false', label: t('common.no') }
              ]}
              onChange={(v) => set({ value: v === 'true' })}
            />
          ) : rule.op === 'between' ? (
            <span className="cvalue range">
              <input
                className="cinput"
                value={String((rule.value as (string | number)[] | undefined)?.[0] ?? '')}
                onChange={(e) =>
                  set({ value: [e.target.value, (rule.value as (string | number)[] | undefined)?.[1] ?? ''] })
                }
              />
              <span className="fdash">–</span>
              <input
                className="cinput"
                value={String((rule.value as (string | number)[] | undefined)?.[1] ?? '')}
                onChange={(e) =>
                  set({ value: [(rule.value as (string | number)[] | undefined)?.[0] ?? '', e.target.value] })
                }
              />
            </span>
          ) : (
            <input
              className="cinput cvalue"
              value={String(rule.value ?? '')}
              placeholder={NAME_FIELDS.has(rule.field) ? t('media.filter.namePlaceholder') : ''}
              onChange={(e) => set({ value: e.target.value })}
            />
          ))}
        <button className="crow-x" onClick={() => update(replaceAt(root, path, null))} aria-label={t('common.remove')}>
          <X size={13} />
        </button>
      </div>
    )
  }

  const renderGroup = (group: FilterGroup, path: number[]): React.JSX.Element => (
    <div className="cgroup" key={path.join('.') || 'root'}>
      <div className="cgroup-head">
        <span>{t('media.filter.matching')}</span>
        <Select
          className="cmatch"
          value={group.match}
          options={[
            { value: 'all', label: t('media.filter.allConditions') },
            { value: 'any', label: t('media.filter.anyCondition') }
          ]}
          onChange={(match) => update(replaceAt(root, path, { ...group, match: match as 'all' | 'any' }))}
        />
        <div className="grow" />
        {path.length > 0 && (
          <button className="crow-x" onClick={() => update(replaceAt(root, path, null))} aria-label={t('common.remove')}>
            <X size={13} />
          </button>
        )}
      </div>

      {group.children.map((child, i) =>
        isGroup(child) ? (
          <div className="cindent" key={i}>
            {renderGroup(child, [...path, i])}
          </div>
        ) : (
          renderRule(child, [...path, i])
        )
      )}

      <div className="crow add">
        <button
          className="ghost sm"
          onClick={() => update(replaceAt(root, path, { ...group, children: [...group.children, newRule()] }))}
        >
          {t('media.filter.addCondition')}
        </button>
        <button
          className="ghost sm"
          onClick={() =>
            update(
              replaceAt(root, path, {
                ...group,
                children: [...group.children, { kind: 'group', match: 'any', children: [newRule()] }]
              })
            )
          }
        >
          {t('media.filter.addGroup')}
        </button>
      </div>
    </div>
  )

  const result = root.children.length > 0 ? root : null

  return (
    <div className="modal-scrim">
      <div className="modal">
        <div className="modal-head">
          <span className="grow">{t('media.filter.advanced')}</span>
          <button className="ghost sm" onClick={onClose} aria-label={t('common.close')}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">{renderGroup(root, [])}</div>
        <div className="modal-foot">
          <span className="count">
            {matchCount === null ? '…' : t('media.filter.estimated', { count: matchCount })}
          </span>
          <div className="grow" />
          <button className="ghost" disabled={!result} onClick={() => result && onSave(result)}>
            {t('media.filter.save')}
          </button>
          <button className="ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="primary" onClick={() => onApply(result)}>
            {t('common.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
