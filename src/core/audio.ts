import { SPEAKING_HOLD_MS, SPEAKING_POLL_MS, SPEAKING_THRESHOLD } from './limits'

type Channel = {
  /** Chrome, WebAudio'ya bağlanan uzak WebRTC sesini bir <audio> elemanına da bağlı değilse çalmıyor. */
  keepAlive: HTMLAudioElement
  source: MediaStreamAudioSourceNode
  gain?: GainNode
  analyser: AnalyserNode
  buf: Float32Array<ArrayBuffer>
  lastLoud: number
}

export const LOCAL = '__local__'

/**
 * Tüm ses çalma ve konuşma algılama işi. Kişi başı ses seviyesi için GainNode kullanıyoruz,
 * çünkü iOS'ta <audio>.volume salt okunur ve %100 üstüne zaten çıkılamıyor.
 */
export class AudioEngine {
  readonly ctx: AudioContext
  private master: GainNode
  private channels = new Map<string, Channel>()
  private timer: number
  private speaking = new Set<string>()
  private onSpeakingChange: (speaking: Set<string>) => void

  constructor(onSpeakingChange: (speaking: Set<string>) => void) {
    this.onSpeakingChange = onSpeakingChange
    // Bu yapıcı mutlaka bir kullanıcı tıklaması içinde çağrılmalı (autoplay kilidi).
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    void this.ctx.resume()
    this.master = this.ctx.createGain()
    this.master.connect(this.ctx.destination)
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
    this.channels.set(id, {
      keepAlive,
      source,
      gain,
      analyser,
      buf: new Float32Array(analyser.fftSize),
      lastLoud: 0,
    })
  }

  setVolume(peerId: string, pct: number) {
    const ch = this.channels.get(peerId)
    if (ch?.gain) ch.gain.gain.setTargetAtTime(pct / 100, this.ctx.currentTime, 0.02)
  }

  setDeafened(deafened: boolean) {
    this.master.gain.setTargetAtTime(deafened ? 0 : 1, this.ctx.currentTime, 0.02)
  }

  remove(id: string) {
    const ch = this.channels.get(id)
    if (!ch) return
    ch.source.disconnect()
    ch.gain?.disconnect()
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
    for (const id of [...this.channels.keys()]) this.remove(id)
    void this.ctx.close()
  }
}
