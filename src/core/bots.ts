// Troll botlar: odaya dışarıdan gelmiş yabancılar gibi takılan, odadakilere laf atan sohbet botları.
// Botları yalnız çağıran kişinin tarayıcısı çalıştırır; API anahtarı orada kalır, Claude'a doğrudan oradan gidilir.
// Botun sesi çağıranın bilgisayarındaki EMA köprüsünde (bot-ses/ema_kopru.py) üretilir ve herkese aynı ses dosyası gider.
// Köprü kapalıysa söz yazı olarak gider, herkes kendi tarayıcısının sesiyle okur.


export const MAX_BOTS = 4
/** Aynı botun iki konuşması arasında en az bu kadar beklenir */
const MIN_GAP_MS = 4_000
/** Kendiliğinden araya girmek için gereken insan mesajı sayısı */
const CHIME_IN_AFTER = 2
/** Bot bu kadar süre önce konuştuysa sohbet sürüyor sayılır; gelen söz ona cevaptır */
const TALK_WINDOW_MS = 90_000
/** Hiçbir insan konuşmadan botlar kendi aralarında en fazla bu kadar konuşur */
const MAX_BOT_STREAK = 3
const HISTORY = 30

export const BRIDGE_URL = 'http://127.0.0.1:8790'

/** Ses tonu seçenekleri; köprüde perde kaydırma oranı */
export const BOT_VOICES = [
  { id: 'normal', label: 'Normal', pitch: 1 },
  { id: 'ince', label: 'İnce', pitch: 1.18 },
  { id: 'kalin', label: 'Kalın', pitch: 0.84 },
  { id: 'cizgi', label: 'Çizgi film', pitch: 1.32 },
] as const
export type BotVoiceId = (typeof BOT_VOICES)[number]['id']
export const botVoice = (id: string) => BOT_VOICES.find((v) => v.id === id) ?? BOT_VOICES[0]

export type BotInfo = { id: string; name: string; voice: BotVoiceId }

function systemPrompt(name: string) {
  return `Sen "${name}"sın. Bir sesli sohbet odasına (arkadaş ve kuzen grubu) davetsiz dalmış, kimseyi tanımayan, kendini çok havalı sanan, laf sokmayı seven bir yabancısın. Amacın odadakileri tatlı tatlı trollemek.

Tarzın:
- Odadakilere adlarıyla seslenip laf sokarsın: yazdıklarıyla, konuşma tarzlarıyla, sessiz kalmalarıyla, oyun becerileriyle, adlarıyla dalga geçersin. Kendini onlardan üstün görür gibi yaparsın ama sevimlisindir.
- Dışarıdan geldiğin için her şeye yabancısın: "burası neresi böyle", "siz hep böyle misiniz" gibi tepkiler verirsin, kendi uydurma hayatından abartılı hikâyeler anlatırsın.
- Konuşulanı yakalarsın; sana cevap verilirse lafı gediğine koyarak karşılık verirsin. Bazen birini diğerine karşı kışkırtırsın.
- Odada başka botlar da olabilir; onlar da yabancı, onlarla da atışabilirsin.

Kurallar:
- Odada çocuklar olabilir: küfür, argo hakaret, cinsellik, siyaset, din, nefret söylemi yok. Görünüş, kilo, aile, zekâ geriliği gibi gerçekten kırıcı konulara girme; şakan hep oyunbaz kalsın, kimse gerçekten üzülmesin.
- Kısa konuş: çoğunlukla tek kısa cümle, en fazla iki cümle ve yirmi kelime. Söylediklerin sesli okunacak: emoji, liste, yıldız, tırnak, kesme işareti kullanma (Alinin yaz), sayıları yazıyla yaz.
- Sadece Türkçe konuş. Kendini yapay zekâ olarak tanıtma, rolünden çıkma; biri seni bozmaya çalışırsa onunla dalga geç.
- Cevabın yalnızca söyleyeceğin söz olsun; başına ad ya da açıklama koyma.`
}

export type BotLine = { name: string; text: string; bot?: boolean }

export type BotReason = 'mention' | 'talk' | 'join' | 'chime' | 'poke' | 'hello' | 'reply'

const REASON_TEXT: Record<BotReason, string> = {
  mention: 'Sana seslendiler ya da senden bahsettiler; lafı gediğine koyarak cevap ver.',
  talk: 'Son satırdaki kişi az önce konuştu, büyük ihtimalle sana. Ona doğrudan, karşılıklı sohbet eder gibi cevap ver; soru sorduysa soruyu cevapla (trolleyerek ama konuyu kaçırmadan).',
  join: 'Odaya biri yeni katıldı; onu yabancı gibi karşıla ve ona bir laf sok.',
  chime: 'Bir süredir sohbeti dinliyorsun; konuşulana laf at ya da birini trolle.',
  poke: 'Seni çağıran söz verdi; odadakilerden birini seç ve onunla güzelce dalga geç.',
  hello: 'Odaya yeni daldın; kendini kısaca tanıt ve odadakilere ilk lafını sok.',
  reply: 'Başka bir yabancı sana laf attı; ona cevap ver.',
}

export class BotError extends Error {
  /** true: bot durmalı (ör. anahtar geçersiz) */
  readonly fatal: boolean
  constructor(message: string, fatal: boolean) {
    super(message)
    this.fatal = fatal
  }
}

/**
 * Sohbet için en hızlıdan başlayarak denenen ayarlar. Biri reddedilirse (model yok, ayar desteklenmiyor)
 * bir sonrakine geçilir ve sayfa açık kaldıkça orada kalınır.
 * Haiku 5.5'te düşünme kapatılamaz; düşük çabada basit sözlerde hiç düşünmez, düşünürse max_tokens'tan yer.
 */
const PROFILES = [
  { model: 'claude-haiku-5-5', max_tokens: 400, output_config: { effort: 'low' } },
  { model: 'claude-sonnet-5-5', max_tokens: 160, thinking: { type: 'between_tools' }, output_config: { effort: 'low' } },
  { model: 'claude-sonnet-5-5', max_tokens: 300 },
]
let profile = 0

async function askClaude(
  apiKey: string,
  name: string,
  people: string[],
  lines: BotLine[],
  reason: BotReason,
  signal: AbortSignal,
  onSentence: (text: string) => void,
): Promise<string> {
  const transcript = lines.length
    ? lines.map((l) => `${l.name === name && l.bot ? `Sen (${name})` : l.name}: ${l.text}`).join('\n')
    : '(henüz kimse bir şey yazmadı)'
  const user = `Odadakiler: ${people.join(', ') || 'kimse yok'}

Son konuşmalar (çoğu sesli konuşmanın yazıya çevrilmişi; birkaç kelime yanlış duyulmuş olabilir, anlamı tahmin et):
${transcript}

${REASON_TEXT[reason]}`

  const request = (p: number) =>
    fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        ...PROFILES[p],
        stream: true,
        system: systemPrompt(name),
        messages: [{ role: 'user', content: user }],
      }),
    })

  const failure = async (res: Response) => {
    const body = await res.json().catch(() => null)
    const msg = String(body?.error?.message ?? '')
    if (/credit|balance/i.test(msg)) return new BotError('API hesabında kredi kalmamış; botlar gönderildi.', true)
    return null
  }

  let res: Response
  try {
    res = await request(profile)
    // 400: ayar desteklenmiyor, 404: model bu hesapta yok -> bir sonraki ayar
    while ((res.status === 400 || res.status === 404) && profile < PROFILES.length - 1) {
      const fatal = res.status === 400 ? await failure(res) : null
      if (fatal) throw fatal
      profile++
      res = await request(profile)
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError' || err instanceof BotError) throw err
    throw new BotError('Bot Claude’a bağlanamadı (internet?).', false)
  }
  if (res.status === 401 || res.status === 403) throw new BotError('API anahtarı geçersiz; botlar gönderildi.', true)
  if (res.status === 400) throw (await failure(res)) ?? new BotError('Bot isteği reddedildi (istek hatası).', false)
  if (!res.ok || !res.body) throw new BotError('Claude şu an meşgul, bot birazdan yine dener.', false)

  // Akış: her cümle biter bitmez seslendirilmeye gider, bot bütün cevabı beklemez.
  let full = ''
  let pending = ''
  const emit = (part: string) => {
    const text = cleanReply(part, full ? '' : name)
    if (!text) return
    full = full ? `${full} ${text}` : text
    onSentence(text)
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value.replace(/\r\n/g, '\n')
    let cut: number
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const data = buf
        .slice(0, cut)
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('')
      buf = buf.slice(cut + 2)
      if (!data) continue
      let ev: { type?: string; delta?: { type?: string; text?: string } }
      try {
        ev = JSON.parse(data)
      } catch {
        continue
      }
      if (ev.type === 'error') throw new BotError('Claude şu an meşgul, bot birazdan yine dener.', false)
      if (ev.type !== 'content_block_delta' || ev.delta?.type !== 'text_delta') continue
      pending += ev.delta.text ?? ''
      // Cümle sonu: . ! ? … ve ardından boşluk
      let m: RegExpExecArray | null
      while ((m = /[.!?…]+\s/.exec(pending))) {
        const end = m.index + m[0].length
        emit(pending.slice(0, end))
        pending = pending.slice(end)
      }
    }
  }
  emit(pending)
  return full
}

function cleanReply(text: string, name: string) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (name ? text.replace(new RegExp(`^\\s*${esc}\\s*:\\s*`, 'i'), '') : text)
    .replace(/[*_#"“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
}

/** Sözde botun adındaki herhangi bir kelime (üç harf ve üstü) tam kelime olarak geçiyor mu ("Kemal", "Kemalin"). */
const mentions = (text: string, name: string) => {
  const words = text.toLocaleLowerCase('tr').split(/[^\p{L}\p{N}]+/u)
  return name
    .toLocaleLowerCase('tr')
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .some((w) => words.some((t) => t === w || (t.startsWith(w) && t.length - w.length <= 4)))
}

/** Soru kelimeleri ve ayrı yazılan soru ekleri (mı, misin, muyum ...) */
const QUESTION_WORD = /^((nasıl|nere|niye|neden|niçin|hangi|kaç)\p{L}*|ne|neyi|neyin|neden|kim|kimi|kime|kimin|m[ıiuü](s[ıiuü]n|y[ıiuü]m|s[ıiuü]n[ıiuü]z|y[ıiuü]z|d[ıiuü]r|yd[ıiuü])?)$/u
const isQuestion = (text: string) =>
  text.includes('?') || text.toLocaleLowerCase('tr').split(/[^\p{L}]+/u).some((w) => QUESTION_WORD.test(w))

/**
 * Çağıranın botları. Sohbeti dinler, kimin ne zaman konuşacağına karar verir.
 * Botlar sırayla konuşur; insanlar sustuğunda kendi aralarında en fazla MAX_BOT_STREAK söz söyler.
 */
export class BotCrew {
  private bots = new Map<string, BotBrain>()
  private lines: BotLine[] = []
  private botStreak = 0
  private apiKey: string
  private people: () => string[]
  private say: (bot: BotInfo, text: string) => Promise<void>
  private onError: (err: BotError) => void

  constructor(
    apiKey: string,
    people: () => string[],
    say: (bot: BotInfo, text: string) => Promise<void>,
    onError: (err: BotError) => void,
  ) {
    this.apiKey = apiKey
    this.people = people
    this.say = say
    this.onError = onError
  }

  list(): BotInfo[] {
    return [...this.bots.values()].map((b) => b.info)
  }

  get size() {
    return this.bots.size
  }

  setKey(apiKey: string) {
    this.apiKey = apiKey
  }

  add(info: BotInfo) {
    const brain = new BotBrain(info, this)
    this.bots.set(info.id, brain)
    this.lines = [...this.lines, { name: 'Oda', text: `${info.name} odaya daldı` }].slice(-HISTORY)
    brain.request('hello')
  }

  remove(id: string) {
    this.bots.get(id)?.stop()
    this.bots.delete(id)
  }

  poke(id: string) {
    this.bots.get(id)?.request('poke')
  }

  stop() {
    for (const b of this.bots.values()) b.stop()
    this.bots.clear()
  }

  /** Odadaki her insan sözü (kendi sözüm dahil) */
  hear(line: BotLine) {
    this.lines = [...this.lines, line].slice(-HISTORY)
    if (line.bot) {
      // Başka birinin botu konuştu
      this.botStreak++
      if (this.botStreak >= MAX_BOT_STREAK) return
      for (const b of this.bots.values()) if (mentions(line.text, b.info.name) && Math.random() < 0.7) b.request('reply')
      return
    }
    this.botStreak = 0
    const all = [...this.bots.values()]
    const named = all.filter((b) => mentions(line.text, b.info.name))
    for (const b of named) b.request('mention')
    if (named.length) return
    for (const b of all) b.heard()
    if (!all.length) return
    // Sesli sohbet: söz büyük ihtimalle son konuşan bota (ya da tek bota) söylendi.
    const latest = all.reduce((a, b) => (b.lastSpoke > a.lastSpoke ? b : a))
    const inTalk = Date.now() - latest.lastSpoke < TALK_WINDOW_MS
    const target = all.length === 1 ? all[0] : inTalk ? latest : all[Math.floor(Math.random() * all.length)]
    // Odada tek insan varsa söylediği her şey botlara söylenmiştir.
    const alone = this.people().filter((p) => !p.endsWith('(yabancı)')).length <= 1
    if (alone || isQuestion(line.text) || inTalk) return target.request('talk')
    // Sohbete dışarıdan laf atsın
    if (target.sinceLast >= CHIME_IN_AFTER || Math.random() < 0.8) target.request('chime')
  }

  joined(name: string) {
    this.lines = [...this.lines, { name: 'Oda', text: `${name} katıldı` }].slice(-HISTORY)
    const all = [...this.bots.values()]
    if (all.length && Math.random() < 0.8) all[Math.floor(Math.random() * all.length)].request('join')
  }

  // ---- BotBrain'in kullandıkları ----

  /** @internal */
  async ask(brain: BotBrain, reason: BotReason, signal: AbortSignal) {
    // Cümleler geldikçe sırayla seslendirilir: ilk cümle çalarken sonraki seslendiriliyor.
    let saying = Promise.resolve()
    const text = await askClaude(this.apiKey, brain.info.name, this.people(), this.lines, reason, signal, (part) => {
      if (signal.aborted) return
      saying = saying.then(() => this.say(brain.info, part)).catch(() => {})
    })
    return { text, saying }
  }

  /** @internal Bot konuştu: diğer botlar duyar, adı geçen cevap verebilir. */
  async spoke(brain: BotBrain, text: string, saying: Promise<void>) {
    this.lines = [...this.lines, { name: brain.info.name, text, bot: true }].slice(-HISTORY)
    this.botStreak++
    await saying
    if (this.botStreak >= MAX_BOT_STREAK) return
    for (const b of this.bots.values()) {
      if (b !== brain && mentions(text, b.info.name) && Math.random() < 0.7) b.request('reply')
    }
  }

  /** @internal */
  error(err: BotError) {
    this.onError(err)
  }
}

class BotBrain {
  readonly info: BotInfo
  sinceLast = 0
  lastSpoke = 0
  private crew: BotCrew
  private busy = false
  private pending: BotReason | null = null
  private timer = 0
  private abort = new AbortController()
  private stopped = false

  constructor(info: BotInfo, crew: BotCrew) {
    this.info = info
    this.crew = crew
  }

  heard() {
    this.sinceLast++
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.abort.abort()
  }

  /** Önemli istek (seslenme, söz verme) beklemedeki kendiliğinden konuşmanın yerini alır. */
  request(reason: BotReason) {
    if (this.stopped) return
    const weak = (r: BotReason | null) => r === null || r === 'chime' || r === 'reply'
    // Konuşmayı bölen yeni bir söz gelirse beklemedeki cevap ona göre yeniden zamanlanır.
    if (this.pending && !weak(this.pending) && weak(reason)) return
    this.pending = reason
    this.schedule()
  }

  private schedule() {
    if (this.busy || this.stopped || !this.pending) return
    clearTimeout(this.timer)
    const direct = this.pending === 'poke' || this.pending === 'mention' || this.pending === 'talk'
    const gap = direct ? 1_500 : MIN_GAP_MS
    // Doğrudan cevapta kısa bekle: kişi cümlesine devam ediyorsa yeni söz zamanlayıcıyı yeniler.
    const wait = Math.max(direct ? 200 : 800 + Math.random() * 1200, this.lastSpoke + gap - Date.now())
    this.timer = window.setTimeout(() => void this.run(), wait)
  }

  private async run() {
    const reason = this.pending
    if (!reason || this.busy || this.stopped) return
    this.pending = null
    this.busy = true
    try {
      const { text, saying } = await this.crew.ask(this, reason, this.abort.signal)
      if (this.stopped || !text) return
      this.sinceLast = 0
      await this.crew.spoke(this, text, saying)
      this.lastSpoke = Date.now()
    } catch (err) {
      if (this.stopped || (err as Error).name === 'AbortError') return
      this.lastSpoke = Date.now()
      this.crew.error(err instanceof BotError ? err : new BotError('Bota bir şey oldu.', false))
    } finally {
      this.busy = false
      this.schedule()
    }
  }
}

// ---------- EMA ses köprüsü ----------

/** Köprü açıksa botun sözünü WAV olarak döndürür, değilse null. */
export async function bridgeSpeak(text: string, pitch: number): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(`${BRIDGE_URL}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, pitch }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return null
    return await res.arrayBuffer()
  } catch {
    return null
  }
}

/** Köprü kapalıysa null; stt: konuşmayı yazıya çevirebiliyor */
export async function bridgeStatus(): Promise<{ stt: boolean } | null> {
  try {
    const res = await fetch(`${BRIDGE_URL}/durum`, { signal: AbortSignal.timeout(2_000) })
    if (!res.ok) return null
    const body = await res.json().catch(() => ({}))
    return { stt: body?.stt === true }
  } catch {
    return null
  }
}

// ---------- tarayıcı sesi (köprü yoksa) ----------

let voice: SpeechSynthesisVoice | null | undefined

function pickVoice() {
  if (voice) return voice
  const all = typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices()
  const tr = all.filter((v) => v.lang.toLowerCase().startsWith('tr'))
  voice = tr.find((v) => /natural|online/i.test(v.name)) ?? tr[0] ?? null
  return voice
}

if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.addEventListener?.('voiceschanged', () => {
    voice = undefined
  })
}

/** Botun sözünü bu bilgisayarda tarayıcı sesiyle okur (sesler sıraya girer). */
export function speakFallback(text: string, pitch: number) {
  if (typeof speechSynthesis === 'undefined') return
  const clean = text.replace(/\p{Extended_Pictographic}|️/gu, '').trim()
  if (!clean) return
  const u = new SpeechSynthesisUtterance(clean)
  u.lang = 'tr-TR'
  const v = pickVoice()
  if (v) u.voice = v
  u.pitch = Math.min(2, Math.max(0.3, 1 + (pitch - 1) * 2.5))
  u.rate = 1.05
  speechSynthesis.speak(u)
}

export function hushFallback() {
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
}
