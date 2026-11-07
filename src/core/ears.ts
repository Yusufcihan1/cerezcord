import { BRIDGE_URL } from './bots'

/**
 * Botların kulağı: odadaki her sesi (yerel mikrofon dahil) konuşma parçalarına böler,
 * parçaları yerel köprüye (Whisper) yazıya çevirtir. Yalnız botları çağıranın bilgisayarında çalışır;
 * ses bu bilgisayardan dışarı çıkmaz.
 */

const RATE = 16_000
/** Bu seviyenin üstü konuşma sayılır (konuşma göstergesiyle aynı mertebe) */
const LOUD = 0.018
/** Konuşma başlamadan önceki şu kadar ses de alınır (ilk hece kesilmesin) */
const PRE_ROLL_S = 0.35
/** Şu kadar sessizlik konuşmayı bitirir */
const END_SILENCE_S = 0.8
/** Bundan kısa konuşmalar (öksürük, tık) atılır */
const MIN_SPEECH_S = 0.45
/** Uzun konuşma bu sürede bölünür */
const MAX_S = 18
/** Sıra bu kadar şişerse eski parçalar atılır (CPU yetişemiyor) */
const MAX_QUEUE = 4

type Track = {
  frames: Float32Array[]
  /** frames içinde toplam örnek (16 kHz) */
  size: number
  active: boolean
  loud: number
  quiet: number
}

export class Ears {
  private tracks = new Map<string, Track>()
  private queue: { id: string; pcm: Float32Array }[] = []
  private busy = false
  private stopped = false
  private onText: (id: string, text: string) => void

  constructor(onText: (id: string, text: string) => void) {
    this.onText = onText
  }

  stop() {
    this.stopped = true
    this.tracks.clear()
    this.queue = []
  }

  forget(id: string) {
    this.tracks.delete(id)
  }

  /** AudioEngine'den gelen ham ses parçası */
  feed = (id: string, input: Float32Array, sampleRate: number) => {
    if (this.stopped) return
    const frame = downsample(input, sampleRate)
    let tr = this.tracks.get(id)
    if (!tr) {
      tr = { frames: [], size: 0, active: false, loud: 0, quiet: 0 }
      this.tracks.set(id, tr)
    }
    let sum = 0
    for (const v of input) sum += v * v
    const isLoud = Math.sqrt(sum / input.length) > LOUD
    const dur = frame.length / RATE

    tr.frames.push(frame)
    tr.size += frame.length
    if (!tr.active) {
      if (isLoud) {
        tr.active = true
        tr.loud = dur
        tr.quiet = 0
      } else {
        // yalnız ön kaydı tut
        while (tr.frames.length > 1 && tr.size - tr.frames[0].length >= PRE_ROLL_S * RATE) {
          tr.size -= tr.frames.shift()!.length
        }
      }
      return
    }
    if (isLoud) {
      tr.loud += dur
      tr.quiet = 0
    } else tr.quiet += dur
    if (tr.quiet >= END_SILENCE_S || tr.size >= MAX_S * RATE) this.cut(id, tr)
  }

  private cut(id: string, tr: Track) {
    const enough = tr.loud >= MIN_SPEECH_S
    const pcm = enough ? join(tr.frames, tr.size) : null
    tr.frames = []
    tr.size = 0
    tr.active = false
    tr.loud = 0
    tr.quiet = 0
    if (!pcm) return
    this.queue.push({ id, pcm })
    if (this.queue.length > MAX_QUEUE) this.queue.shift()
    void this.pump()
  }

  private async pump() {
    if (this.busy) return
    this.busy = true
    try {
      while (this.queue.length && !this.stopped) {
        const { id, pcm } = this.queue.shift()!
        const text = await transcribe(pcm)
        if (text && !this.stopped) this.onText(id, text)
      }
    } finally {
      this.busy = false
    }
  }
}

/** Basit kutu süzgeçli örnekleme (48/44.1 kHz -> 16 kHz) */
function downsample(input: Float32Array, rate: number): Float32Array {
  const ratio = rate / RATE
  const n = Math.floor(input.length / ratio)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio)
    const b = Math.min(input.length, Math.floor((i + 1) * ratio))
    let s = 0
    for (let j = a; j < b; j++) s += input[j]
    out[i] = b > a ? s / (b - a) : input[a] ?? 0
  }
  return out
}

function join(frames: Float32Array[], size: number) {
  const out = new Float32Array(size)
  let o = 0
  for (const f of frames) {
    out.set(f, o)
    o += f.length
  }
  return out
}

async function transcribe(pcm: Float32Array): Promise<string> {
  try {
    const res = await fetch(`${BRIDGE_URL}/stt`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: pcm.buffer as ArrayBuffer,
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return ''
    const body = await res.json()
    return String(body?.metin ?? '').trim()
  } catch {
    return ''
  }
}
