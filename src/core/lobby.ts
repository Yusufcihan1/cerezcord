import { schnorr } from '@noble/secp256k1'
import { MAX_ROOM_SIZE, ROOM_MAX_LENGTH } from './limits'
import { cleanName, normalizeRoomName } from './protocol'

// Açık oda vitrini. Sunucu yok: odadaki en eski kişi, odanın adını ve doluluğunu birkaç Nostr
// sunucusuna 30 sn'de bir ilan eder. "Açık odalar" ekranı bu ilanları dinler. İlanlar kendiliğinden
// eskir; ilanı yenilenmeyen oda listeden düşer. Herkes ilan atabildiği için içerik güvenilmez kabul
// edilir ve sıkı doğrulanır.

export type PublicRoomInfo = {
  room: string
  count: number
  /** Odadakilerin adları, katılma sırasıyla */
  names: string[]
  /** İlanın zamanı (ms) */
  updatedAt: number
}

/** NIP-78 uygulama verisi: adreslenebilir, sunucuda saklanan olay türü */
const KIND = 30078
const TOPIC = 'cerezcord-acik-v1'
const D_PREFIX = 'cerezcord-acik:'

export const ANNOUNCE_INTERVAL_MS = 30_000
/** İki ilan kaçarsa oda listeden düşer */
const STALE_MS = 75_000
/** NIP-40: sunucular ilanı bu süre sonra silebilir */
const EXPIRATION_S = 120

// Vitrin ilanlarının saklanması gerektiği için, olayları saklayan bilinen sunucular kullanılır.
// VITE_NOSTR_RELAYS verilirse (bkz. README) onlar kullanılır.
const DEFAULT_LOBBY_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom']

const relayUrls = (() => {
  const custom = (import.meta.env.VITE_NOSTR_RELAYS as string | undefined)
    ?.split(',')
    .map((u) => u.trim())
    .filter(Boolean)
  return custom?.length ? custom : DEFAULT_LOBBY_RELAYS
})()

const nowS = () => Math.floor(Date.now() / 1000)
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** Birkaç sunucuya açık tutulan bağlantılar; kopan yeniden bağlanır. */
class RelayPool {
  private sockets = new Map<string, WebSocket>()
  private timers = new Set<number>()
  private retries = new Map<string, number>()
  private closed = false
  private onOpen: (ws: WebSocket) => void
  private onMessage: (msg: unknown[]) => void

  constructor(onOpen: (ws: WebSocket) => void, onMessage: (msg: unknown[]) => void) {
    this.onOpen = onOpen
    this.onMessage = onMessage
    for (const url of relayUrls) this.connect(url)
  }

  private connect(url: string) {
    if (this.closed) return
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      return this.retry(url)
    }
    ws.onopen = () => {
      this.retries.set(url, 0)
      this.onOpen(ws)
    }
    ws.onmessage = (e) => {
      try {
        const msg: unknown = JSON.parse(e.data as string)
        if (Array.isArray(msg)) this.onMessage(msg)
      } catch {
        /* bozuk mesaj */
      }
    }
    ws.onclose = () => {
      this.sockets.delete(url)
      this.retry(url)
    }
    this.sockets.set(url, ws)
  }

  private retry(url: string) {
    if (this.closed) return
    const n = (this.retries.get(url) ?? 0) + 1
    this.retries.set(url, n)
    const t = window.setTimeout(() => {
      this.timers.delete(t)
      this.connect(url)
    }, Math.min(60_000, 2_000 * 2 ** n))
    this.timers.add(t)
  }

  broadcast(data: string) {
    for (const ws of this.sockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(data)
  }

  close() {
    this.closed = true
    for (const t of this.timers) clearTimeout(t)
    for (const ws of this.sockets.values()) {
      ws.onclose = null
      ws.close()
    }
    this.sockets.clear()
  }
}

/** Bir açık odanın ilanlarını gönderir. Oda içinde, yalnız en eski kişi kullanır. */
export class LobbyAnnouncer {
  private key = schnorr.keygen()
  private pubkey = toHex(this.key.publicKey)
  private last: string | null = null
  private pool = new RelayPool(
    (ws) => this.last && ws.send(this.last),
    () => {},
  )

  async announce(info: Omit<PublicRoomInfo, 'updatedAt'>) {
    const created_at = nowS()
    const tags = [
      ['d', D_PREFIX + info.room],
      ['t', TOPIC],
      ['expiration', String(created_at + (info.count > 0 ? EXPIRATION_S : 10))],
    ]
    const content = JSON.stringify({ count: info.count, names: info.names })
    const serialized = JSON.stringify([0, this.pubkey, created_at, KIND, tags, content])
    const id = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized)))
    const sig = await schnorr.signAsync(id, this.key.secretKey)
    const event = { id: toHex(id), pubkey: this.pubkey, created_at, kind: KIND, tags, content, sig: toHex(sig) }
    this.last = JSON.stringify(['EVENT', event])
    this.pool.broadcast(this.last)
  }

  /** Son kişi çıkarken odayı vitrinden hemen kaldırır. */
  async announceEmpty(room: string) {
    await this.announce({ room, count: 0, names: [] }).catch(() => {})
    // Gönderimin sokete yazılmasına fırsat ver.
    window.setTimeout(() => this.pool.close(), 500)
  }

  close() {
    this.pool.close()
  }
}

function parseEvent(raw: unknown): PublicRoomInfo | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e.kind !== KIND || typeof e.created_at !== 'number' || typeof e.content !== 'string' || !Array.isArray(e.tags))
    return null
  const d = (e.tags as unknown[]).find((t): t is string[] => Array.isArray(t) && t[0] === 'd')?.[1]
  if (typeof d !== 'string' || !d.startsWith(D_PREFIX)) return null
  const room = normalizeRoomName(d.slice(D_PREFIX.length))
  if (!room || room.length > ROOM_MAX_LENGTH) return null
  let body: unknown
  try {
    body = JSON.parse(e.content)
  } catch {
    return null
  }
  const b = body as Record<string, unknown>
  if (typeof b?.count !== 'number' || !Number.isInteger(b.count) || b.count < 0) return null
  const names = Array.isArray(b.names)
    ? b.names
        .filter((n): n is string => typeof n === 'string')
        .map((n) => cleanName(n))
        .filter(Boolean)
        .slice(0, MAX_ROOM_SIZE)
    : []
  return { room, count: Math.min(b.count, MAX_ROOM_SIZE), names, updatedAt: e.created_at * 1000 }
}

/** Açık odaları dinler; liste her değiştiğinde (en kalabalık başta) onChange çağrılır. */
export function watchPublicRooms(onChange: (rooms: PublicRoomInfo[]) => void): () => void {
  const subId = 'cz' + Math.random().toString(36).slice(2, 10)
  const rooms = new Map<string, PublicRoomInfo>()

  const emit = () => {
    const cutoff = Date.now() - STALE_MS
    for (const [k, r] of rooms) if (r.updatedAt < cutoff) rooms.delete(k)
    onChange(
      [...rooms.values()]
        .filter((r) => r.count > 0)
        .sort((a, b) => b.count - a.count || a.room.localeCompare(b.room, 'tr')),
    )
  }

  const pool = new RelayPool(
    (ws) =>
      ws.send(
        JSON.stringify(['REQ', subId, { kinds: [KIND], '#t': [TOPIC], since: nowS() - STALE_MS / 1000, limit: 200 }]),
      ),
    (msg) => {
      if (msg[0] !== 'EVENT' || msg[1] !== subId) return
      const info = parseEvent(msg[2])
      if (!info || info.updatedAt < Date.now() - STALE_MS) return
      // Aynı oda için birden çok ilan varsa (ör. ilan eden kişi değişti) en yenisi geçerli.
      const prev = rooms.get(info.room)
      if (prev && prev.updatedAt >= info.updatedAt) return
      rooms.set(info.room, info)
      emit()
    },
  )
  const timer = window.setInterval(emit, 5_000)
  emit()

  return () => {
    clearInterval(timer)
    pool.close()
  }
}
