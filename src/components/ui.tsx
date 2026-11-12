import type { ReactNode } from 'react'
import { tr } from '../lib/i18n'

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button role="switch" aria-checked={on} className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T
  options: [T, string][]
  onChange: (v: T) => void
}) {
  return (
    <div className="seg">
      {options.map(([v, label]) => (
        <button key={String(v)} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

export function Stepper({
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  value: number
  min: number
  max: number
  step: number
  format?: (v: number) => string
  onChange: (v: number) => void
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step))
  const fix = (v: number) => Number(clamp(v).toFixed(3))
  return (
    <div className="stepper">
      <button aria-label={tr('减少')} onClick={() => onChange(fix(value - step))}>−</button>
      <span>{format ? format(value) : value}</span>
      <button aria-label={tr('增加')} onClick={() => onChange(fix(value + step))}>+</button>
    </div>
  )
}

export function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="row">
      <div className="row-label">
        {label}
        {hint && <span className="hint">{hint}</span>}
      </div>
      {children != null && <div className="row-control">{children}</div>}
    </div>
  )
}

export function Card({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <>
      {title && <div className="card-title">{title}</div>}
      <div className="card glass">{children}</div>
    </>
  )
}
