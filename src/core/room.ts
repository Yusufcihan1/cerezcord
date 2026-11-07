import { joinRoom, selfId, type JsonValue, type MessageAction, type Room } from 'trystero/nostr'
import { AudioEngine, LOCAL } from './audio'
import { deviceKind, type DeviceKind } from './device'
import {
  APP_ID,
  PUBLIC_APP_ID,
  AUDIO_MAX_BITRATE,
  CHAT_HISTORY_LIMIT,
  CHAT_MAX_LENGTH,
  CHAT_RATE_MAX,
  CHAT_RATE_WINDOW_MS,
  FILE_INCOMING_MAX,
  FILE_MAX_BYTES,
  FILE_NAME_MAX_LENGTH,
  FILE_RATE_MAX,
  FILE_RATE_WINDOW_MS,
  MAX_ROOM_SIZE,
  PING_INTERVAL_MS,
  SFX_RATE_MAX,
  SFX_RATE_WINDOW_MS,
} from './limits'
import { getMicrophone, micErrorMessage } from './media'
import { ANNOUNCE_INTERVAL_MS, LobbyAnnouncer } from './lobby'
import { PROTOCOL_VERSION, normalizeRoomName, parse, type Msg } from './protocol'
import { sfxInfo, type SfxId } from './sfx'
import { loadValue, loadVolumes, save, saveVolumes, type Settings, type VoiceMode } from './storage'
import { VoiceChanger, type VoiceEffect } from './voicefx'

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

export type ChatFile = {
  name: string
  size: number
  /** Önizleme yalnız güvenli resim türlerinde yapılır */
  isImage: boolean
  status: 'sending' | 'receiving' | 'done' | 'failed'
  /** 0..1 */
  progress: number
  /** Tamamlanınca: indirme/önizleme adresi (bellekte, odadan çıkınca silinir) */
  url: string | null
}

export type ChatEntry = {
  id: string
  kind: 'message' | 'system'
  fromId: string
  name: string
  text: string
  ts: number
  file?: ChatFile
}

/** SVG gibi betik taşıyabilen türler önizlenmez, yalnız indirilir. */
const PREVIEW_MIME = /^image\/(png|jpeg|gif|webp|avif)$/

const cleanFileName = (name: string) =>
  // oxlint-disable-next-line no-control-regex
  name.replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(-FILE_NAME_MAX_LENGTH) || 'dosya'

type FileMeta = { id: string; name: string; size: number; mime: string }

function parseFileMeta(raw: unknown): FileMeta | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  if (typeof m.id !== 'string' || typeof m.name !== 'string' || typeof m.size !== 'number' || typeof m.mime !== 'string')
    return null
  return { id: m.id.slice(0, 40), name: cleanFileName(m.name), size: m.size, mime: m.mime.slice(0, 100) }
}

export type RoomStatus = 'live' | 'full' | 'left'

export type RoomState = {
  status: RoomStatus
  roomName: string
  /** Şifresiz, oda adını bilen herkesin girebildiği oda */
  isPublic: boolean
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
  /** Ses değiştirici */
  voiceEffect: VoiceEffect
  /** Kendi (değişmiş) sesini duy */
  monitor: boolean
  /** Başkalarının efekt panosu seslerini çalma */
  sfxMuted: boolean
}

export type JoinOptions = {
  roomName: string
  /** Açık odada boş kalır */
  password: string
  isPublic: boolean
  name: string
  settings: Settings
}

export const SELF = LOCAL

/**
 * Bir sesli odanın tüm yaşam döngüsü: P2P bağlantılar, mikrofon, protokol, sınırlar.
 * React tarafı yalnızca getState/subscribe ve eylem metodlarını kullanır.
 */
export class CerezRoom {
  private room: Room
  private send: (msg: Msg, target?: string) => void
  private fileAction: MessageAction<Blob>
  private fileRate = new Map<string, number[]>()
  /** Süren gelen aktarımlar: dosya (sohbet kaydı) id'si -> gönderen */
  private incomingFiles = new Map<string, string>()
  /** Giden dosyalar sırayla gider; biri bitmeden sıradaki başlamaz. */
  private sendQueue: Promise<void> = Promise.resolve()
  private audio: AudioEngine
  private mic: MediaStream | null = null
  private fx: VoiceChanger
  /** Karşıya giden ses izi: efekt kapalıyken mikrofonun kendisi, açıkken işlenmiş ses */
  private sentTrack: MediaStreamTrack | null = null
  private fxBusy: Promise<void> = Promise.resolve()
  private sfxRate = new Map<string, number[]>()
  private state: RoomState
  private listeners = new Set<() => void>()
  private joinedAt = Date.now()
  private volumes = loadVolumes()
  private chatRate = new Map<string, number[]>()
  private pingTimer: number
  private wakeLock: WakeLockSentinel | null = null
  /** Yalnız açık odada: vitrine ilan (herkeste var, doluluğu en eski kişi ilan eder) */
  private lobby: LobbyAnnouncer | null = null
  private announceTimer = 0
  private announceDebounce = 0
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
      isPublic: opts.isPublic,
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
      voiceEffect: 'off',
      monitor: false,
      sfxMuted: loadValue('sfxMuted', false),
    }
    this.fx = new VoiceChanger(audio.ctx)
    this.fx.setSource(mic)
    this.sentTrack = mic?.getAudioTracks()[0] ?? null

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
        appId: opts.isPublic ? PUBLIC_APP_ID : APP_ID,
        // Açık odada sinyal mesajları şifrelenmez; ses yine de WebRTC ile (DTLS-SRTP) şifreli gider.
        password: opts.isPublic ? undefined : opts.password,
        turnConfig,
        relayConfig: relayUrls?.length ? { urls: relayUrls, redundancy: relayUrls.length } : undefined,
        // Sınırın üstünde veri belleğe hiç alınmaz.
        maxReceiveBytes: FILE_MAX_BYTES + 64 * 1024,
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

    this.fileAction = this.room.makeAction<Blob>('file', {
      onReceive: (ctx) => this.acceptFile(ctx.peerId, ctx.byteLength, ctx.metadata),
      onReceiveProgress: (p, { peerId, metadata }) => {
        const id = parseFileMeta(metadata)?.id
        if (id && this.incomingFiles.get(id) === peerId) this.patchFile(id, { progress: p })
      },
      onMessage: (data, { peerId, metadata }) => this.onFile(peerId, data, metadata),
    })

    this.room.onPeerJoin = (id) => this.onPeerJoin(id)
    this.room.onPeerLeave = (id) => this.onPeerLeave(id)
    this.room.onPeerStream = (stream, id) => {
      this.audio.addRemote(id, stream, this.state.peers[id]?.volume ?? 100)
    }

    if (mic) this.audio.setLocal(mic)
    this.applyMicEnabled()
    this.pingTimer = window.setInterval(() => this.measurePings(), PING_INTERVAL_MS)
    if (opts.isPublic) {
      this.lobby = new LobbyAnnouncer(this.state.roomName)
      this.announceTimer = window.setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS)
      this.scheduleAnnounce()
    }
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
    const out = this.sendStream()
    if (out) {
      void Promise.all(this.room.addStream(out, { target: id }))
        .then(() => this.tuneAudioSenders(id))
        .catch(() => {})
    }
  }

  private onPeerLeave(id: string) {
    const peer = this.state.peers[id]
    this.audio.remove(id)
    this.chatRate.delete(id)
    this.fileRate.delete(id)
    this.sfxRate.delete(id)
    for (const [fileId, from] of this.incomingFiles) {
      if (from !== id) continue
      this.incomingFiles.delete(fileId)
      this.patchFile(fileId, { status: 'failed' })
    }
    if (!peer) return
    const peers = { ...this.state.peers }
    delete peers[id]
    this.set({ peers })
    if (peer.known) this.pushSystem(`${peer.name} ayrıldı`)
    this.scheduleAnnounce()
  }

  // ---------- açık oda vitrini ----------

  /** Odadakiler katılma sırasıyla (yalnız adı bilinenler). Doluluk kuralı da bu sırayı kullanır. */
  private members() {
    return [
      { id: selfId, joinedAt: this.joinedAt, name: this.state.name },
      ...Object.values(this.state.peers)
        .filter((p) => p.known)
        .map((p) => ({ id: p.id, joinedAt: p.joinedAt, name: p.name })),
    ].sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1))
  }

  /** Katılma/ayrılma dalgalarını tek ilanda toplar. */
  private scheduleAnnounce() {
    if (!this.lobby) return
    clearTimeout(this.announceDebounce)
    this.announceDebounce = window.setTimeout(() => this.announce(), 1500)
  }

  /** Aynı ilanı herkes atmasın: yalnız odadaki en eski kişi ilan eder. */
  private announce() {
    if (!this.lobby || this.disposed) return
    const members = this.members().slice(0, MAX_ROOM_SIZE)
    if (members[0].id !== selfId) return
    void this.lobby.announce(members.length, members.map((m) => m.name)).catch(() => {})
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
        this.scheduleAnnounce()
        break
      }
      case 'state':
        this.patchPeer(peerId, { muted: msg.muted, deafened: msg.deafened })
        break
      case 'chat':
        if (!this.allowChat(peerId)) return
        this.pushChat({ id: msg.id, kind: 'message', fromId: peerId, name: peer.name, text: msg.text, ts: Date.now() })
        break
      case 'sfx':
        if (!peer.known || !this.allowSfx(peerId)) return
        if (!this.state.sfxMuted) this.audio.playSfx(msg.id)
        this.pushSfxLine(peer.name, msg.id)
        break
    }
  }

  /**
   * Oda doluluk kuralı: herkes aynı listeyi (katılma zamanı, sonra id) sıralar.
   * İlk MAX_ROOM_SIZE kişinin dışında kalan kendiliğinden ayrılır. Sunucu gerekmez.
   */
  private enforceCapacity() {
    const members = this.members()
    if (members.length <= MAX_ROOM_SIZE) return
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
    this.fx.track.enabled = on
  }

  /** Yeni gelen kişiye gönderilecek akış */
  private sendStream() {
    if (!this.sentTrack) return null
    return this.sentTrack === this.fx.track ? this.fx.stream : this.mic
  }

  /** Gönderilen izi değiştirir (mikrofon <-> işlenmiş ses); bağlantı yeniden kurulmaz. */
  private async swapSentTrack(next: MediaStreamTrack) {
    const prev = this.sentTrack
    if (!prev || prev === next) return
    this.sentTrack = next
    await Promise.all(this.room.replaceTrack(prev, next)).catch(() => {})
  }

  // ---------- ses değiştirici ----------

  setVoiceEffect(effect: VoiceEffect) {
    this.set({ voiceEffect: effect })
    // Hızlı tıklamalarda değişiklikler sırayla uygulanır.
    this.fxBusy = this.fxBusy.then(async () => {
      if (this.disposed || this.state.voiceEffect !== effect) return
      try {
        await this.fx.setEffect(effect)
      } catch {
        this.set({ voiceEffect: 'off' })
        this.setNotice('Ses değiştirici bu tarayıcıda çalışmadı.')
        await this.fx.setEffect('off').catch(() => {})
        effect = 'off'
      }
      const raw = this.mic?.getAudioTracks()[0]
      // Normal seste mikrofon doğrudan gider (ek gecikme yok, telefon arka plana alınınca da çalışır).
      // Kendini dinlerken de işlenmiş ses lazım; o zaman da karşıya aynısı gider.
      if (raw) await this.swapSentTrack(effect === 'off' && !this.state.monitor ? raw : this.fx.track)
    })
  }

  setMonitor(on: boolean) {
    this.set({ monitor: on })
    this.fx.setMonitor(on)
    this.setVoiceEffect(this.state.voiceEffect)
  }

  // ---------- efekt panosu ----------

  private allowSfx(id: string) {
    const now = Date.now()
    const recent = (this.sfxRate.get(id) ?? []).filter((t) => now - t < SFX_RATE_WINDOW_MS)
    if (recent.length >= SFX_RATE_MAX) return false
    recent.push(now)
    this.sfxRate.set(id, recent)
    return true
  }

  /** false dönerse çok sık basıldı. */
  playSfx(id: SfxId): boolean {
    if (!this.allowSfx(selfId)) return false
    this.send({ t: 'sfx', id })
    this.audio.playSfx(id)
    this.pushSfxLine(this.state.name, id)
    return true
  }

  setSfxMuted(sfxMuted: boolean) {
    this.set({ sfxMuted })
    save('sfxMuted', sfxMuted)
  }

  private pushSfxLine(name: string, id: SfxId) {
    const s = sfxInfo(id)
    this.pushSystem(`${name}: ${s.emoji} ${s.label}`)
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
      // Efekt açıksa karşıya işlenmiş ses gidiyor; yalnız işleyicinin girişi değişir.
      if (this.sentTrack === old) await this.swapSentTrack(newTrack)
      this.mic.removeTrack(old)
      this.mic.addTrack(newTrack)
      old.stop()
      this.fx.setSource(this.mic)
    } else {
      // Mikrofonsuz katılmıştı; şimdi herkese gönder.
      this.mic = next
      this.fx.setSource(next)
      const useFx = this.state.voiceEffect !== 'off' || this.state.monitor
      this.sentTrack = useFx ? this.fx.track : newTrack
      await Promise.all(this.room.addStream(this.sendStream()!)).catch(() => {})
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
    const chat = [...this.state.chat, entry]
    // Listeden düşen dosyaların belleği de bırakılır.
    for (const old of chat.slice(0, -CHAT_HISTORY_LIMIT)) if (old.file?.url) URL.revokeObjectURL(old.file.url)
    this.set({ chat: chat.slice(-CHAT_HISTORY_LIMIT) })
  }

  // ---------- dosya ----------

  private patchFile(id: string, patch: Partial<ChatFile>) {
    this.set({
      chat: this.state.chat.map((c) => (c.id === id && c.file ? { ...c, file: { ...c.file, ...patch } } : c)),
    })
  }

  private allowFile(id: string) {
    const now = Date.now()
    const recent = (this.fileRate.get(id) ?? []).filter((t) => now - t < FILE_RATE_WINDOW_MS)
    if (recent.length >= FILE_RATE_MAX) return false
    recent.push(now)
    this.fileRate.set(id, recent)
    return true
  }

  /** Aktarım başlamadan önce: kişi, boyut ve sıklık kontrolü. false dönerse veri hiç gelmez. */
  private acceptFile(peerId: string, byteLength: number, rawMeta: unknown) {
    const peer = this.state.peers[peerId]
    const meta = parseFileMeta(rawMeta)
    if (!peer?.known || !meta || this.disposed) return false
    const active = [...this.incomingFiles.values()].filter((from) => from === peerId).length
    if (byteLength > FILE_MAX_BYTES || active >= FILE_INCOMING_MAX || this.incomingFiles.has(meta.id)) return false
    if (this.state.chat.some((c) => c.id === meta.id) || !this.allowFile(peerId)) return false
    this.incomingFiles.set(meta.id, peerId)
    this.pushChat({
      id: meta.id,
      kind: 'message',
      fromId: peerId,
      name: peer.name,
      text: '',
      ts: Date.now(),
      file: {
        name: meta.name,
        size: byteLength,
        isImage: PREVIEW_MIME.test(meta.mime),
        status: 'receiving',
        progress: 0,
        url: null,
      },
    })
    return true
  }

  private onFile(peerId: string, data: Blob, rawMeta: unknown) {
    const meta = parseFileMeta(rawMeta)
    if (!meta || this.incomingFiles.get(meta.id) !== peerId || this.disposed) return
    const id = meta.id
    this.incomingFiles.delete(id)
    // Tür yalnız önizleme için kullanılır; diğer her şey ikili dosya olarak iner.
    const type = PREVIEW_MIME.test(meta.mime) ? meta.mime : 'application/octet-stream'
    const blob = new Blob([data as BlobPart], { type })
    this.patchFile(id, { status: 'done', progress: 1, url: URL.createObjectURL(blob) })
  }

  /** Hata metni döner; null ise gönderim başladı. */
  sendFile(file: File): string | null {
    if (file.size === 0) return 'Boş dosya gönderilemez.'
    if (file.size > FILE_MAX_BYTES) return `Dosya çok büyük: en fazla ${Math.round(FILE_MAX_BYTES / 1024 ** 2)} MB.`
    const targets = Object.values(this.state.peers)
      .filter((p) => p.known)
      .map((p) => p.id)
    if (targets.length === 0) return 'Odada senden başka kimse yok.'
    if (!this.allowFile(selfId)) return 'Çok sık dosya gönderiyorsun, biraz bekle.'

    const id = crypto.randomUUID()
    const meta: FileMeta = { id, name: cleanFileName(file.name), size: file.size, mime: file.type }
    const isImage = PREVIEW_MIME.test(file.type)
    this.pushChat({
      id,
      kind: 'message',
      fromId: selfId,
      name: this.state.name,
      text: '',
      ts: Date.now(),
      file: {
        name: meta.name,
        size: file.size,
        isImage,
        status: 'sending',
        progress: 0,
        url: URL.createObjectURL(file),
      },
    })

    this.sendQueue = this.sendQueue.then(async () => {
      let ok = 0
      // Kişilere sırayla: aynı anda herkese yüklemek, gönderenin sesini boğar.
      for (const [i, target] of targets.entries()) {
        if (this.disposed) return
        if (!this.state.peers[target]) continue
        try {
          await this.fileAction.send(file, {
            target,
            metadata: meta,
            onProgress: (p) => this.patchFile(id, { progress: (i + p) / targets.length }),
          })
          ok++
        } catch {
          /* bu kişi reddetti ya da ayrıldı; sıradakine geç */
        }
      }
      this.patchFile(id, { status: ok > 0 ? 'done' : 'failed', progress: 1 })
    })
    return null
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
    clearInterval(this.announceTimer)
    clearTimeout(this.announceDebounce)
    if (this.lobby) {
      // Son kişi çıkıyorsa oda vitrinden hemen kalksın; değilse kalanlardan en eskisi ilanı sürdürür.
      // Sayfa kapanırken de çalışması için bu blok, ilk await'ten önce kalmalı.
      if (reason === 'left' && !Object.values(this.state.peers).some((p) => p.known)) {
        this.lobby.leaveAsLast()
      } else {
        this.lobby.close()
      }
    }
    document.removeEventListener('visibilitychange', this.onVisibility)
    void this.wakeLock?.release().catch(() => {})
    for (const t of this.mic?.getTracks() ?? []) t.stop()
    this.fx.close()
    this.audio.close()
    for (const c of this.state.chat) if (c.file?.url) URL.revokeObjectURL(c.file.url)
    await this.room.leave().catch(() => {})
    this.set({ status: reason })
  }
}
