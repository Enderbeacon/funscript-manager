import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { ENTITY_KINDS, type EntityKind } from '@shared/schemas/taxonomy'
import Select from '../components/Select'
import { KIND_COLOR, type Taxonomy } from '../components/NameChips'
import { askConfirm, askName } from '../dialogs'
import { ipcInvoke, ipcOn } from '../ipc'
import {
  confirm as confirmApplied,
  dismissFailure,
  enqueue,
  mark,
  pendingNames,
  projectRows,
  useOrganiseQueue,
  whenIdle
} from '../organiseQueue'
import { useErrorMessage } from '../useErrorMessage'

/**
 * Managing the vocabulary itself.
 *
 * One tab per kind, a tree on the left, the selected entry on the right. The
 * operations that need a decision — merging, deleting — live in the panel with
 * the counts beside them, because "delete VR" means something very different
 * at 3 media than at 96.
 *
 * Everything here rewrites sidecars: names are what a media carries, so a
 * rename is not finished until the files say the new one. The count of media
 * touched comes back and is shown, rather than the change appearing to be free.
 *
 * None of it happens while the user waits. Edits go to a queue that runs them
 * in order (`organiseQueue`), and the tree is drawn with the whole queue
 * already applied — so tidying up a tag tree is a continuous piece of work
 * rather than a change, a pause, another change.
 */

type Row = Taxonomy['entities'][EntityKind][number]

export default function OrganisePage(): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [kind, setKind] = useState<EntityKind>('tags')
  const [taxonomy, setTaxonomy] = useState<Taxonomy | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  /** Drag-to-reparent: what is being dragged, and what it is hovering over. */
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  // Draft fields; committed on blur so typing does not rewrite sidecars.
  const [draftName, setDraftName] = useState('')
  const [draftDescription, setDraftDescription] = useState('')
  const [mergeInto, setMergeInto] = useState('')

  const queue = useOrganiseQueue()

  const load = (): void => {
    // What has already been written is confirmed by the read that contains it;
    // until then it stays in the projection.
    const marked = mark()
    ipcInvoke('taxonomy:get')
      .then((next) => {
        setTaxonomy(next)
        confirmApplied(marked)
      })
      .catch(() => setTaxonomy(null))
  }
  useEffect(load, [])
  useEffect(() => ipcOn('event:taxonomy-changed', load), [])
  useEffect(() => ipcOn('event:media-changed', load), [])

  /** Everything queued for this tab, oldest first: the tree shows the result. */
  const queued = useMemo(
    () => [...queue.applied, ...queue.pending].filter((op) => op.kind === kind),
    [queue.applied, queue.pending, kind]
  )
  const waiting = useMemo(
    () => pendingNames(queue.pending.filter((op) => op.kind === kind)),
    [queue.pending, kind]
  )

  const rows = useMemo(
    () => projectRows(taxonomy?.entities[kind] ?? [], queued),
    [taxonomy, kind, queued]
  )
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(
      (r) => r.name.toLowerCase().includes(q) || r.aliases.some((a) => a.toLowerCase().includes(q))
    )
  }, [rows, search])

  const current = rows.find((r) => r.name === selected) ?? null
  const unused = rows.filter((r) => r.countWithDescendants === 0)

  /** Tags and playlists nest; authors and studios are flat lists. */
  const nests = kind === 'tags' || kind === 'playlists'

  /** Is `name` somewhere under `ancestor`? Guards the drop, and the cycle. */
  const isDescendant = (name: string, ancestor: string): boolean => {
    const byName = new Map(rows.map((r) => [r.name, r]))
    let node = byName.get(name)
    const seen = new Set<string>()
    while (node?.parent) {
      if (seen.has(node.parent)) return false
      seen.add(node.parent)
      if (node.parent === ancestor) return true
      node = byName.get(node.parent)
    }
    return false
  }

  const dropOnto = (parent: string): void => {
    const moved = dragging
    setDragging(null)
    setDropTarget(null)
    if (!moved || moved === parent) return
    if (parent && isDescendant(parent, moved)) return
    const row = rows.find((r) => r.name === moved)
    if ((row?.parent ?? '') === parent) return
    enqueue(kind, { type: 'parent', name: moved, parent: parent || null })
  }

  // Only on a change of selection: a reload while the user is typing must not
  // take the field back off them.
  useEffect(() => {
    const row = rows.find((r) => r.name === selected) ?? null
    setDraftName(row?.name ?? '')
    setDraftDescription(row?.description ?? '')
    setMergeInto('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, kind])

  const rename = (): void => {
    const next = draftName.trim()
    if (!current || !next || next === current.name) return
    enqueue(kind, { type: 'rename', name: current.name, to: next })
    setSelected(next)
  }

  const setParent = (parent: string): void => {
    if (!current) return
    enqueue(kind, { type: 'parent', name: current.name, parent: parent || null })
  }

  const setAliases = (aliases: string[]): void => {
    if (!current) return
    enqueue(kind, { type: 'aliases', name: current.name, aliases })
  }

  const saveDescription = (): void => {
    if (!current || draftDescription === (current.description ?? '')) return
    enqueue(kind, { type: 'description', name: current.name, description: draftDescription })
  }

  const create = async (): Promise<void> => {
    const name = await askName({ title: t('organise.newPrompt'), confirmLabel: t('organise.new') })
    if (!name) return
    enqueue(kind, { type: 'create', name })
    setSelected(name)
  }

  const remove = async (): Promise<void> => {
    if (!current) return
    const ok = await askConfirm({
      message: t('organise.confirmDelete', { name: current.name, count: current.count }),
      confirmLabel: t('organise.delete'),
      danger: true
    })
    if (!ok) return
    enqueue(kind, { type: 'delete', name: current.name })
    setSelected(null)
  }

  const merge = async (): Promise<void> => {
    if (!current || !mergeInto || mergeInto === current.name) return
    const ok = await askConfirm({
      message: t('organise.confirmMerge', { from: current.name, into: mergeInto }),
      confirmLabel: t('organise.merge')
    })
    if (!ok) return
    enqueue(kind, { type: 'merge', name: current.name, into: mergeInto })
    setSelected(mergeInto)
  }

  const cleanUnused = async (): Promise<void> => {
    if (unused.length === 0) return
    const ok = await askConfirm({
      message: t('organise.confirmClean', { count: unused.length }),
      confirmLabel: t('organise.cleanUnused'),
      danger: true
    })
    if (!ok) return
    for (const row of unused) enqueue(kind, { type: 'delete', name: row.name })
    if (selected && unused.some((r) => r.name === selected)) setSelected(null)
  }

  return (
    <div className="organise-page">
      <h1 className="page-title">{t('nav.organise')}</h1>

      <div className="settings-tabs" data-tour="organise-kinds">
        {ENTITY_KINDS.map((key) => (
          <button
            key={key}
            className={`settings-tab${kind === key ? ' on' : ''}`}
            onClick={() => {
              setKind(key)
              setSelected(null)
            }}
          >
            {t(`media.filter.kind.${key}`)}
          </button>
        ))}
      </div>

      <div className="row organise-bar">
        <input
          className="search"
          type="search"
          value={search}
          placeholder={t('organise.searchPlaceholder')}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="count">
          {t('organise.count', { count: rows.length, unused: unused.length })}
        </span>
        {queue.pending.length > 0 && (
          <span className="org-pending">
            <i className="org-pending-dot" />
            {queue.waiting
              ? t('organise.pendingScan', { count: queue.pending.length })
              : t('organise.pending', { count: queue.pending.length })}
          </span>
        )}
        <div className="grow" />
        <button
          data-tour="organise-clean"
          className="ghost"
          disabled={unused.length === 0}
          onClick={() => void cleanUnused()}
        >
          {t('organise.cleanUnused')}
        </button>
        <button data-tour="organise-new" className="primary" onClick={() => void create()}>
          <Plus size={14} />
          {t('organise.new')}
        </button>
      </div>

      {queue.failed && (
        <div className="error-banner">
          {t('organise.opFailed', {
            name: queue.failed.name,
            message: toMessage(queue.failed.cause)
          })}
          <button className="chip-x" onClick={dismissFailure}>
            <X size={11} />
          </button>
        </div>
      )}
      {queue.pending.length === 0 && queue.rewritten > 0 && (
        <div className="sync-banner">{t('organise.rewrote', { count: queue.rewritten })}</div>
      )}

      <div className="organise-body">
        <div className="organise-tree" data-tour="organise-list">
          {visible.length === 0 && <div className="empty">{t('organise.empty')}</div>}

          {/* Only the nesting kinds accept a drop; an author has no parent. */}
          {nests && (
            <div
              className={`org-droproot${dropTarget === '' ? ' over' : ''}`}
              onDragOver={(e) => {
                if (!dragging) return
                e.preventDefault()
                setDropTarget('')
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(e) => {
                e.preventDefault()
                dropOnto('')
              }}
            >
              {t('organise.dropToTop')}
            </div>
          )}

          {visible.map((row) => (
            <button
              key={row.name}
              className={[
                'org-row',
                selected === row.name ? 'on' : '',
                row.countWithDescendants === 0 ? 'unused' : '',
                dragging === row.name ? 'dragging' : '',
                dropTarget === row.name ? 'over' : '',
                waiting.has(row.name.toLowerCase()) ? 'waiting' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ paddingLeft: `${0.5 + row.depth * 1.1}rem` }}
              onClick={() => setSelected(row.name)}
              draggable={nests}
              onDragStart={() => setDragging(row.name)}
              onDragEnd={() => {
                setDragging(null)
                setDropTarget(null)
              }}
              onDragOver={(e) => {
                // Dropping a tag onto its own descendant would make a loop; the
                // service refuses it, so it must not look accepted either.
                if (!dragging || dragging === row.name || isDescendant(row.name, dragging)) return
                e.preventDefault()
                setDropTarget(row.name)
              }}
              onDragLeave={() => setDropTarget((cur) => (cur === row.name ? null : cur))}
              onDrop={(e) => {
                e.preventDefault()
                dropOnto(row.name)
              }}
            >
              {nests && <span className="org-grip">⠿</span>}
              <i className="frow-dot" style={{ background: KIND_COLOR[kind] }} />
              <span className="frow-name">{row.name}</span>
              {row.aliases.length > 0 && <span className="org-aliases">{row.aliases.length}</span>}
              <span className="frow-n">{row.countWithDescendants}</span>
            </button>
          ))}
        </div>

        <aside className="detail-panel organise-detail">
          {!current ? (
            <div className="empty">{t('organise.pickOne')}</div>
          ) : (
            <>
              <div className="panel-head">
                <span className="grow">{current.name}</span>
              </div>
              <div className="panel-body">
                <div className="lab">{t('organise.name')}</div>
                <input
                  className="settings-input"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={rename}
                  onKeyDown={(e) => e.key === 'Enter' && rename()}
                />

                {/* Only tags and playlists nest; an author has no parent. */}
                {(kind === 'tags' || kind === 'playlists') && (
                  <>
                    <div className="lab">{t('organise.parent')}</div>
                    <Select
                      className="block"
                      value={current.parent ?? ''}
                      onChange={setParent}
                      options={[
                        { value: '', label: t('organise.noParent') },
                        ...rows
                          .filter((r) => r.name !== current.name)
                          .map((r) => ({ value: r.name, label: r.name }))
                      ]}
                    />
                  </>
                )}

                <div className="lab">{t('organise.aliases')}</div>
                <AliasEditor
                  aliases={current.aliases}
                  onChange={setAliases}
                  placeholder={t('organise.aliasPlaceholder')}
                />
                <div className="mixed-note">{t('organise.aliasHint')}</div>

                <div className="lab">{t('organise.description')}</div>
                <textarea
                  className="settings-input"
                  rows={3}
                  value={draftDescription}
                  onChange={(e) => setDraftDescription(e.target.value)}
                  onBlur={saveDescription}
                />

                <div className="lab">{t('organise.cover')}</div>
                <CoverPicker kind={kind} name={current.name} />

                <div className="lab">{t('organise.stats')}</div>
                <div className="box">
                  <div className="kv">
                    <span>{t('organise.directUse')}</span>
                    <span>{current.count}</span>
                  </div>
                  <div className="kv">
                    <span>{t('organise.withChildren')}</span>
                    <span>{current.countWithDescendants}</span>
                  </div>
                  <div className="kv">
                    <span>{t('organise.children')}</span>
                    <span>{rows.filter((r) => r.parent === current.name).length}</span>
                  </div>
                </div>

                <div className="lab">{t('organise.mergeInto')}</div>
                <div className="row">
                  <Select
                    className="grow"
                    value={mergeInto}
                    onChange={setMergeInto}
                    options={[
                      { value: '', label: t('organise.pickTarget') },
                      ...rows
                        .filter((r) => r.name !== current.name)
                        .map((r) => ({ value: r.name, label: r.name }))
                    ]}
                  />
                  <button className="ghost" disabled={!mergeInto} onClick={() => void merge()}>
                    {t('organise.merge')}
                  </button>
                </div>
                <div className="mixed-note">{t('organise.mergeHint')}</div>
              </div>

              <div className="panel-foot">
                <button className="ghost danger grow" onClick={() => void remove()}>
                  {t('organise.delete')}
                </button>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

/**
 * The entity's cover picture. The file is copied into the app's own folder on
 * pick, so the picture survives the user reorganising wherever they got it
 * from, and comes back as a data URL because the renderer's CSP allows no
 * file:// at all.
 *
 * Covers are the one thing here that is not queued — but they are addressed by
 * name like everything else, so they wait for the queue before reading or
 * writing. `name` is the name the panel shows, which is what the entity will be
 * called once the queue has run.
 */
function CoverPicker({ kind, name }: { kind: EntityKind; name: string }): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setDataUrl(null)
    whenIdle()
      .then(() => (live ? ipcInvoke('taxonomy:getImage', { kind, name }) : null))
      .then((r) => live && r && setDataUrl(r.dataUrl))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [kind, name])

  const set = async (sourcePath: string | null): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await whenIdle()
      const { dataUrl } = await ipcInvoke('taxonomy:setImage', { kind, name, sourcePath })
      setDataUrl(dataUrl)
    } catch (e) {
      setError(toMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const pick = async (): Promise<void> => {
    const { path } = await ipcInvoke('dialog:pickImage', { title: t('organise.coverPick') })
    if (path) await set(path)
  }

  return (
    <div className="cover-picker">
      {error && <div className="error-banner">{error}</div>}
      <div className={`cover-frame${dataUrl ? '' : ' empty'}`}>
        {dataUrl ? <img src={dataUrl} alt="" /> : <span>{t('organise.coverNone')}</span>}
      </div>
      <div className="row">
        <button className="ghost" disabled={busy} onClick={() => void pick()}>
          {dataUrl ? t('organise.coverReplace') : t('organise.coverAdd')}
        </button>
        {dataUrl && (
          <button className="ghost" disabled={busy} onClick={() => void set(null)}>
            {t('organise.coverClear')}
          </button>
        )}
      </div>
    </div>
  )
}

/** Aliases as chips plus one input; Enter commits, ✕ removes. */
function AliasEditor({
  aliases,
  placeholder,
  onChange
}: {
  aliases: string[]
  placeholder: string
  onChange: (next: string[]) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const commit = (): void => {
    const value = draft.trim()
    if (!value || aliases.some((a) => a.toLowerCase() === value.toLowerCase())) {
      setDraft('')
      return
    }
    onChange([...aliases, value])
    setDraft('')
  }
  return (
    <div className="chips">
      {aliases.map((alias) => (
        <span key={alias} className="chip">
          {alias}
          <button className="chip-x" onClick={() => onChange(aliases.filter((a) => a !== alias))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        className="chip-input alias"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
    </div>
  )
}
