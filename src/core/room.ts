import { joinRoom, selfId, type JsonValue, type Room } from 'trystero/nostr'
import { AudioEngine, LOCAL } from './audio'
import { deviceKind, type DeviceKind } from './device'
import {
  APP_ID,
  AUDIO_MAX_BITRATE,
  CHAT_HISTORY_LIMIT,
  CHAT_MAX_LENGTH,
  CHAT_RATE_MAX,
  CHAT_RATE_WINDOW_MS,
  MAX_ROOM_SIZE,
  PING_INTERVAL_MS,
} from './limits'
import { getMicrophone, micErrorMessage } from './media'
import { PROTOCOL_VERSION, parse, type Msg } from './protocol'
import { loadVolumes, saveVolumes, type Settings, type VoiceMode } from './storage'

export type PeerInfo = {
  id: string
  /** hello mesajı gelene kadar false; o zamana kadar isim bilinmiyor */
  known: boolean
  name: string
  device: DeviceKind
  joinedAt: number
  muted: boolean
  deafened: boolean
  ping: number | null
  volume: number
}

export type ChatEntry = {
  id: string
  kind: 'message' | 'system'
  fromId: string
  name: string
  text: string
  ts: number
}

export type RoomStatus = 'live' | 'full' | 'left'

export type RoomState = {
  status: RoomStatus
  roomName: string
  selfId: string
  name: string
  muted: boolean
  deafened: boolean
  voiceMode: VoiceMode
  pttDown: boolean
  micDeviceId: string
  micError: string | null
  peers: Record<string, PeerInfo>
  speaking: ReadonlySet<string>
  chat: ChatEntry[]
  notice: string | null
}

export type JoinOptions = {
  roomName: string
  password: string
  name: string
  settings: Settings
}

export const SELF = LOCAL

export function normalizeRoomName(name: string) {
  return name.trim().toLocaleLowerCase('tr').replace(/\s+/g, '-')
}

/**
 * Bir sesli odanın tüm yaşam döngüsü: P2P bağlantılar, mikrofon, protokol, sınırlar.
 * React tarafı yalnızca getState/subscribe ve eylem metodlarını kullanır.
 */
export class CerezRoom {
  private room: Room
  private send: (msg: Msg, target?: string) => void
  private audio: AudioEngine
  private mic: MediaStream | null = null
  private state: RoomState
  private listeners = new Set<() => void>()
  private joinedAt = Date.now()
  private volumes = loadVolumes()
  private chatRate = new Map<string, number[]>()
  private pingTimer: number
  private wakeLock: WakeLockSentinel | null = null
  private disposed = false

  /** Mutlaka kullanıcı tıklaması içinde çağrılmalı (ses kilidi + mikrofon izni). */
  static async join(opts: JoinOptions): Promise<CerezRoom> {
    let instance: CerezRoom | null = null
    const audio = new AudioEngine((s) => instance?.setSpeaking(s))
    let mic: MediaStream | null = null
    let micError: string | null = null
    try {
      mic = await getMicrophone(opts.settings.micDeviceId || undefined)
    } catch (err) {
      // Önce seçili cihazla, olmazsa varsayılanla dene.
      if (opts.settings.micDeviceId) {
        try {
          mic = await getMicrophone()
        } catch (err2) {
          micError = micErrorMessage(err2)
        }
      } else {
        micError = micErrorMessage(err)
      }
    }
    instance = new CerezRoom(opts, audio, mic, micError)
    return instance
  }

  private constructor(opts: JoinOptions, audio: AudioEngine, mic: MediaStream | null, micError: string | null) {
    this.audio = audio
    this.mic = mic
    const { settings } = opts
    this.state = {
      status: 'live',
      roomName: normalizeRoomName(opts.roomName),
      selfId,
      name: opts.name,
      muted: false,
      deafened: false,
      voiceMode: settings.voiceMode,
      pttDown: false,
      micDeviceId: mic?.getAudioTracks()[0]?.getSettings().deviceId ?? '',
      micError,
      peers: {},
      speaking: new Set(),
      chat: [],
      notice: micError ? 'Mikrofonsuz katıldın: diğerlerini duyabilirsin ama onlar seni duyamaz.' : null,
    }

    const turnConfig = settings.turnUrl.trim()
      ? [
          {
            urls: settings.turnUrl.trim(),
            username: settings.turnUsername || undefined,
            credential: settings.turnCredential || undefined,
          },
        ]
      : undefined

    // İsteğe bağlı: derleme sırasında VITE_NOSTR_RELAYS="wss://a,wss://b" verilirse halka açık
    // listeler yerine bu sinyal sunucuları kullanılır.
    const relayUrls = (import.meta.env.VITE_NOSTR_RELAYS as string | undefined)
      ?.split(',')
      .map((u) => u.trim())
      .filter(Boolean)

    this.room = joinRoom(
      {
        appId: APP_ID,
        password: opts.password,
        turnConfig,
        relayConfig: relayUrls?.length ? { urls: relayUrls, redundancy: relayUrls.length } : undefined,
      },
      this.state.roomName,
      {
      onJoinError: ({ error }) => {
        if (/password|decrypt/i.test(error)) {
          this.setNotice('Odada farklı şifre kullanan biri var; onunla bağlantı kurulamadı.')
        } else {
          this.setNotice('Biriyle bağlantı kurulamadı. Ağınız engelliyor olabilir; Ayarlar’dan TURN sunucusu ekleyebilirsin.')
        }
      },
    },
    )

    const action = this.room.makeAction<JsonValue>('msg', {
      onMessage: (data, { peerId }) => this.onMessage(peerId, data),
    })
    this.send = (msg, target) => void action.send(msg as unknown as JsonValue, target ? { target } : undefined).catch(() => {})

    this.room.onPeerJoin = (id) => this.onPeerJoin(id)
    this.room.onPeerLeave = (id) => this.onPeerLeave(id)
    this.room.onPeerStream = (stream, id) => {
      this.audio.addRemote(id, stream, this.state.peers[id]?.volume ?? 100)
    }

    if (mic) this.audio.setLocal(mic)
    this.applyMicEnabled()
    this.pingTimer = window.setInterval(() => this.measurePings(), PING_INTERVAL_MS)
    document.addEventListener('visibilitychange', this.onVisibility)
    void this.acquireWakeLock()
  }

  // ---------- store ----------

  getState = () => this.state

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(patch: Partial<RoomState>) {
    if (this.disposed && patch.status === undefined) return
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn()
  }

  private patchPeer(id: string, patch: Partial<PeerInfo>) {
    const prev = this.state.peers[id]
    if (!prev) return
    this.set({ peers: { ...this.state.peers, [id]: { ...prev, ...patch } } })
  }

  private setSpeaking(s: Set<string>) {
    this.set({ speaking: s })
  }

  private setNotice(text: string | null) {
    this.set({ notice: text })
  }

  dismissNotice() {
    this.setNotice(null)
  }

  // ---------- bağlantılar ----------

  private onPeerJoin(id: string) {
    this.set({
      peers: {
        ...this.state.peers,
        [id]: {
          id,
          known: false,
          name: '…',
          device: 'pc',
          joinedAt: Number.MAX_SAFE_INTEGER,
          muted: false,
          deafened: false,
          ping: null,
          volume: 100,
        },
      },
    })
    this.send(this.helloMsg(), id)
    // İlk ping'i beklemeden ölç, kartta "—" uzun süre kalmasın.
    setTimeout(() => this.pingPeer(id), 1000)
    if (this.mic) {
      void Promise.all(this.room.addStream(this.mic, { target: id }))
        .then(() => this.tuneAudioSenders(id))
        .catch(() => {})
    }
  }

  private onPeerLeave(id: string) {
    const peer = this.state.peers[id]
    this.audio.remove(id)
    this.chatRate.delete(id)
    if (!peer) return
    const peers = { ...this.state.peers }
    delete peers[id]
    this.set({ peers })
    if (peer.known) this.pushSystem(`${peer.name} ayrıldı`)
  }

  /** Ses paketleri: düşük bit hızı, yüksek ağ önceliği. Görüntü geldiğinde önce o düşer. */
  private async tuneAudioSenders(peerId: string) {
    const pc = this.room.getPeers()[peerId]
    if (!pc) return
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'audio') continue
      const params = sender.getParameters()
      if (!params.encodings?.length) params.encodings = [{}]
      for (const enc of params.encodings) {
        enc.maxBitrate = AUDIO_MAX_BITRATE
        enc.priority = 'high'
        enc.networkPriority = 'high'
      }
      await sender.setParameters(params).catch(() => {})
    }
  }

  private helloMsg(): Msg {
    return {
      t: 'hello',
      v: PROTOCOL_VERSION,
      name: this.state.name,
      device: deviceKind,
      joinedAt: this.joinedAt,
      muted: this.state.muted,
      deafened: this.state.deafened,
    }
  }

  private onMessage(peerId: string, raw: unknown) {
    const msg = parse(raw)
    const peer = this.state.peers[peerId]
    if (!msg || !peer) return
    switch (msg.t) {
      case 'hello': {
        const volume = this.volumes[msg.name] ?? 100
        this.patchPeer(peerId, {
          known: true,
          name: msg.name,
          device: msg.device,
          joinedAt: msg.joinedAt,
          muted: msg.muted,
          deafened: msg.deafened,
          volume,
        })
        this.audio.setVolume(peerId, volume)
        if (!peer.known) this.pushSystem(`${msg.name} katıldı`)
        this.enforceCapacity()
        break
      }
      case 'state':
        this.patchPeer(peerId, { muted: msg.muted, deafened: msg.deafened })
        break
      case 'chat':
        if (!this.allowChat(peerId)) return
        this.pushChat({ id: msg.id, kind: 'message', fromId: peerId, name: peer.name, text: msg.text, ts: Date.now() })
        break
    }
  }

  /**
   * Oda doluluk kuralı: herkes aynı listeyi (katılma zamanı, sonra id) sıralar.
   * İlk MAX_ROOM_SIZE kişinin dışında kalan kendiliğinden ayrılır. Sunucu gerekmez.
   */
  private enforceCapacity() {
    const members = [
      { id: selfId, joinedAt: this.joinedAt },
      ...Object.values(this.state.peers)
        .filter((p) => p.known)
        .map((p) => ({ id: p.id, joinedAt: p.joinedAt })),
    ]
    if (members.length <= MAX_ROOM_SIZE) return
    members.sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1))
    const myIndex = members.findIndex((m) => m.id === selfId)
    if (myIndex >= MAX_ROOM_SIZE) void this.leave('full')
  }

  private measurePings() {
    for (const id of Object.keys(this.state.peers)) this.pingPeer(id)
  }

  private pingPeer(id: string) {
    if (this.disposed || !this.state.peers[id]) return
    this.room
      .ping(id)
      .then((ms) => this.patchPeer(id, { ping: Math.round(ms) }))
      .catch(() => {})
  }

  // ---------- mikrofon ----------

  private applyMicEnabled() {
    const s = this.state
    const on = !s.muted && !s.deafened && (s.voiceMode === 'vad' || s.pttDown)
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = on
  }

  private broadcastState() {
    this.send({ t: 'state', muted: this.state.muted, deafened: this.state.deafened })
  }

  toggleMute() {
    // Sağırken mikrofonu açmak, sağırlığı da kaldırır (Discord'daki gibi).
    if (this.state.deafened) {
      this.set({ deafened: false, muted: false })
      this.audio.setDeafened(false)
    } else {
      this.set({ muted: !this.state.muted })
    }
    this.applyMicEnabled()
    this.broadcastState()
  }

  toggleDeafen() {
    const deafened = !this.state.deafened
    this.set({ deafened })
    this.audio.setDeafened(deafened)
    this.applyMicEnabled()
    this.broadcastState()
  }

  setVoiceMode(voiceMode: VoiceMode) {
    this.set({ voiceMode, pttDown: false })
    this.applyMicEnabled()
  }

  setPtt(down: boolean) {
    if (this.state.pttDown === down) return
    this.set({ pttDown: down })
    this.applyMicEnabled()
  }

  async setMicDevice(deviceId: string) {
    let next: MediaStream
    try {
      next = await getMicrophone(deviceId || undefined)
    } catch (err) {
      this.setNotice(micErrorMessage(err))
      return
    }
    const newTrack = next.getAudioTracks()[0]
    if (this.mic) {
      const old = this.mic.getAudioTracks()[0]
      await Promise.all(this.room.replaceTrack(old, newTrack)).catch(() => {})
      this.mic.removeTrack(old)
      this.mic.addTrack(newTrack)
      old.stop()
    } else {
      // Mikrofonsuz katılmıştı; şimdi herkese gönder.
      this.mic = next
      await Promise.all(this.room.addStream(next)).catch(() => {})
      for (const id of Object.keys(this.state.peers)) void this.tuneAudioSenders(id)
    }
    this.audio.setLocal(this.mic)
    this.set({ micDeviceId: newTrack.getSettings().deviceId ?? deviceId, micError: null, notice: null })
    this.applyMicEnabled()
  }

  // ---------- ses seviyesi ----------

  setVolume(peerId: string, pct: number) {
    const peer = this.state.peers[peerId]
    if (!peer) return
    this.patchPeer(peerId, { volume: pct })
    this.audio.setVolume(peerId, pct)
    if (peer.known) {
      this.volumes = { ...this.volumes, [peer.name]: pct }
      saveVolumes(this.volumes)
    }
  }

  // ---------- sohbet ----------

  private allowChat(id: string) {
    const now = Date.now()
    const recent = (this.chatRate.get(id) ?? []).filter((t) => now - t < CHAT_RATE_WINDOW_MS)
    if (recent.length >= CHAT_RATE_MAX) return false
    recent.push(now)
    this.chatRate.set(id, recent)
    return true
  }

  /** false dönerse mesaj gönderilmedi (çok hızlı yazıldı). */
  sendChat(text: string): boolean {
    const clean = text.trim().slice(0, CHAT_MAX_LENGTH)
    if (!clean) return true
    if (!this.allowChat(selfId)) return false
    const msg = { t: 'chat' as const, id: crypto.randomUUID(), text: clean, ts: Date.now() }
    this.send(msg)
    this.pushChat({ id: msg.id, kind: 'message', fromId: selfId, name: this.state.name, text: clean, ts: msg.ts })
    return true
  }

  private pushChat(entry: ChatEntry) {
    this.set({ chat: [...this.state.chat, entry].slice(-CHAT_HISTORY_LIMIT) })
  }

  private pushSystem(text: string) {
    this.pushChat({ id: crypto.randomUUID(), kind: 'system', fromId: '', name: '', text, ts: Date.now() })
  }

  // ---------- telefon: ekran açık kalsın, arka plandan dönünce sesi toparla ----------

  private onVisibility = () => {
    if (document.visibilityState === 'visible') {
      this.audio.resume()
      void this.acquireWakeLock()
    } else if (this.state.pttDown) {
      // Sekme arka plana giderken tuş bırakılmış sayılır, yoksa mikrofon açık kalır.
      this.setPtt(false)
    }
  }

  private async acquireWakeLock() {
    if (!('wakeLock' in navigator) || this.disposed) return
    try {
      this.wakeLock = await navigator.wakeLock.request('screen')
    } catch {
      /* desteklenmiyor veya reddedildi */
    }
  }

  // ---------- çıkış ----------

  async leave(reason: 'left' | 'full' = 'left') {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.pingTimer)
    document.removeEventListener('visibilitychange', this.onVisibility)
    void this.wakeLock?.release().catch(() => {})
    for (const t of this.mic?.getTracks() ?? []) t.stop()
    this.audio.close()
    await this.room.leave().catch(() => {})
    this.set({ status: reason })
  }
}
