/** Defensive readers for InnerTube JSON, whose renderers change shape without notice. */

export type JsonRecord = Record<string, unknown>

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Walk object keys and array indexes; any missing step yields `undefined`. */
export function dig(value: unknown, ...path: Array<string | number>): unknown {
  let current: unknown = value
  for (const key of path) {
    if (typeof key === 'number') {
      if (!Array.isArray(current)) return undefined
      current = current[key < 0 ? current.length + key : key]
    } else {
      const record = asRecord(current)
      if (!record) return undefined
      current = record[key]
    }
  }
  return current
}

/** The single renderer wrapped in `{ someRenderer: {...} }`, with its key. */
export function unwrap(value: unknown): { kind: string; renderer: JsonRecord } | null {
  const record = asRecord(value)
  if (!record) return null
  const kind = Object.keys(record).find((key) => key.endsWith('Renderer') || key.endsWith('ViewModel'))
  const renderer = kind ? asRecord(record[kind]) : null
  return kind && renderer ? { kind, renderer } : null
}
