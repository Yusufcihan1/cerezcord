import type { DeviceKind } from './device'
import { isSfxId, type SfxId } from './sfx'
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

/** Efekt panosu: yalnız efektin adı gider, ses her kişide üretilir */
export type SfxMsg = { t: 'sfx'; id: SfxId }

/** Troll botun sözü (ses köprüsü kapalıyken); botu çağıran kişiden gelir, herkes kendi tarayıcı sesiyle okur */
export type BotMsg = { t: 'bot'; id: string; bot: string; text: string }

/** Bir kişinin çağırdığı botların listesi; her değişimde ve yeni gelene gönderilir */
/** ears: botlar odadaki sesleri dinliyor (çağıranın bilgisayarında yazıya çevriliyor) */
export type BotsMsg = { t: 'bots'; list: { id: string; name: string; voice: string }[]; ears?: boolean }

export type Msg = HelloMsg | StateMsg | ChatMsg | SfxMsg | BotMsg | BotsMsg

/** Botun sesli sözü ikili veri olarak gider; yanında bu bilgi */
export type BotAudioMeta = { id: string; bot: string; text: string }

export const BOTS_MAX = 4

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
    case 'sfx':
      return isSfxId(m.id) ? { t: 'sfx', id: m.id } : null
    case 'bot':
      if (!isStr(m.id) || !isStr(m.bot) || !isStr(m.text) || !m.text.trim() || m.text.length > CHAT_MAX_LENGTH) return null
      return { t: 'bot', id: m.id.slice(0, 40), bot: m.bot.slice(0, 40), text: m.text }
    case 'bots': {
      if (!Array.isArray(m.list) || m.list.length > BOTS_MAX) return null
      const list = []
      for (const b of m.list as unknown[]) {
        const o = b as Record<string, unknown>
        if (typeof o !== 'object' || o === null || !isStr(o.id) || !isStr(o.name)) return null
        list.push({ id: o.id.slice(0, 40), name: cleanName(o.name) || 'Yabancı', voice: isStr(o.voice) ? o.voice.slice(0, 12) : 'normal' })
      }
      return { t: 'bots', list, ears: m.ears === true }
    }
    default:
      return null
  }
}

export function parseBotAudioMeta(raw: unknown): BotAudioMeta | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  if (!isStr(m.id) || !isStr(m.bot) || !isStr(m.text) || !m.text.trim() || m.text.length > CHAT_MAX_LENGTH) return null
  return { id: m.id.slice(0, 40), bot: m.bot.slice(0, 40), text: m.text }
}

export function normalizeRoomName(name: string) {
  return name.trim().toLocaleLowerCase('tr').replace(/\s+/g, '-')
}

export function cleanName(name: string) {
  return name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX_LENGTH)
}
