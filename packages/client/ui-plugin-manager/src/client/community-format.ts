/** Locale-neutral number formatting for plugin community cards and the install review. */
import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'

/** Dictionary keys for the relative age of a repository's latest push. */
export type AgeKey = 'ageNow' | 'ageMinutes' | 'ageHours' | 'ageDays' | 'ageMonths' | 'ageYears'

/**
 * Abbreviate a count above one thousand.
 * @param value Non-negative integer count.
 * @returns `999`, `1.2k` or `12k` style text.
 */
export function compactCount(value: number): string {
  if (value < 1000) return String(value)
  const thousands = value / 1000
  return (thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, '') : String(Math.round(thousands))) + 'k'
}

/**
 * Format a byte length with a binary unit.
 * @param bytes Non-negative byte count.
 * @returns `512 B`, `12.3 KB` or `1.4 MB` style text.
 */
export function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} ${units[unit]}`
}

/**
 * Bucket an ISO timestamp into a localizable age.
 * @param iso Time of the latest push.
 * @param now Current epoch milliseconds.
 * @returns The dictionary key and its `{n}` parameter.
 */
export function age(iso: string, now: number): { key: AgeKey; n: number } {
  const { unit, n } = relativeTime(Date.parse(iso), now)
  switch (unit) {
    case 'now': return { key: 'ageNow', n }
    case 'minutes': return { key: 'ageMinutes', n }
    case 'hours': return { key: 'ageHours', n }
    case 'days': return { key: 'ageDays', n }
    case 'months': return { key: 'ageMonths', n }
    case 'years': return { key: 'ageYears', n }
  }
}
