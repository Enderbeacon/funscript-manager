import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  ChevronDown,
  CirclePause,
  File,
  FileInput,
  FlipVertical2,
  FolderOpen,
  Gauge,
  House,
  Link,
  Lock,
  LockOpen,
  RotateCcw,
  Spline,
  ToggleLeft,
  Waves,
  X
} from 'lucide-react'
import type { IpcOutput } from '@shared/ipc/contract'
import { ipcInvoke } from '@/ipc'
import { usePopover } from '@/usePopover'
import Select from '@/components/Select'
import {
  INTERPOLATION_TYPES,
  MOTION_PROVIDERS,
  PATTERN_TYPES,
  SCRIPT_PLAYER_AXES,
  SMART_LIMIT_MODES,
  TCODE_CHANNEL_BY_AXIS,
  type AxisMotion,
  type MotionProviders,
  type ScriptPlayerAxis
} from '../../shared/config'
import { linearThrough } from '../../domain/engine/evaluate'
import CurveEditor from './CurveEditor'
import RangeSlider from './RangeSlider'
import { InterpolationPreview, NoisePreview, useSweep } from './AxisPreviews'

type PlayerSettings = IpcOutput<'script-player:settings'>
type PlayerStatus = IpcOutput<'script-player:status'>
type UpdateAxis = (axis: ScriptPlayerAxis, update: (motion: AxisMotion) => AxisMotion) => void

const TAB_KEY = 'sp-axis-tab'
const OPEN_KEY = 'sp-axis-open'

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Remembering the tab is a convenience; losing it is fine.
  }
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/**
 * Per-axis script tools: which script the axis plays and everything that
 * shapes it on the way to the device. One tab per axis, a toolbar of popovers
 * for the less frequent settings, and the everyday ones — file, offset,
 * scale — underneath.
 *
 * Derived implementation; origin and licence in THIRD_PARTY_NOTICES.md.
 */
export default function AxisPanel({
  settings,
  status,
  onUpdateAxis,
  onStatus,
  onError
}: {
  settings: PlayerSettings
  status: PlayerStatus | null
  onUpdateAxis: UpdateAxis
  onStatus: (status: PlayerStatus) => void
  onError: (caught: unknown) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [axis, setAxis] = useState<ScriptPlayerAxis>(() => {
    const stored = readStored(TAB_KEY)
    return SCRIPT_PLAYER_AXES.includes(stored as ScriptPlayerAxis) ? stored as ScriptPlayerAxis : 'main'
  })
  const [open, setOpen] = useState(() => readStored(OPEN_KEY) !== '0')
  const motion = settings.axes[axis]
  const script = status?.scripts[axis]

  const update = (change: Partial<AxisMotion>): void => onUpdateAxis(axis, (current) => ({ ...current, ...change }))

  const act = (promise: Promise<PlayerStatus | void>): void => {
    promise
      .then((next) => { if (next) onStatus(next) })
      .catch(onError)
  }

  const chooseTab = (next: ScriptPlayerAxis): void => {
    setAxis(next)
    store(TAB_KEY, next)
  }

  const toggleOpen = (): void => {
    setOpen((current) => {
      store(OPEN_KEY, current ? '0' : '1')
      return !current
    })
  }

  const loadPath = (path: string): void => {
    act(ipcInvoke('script-player:axisLoad', { axis, path }))
  }

  const browse = (): void => {
    ipcInvoke('script-player:pickScript')
      .then(({ path }) => { if (path) loadPath(path) })
      .catch(onError)
  }

  const drop = (event: React.DragEvent): void => {
    event.preventDefault()
    const file = [...event.dataTransfer.files].find((candidate) => candidate.name.toLowerCase().endsWith('.funscript'))
    const path = file ? window.fsmgr.pathForFile(file) : ''
    if (path) loadPath(path)
  }

  const name = t(`scriptPlayer.axis.${axis}`)
  const channel = TCODE_CHANNEL_BY_AXIS[axis]

  return (
    <section className={`sp-axes${open ? ' open' : ''}`}>
      <div className="sp-axis-tabs" role="tablist">
        {SCRIPT_PLAYER_AXES.map((candidate) => (
          <AxisTab
            key={candidate}
            axis={candidate}
            selected={candidate === axis}
            motion={settings.axes[candidate]}
            status={status}
            onSelect={() => chooseTab(candidate)}
          />
        ))}
      </div>

      <div className="sp-axis-toolbar">
        <ToolPopover icon={<File size={16} />} title={t('scriptPlayer.axisTools.script')} menu>
          {(close) => (
            <div className="sp-pop-menu">
              <button type="button" disabled={!script?.path} onClick={() => { close(); act(ipcInvoke('script-player:axisReveal', { axis })) }}>
                <FolderOpen size={14} />{t('scriptPlayer.axisTools.openFolder')}
              </button>
              <button type="button" disabled={!status?.mediaId} onClick={() => { close(); browse() }}>
                <FileInput size={14} />{t('scriptPlayer.axisTools.load')}
              </button>
              <button type="button" disabled={!script?.name} onClick={() => { close(); act(ipcInvoke('script-player:axisClear', { axis })) }}>
                <X size={14} />{t('scriptPlayer.axisTools.clear')}
              </button>
              <button type="button" disabled={!status?.mediaId} onClick={() => { close(); act(ipcInvoke('script-player:axisReload', { axis })) }}>
                <RotateCcw size={14} />{t('scriptPlayer.axisTools.reload')}
              </button>
              <button
                type="button"
                className={script?.locked ? 'alert' : ''}
                onClick={() => { close(); act(ipcInvoke('script-player:axisLock', { axis, locked: !script?.locked })) }}
              >
                {script?.locked ? <Lock size={14} /> : <LockOpen size={14} />}
                {t(script?.locked ? 'scriptPlayer.axisTools.unlock' : 'scriptPlayer.axisTools.lock')}
              </button>
            </div>
          )}
        </ToolPopover>

        <button
          type="button"
          className={`sp-tool${motion.invert ? ' on' : ''}`}
          title={t('scriptPlayer.invert')}
          aria-pressed={motion.invert}
          onClick={() => update({ invert: !motion.invert })}
        >
          <FlipVertical2 size={16} />
        </button>

        <ToolPopover
          icon={<CirclePause size={16} />}
          title={t('scriptPlayer.axisTools.bypass')}
          tone={motion.bypassScript || motion.bypassMotion ? 'alert' : undefined}
        >
          {() => <BypassSettings motion={motion} update={update} />}
        </ToolPopover>

        <ToolPopover
          icon={<Link size={16} />}
          title={t('scriptPlayer.axisTools.link')}
          tone={motion.linkAxis !== null ? 'on' : undefined}
        >
          {() => <LinkSettings axis={axis} settings={settings} update={update} />}
        </ToolPopover>

        <ToolPopover
          icon={<Activity size={16} />}
          title={t('scriptPlayer.axisTools.motion')}
          tone={motion.motionProvider !== null ? 'on' : undefined}
          wide
        >
          {() => (
            <MotionSettings
              axis={axis}
              motion={motion}
              status={status}
              update={update}
              updateAxis={onUpdateAxis}
              onError={onError}
            />
          )}
        </ToolPopover>

        <ToolPopover
          icon={<Spline size={16} />}
          title={t('scriptPlayer.axisTools.smartLimit')}
          tone={motion.smartLimitAxis !== null ? 'on' : undefined}
        >
          {() => <SmartLimitSettings axis={axis} motion={motion} update={update} />}
        </ToolPopover>

        <ToolPopover
          icon={<Gauge size={16} />}
          title={t('scriptPlayer.speedLimit')}
          tone={motion.speedLimit ? 'on' : undefined}
        >
          {() => <SpeedLimitSettings motion={motion} update={update} />}
        </ToolPopover>

        <ToolPopover icon={<Waves size={16} />} title={t('scriptPlayer.interpolation')}>
          {() => (
            <div className="sp-pop-body">
              <InterpolationPreview type={motion.interpolation} />
              <label className="sp-pop-row">
                <span>{t('scriptPlayer.axisTools.type')}</span>
                <Select
                  value={motion.interpolation}
                  onChange={(value) => update({ interpolation: value })}
                  options={INTERPOLATION_TYPES.map((value) => ({ value, label: t(`scriptPlayer.interpolationType.${value}`) }))}
                />
              </label>
            </div>
          )}
        </ToolPopover>

        <ToolPopover
          icon={<House size={16} />}
          title={t('scriptPlayer.autoHome')}
          tone={motion.autoHome ? 'on' : undefined}
        >
          {() => <AutoHomeSettings motion={motion} update={update} />}
        </ToolPopover>

        <span className="sp-axis-title" title={name}>{name}</span>
        <button
          type="button"
          className={`sp-tool sp-axis-expand${open ? ' open' : ''}`}
          title={t(open ? 'scriptPlayer.axisTools.collapse' : 'scriptPlayer.axisTools.expand')}
          aria-expanded={open}
          onClick={toggleOpen}
        >
          <ChevronDown size={16} />
        </button>
      </div>

      {open && (
        <div className="sp-axis-body">
          <label
            className={`sp-axis-file${script?.locked && script.name ? ' locked' : ''}`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={drop}
            title={script?.path ?? undefined}
          >
            <span className="sp-axis-label">{t('scriptPlayer.axisTools.file')}</span>
            <span className={`sp-axis-file-name${script?.name ? '' : ' empty'}`}>
              {script?.locked && script.name && <Lock size={12} />}
              {script?.name ?? t('scriptPlayer.axisTools.dropHint')}
              {script?.linkedFrom && (
                <small>{t('scriptPlayer.axisTools.linkedFrom', { axis: TCODE_CHANNEL_BY_AXIS[script.linkedFrom] })}</small>
              )}
            </span>
          </label>
          <div className="sp-axis-tune">
            <label className="sp-axis-offset">
              <span className="sp-axis-label">{t('scriptPlayer.axisTools.offset')}</span>
              <NumberField
                value={motion.offsetMs / 1000}
                step={0.1}
                min={-600}
                max={600}
                decimals={2}
                unit="s"
                wheel
                onChange={(value) => update({ offsetMs: Math.round(value * 1000) })}
              />
            </label>
            <label className="sp-axis-scale">
              <span className="sp-axis-label">{t('scriptPlayer.axisTools.scale')}</span>
              <input
                type="range"
                min={0.01}
                max={4}
                step={0.01}
                value={motion.scriptScale}
                aria-label={`${channel} ${t('scriptPlayer.axisTools.scale')}`}
                onChange={(event) => update({ scriptScale: Number(event.target.value) })}
                onDoubleClick={() => update({ scriptScale: 1 })}
              />
              <span className="sp-axis-scale-value">{percent(motion.scriptScale)}</span>
            </label>
          </div>
        </div>
      )}
    </section>
  )
}

function AxisTab({
  axis,
  selected,
  motion,
  status,
  onSelect
}: {
  axis: ScriptPlayerAxis
  selected: boolean
  motion: AxisMotion
  status: PlayerStatus | null
  onSelect: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const script = status?.scripts[axis]
  const activity = status?.activity[axis]
  const hasScript = Boolean(script?.name)

  const link = motion.linkAxis === null ? 'off' : motion.linkPriority ? 'override' : 'on'
  const provider = motion.motionProvider === null
    ? 'off'
    : motion.bypassMotion
      ? 'bypassed'
      : hasScript && motion.motionBlend > 0.5 ? 'override' : 'on'
  const speed = !motion.speedLimit ? 'off' : activity?.speedLimited ? 'active' : 'on'
  const smart = motion.smartLimitAxis === null ? 'off' : activity?.smartLimited ? 'active' : 'on'

  const tone = (state: string): string =>
    state === 'override' || state === 'active' ? 'hot' : state === 'on' ? 'on' : ''

  const tooltip = [
    `${t('scriptPlayer.axisTools.link')}: ${t(`scriptPlayer.axisTools.state.${link}`)}`,
    `${t('scriptPlayer.axisTools.motion')}: ${t(`scriptPlayer.axisTools.state.${provider}`)}`,
    `${t('scriptPlayer.speedLimit')}: ${t(`scriptPlayer.axisTools.state.${speed}`)}`,
    `${t('scriptPlayer.axisTools.smartLimit')}: ${t(`scriptPlayer.axisTools.state.${smart}`)}`
  ].join('\n')

  const labelTone = motion.bypassScript || (script?.locked && hasScript) ? ' hot' : hasScript ? ' loaded' : ''

  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={`sp-axis-tab${selected ? ' active' : ''}${labelTone}`}
      title={`${t(`scriptPlayer.axis.${axis}`)}\n${tooltip}`}
      onClick={onSelect}
    >
      <span>{TCODE_CHANNEL_BY_AXIS[axis]}</span>
      <span className="sp-axis-dots">
        {[link, provider, speed, smart].map((state, index) => (
          <i key={index} className={tone(state)} />
        ))}
      </span>
    </button>
  )
}

/**
 * A toolbar button that opens a panel of settings. The panel goes into the
 * body so the card's stacking context cannot bury it; a click anywhere else
 * closes it, and a dropdown opened inside it stacks above it.
 */
export function ToolPopover({
  icon,
  title,
  tone,
  wide = false,
  menu = false,
  buttonClass = 'sp-tool',
  children
}: {
  icon: React.ReactNode
  title: string
  tone?: 'on' | 'alert'
  wide?: boolean
  menu?: boolean
  buttonClass?: string
  children: (close: () => void) => React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const placement = usePopover(buttonRef, open, close, { maxHeight: 640, minRoom: 280 })

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`${buttonClass}${tone ? ` ${tone}` : ''}${open ? ' open' : ''}`}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
      </button>
      {open && placement && createPortal(
        <>
          <div className="select-scrim" onClick={close} />
          <div
            className={`sp-pop${wide ? ' wide' : ''}${menu ? ' menu' : ''}`}
            role="dialog"
            aria-label={title}
            style={placement}
          >
            {!menu && <div className="sp-pop-title">{title}</div>}
            {children(close)}
          </div>
        </>,
        document.body
      )}
    </>
  )
}

/**
 * A number that can be typed freely and only reaches the setting once it
 * parses; the field shows the setting again when it loses focus.
 */
function NumberField({
  value,
  onChange,
  min,
  max,
  step,
  decimals = 0,
  unit,
  wheel = false,
  disabled = false
}: {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step: number
  decimals?: number
  unit?: string
  wheel?: boolean
  disabled?: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const valueRef = useRef(value)
  valueRef.current = value

  const clamp = (next: number): number =>
    Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, next))
  const round = (next: number): number => Number(next.toFixed(Math.max(decimals, 2)))

  // Scrolling over the field nudges it, without having to click into it first.
  // Registered by hand because React's wheel listener cannot stop the page
  // from scrolling underneath.
  useEffect(() => {
    const input = inputRef.current
    if (!wheel || !input || disabled) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const next = round(clamp(valueRef.current + (event.deltaY < 0 ? step : -step)))
      setDraft(null)
      onChange(next)
    }
    input.addEventListener('wheel', onWheel, { passive: false })
    return () => input.removeEventListener('wheel', onWheel)
  })

  return (
    <span className="sp-number-field">
      <input
        ref={inputRef}
        type="number"
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        value={draft ?? value.toFixed(decimals)}
        onChange={(event) => {
          setDraft(event.target.value)
          const parsed = Number(event.target.value)
          if (event.target.value.trim() !== '' && Number.isFinite(parsed)) onChange(round(clamp(parsed)))
        }}
        onBlur={() => setDraft(null)}
      />
      {unit && <span className="settings-unit">{unit}</span>}
    </span>
  )
}

function Switch({
  checked,
  label,
  onChange,
  disabled = false
}: {
  checked: boolean
  label: React.ReactNode
  onChange: (checked: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <label className={`sp-pop-row sp-switch${disabled ? ' disabled' : ''}`}>
      <span>{label}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    </label>
  )
}

function AxisSelect({
  value,
  exclude,
  onChange,
  none = true
}: {
  value: ScriptPlayerAxis | null
  exclude: (axis: ScriptPlayerAxis) => boolean
  onChange: (axis: ScriptPlayerAxis | null) => void
  none?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const options = [
    ...(none ? [{ value: '', label: t('scriptPlayer.axisTools.none') }] : []),
    ...SCRIPT_PLAYER_AXES.filter((axis) => !exclude(axis)).map((axis) => ({ value: axis as string, label: TCODE_CHANNEL_BY_AXIS[axis] }))
  ]
  return (
    <Select
      className="sp-axis-select"
      value={value ?? ''}
      options={options}
      onChange={(next) => onChange(next === '' ? null : next as ScriptPlayerAxis)}
    />
  )
}

function BypassSettings({ motion, update }: { motion: AxisMotion; update: (change: Partial<AxisMotion>) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const any = motion.bypassScript || motion.bypassMotion
  return (
    <div className="sp-pop-body">
      <div className="sp-pop-row">
        <button type="button" className="ghost" onClick={() => update({ bypassScript: true, bypassMotion: true })}>
          {t('scriptPlayer.axisTools.bypassAll')}
        </button>
        <button
          type="button"
          className="icon-btn"
          disabled={!any}
          title={t('scriptPlayer.axisTools.bypassNone')}
          onClick={() => update({ bypassScript: false, bypassMotion: false })}
        >
          <ToggleLeft size={15} />
        </button>
      </div>
      <Switch checked={motion.bypassScript} label={t('scriptPlayer.axisTools.bypassScript')} onChange={(bypassScript) => update({ bypassScript })} />
      <Switch checked={motion.bypassMotion} label={t('scriptPlayer.axisTools.bypassMotion')} onChange={(bypassMotion) => update({ bypassMotion })} />
    </div>
  )
}

function LinkSettings({
  axis,
  settings,
  update
}: {
  axis: ScriptPlayerAxis
  settings: PlayerSettings
  update: (change: Partial<AxisMotion>) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const motion = settings.axes[axis]
  // Offer only targets whose own links do not lead back here.
  const loopsBack = (candidate: ScriptPlayerAxis): boolean => {
    let current: ScriptPlayerAxis | null = candidate
    for (let hops = 0; current !== null && hops <= SCRIPT_PLAYER_AXES.length; hops++) {
      if (current === axis) return true
      current = settings.axes[current].linkAxis
    }
    return false
  }
  return (
    <div className="sp-pop-body">
      <label className="sp-pop-row">
        <span>{t('scriptPlayer.axisTools.linkTarget')}</span>
        <AxisSelect value={motion.linkAxis} exclude={loopsBack} onChange={(linkAxis) => update({ linkAxis })} />
      </label>
      <label className="sp-pop-row" title={t('scriptPlayer.axisTools.linkPriorityHint')}>
        <span>{t('scriptPlayer.axisTools.linkPriority')}</span>
        <input
          type="checkbox"
          checked={motion.linkPriority}
          disabled={motion.linkAxis === null}
          onChange={(event) => update({ linkPriority: event.target.checked })}
        />
      </label>
    </div>
  )
}

function MotionSettings({
  axis,
  motion,
  status,
  update,
  updateAxis,
  onError
}: {
  axis: ScriptPlayerAxis
  motion: AxisMotion
  status: PlayerStatus | null
  update: (change: Partial<AxisMotion>) => void
  updateAxis: UpdateAxis
  onError: (caught: unknown) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const channel = TCODE_CHANNEL_BY_AXIS[axis]
  const provider = motion.motionProvider

  const changeProvider = <K extends keyof MotionProviders>(kind: K, change: Partial<MotionProviders[K]>): void => {
    updateAxis(axis, (current) => ({
      ...current,
      providers: { ...current.providers, [kind]: { ...current.providers[kind], ...change } }
    }))
  }

  return (
    <div className="sp-pop-body">
      <label className="sp-pop-row">
        <span>{t('scriptPlayer.axisTools.motionProvider')}</span>
        <Select
          value={provider ?? ''}
          onChange={(value) => update({ motionProvider: value === '' ? null : value as AxisMotion['motionProvider'] })}
          options={[
            { value: '', label: t('scriptPlayer.axisTools.none') },
            ...MOTION_PROVIDERS.map((value) => ({ value: value as string, label: t(`scriptPlayer.axisTools.provider.${value}`) }))
          ]}
        />
      </label>

      <details className="sp-pop-group">
        <summary>{t('scriptPlayer.axisTools.commonSettings')}</summary>
        <div className="sp-pop-group-body">
          <div className="sp-pop-heading">{t('scriptPlayer.axisTools.blend')}</div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={motion.motionBlend}
            onChange={(event) => update({ motionBlend: Number(event.target.value) })}
          />
          <div className="sp-pop-row sp-pop-split">
            <span>{t('scriptPlayer.axisTools.blendScript')}: {percent(1 - motion.motionBlend)}</span>
            <span>{t('scriptPlayer.axisTools.blendProvider')}: {percent(motion.motionBlend)}</span>
          </div>

          <Switch
            checked={motion.fillGaps}
            label={<b>{t('scriptPlayer.axisTools.gapFill')}</b>}
            onChange={(fillGaps) => update({ fillGaps })}
          />
          <label className="sp-pop-row">
            <span>{t('scriptPlayer.axisTools.minimumGap', { axis: channel })}</span>
            <NumberField
              value={motion.minGapMs / 1000}
              min={0}
              max={600}
              step={1}
              unit="s"
              onChange={(value) => update({ minGapMs: Math.round(value * 1000) })}
            />
          </label>

          {motion.updateWithAxis !== null && (
            <Switch
              checked={motion.matchAxisSpeed}
              label={t('scriptPlayer.axisTools.matchSpeed', { axis: TCODE_CHANNEL_BY_AXIS[motion.updateWithAxis] })}
              onChange={(matchAxisSpeed) => update({ matchAxisSpeed })}
            />
          )}

          <div className="sp-pop-heading">{t('scriptPlayer.axisTools.updateWhen')}</div>
          <Switch
            checked={motion.updateWhenPaused}
            label={t('scriptPlayer.axisTools.whenPaused')}
            onChange={(updateWhenPaused) => update({ updateWhenPaused })}
          />
          <Switch
            checked={motion.updateWithoutScript}
            label={t('scriptPlayer.axisTools.whenNoScript', { axis: channel })}
            onChange={(updateWithoutScript) => update({ updateWithoutScript })}
          />
          <label className="sp-pop-row">
            <span>{t('scriptPlayer.axisTools.whenAxisMoving')}</span>
            <AxisSelect
              value={motion.updateWithAxis}
              exclude={(candidate) => candidate === axis}
              onChange={(updateWithAxis) => update({ updateWithAxis })}
            />
          </label>
        </div>
      </details>

      {provider === 'random' && (
        <>
          <ProviderBaseFields settings={motion.providers.random} onChange={(change) => changeProvider('random', change)} />
          <details className="sp-pop-group">
            <summary>{t('scriptPlayer.axisTools.advanced')}</summary>
            <div className="sp-pop-group-body">
              <label className="sp-pop-row">
                <span>{t('scriptPlayer.axisTools.octaves')}</span>
                <NumberField value={motion.providers.random.octaves} min={1} max={8} step={1} onChange={(octaves) => changeProvider('random', { octaves })} />
              </label>
              <label className="sp-pop-row">
                <span>{t('scriptPlayer.axisTools.persistence')}</span>
                <NumberField value={motion.providers.random.persistence} min={0.01} max={100} step={0.01} decimals={2} onChange={(persistence) => changeProvider('random', { persistence })} />
              </label>
              <label className="sp-pop-row">
                <span>{t('scriptPlayer.axisTools.lacunarity')}</span>
                <NumberField value={motion.providers.random.lacunarity} min={0.1} max={2} step={0.01} decimals={2} onChange={(lacunarity) => changeProvider('random', { lacunarity })} />
              </label>
              <NoisePreview
                octaves={motion.providers.random.octaves}
                persistence={motion.providers.random.persistence}
                lacunarity={motion.providers.random.lacunarity}
              />
            </div>
          </details>
        </>
      )}

      {provider === 'pattern' && (
        <>
          <label className="sp-pop-row">
            <span>{t('scriptPlayer.axisTools.patternType')}</span>
            <Select
              value={motion.providers.pattern.pattern}
              onChange={(pattern) => changeProvider('pattern', { pattern })}
              options={PATTERN_TYPES.map((value) => ({ value, label: t(`scriptPlayer.axisTools.pattern.${value}`) }))}
            />
          </label>
          <ProviderBaseFields settings={motion.providers.pattern} onChange={(change) => changeProvider('pattern', change)} />
        </>
      )}

      {provider === 'customCurve' && (
        <CustomCurveFields
          axis={axis}
          settings={motion.providers.customCurve}
          curveTime={status?.activity[axis].curveTime ?? null}
          onChange={(change) => changeProvider('customCurve', change)}
        />
      )}

      {provider === 'loopingScript' && (
        <>
          <div className="sp-pop-row">
            <span>{t('scriptPlayer.axisTools.script')}</span>
            <span className="sp-pop-file" title={motion.providers.loopingScript.path || undefined}>
              {motion.providers.loopingScript.path.split(/[\\/]/).pop() || t('scriptPlayer.axisTools.none')}
            </span>
            <button
              type="button"
              className="icon-btn"
              title={t('scriptPlayer.axisTools.load')}
              onClick={() => {
                ipcInvoke('script-player:pickScript')
                  .then(({ path }) => { if (path) changeProvider('loopingScript', { path }) })
                  .catch(onError)
              }}
            >
              <FileInput size={14} />
            </button>
          </div>
          <label className="sp-pop-row">
            <span>{t('scriptPlayer.interpolation')}</span>
            <Select
              value={motion.providers.loopingScript.interpolation}
              onChange={(interpolation) => changeProvider('loopingScript', { interpolation })}
              options={INTERPOLATION_TYPES.map((value) => ({ value, label: t(`scriptPlayer.interpolationType.${value}`) }))}
            />
          </label>
          <ProviderBaseFields settings={motion.providers.loopingScript} onChange={(change) => changeProvider('loopingScript', change)} />
        </>
      )}
    </div>
  )
}

function ProviderBaseFields({
  settings,
  onChange
}: {
  settings: { speed: number; minimum: number; maximum: number }
  onChange: (change: { speed?: number; minimum?: number; maximum?: number }) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <label className="sp-pop-row">
        <span>{t('scriptPlayer.axisTools.speed')}</span>
        <NumberField
          value={Math.round(settings.speed * 100)}
          min={1}
          max={10_000}
          step={1}
          unit="%"
          onChange={(value) => onChange({ speed: value / 100 })}
        />
      </label>
      <div className="sp-pop-row sp-pop-range">
        <span>{t('scriptPlayer.axisTools.range')}</span>
        <RangeSlider
          min={Math.round(settings.minimum * 100)}
          max={Math.round(settings.maximum * 100)}
          marker={undefined}
          label={t('scriptPlayer.axisTools.range')}
          disabled={false}
          onChange={(next) => onChange({ minimum: next.min / 100, maximum: next.max / 100 })}
        />
        <span className="sp-range-value">{Math.round(settings.minimum * 100)}–{Math.round(settings.maximum * 100)}</span>
      </div>
    </>
  )
}

function CustomCurveFields({
  axis,
  settings,
  curveTime,
  onChange
}: {
  axis: ScriptPlayerAxis
  settings: MotionProviders['customCurve']
  curveTime: number | null
  onChange: (change: Partial<MotionProviders['customCurve']>) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <label className="sp-pop-row">
        <span>{t('scriptPlayer.interpolation')}</span>
        <Select
          value={settings.interpolation}
          onChange={(interpolation) => onChange({ interpolation })}
          options={INTERPOLATION_TYPES.map((value) => ({ value, label: t(`scriptPlayer.interpolationType.${value}`) }))}
        />
      </label>
      <label className="sp-pop-row">
        <span>{t('scriptPlayer.axisTools.duration')}</span>
        <NumberField
          value={settings.durationS}
          min={1}
          max={60}
          step={1}
          unit="s"
          // A shorter curve drops the points that no longer fit on it.
          onChange={(durationS) => onChange({ durationS, points: settings.points.filter((point) => point.x <= durationS) })}
        />
      </label>
      <div className="sp-pop-row">
        <label className="sp-inline-check">
          <input type="checkbox" checked={settings.loop} onChange={(event) => onChange({ loop: event.target.checked })} />
          {t('scriptPlayer.axisTools.loop')}
        </label>
        <button
          type="button"
          className="icon-btn"
          title={t('scriptPlayer.axisTools.restart')}
          onClick={() => void ipcInvoke('script-player:resetCurve', { axis })}
        >
          <RotateCcw size={13} />
        </button>
        {!settings.loop && (
          <label className="sp-inline-check">
            <input type="checkbox" checked={settings.syncOnEnd} onChange={(event) => onChange({ syncOnEnd: event.target.checked })} />
            {t('scriptPlayer.axisTools.syncOnEnd')}
          </label>
        )}
      </div>
      <ProviderBaseFields settings={settings} onChange={onChange} />
      <CurveEditor
        points={settings.points}
        width={settings.durationS}
        height={1}
        interpolation={settings.interpolation}
        loop={settings.loop}
        scrubber={curveTime}
        pixelHeight={150}
        title={t('scriptPlayer.axisTools.curveHint')}
        format={(point) => `${point.x.toFixed(1)}s, ${percent(point.y)}`}
        onChange={(points) => onChange({ points })}
      />
    </>
  )
}

function SmartLimitSettings({
  axis,
  motion,
  update
}: {
  axis: ScriptPlayerAxis
  motion: AxisMotion
  update: (change: Partial<AxisMotion>) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const input = useSweep(true)
  const output = linearThrough(motion.smartLimitPoints, input)
  const inputAxis = motion.smartLimitAxis === null ? '—' : TCODE_CHANNEL_BY_AXIS[motion.smartLimitAxis]
  const channel = TCODE_CHANNEL_BY_AXIS[axis]
  return (
    <div className="sp-pop-body">
      <label className="sp-pop-row">
        <span>{t('scriptPlayer.axisTools.inputAxis')}</span>
        <AxisSelect
          value={motion.smartLimitAxis}
          exclude={(candidate) => candidate === axis}
          onChange={(smartLimitAxis) => update({ smartLimitAxis })}
        />
      </label>

      <div className="sp-smart-plot">
        <span className="sp-smart-y">{t('scriptPlayer.axisTools.output')}</span>
        <CurveEditor
          points={motion.smartLimitPoints}
          width={100}
          height={100}
          scrubber={input}
          pixelHeight={125}
          title={t('scriptPlayer.axisTools.curveHint')}
          format={(point) => `${Math.round(point.x)}%, ${Math.round(point.y)}%`}
          onChange={(points) => { if (points.length > 0) update({ smartLimitPoints: points }) }}
        />
        <span className="sp-smart-x">{t('scriptPlayer.axisTools.input')}</span>
      </div>

      <label className="sp-pop-row">
        <span>{t('scriptPlayer.axisTools.mode')}</span>
        <Select
          value={motion.smartLimitMode}
          onChange={(smartLimitMode) => update({ smartLimitMode })}
          options={SMART_LIMIT_MODES.map((value) => ({ value, label: t(`scriptPlayer.axisTools.smartMode.${value}`) }))}
        />
      </label>
      {motion.smartLimitMode === 'value' && (
        <label className="sp-pop-row">
          <span>{t('scriptPlayer.axisTools.target')}</span>
          <NumberField
            value={Math.round(motion.smartLimitTarget * 100)}
            min={0}
            max={100}
            step={1}
            unit="%"
            onChange={(value) => update({ smartLimitTarget: value / 100 })}
          />
        </label>
      )}

      <div className="sp-pop-heading">{t('scriptPlayer.axisTools.when')}</div>
      <div className="sp-pop-note">{t('scriptPlayer.axisTools.inputAt', { axis: inputAxis, value: Math.round(input) })}</div>
      <div className="sp-pop-heading">{t('scriptPlayer.axisTools.then')}</div>
      <div className="sp-pop-note">
        {t(motion.smartLimitMode === 'value' ? 'scriptPlayer.axisTools.limitRange' : 'scriptPlayer.axisTools.limitSpeed', {
          axis: channel,
          value: Math.round(output)
        })}
      </div>
    </div>
  )
}

function SpeedLimitSettings({ motion, update }: { motion: AxisMotion; update: (change: Partial<AxisMotion>) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const perStroke = motion.speedLimitPerSecond <= 0 ? '∞' : (1 / motion.speedLimitPerSecond).toFixed(3)
  return (
    <div className="sp-pop-body">
      <Switch checked={motion.speedLimit} label={t('scriptPlayer.axisTools.enabled')} onChange={(speedLimit) => update({ speedLimit })} />
      <label className="sp-pop-row" title={t('scriptPlayer.axisTools.speedUnitHint')}>
        <span>{t('scriptPlayer.axisTools.limit')}</span>
        <NumberField
          value={motion.speedLimitPerSecond}
          min={0}
          max={100}
          step={0.1}
          decimals={2}
          unit={t('scriptPlayer.perSecond')}
          onChange={(speedLimitPerSecond) => update({ speedLimitPerSecond })}
        />
      </label>
      <div className="sp-pop-note align-end">{t('scriptPlayer.axisTools.secondsPerStroke', { value: perStroke })}</div>
    </div>
  )
}

function AutoHomeSettings({ motion, update }: { motion: AxisMotion; update: (change: Partial<AxisMotion>) => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="sp-pop-body">
      <Switch checked={motion.autoHome} label={t('scriptPlayer.axisTools.enabled')} onChange={(autoHome) => update({ autoHome })} />
      <Switch
        checked={motion.autoHomeInsideScript}
        label={t('scriptPlayer.axisTools.homeInsideScript')}
        onChange={(autoHomeInsideScript) => update({ autoHomeInsideScript })}
      />
      <label className="sp-pop-row">
        <span>{t('scriptPlayer.axisTools.delay')}</span>
        <NumberField
          value={motion.autoHomeDelayMs / 1000}
          min={0}
          max={600}
          step={0.5}
          decimals={2}
          unit="s"
          onChange={(value) => update({ autoHomeDelayMs: Math.round(value * 1000) })}
        />
      </label>
      <label className="sp-pop-row">
        <span>{t('scriptPlayer.axisTools.duration')}</span>
        <NumberField
          value={motion.autoHomeDurationMs / 1000}
          min={0}
          max={600}
          step={0.5}
          decimals={2}
          unit="s"
          onChange={(value) => update({ autoHomeDurationMs: Math.round(value * 1000) })}
        />
      </label>
      <label className="sp-pop-row">
        <span>{t('scriptPlayer.axisTools.target')}</span>
        <NumberField
          value={Math.round(motion.autoHomeTarget * 100)}
          min={0}
          max={100}
          step={1}
          unit="%"
          onChange={(value) => update({ autoHomeTarget: value / 100 })}
        />
      </label>
    </div>
  )
}
