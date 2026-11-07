import { playSfx, type SfxId } from './sfx'
import { SPEAKING_HOLD_MS, SPEAKING_POLL_MS, SPEAKING_THRESHOLD } from './limits'

type Channel = {
  /** Chrome, WebAudio'ya bağlanan uzak WebRTC sesini bir <audio> elemanına da bağlı değilse çalmıyor. */
  keepAlive: HTMLAudioElement
  source: MediaStreamAudioSourceNode
  gain?: GainNode
  analyser: AnalyserNode
  buf: Float32Array<ArrayBuffer>
  lastLoud: number
  /** Botlar için ham ses dinleyicisi (yalnız botları çağıranda) */
  tap?: ScriptProcessorNode
}

export type EarFn = (id: string, frame: Float32Array, sampleRate: number) => void

export const LOCAL = '__local__'

/**
 * Tüm ses çalma ve konuşma algılama işi. Kişi başı ses seviyesi için GainNode kullanıyoruz,
 * çünkü iOS'ta <audio>.volume salt okunur ve %100 üstüne zaten çıkılamıyor.
 */
export class AudioEngine {
  readonly ctx: AudioContext
  private master: GainNode
  private sfxOut: GainNode
  private botOut: GainNode
  /** Bot sesleri üst üste binmesin diye sırayla çalar */
  private clipChain: Promise<void> = Promise.resolve()
  private clipGen = 0
  private clipNow: AudioBufferSourceNode | null = null
  private channels = new Map<string, Channel>()
  private timer: number
  private speaking = new Set<string>()
  private onSpeakingChange: (speaking: Set<string>) => void
  private ears: EarFn | null = null
  private tapSink: GainNode

  constructor(onSpeakingChange: (speaking: Set<string>) => void) {
    this.onSpeakingChange = onSpeakingChange
    // Bu yapıcı mutlaka bir kullanıcı tıklaması içinde çağrılmalı (autoplay kilidi).
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    void this.ctx.resume()
    this.master = this.ctx.createGain()
    this.master.connect(this.ctx.destination)
    this.sfxOut = this.ctx.createGain()
    this.sfxOut.gain.value = 0.6
    this.sfxOut.connect(this.master)
    this.botOut = this.ctx.createGain()
    this.botOut.connect(this.master)
    // ScriptProcessor ancak bir çıkışa bağlıyken çalışır; sessiz bir lavaboya akıtılır.
    this.tapSink = this.ctx.createGain()
    this.tapSink.gain.value = 0
    this.tapSink.connect(this.ctx.destination)
    this.timer = window.setInterval(() => this.poll(), SPEAKING_POLL_MS)
  }

  /** Telefonlar sekme arka plandan dönünce AudioContext'i askıya alabiliyor. */
  resume() {
    if (this.ctx.state !== 'running') void this.ctx.resume()
  }

  setLocal(stream: MediaStream | null) {
    this.remove(LOCAL)
    if (stream) this.attach(LOCAL, stream, false)
  }

  addRemote(peerId: string, stream: MediaStream, volumePct: number) {
    if (!stream.getAudioTracks().length) return
    this.remove(peerId)
    this.attach(peerId, stream, true)
    this.setVolume(peerId, volumePct)
  }

  private attach(id: string, stream: MediaStream, playback: boolean) {
    const keepAlive = new Audio()
    keepAlive.muted = true
    keepAlive.srcObject = stream
    void keepAlive.play().catch(() => {})

    const source = this.ctx.createMediaStreamSource(stream)
    const analyser = this.ctx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)

    let gain: GainNode | undefined
    if (playback) {
      gain = this.ctx.createGain()
      source.connect(gain)
      gain.connect(this.master)
    }
    const ch: Channel = {
      keepAlive,
      source,
      gain,
      analyser,
      buf: new Float32Array(analyser.fftSize),
      lastLoud: 0,
    }
    this.channels.set(id, ch)
    if (this.ears) this.addTap(id, ch)
  }

  /** Her kanalın ham sesini (yerel mikrofon dahil) fn'e verir; null kapatır. */
  setEars(fn: EarFn | null) {
    this.ears = fn
    for (const [id, ch] of this.channels) {
      if (fn && !ch.tap) this.addTap(id, ch)
      if (!fn && ch.tap) this.dropTap(ch)
    }
  }

  private addTap(id: string, ch: Channel) {
    const tap = this.ctx.createScriptProcessor(4096, 1, 1)
    tap.onaudioprocess = (e) => this.ears?.(id, e.inputBuffer.getChannelData(0), this.ctx.sampleRate)
    ch.source.connect(tap)
    tap.connect(this.tapSink)
    ch.tap = tap
  }

  private dropTap(ch: Channel) {
    if (!ch.tap) return
    ch.tap.onaudioprocess = null
    ch.tap.disconnect()
    ch.tap = undefined
  }

  setVolume(peerId: string, pct: number) {
    const ch = this.channels.get(peerId)
    if (ch?.gain) ch.gain.gain.setTargetAtTime(pct / 100, this.ctx.currentTime, 0.02)
  }

  /** Efekt panosu sesi; sağırken (master kapalı) duyulmaz. */
  playSfx(id: SfxId) {
    this.resume()
    playSfx(this.ctx, this.sfxOut, id)
  }

  /**
   * Bot sesini sıraya koyar. Sıradakiler bitince çalar; sağırken (master kapalı) duyulmaz.
   * onStart/onEnd konuşma göstergesi içindir.
   */
  playClip(data: ArrayBuffer, onStart: () => void, onEnd: () => void) {
    const gen = this.clipGen
    const decoded = this.ctx.decodeAudioData(data.slice(0))
    decoded.catch(() => {})
    this.clipChain = this.clipChain.then(async () => {
      let buf: AudioBuffer
      try {
        buf = await decoded
      } catch {
        return
      }
      if (gen !== this.clipGen || this.ctx.state === 'closed') return
      this.resume()
      const src = this.ctx.createBufferSource()
      src.buffer = buf
      src.connect(this.botOut)
      this.clipNow = src
      onStart()
      await new Promise<void>((done) => {
        src.onended = () => done()
        src.start()
      })
      if (this.clipNow === src) this.clipNow = null
      onEnd()
    })
  }

  /** Çalan ve sıradaki bot seslerini atar */
  stopClips() {
    this.clipGen++
    try {
      this.clipNow?.stop()
    } catch {
      /* zaten bitti */
    }
  }

  setBotVolume(pct: number) {
    this.botOut.gain.setTargetAtTime(pct / 100, this.ctx.currentTime, 0.02)
  }

  setDeafened(deafened: boolean) {
    this.master.gain.setTargetAtTime(deafened ? 0 : 1, this.ctx.currentTime, 0.02)
  }

  remove(id: string) {
    const ch = this.channels.get(id)
    if (!ch) return
    ch.source.disconnect()
    ch.gain?.disconnect()
    this.dropTap(ch)
    ch.keepAlive.srcObject = null
    this.channels.delete(id)
    if (this.speaking.delete(id)) this.onSpeakingChange(new Set(this.speaking))
  }

  private poll() {
    const now = performance.now()
    let changed = false
    for (const [id, ch] of this.channels) {
      ch.analyser.getFloatTimeDomainData(ch.buf)
      let sum = 0
      for (const s of ch.buf) sum += s * s
      const rms = Math.sqrt(sum / ch.buf.length)
      if (rms > SPEAKING_THRESHOLD) ch.lastLoud = now
      const isSpeaking = now - ch.lastLoud < SPEAKING_HOLD_MS
      if (isSpeaking !== this.speaking.has(id)) {
        if (isSpeaking) this.speaking.add(id)
        else this.speaking.delete(id)
        changed = true
      }
    }
    if (changed) this.onSpeakingChange(new Set(this.speaking))
  }

  close() {
    clearInterval(this.timer)
    this.stopClips()
    for (const id of [...this.channels.keys()]) this.remove(id)
    void this.ctx.close()
  }
}
