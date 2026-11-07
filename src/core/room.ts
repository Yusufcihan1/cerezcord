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
import { Ears } from './ears'
import { ANNOUNCE_INTERVAL_MS, LobbyAnnouncer } from './lobby'
import { BOTS_MAX, PROTOCOL_VERSION, normalizeRoomName, parse, parseBotAudioMeta, type Msg } from './protocol'
import { sfxInfo, type SfxId } from './sfx'
import { loadValue, loadVolumes, save, saveVolumes, type Settings, type VoiceMode } from './storage'
import { VoiceChanger, type VoiceEffect } from './voicefx'
import {
  BotCrew,
  MAX_BOTS,
  bridgeStatus,
  bridgeSpeak,
  botVoice,
  hushFallback,
  speakFallback,
  type BotInfo,
  type BotVoiceId,
} from './bots'

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
  kind: 'message' | 'system' | 'bot'
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
  /** Odadaki troll botlar (benimkiler ve başkalarınınki), bot id -> bilgi */
  bots: Record<string, RoomBot>
  /** Botların sözlerini sesli dinle */
  botVoice: boolean
  /** Şu an sesi çalan bot */
  botTalking: string | null
  /** Bu bilgisayardaki EMA ses köprüsü: bilinmiyor / açık / kapalı */
  bridge: 'unknown' | 'on' | 'off'
  /** Köprü konuşmayı yazıya çevirebiliyor; botlarım odadaki sesleri duyuyor */
  bridgeStt: boolean
  botEars: boolean
}

export type RoomBot = { id: string; name: string; voice: string; host: string }

const BOT_AUDIO_MAX_BYTES = 2_000_000

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
  private crew: BotCrew | null = null
  /** Botlar sesleri dinliyor (yalnız çağıranda) */
  private ears: Ears | null = null
  /** Başkalarının botları dinliyor mu (bildirimi bir kez göstermek için) */
  private earsHosts = new Set<string>()
  private botAudioAction: MessageAction<Blob>
  private botRate = new Map<string, number[]>()
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
      bots: {},
      botVoice: loadValue('botVoice', true),
      botTalking: null,
      bridge: 'unknown',
      bridgeStt: false,
      botEars: false,
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

    this.botAudioAction = this.room.makeAction<Blob>('botses', {
      onReceive: ({ peerId, byteLength, metadata }) => {
        const meta = parseBotAudioMeta(metadata)
        const bot = meta && this.state.bots[meta.bot]
        return !!bot && bot.host === peerId && byteLength <= BOT_AUDIO_MAX_BYTES && this.allowBot(peerId)
      },
      onMessage: (data, { peerId, metadata }) => {
        const meta = parseBotAudioMeta(metadata)
        const bot = meta && this.state.bots[meta.bot]
        if (!meta || !bot || bot.host !== peerId || this.disposed) return
        this.crew?.hear({ name: bot.name, text: meta.text, bot: true })
        // Trystero ikili veriyi Blob değil ArrayBuffer/Uint8Array olarak verir.
        void new Blob([data as BlobPart])
          .arrayBuffer()
          .then((buf) => this.pushBot(bot, meta.id, meta.text, buf))
      },
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
    this.ears?.forget(id)
    this.earsHosts.delete(id)
    this.chatRate.delete(id)
    this.fileRate.delete(id)
    this.sfxRate.delete(id)
    this.botRate.delete(id)
    const bots = Object.fromEntries(Object.entries(this.state.bots).filter(([, b]) => b.host !== id))
    if (Object.keys(bots).length !== Object.keys(this.state.bots).length) this.set({ bots })
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
        if (!peer.known) {
          this.pushSystem(`${msg.name} katıldı`)
          this.crew?.joined(msg.name)
          if (this.crew?.size) this.broadcastBots(peerId)
        }
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
        this.crew?.hear({ name: peer.name, text: msg.text })
        break
      case 'bot': {
        const bot = this.state.bots[msg.bot]
        if (!peer.known || !bot || bot.host !== peerId || !this.allowBot(peerId)) return
        this.crew?.hear({ name: bot.name, text: msg.text, bot: true })
        this.pushBot(bot, msg.id, msg.text, null)
        break
      }
      case 'bots': {
        if (!peer.known) return
        const mine = Object.values(this.state.bots).filter((b) => b.host === peerId)
        const bots: Record<string, RoomBot> = {}
        for (const [id, b] of Object.entries(this.state.bots)) if (b.host !== peerId) bots[id] = b
        for (const b of msg.list) {
          if (bots[b.id]) continue
          bots[b.id] = { ...b, host: peerId }
          if (!mine.some((m) => m.id === b.id)) this.pushSystem(`🤖 ${b.name} odaya daldı (${peer.name} çağırdı)`)
        }
        for (const m of mine) if (!bots[m.id]) this.pushSystem(`🤖 ${m.name} gitti`)
        if (msg.ears && !this.earsHosts.has(peerId)) {
          this.earsHosts.add(peerId)
          this.pushSystem(`🎙️ ${peer.name} çağırdığı botlar konuşulanları duyuyor (sesler ${peer.name} bilgisayarında yazıya çevriliyor)`)
        } else if (!msg.ears) this.earsHosts.delete(peerId)
        this.set({ bots })
        break
      }
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

  // ---------- Troll botlar ----------

  /** Bot çağırır; hata metni döner, null ise bot geldi. API anahtarı yalnız bu bilgisayarda kalır. */
  summonBot(apiKey: string, name: string, voice: BotVoiceId): string | null {
    const key = apiKey.trim()
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 24)
    if (!key) return 'Önce Claude API anahtarını yaz.'
    if (!clean) return 'Bota bir ad ver.'
    if ((this.crew?.size ?? 0) >= MAX_BOTS) return `En fazla ${MAX_BOTS} bot çağırabilirsin.`
    const taken = [
      this.state.name,
      ...Object.values(this.state.peers).map((p) => p.name),
      ...Object.values(this.state.bots).map((b) => b.name),
    ]
    if (taken.some((n) => n.toLocaleLowerCase('tr') === clean.toLocaleLowerCase('tr'))) return 'Bu ad odada zaten var.'
    save('botKey', key)
    if (!this.crew) {
      this.crew = new BotCrew(
        key,
        () => [...this.members().map((m) => m.name), ...Object.values(this.state.bots).map((b) => `${b.name} (yabancı)`)],
        (bot, text) => this.botSay(bot, text),
        (err) => {
          this.setNotice(err.message)
          if (err.fatal) this.dismissAllBots()
        },
      )
    } else this.crew.setKey(key)
    void this.checkBridge()
    const info: BotInfo = { id: crypto.randomUUID(), name: clean, voice }
    this.set({ bots: { ...this.state.bots, [info.id]: { ...info, host: selfId } } })
    this.crew.add(info)
    this.broadcastBots()
    this.pushSystem(`🤖 ${clean} odaya daldı (${this.state.name} çağırdı)`)
    return null
  }

  dismissBot(id: string) {
    const bot = this.state.bots[id]
    if (!bot || bot.host !== selfId) return
    this.crew?.remove(id)
    const bots = { ...this.state.bots }
    delete bots[id]
    this.set({ bots })
    this.broadcastBots()
    this.pushSystem(`🤖 ${bot.name} gitti`)
    if (this.crew && !this.crew.size) {
      this.crew = null
      this.stopEars()
    }
  }

  dismissAllBots() {
    for (const b of Object.values(this.state.bots)) if (b.host === selfId) this.dismissBot(b.id)
    this.crew?.stop()
    this.crew = null
    this.stopEars()
  }

  pokeBot(id: string) {
    this.crew?.poke(id)
  }

  savedBotKey() {
    return loadValue('botKey', '')
  }

  forgetBotKey() {
    save('botKey', '')
  }

  setBotVoice(on: boolean) {
    this.set({ botVoice: on })
    save('botVoice', on)
    this.audio.setBotVolume(on ? 100 : 0)
    if (!on) hushFallback()
  }

  async checkBridge() {
    const st = await bridgeStatus()
    this.set({ bridge: st ? 'on' : 'off', bridgeStt: !!st?.stt })
    if (st?.stt && this.crew?.size && !this.ears && !this.disposed) this.startEars()
    return !!st
  }

  /** Botlar odadaki konuşmaları duysun: her ses köprüde (Whisper) yazıya çevrilir. */
  private startEars() {
    this.ears = new Ears((id, text) => this.heardVoice(id, text))
    this.audio.setEars(this.ears.feed)
    this.set({ botEars: true })
    this.broadcastBots()
    this.pushSystem('🎙️ Botlar artık konuşulanları duyuyor (sesler senin bilgisayarında yazıya çevriliyor)')
  }

  private stopEars() {
    if (!this.ears) return
    this.audio.setEars(null)
    this.ears.stop()
    this.ears = null
    this.set({ botEars: false })
  }

  private heardVoice(id: string, text: string) {
    if (!this.crew?.size) return
    const name = id === LOCAL ? this.state.name : this.state.peers[id]?.known ? this.state.peers[id].name : null
    if (!name || this.isBotEcho(text)) return
    this.crew.hear({ name, text })
  }

  /** Hoparlörden mikrofona kaçan bot sesi: son bot sözleriyle kelimelerin çoğu aynıysa yok say. */
  private isBotEcho(text: string) {
    const words = (s: string) => new Set(s.toLocaleLowerCase('tr').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2))
    const heard = words(text)
    if (!heard.size) return true
    const since = Date.now() - 30_000
    return this.state.chat.some((c) => {
      if (c.kind !== 'bot' || c.ts < since) return false
      const said = words(c.text)
      let same = 0
      for (const w of heard) if (said.has(w)) same++
      return same / heard.size >= 0.6
    })
  }

  private broadcastBots(target?: string) {
    const list = Object.values(this.state.bots)
      .filter((b) => b.host === selfId)
      .slice(0, BOTS_MAX)
      .map(({ id, name, voice }) => ({ id, name, voice }))
    this.send({ t: 'bots', list, ears: !!this.ears && list.length > 0 }, target)
  }

  /** Botumun sözü: köprüde seslendir, herkese gönder, burada da çal. */
  private async botSay(info: BotInfo, text: string) {
    if (!this.state.bots[info.id]) return
    const id = crypto.randomUUID()
    const wav = await bridgeSpeak(text, botVoice(info.voice).pitch)
    const bot = this.state.bots[info.id]
    if (!bot || this.disposed) return
    if (wav) {
      if (this.state.bridge !== 'on') this.set({ bridge: 'on' })
      const blob = new Blob([wav], { type: 'audio/wav' })
      for (const p of Object.values(this.state.peers)) {
        if (!p.known) continue
        void this.botAudioAction.send(blob, { target: p.id, metadata: { id, bot: info.id, text } }).catch(() => {})
      }
    } else {
      if (this.state.bridge !== 'off') {
        this.set({ bridge: 'off' })
        this.setNotice('Bot sesi köprüsü kapalı; botlar tarayıcı sesiyle konuşuyor. bot-ses klasöründeki Bot Sesi Başlat dosyasını aç.')
      }
      this.send({ t: 'bot', id, bot: info.id, text })
    }
    this.pushBot(bot, id, text, wav)
  }

  /** Bot sözünü sohbete ekler ve çalar (ses yoksa tarayıcı sesiyle okur). */
  private pushBot(bot: RoomBot, id: string, text: string, wav: ArrayBuffer | null) {
    if (this.state.chat.some((c) => c.id === id)) return
    this.pushChat({ id, kind: 'bot', fromId: bot.host, name: bot.name, text, ts: Date.now() })
    if (!this.state.botVoice) return
    if (wav) {
      this.audio.playClip(
        wav,
        () => this.set({ botTalking: bot.id }),
        () => {
          if (this.state.botTalking === bot.id) this.set({ botTalking: null })
        },
      )
    } else if (!this.state.deafened) speakFallback(text, botVoice(bot.voice).pitch)
  }

  /** Bir kişinin botları toplam en fazla dakikada otuz söz söyler. */
  private allowBot(id: string) {
    const now = Date.now()
    const recent = (this.botRate.get(id) ?? []).filter((t) => now - t < 60_000)
    if (recent.length >= 30) return false
    recent.push(now)
    this.botRate.set(id, recent)
    return true
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
    if (deafened) hushFallback()
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
    this.crew?.hear({ name: this.state.name, text: clean })
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
    this.crew?.stop()
    this.crew = null
    this.stopEars()
    this.audio.stopClips()
    hushFallback()
    this.fx.close()
    this.audio.close()
    for (const c of this.state.chat) if (c.file?.url) URL.revokeObjectURL(c.file.url)
    await this.room.leave().catch(() => {})
    this.set({ status: reason })
  }
}
