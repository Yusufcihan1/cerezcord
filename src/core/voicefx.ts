// Ses değiştirici. Mikrofon sesi bu bilgisayarda işlenir, karşıya değişmiş ses gider.
// Efekt kapalıyken hiç devreye girmez: mikrofon doğrudan gönderilir (bkz. CerezRoom.setVoiceEffect).

export type VoiceEffect = 'off' | 'sincap' | 'dev' | 'robot' | 'uzayli' | 'magara' | 'telsiz'

export const VOICE_EFFECTS: { id: VoiceEffect; label: string; emoji: string }[] = [
  { id: 'off', label: 'Normal', emoji: '🙂' },
  { id: 'sincap', label: 'Sincap', emoji: '🐿️' },
  { id: 'dev', label: 'Dev', emoji: '👹' },
  { id: 'robot', label: 'Robot', emoji: '🤖' },
  { id: 'uzayli', label: 'Uzaylı', emoji: '👽' },
  { id: 'magara', label: 'Mağara', emoji: '🕳️' },
  { id: 'telsiz', label: 'Telsiz', emoji: '📻' },
]

export const isVoiceEffect = (v: unknown): v is VoiceEffect => VOICE_EFFECTS.some((e) => e.id === v)

// Gecikme hattıyla perde kaydırma: iki okuma ucu, yarım pencere arayla, yumuşak geçişle.
// Gecikme ~30 ms; konuşma için yeterince doğal, ek kütüphane gerektirmez.
const PITCH_WORKLET = `
class CzPitch extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4 }] }
  constructor() {
    super()
    this.size = 8192
    this.buf = new Float32Array(this.size)
    this.w = 0
    this.phase = 0
    this.win = Math.round(sampleRate * 0.03)
  }
  read(pos) {
    const S = this.size
    pos = ((pos % S) + S) % S
    const i = Math.floor(pos), f = pos - i
    return this.buf[i] * (1 - f) + this.buf[(i + 1) % S] * f
  }
  process(inputs, outputs, params) {
    const inp = inputs[0] && inputs[0][0]
    const outs = outputs[0]
    if (!outs || !outs[0]) return true
    const out = outs[0]
    const r = params.ratio[0]
    const N = this.win
    for (let i = 0; i < out.length; i++) {
      this.buf[this.w] = inp ? inp[i] : 0
      this.phase += (1 - r) / N
      this.phase -= Math.floor(this.phase)
      const p2 = (this.phase + 0.5) % 1
      const g1 = Math.sin(Math.PI * this.phase) ** 2
      const g2 = Math.sin(Math.PI * p2) ** 2
      out[i] = this.read(this.w - this.phase * N - 1) * g1 + this.read(this.w - p2 * N - 1) * g2
      this.w = (this.w + 1) % this.size
    }
    for (let c = 1; c < outs.length; c++) outs[c].set(out)
    return true
  }
}
registerProcessor('cz-pitch', CzPitch)
`

const loaded = new WeakMap<AudioContext, Promise<void>>()

function loadWorklet(ctx: AudioContext) {
  let p = loaded.get(ctx)
  if (!p) {
    const url = URL.createObjectURL(new Blob([PITCH_WORKLET], { type: 'text/javascript' }))
    p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
    loaded.set(ctx, p)
  }
  return p
}

export class VoiceChanger {
  private ctx: AudioContext
  private dest: MediaStreamAudioDestinationNode
  private inputGain: GainNode
  private out: GainNode
  private monitorGain: GainNode
  private source: MediaStreamAudioSourceNode | null = null
  /** Etkin efektin düğümleri; efekt değişince sökülür */
  private nodes: AudioNode[] = []
  private oscs: OscillatorNode[] = []
  private effect: VoiceEffect = 'off'
  /** Karşıya giden işlenmiş ses */
  readonly stream: MediaStream
  readonly track: MediaStreamTrack

  constructor(ctx: AudioContext) {
    this.ctx = ctx
    this.dest = ctx.createMediaStreamDestination()
    this.dest.channelCount = 1
    this.inputGain = ctx.createGain()
    this.out = ctx.createGain()
    this.out.connect(this.dest)
    this.monitorGain = ctx.createGain()
    this.monitorGain.gain.value = 0
    this.out.connect(this.monitorGain)
    this.monitorGain.connect(ctx.destination)
    this.stream = this.dest.stream
    this.track = this.stream.getAudioTracks()[0]
  }

  setSource(stream: MediaStream | null) {
    this.source?.disconnect()
    this.source = stream ? this.ctx.createMediaStreamSource(stream) : null
    this.source?.connect(this.inputGain)
  }

  /** Kendi sesini duy (kulaklıkla; hoparlörde yankı yapar). */
  setMonitor(on: boolean) {
    this.monitorGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02)
  }

  async setEffect(effect: VoiceEffect) {
    if (effect !== 'off') await loadWorklet(this.ctx)
    this.teardown()
    this.effect = effect
    const ctx = this.ctx
    const add = <T extends AudioNode>(n: T) => (this.nodes.push(n), n)
    const pitch = (ratio: number) => {
      const n = add(new AudioWorkletNode(ctx, 'cz-pitch', { outputChannelCount: [1] }))
      n.parameters.get('ratio')!.value = ratio
      return n
    }
    const filter = (type: BiquadFilterType, freq: number, gain = 0, q = 0.7) => {
      const f = add(ctx.createBiquadFilter())
      f.type = type
      f.frequency.value = freq
      f.gain.value = gain
      f.Q.value = q
      return f
    }
    const gain = (v: number) => {
      const g = add(ctx.createGain())
      g.gain.value = v
      return g
    }
    /** Halka modülasyonu: ses, bir osilatörle çarpılır (metalik, robotik) */
    const ring = (freq: number) => {
      const g = gain(0)
      const osc = ctx.createOscillator()
      osc.frequency.value = freq
      osc.connect(g.gain)
      osc.start()
      this.oscs.push(osc)
      return g
    }
    const chain = (...ns: AudioNode[]) => {
      for (let i = 0; i < ns.length - 1; i++) ns[i].connect(ns[i + 1])
      return ns
    }
    const inp = this.inputGain
    const out = this.out

    switch (effect) {
      case 'off':
        inp.connect(out)
        break
      case 'sincap':
        chain(inp, pitch(1.75), filter('highpass', 180), gain(1.1), out)
        break
      case 'dev':
        chain(inp, pitch(0.6), filter('lowshelf', 220, 5), filter('lowpass', 3500), gain(1.2), out)
        break
      case 'robot': {
        // Halka modülasyonu + kısa geri beslemeli yankı (metal kutu tınısı)
        const d = add(ctx.createDelay(0.1))
        d.delayTime.value = 0.009
        const rm = ring(60)
        chain(inp, rm, d, gain(1.6), out)
        chain(rm, gain(0.8), out)
        chain(d, gain(0.55), d)
        break
      }
      case 'uzayli': {
        const p = pitch(1.3)
        chain(inp, p)
        const dry = gain(0.6)
        const wet = gain(0.9)
        chain(p, dry, out)
        chain(p, ring(520), wet, out)
        break
      }
      case 'magara': {
        inp.connect(out)
        for (const [time, fbAmt, lvl] of [
          [0.19, 0.45, 0.55],
          [0.31, 0.4, 0.4],
        ] as const) {
          const d = add(ctx.createDelay(1))
          d.delayTime.value = time
          const lp = filter('lowpass', 2200)
          const fb = gain(fbAmt)
          const wet = gain(lvl)
          chain(inp, d, lp, fb, d)
          chain(lp, wet, out)
        }
        break
      }
      case 'telsiz': {
        const shaper = add(ctx.createWaveShaper())
        const curve = new Float32Array(1024)
        for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh((i / 511.5 - 1) * 5)
        shaper.curve = curve
        chain(inp, filter('highpass', 450), filter('lowpass', 2800), filter('peaking', 1600, 6, 1), shaper, gain(0.45), out)
        break
      }
    }
  }

  getEffect() {
    return this.effect
  }

  private teardown() {
    this.inputGain.disconnect()
    for (const o of this.oscs) o.stop()
    for (const n of this.nodes) n.disconnect()
    this.nodes = []
    this.oscs = []
  }

  close() {
    this.teardown()
    this.source?.disconnect()
    this.out.disconnect()
    this.monitorGain.disconnect()
    this.track.stop()
  }
}
