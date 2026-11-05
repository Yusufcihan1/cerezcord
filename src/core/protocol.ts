import type { DeviceKind } from './device'
import { CHAT_MAX_LENGTH, NAME_MAX_LENGTH } from './limits'

// Veri kanalı üzerinden giden tüm mesajlar. Karşıdan gelen her şey güvenilmez kabul edilir
// ve parse() ile doğrulanır.

export const PROTOCOL_VERSION = 1

export type HelloMsg = {
  t: 'hello'
  v: number
  name: string
  device: DeviceKind
  /** Odaya katılma zamanı (ms). Oda doluyken kimin kalacağını belirler. */
  joinedAt: number
  muted: boolean
  deafened: boolean
}

export type StateMsg = { t: 'state'; muted: boolean; deafened: boolean }

export type ChatMsg = { t: 'chat'; id: string; text: string; ts: number }

export type Msg = HelloMsg | StateMsg | ChatMsg

const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

export function parse(raw: unknown): Msg | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  switch (m.t) {
    case 'hello':
      if (!isNum(m.v) || !isStr(m.name) || !isNum(m.joinedAt) || !isBool(m.muted) || !isBool(m.deafened)) return null
      return {
        t: 'hello',
        v: m.v,
        name: cleanName(m.name) || 'İsimsiz',
        device: m.device === 'mobile' ? 'mobile' : 'pc',
        joinedAt: m.joinedAt,
        muted: m.muted,
        deafened: m.deafened,
      }
    case 'state':
      if (!isBool(m.muted) || !isBool(m.deafened)) return null
      return { t: 'state', muted: m.muted, deafened: m.deafened }
    case 'chat':
      if (!isStr(m.id) || !isStr(m.text) || !isNum(m.ts)) return null
      if (!m.text.trim() || m.text.length > CHAT_MAX_LENGTH) return null
      return { t: 'chat', id: m.id.slice(0, 40), text: m.text, ts: m.ts }
    default:
      return null
  }
}

export function cleanName(name: string) {
  return name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX_LENGTH)
}
