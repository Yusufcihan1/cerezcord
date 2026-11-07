// Ses efekti panosu. Sesler dosya değil, Web Audio ile burada üretilir; ağdan yalnız efektin adı
// gider ve her kişi kendi bilgisayarında çalar. Bu yüzden ses kalitesi bozulmaz, mikrofon kapalıyken
// de çalışır.

export const SFX = [
  { id: 'badumtss', label: 'Ba-dum-tss', emoji: '🥁' },
  { id: 'alkis', label: 'Alkış', emoji: '👏' },
  { id: 'korna', label: 'Korna', emoji: '📯' },
  { id: 'yanlis', label: 'Yanlış', emoji: '❌' },
  { id: 'dogru', label: 'Doğru', emoji: '✅' },
  { id: 'boing', label: 'Boing', emoji: '🦘' },
  { id: 'trombon', label: 'Hüzünlü', emoji: '🎺' },
  { id: 'circir', label: 'Cırcır', emoji: '🦗' },
] as const

export type SfxId = (typeof SFX)[number]['id']

export const isSfxId = (v: unknown): v is SfxId => SFX.some((s) => s.id === v)
export const sfxInfo = (id: SfxId) => SFX.find((s) => s.id === id)!

let noiseBuf: AudioBuffer | null = null
function noise(ctx: BaseAudioContext) {
  if (!noiseBuf || noiseBuf.sampleRate !== ctx.sampleRate) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const d = noiseBuf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }
  return noiseBuf
}

type Tone = {
  type?: OscillatorType
  freq: number
  /** Bitişte bu frekansa kayar */
  to?: number
  at: number
  dur: number
  gain: number
  attack?: number
  lowpass?: number
  vibrato?: [rate: number, depth: number]
}

export function playSfx(ctx: AudioContext, out: AudioNode, id: SfxId) {
  const t0 = ctx.currentTime + 0.02

  const env = (at: number, dur: number, peak: number, attack = 0.005) => {
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t0 + at)
    g.gain.linearRampToValueAtTime(peak, t0 + at + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur)
    g.connect(out)
    return g
  }

  const tone = ({ type = 'sine', freq, to, at, dur, gain, attack, lowpass, vibrato }: Tone) => {
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(freq, t0 + at)
    if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + at + dur)
    let node: AudioNode = o
    if (lowpass) {
      const f = ctx.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.value = lowpass
      o.connect(f)
      node = f
    }
    node.connect(env(at, dur, gain, attack))
    if (vibrato) {
      const lfo = ctx.createOscillator()
      const depth = ctx.createGain()
      lfo.frequency.value = vibrato[0]
      depth.gain.value = vibrato[1]
      lfo.connect(depth).connect(o.frequency)
      lfo.start(t0 + at)
      lfo.stop(t0 + at + dur)
    }
    o.start(t0 + at)
    o.stop(t0 + at + dur + 0.05)
  }

  const hiss = (at: number, dur: number, gain: number, type: BiquadFilterType, freq: number, q = 0.7) => {
    const s = ctx.createBufferSource()
    s.buffer = noise(ctx)
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.Q.value = q
    s.connect(f).connect(env(at, dur, gain, 0.002))
    s.start(t0 + at, Math.random())
    s.stop(t0 + at + dur + 0.05)
  }

  switch (id) {
    case 'badumtss':
      tone({ freq: 190, to: 95, at: 0, dur: 0.22, gain: 0.55 })
      hiss(0, 0.06, 0.3, 'bandpass', 2000)
      tone({ freq: 130, to: 65, at: 0.2, dur: 0.28, gain: 0.6 })
      hiss(0.2, 0.06, 0.3, 'bandpass', 1600)
      tone({ freq: 60, to: 45, at: 0.46, dur: 0.3, gain: 0.5 })
      hiss(0.46, 1.4, 0.35, 'highpass', 6500)
      break
    case 'alkis':
      for (let i = 0; i < 70; i++) {
        const at = Math.random() ** 0.8 * 1.8
        hiss(at, 0.03 + Math.random() * 0.04, 0.15 + Math.random() * 0.3, 'bandpass', 900 + Math.random() * 1500, 1.2)
      }
      break
    case 'korna':
      for (const [at, dur] of [
        [0, 0.2],
        [0.26, 0.2],
        [0.52, 0.95],
      ]) {
        for (const f of [440, 444, 554, 220]) tone({ type: 'sawtooth', freq: f, at, dur, gain: 0.12, attack: 0.02, lowpass: 3200 })
      }
      break
    case 'yanlis':
      tone({ type: 'square', freq: 155, at: 0, dur: 0.22, gain: 0.22, attack: 0.01, lowpass: 1800 })
      tone({ type: 'square', freq: 110, at: 0.28, dur: 0.6, gain: 0.22, attack: 0.01, lowpass: 1800 })
      break
    case 'dogru':
      tone({ freq: 988, at: 0, dur: 0.5, gain: 0.35 })
      tone({ freq: 1319, at: 0.12, dur: 1.2, gain: 0.35 })
      tone({ freq: 2637, at: 0.12, dur: 0.6, gain: 0.08 })
      break
    case 'boing':
      tone({ freq: 110, to: 520, at: 0, dur: 0.7, gain: 0.5, vibrato: [16, 40] })
      break
    case 'trombon':
      for (const [i, f] of [233, 220, 208, 196].entries()) {
        const last = i === 3
        tone({
          type: 'sawtooth',
          freq: f,
          at: i * 0.42,
          dur: last ? 1.3 : 0.38,
          gain: 0.22,
          attack: 0.04,
          lowpass: 1300,
          vibrato: last ? [5.5, 6] : undefined,
        })
      }
      break
    case 'circir':
      for (let g = 0; g < 4; g++) {
        for (let c = 0; c < 3; c++) tone({ freq: 4400, at: g * 0.55 + c * 0.06, dur: 0.035, gain: 0.12, attack: 0.003 })
      }
      break
  }
}
