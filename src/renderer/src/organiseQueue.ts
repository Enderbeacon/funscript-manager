import { useSyncExternalStore } from 'react'
import type { IpcInput, IpcOutput } from '@shared/ipc/contract'
import type { OrganiseAction, QueuedOp } from '@shared/schemas/organise-queue'
import type { EntityKind } from '@shared/schemas/taxonomy'
import { ipcInvoke } from './ipc'

/**
 * The queue behind the organise page.
 *
 * Every edit there rewrites the whole taxonomy file, and a rename or a merge
 * rewrites every sidecar carrying the name — seconds of work for a big tag.
 * Sending them off as they are made lets two writes overlap and the later one
 * put back a file computed before the earlier one existed. Blocking the panel
 * until each finishes avoids that by making the user wait for their own tidying,
 * which is the one thing this page is for.
 *
 * So edits are recorded instead. Each becomes an operation, they run one at a
 * time in the order they were made, and the page draws the taxonomy with all of
 * them already applied. Because what is on screen is the result of everything
 * queued, the next edit is expressed against that result — renaming A to B and
 * then giving B a parent needs no fixing up, the two operations simply run in
 * that order.
 *
 * The queue lives outside React so leaving the page does not abandon half of it,
 * and on disk (main keeps the file) so quitting does not either.
 */

type Row = IpcOutput<'taxonomy:get'>['entities'][EntityKind][number]

export type { OrganiseAction }
export type OrganiseOp = QueuedOp

export interface QueueState {
  /** Not started yet, in the order they were made. */
  pending: OrganiseOp[]
  /**
   * Done, but the page has not yet reloaded the taxonomy that contains them.
   * They stay in the projection until it has, or the row would flick back to
   * its old name between the write landing and the reload arriving.
   */
  applied: OrganiseOp[]
  /** Media rewritten by the run in progress. */
  rewritten: number
  failed: { name: string; cause: unknown } | null
  /** Held back until the libraries have finished starting. */
  waiting: boolean
}

let state: QueueState = {
  pending: [],
  applied: [],
  rewritten: 0,
  failed: null,
  waiting: false
}
const listeners = new Set<() => void>()

function set(patch: Partial<QueueState>): void {
  const before = state.pending
  state = { ...state, ...patch }
  // Written out on every change, so a quit at any moment leaves the file
  // saying exactly what is still owed.
  if (state.pending !== before) {
    void ipcInvoke('taxonomy:saveQueue', { ops: state.pending }).catch(() => {})
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getQueueState(): QueueState {
  return state
}

export function useOrganiseQueue(): QueueState {
  return useSyncExternalStore(subscribe, getQueueState)
}

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/* ------------------------------------------------------------------ *
 * Recording
 * ------------------------------------------------------------------ */

let nextId = 1
/** The operation being run, which is always the head and cannot be rewritten. */
let running: number | null = null

export function enqueue(kind: EntityKind, action: OrganiseAction): void {
  const fresh = state.pending.length === 0
  set({
    pending: record(state.pending, kind, action),
    // A new run reports its own totals, not the previous one's.
    ...(fresh ? { rewritten: 0, failed: null } : {})
  })
  void drain()
}

/**
 * Append, or fold into the operation before it.
 *
 * Typing a description and leaving the field twice is one edit as far as the
 * files are concerned, and renaming twice in a row would spend a full sidecar
 * rewrite on a name the user has already moved on from.
 */
function record(pending: OrganiseOp[], kind: EntityKind, action: OrganiseAction): OrganiseOp[] {
  const last = pending[pending.length - 1]
  const foldable = last && last.id !== running && last.kind === kind
  if (last && foldable) {
    const sameField =
      last.type === action.type &&
      eq(last.name, action.name) &&
      (action.type === 'parent' || action.type === 'aliases' || action.type === 'description')
    if (sameField) return [...pending.slice(0, -1), { ...action, kind, id: last.id } as OrganiseOp]

    if (last.type === 'rename' && action.type === 'rename' && eq(last.to, action.name)) {
      return [...pending.slice(0, -1), { ...last, to: action.to }]
    }
    if (last.type === 'create' && action.type === 'rename' && eq(last.name, action.name)) {
      return [...pending.slice(0, -1), { ...last, name: action.to }]
    }
  }
  return [...pending, { ...action, kind, id: nextId++ } as OrganiseOp]
}

/** Forget the failure banner. */
export function dismissFailure(): void {
  set({ failed: null })
}

/* ------------------------------------------------------------------ *
 * Resuming
 * ------------------------------------------------------------------ */

let restoreDone: Promise<void> = Promise.resolve()
let restored = false

/**
 * Take back the work the last run did not finish. Called once at startup: what
 * was recorded then was recorded before anything in this session, so it goes
 * in front.
 */
export function restoreQueue(): Promise<void> {
  if (restored) return restoreDone
  restored = true
  restoreDone = ipcInvoke('taxonomy:queue')
    .then(({ ops }) => {
      if (ops.length === 0) return
      nextId = Math.max(nextId, ...ops.map((op) => op.id + 1))
      set({ pending: [...ops, ...state.pending] })
    })
    .catch(() => undefined)
  void restoreDone.then(drain)
  return restoreDone
}

/**
 * Nothing runs until the libraries have started.
 *
 * Renames and merges rewrite sidecars by asking the index which media carry
 * the name. Before the startup scan has reached a library the index cannot
 * answer, and the rewrite would report success having touched nothing.
 */
let librariesReady = false
let gate: Promise<void> | null = null

async function passGate(): Promise<void> {
  if (librariesReady) return
  gate ??= ipcInvoke('library:whenReady')
    .catch(() => undefined)
    .then(() => {
      librariesReady = true
    })
  set({ waiting: true })
  await gate
  set({ waiting: false })
}

/* ------------------------------------------------------------------ *
 * Running
 * ------------------------------------------------------------------ */

async function send(op: OrganiseOp): Promise<number> {
  const kind = op.kind
  const patch = async (p: IpcInput<'taxonomy:update'>['patch']): Promise<number> =>
    (await ipcInvoke('taxonomy:update', { kind, name: op.name, patch: p })).mediaRewritten

  switch (op.type) {
    case 'create':
      await ipcInvoke('taxonomy:create', { kind, name: op.name })
      return 0
    case 'rename':
      return patch({ name: op.to })
    case 'parent':
      return patch({ parent: op.parent })
    case 'aliases':
      return patch({ aliases: op.aliases })
    case 'description':
      return patch({ description: op.description })
    case 'merge':
      return (await ipcInvoke('taxonomy:merge', { kind, from: op.name, into: op.into }))
        .mediaRewritten
    case 'delete':
      return (await ipcInvoke('taxonomy:delete', { kind, name: op.name })).mediaRewritten
  }
}

/**
 * Resolves once nothing is queued. For the few writes that are not operations
 * but are still addressed by name — a cover picture — and so must not land
 * before a rename that was made first.
 */
const idle = new Set<() => void>()

export function whenIdle(): Promise<void> {
  if (!draining && state.pending.length === 0) return Promise.resolve()
  return new Promise((resolve) => idle.add(resolve))
}

let draining = false

async function drain(): Promise<void> {
  if (draining || state.pending.length === 0) return
  draining = true
  try {
    await runQueue()
  } finally {
    draining = false
  }
  for (const resolve of [...idle]) resolve()
  idle.clear()
}

async function runQueue(): Promise<void> {
  await restoreDone
  await passGate()
  while (state.pending.length > 0) {
    const op = state.pending[0]!
    running = op.id
    try {
      const rewritten = await send(op)
      running = null
      set({
        pending: state.pending.slice(1),
        applied: [...state.applied, op],
        rewritten: state.rewritten + rewritten
      })
    } catch (cause) {
      running = null
      // Whatever else was queued for this entry was written against a state
      // that never happened. Running it would fail too, once per operation, so
      // it goes with the one that failed and the user is told once.
      const dropped = new Set([op.name.toLowerCase()])
      if (op.type === 'rename') dropped.add(op.to.toLowerCase())
      set({
        pending: state.pending
          .slice(1)
          .filter((rest) => rest.kind !== op.kind || !dropped.has(rest.name.toLowerCase())),
        failed: { name: op.type === 'rename' ? op.to : op.name, cause }
      })
    }
  }
}

/* ------------------------------------------------------------------ *
 * Confirming
 * ------------------------------------------------------------------ */

/**
 * How many applied operations a taxonomy read starting now is guaranteed to
 * contain. The page passes it back to `confirm` when the read lands.
 */
export function mark(): number {
  return state.applied.length
}

export function confirm(marked: number): void {
  if (marked > 0) set({ applied: state.applied.slice(marked) })
}

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

interface Node extends Row {
  /**
   * Where the row arrived in the list, so siblings keep the order main sent
   * them in. Named `seq` and not `order` because `order` is a real field on the
   * row — the taxonomy's own sort key, which pinning a playlist sets — and
   * having the two share a name meant this projection silently overwrote it.
   */
  seq: number
}

/**
 * The rows as they will look once `ops` have run.
 *
 * Media counts are carried, not recalculated — nothing here changes what a
 * media carries except a merge, whose total double-counts anything wearing both
 * names until the real count arrives with the next reload.
 */
export function projectRows(rows: Row[], ops: OrganiseOp[]): Row[] {
  if (ops.length === 0) return rows
  let nodes: Node[] = rows.map((row, seq) => ({ ...row, seq }))
  const find = (name: string): Node | undefined => nodes.find((n) => eq(n.name, name))

  for (const op of ops) {
    const target = find(op.name)
    switch (op.type) {
      case 'create':
        if (target) break
        nodes = [
          ...nodes,
          {
            name: op.name,
            parent: null,
            aliases: [],
            description: null,
            image: null,
            depth: 0,
            order: null,
            count: 0,
            countWithDescendants: 0,
            seq: nodes.length
          }
        ]
        break
      case 'rename':
        if (!target) break
        nodes = nodes.map((n) =>
          n === target
            ? { ...n, name: op.to }
            : n.parent && eq(n.parent, op.name)
              ? { ...n, parent: op.to }
              : n
        )
        break
      case 'parent':
        if (!target) break
        nodes = nodes.map((n) => (n === target ? { ...n, parent: op.parent } : n))
        break
      case 'aliases':
        if (!target) break
        nodes = nodes.map((n) => (n === target ? { ...n, aliases: op.aliases } : n))
        break
      case 'description':
        if (!target) break
        nodes = nodes.map((n) => (n === target ? { ...n, description: op.description } : n))
        break
      case 'delete': {
        if (!target) break
        const up = target.parent
        nodes = nodes
          .filter((n) => n !== target)
          .map((n) => (n.parent && eq(n.parent, op.name) ? { ...n, parent: up } : n))
        break
      }
      case 'merge': {
        const winner = find(op.into)
        if (!target || !winner || target === winner) break
        nodes = nodes
          .filter((n) => n !== target)
          .map((n) =>
            n === winner
              ? {
                  ...n,
                  aliases: [...new Set([...n.aliases, ...target.aliases, target.name])],
                  count: n.count + target.count
                }
              : n.parent && eq(n.parent, op.name)
                ? { ...n, parent: winner.name }
                : n
          )
        break
      }
    }
  }

  return rebuild(nodes)
}

/** Tree order, depth and rolled-up counts, the way main computes them. */
function rebuild(nodes: Node[]): Row[] {
  const known = new Set(nodes.map((n) => n.name.toLowerCase()))
  const byParent = new Map<string, Node[]>()
  const children = new Map<string, string[]>()
  for (const node of nodes) {
    // A parent that no longer exists would hide its children entirely.
    const key = node.parent && known.has(node.parent.toLowerCase()) ? node.parent.toLowerCase() : ''
    byParent.set(key, [...(byParent.get(key) ?? []), node])
    if (key) children.set(key, [...(children.get(key) ?? []), node.name])
  }

  const counts = new Map(nodes.map((n) => [n.name.toLowerCase(), n.count]))
  const rollUp = (name: string, seen: Set<string>): number => {
    const key = name.toLowerCase()
    if (seen.has(key)) return 0
    seen.add(key)
    return (
      (counts.get(key) ?? 0) +
      (children.get(key) ?? []).reduce((sum, child) => sum + rollUp(child, seen), 0)
    )
  }

  const out: Row[] = []
  const walk = (parentKey: string, depth: number, seen: Set<string>): void => {
    const sorted = [...(byParent.get(parentKey) ?? [])].sort(
      (a, b) => a.seq - b.seq || a.name.localeCompare(b.name)
    )
    for (const node of sorted) {
      const key = node.name.toLowerCase()
      if (seen.has(key)) continue // a cycle survived an edit; show it once
      seen.add(key)
      const { seq: _seq, ...row } = node
      out.push({ ...row, depth, countWithDescendants: rollUp(node.name, new Set()) })
      walk(key, depth + 1, seen)
    }
  }
  walk('', 0, new Set())
  return out
}

/** Names with an edit still waiting, so the tree can mark those rows. */
export function pendingNames(ops: OrganiseOp[]): Set<string> {
  const names = new Set<string>()
  for (const op of ops) {
    if (op.type === 'rename') names.add(op.to.toLowerCase())
    else if (op.type === 'merge') names.add(op.into.toLowerCase())
    else if (op.type !== 'delete') names.add(op.name.toLowerCase())
  }
  return names
}
