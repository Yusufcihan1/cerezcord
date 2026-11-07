import { useEffect, useRef, useState } from 'react'
import type { CerezRoom, RoomState } from '../core/room'
import { SFX } from '../core/sfx'
import { VOICE_EFFECTS } from '../core/voicefx'
import { BOT_VOICES, MAX_BOTS, type BotVoiceId } from '../core/bots'

/** Alt çubuktaki "Eğlence" düğmesi ve açılan panel: ses değiştirici + efekt panosu. */
export function FunButton({ room, s }: { room: CerezRoom; s: RoomState }) {
  const [open, setOpen] = useState(false)
  const [warn, setWarn] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = VOICE_EFFECTS.find((e) => e.id === s.voiceEffect)!

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const play = (id: (typeof SFX)[number]['id']) => {
    if (room.playSfx(id)) return
    setWarn(true)
    setTimeout(() => setWarn(false), 1500)
  }

  return (
    <div className="fun" ref={ref}>
      {open && (
        <div className="fun-panel" role="dialog" aria-label="Eğlence">
          <h3>Sesimi değiştir</h3>
          <div className="fun-grid">
            {VOICE_EFFECTS.map((e) => (
              <button
                key={e.id}
                className={`fun-chip ${s.voiceEffect === e.id ? 'on' : ''}`}
                aria-pressed={s.voiceEffect === e.id}
                onClick={() => room.setVoiceEffect(e.id)}
                disabled={!!s.micError}
              >
                <span className="fun-emoji">{e.emoji}</span>
                {e.label}
              </button>
            ))}
          </div>
          <label className="fun-check">
            <input
              type="checkbox"
              checked={s.monitor}
              onChange={(e) => room.setMonitor(e.target.checked)}
              disabled={!!s.micError}
            />
            Kendimi duy <span className="muted">(kulaklıkla dene, hoparlörde yankı yapar)</span>
          </label>

          <h3>Efekt panosu {warn && <span className="fun-warn">Biraz yavaş!</span>}</h3>
          <div className="fun-grid">
            {SFX.map((x) => (
              <button key={x.id} className="fun-chip" onClick={() => play(x.id)}>
                <span className="fun-emoji">{x.emoji}</span>
                {x.label}
              </button>
            ))}
          </div>
          <label className="fun-check">
            <input type="checkbox" checked={!s.sfxMuted} onChange={(e) => room.setSfxMuted(!e.target.checked)} />
            Başkalarının efektlerini çal
          </label>

          <BotSection room={room} s={s} />
        </div>
      )}
      <button
        className={`ctl ${s.voiceEffect !== 'off' ? 'fx-on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Ses değiştirici ve efektler"
      >
        <span className="fun-emoji big">{s.voiceEffect === 'off' ? '🎉' : active.emoji}</span>
        <span>{s.voiceEffect === 'off' ? 'Eğlence' : active.label}</span>
      </button>
    </div>
  )
}

/** Troll botlar: çağır (ad + ses tonu), söz ver, gönder. Anahtar yalnız bu bilgisayarda kalır. */
function BotSection({ room, s }: { room: CerezRoom; s: RoomState }) {
  const [key, setKey] = useState(() => room.savedBotKey())
  const [editKey, setEditKey] = useState(() => !room.savedBotKey())
  const [name, setName] = useState('')
  const [voice, setVoice] = useState<BotVoiceId>('normal')
  const [err, setErr] = useState<string | null>(null)
  const all = Object.values(s.bots)
  const mine = all.filter((b) => b.host === s.selfId)
  const others = all.filter((b) => b.host !== s.selfId)

  useEffect(() => {
    if (s.bridge === 'unknown') void room.checkBridge()
  }, [room, s.bridge])

  const summon = (e: React.FormEvent) => {
    e.preventDefault()
    const error = room.summonBot(key, name, voice)
    setErr(error)
    if (!error) {
      setName('')
      setEditKey(false)
    }
  }

  return (
    <>
      <h3>🤖 Troll botlar</h3>
      {mine.length > 0 && (
        <ul className="bot-list">
          {mine.map((b) => (
            <li key={b.id} className={s.botTalking === b.id ? 'talking' : ''}>
              <span className="bot-name">🤖 {b.name}</span>
              <button className="fun-chip" onClick={() => room.pokeBot(b.id)} title="Hemen birine laf soksun">
                🗣️ Söz ver
              </button>
              <button className="fun-chip" onClick={() => room.dismissBot(b.id)} title="Odadan gönder">
                👋
              </button>
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <p className="fun-note muted">
          Başkalarının botları: {others.map((b) => `${b.name} (${s.peers[b.host]?.name ?? '?'})`).join(', ')}
        </p>
      )}
      {mine.length < MAX_BOTS && (
        <form className="bot-form" onSubmit={summon}>
          {editKey && (
            <input
              type="password"
              placeholder="Claude API anahtarı"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          )}
          <div className="fun-row">
            <input
              placeholder="Botun adı (ör. Yabancı Kemal)"
              value={name}
              maxLength={24}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
            />
            <select value={voice} onChange={(e) => setVoice(e.target.value as BotVoiceId)} aria-label="Ses tonu">
              {BOT_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
          <button className="fun-chip on" type="submit" disabled={!key.trim() || !name.trim()}>
            🤖 Bot çağır
          </button>
          {err && <p className="fun-warn">{err}</p>}
        </form>
      )}
      <p className="fun-note muted">
        Bot ses:{' '}
        {s.bridge === 'on' ? (
          <>
            <span className="ok">EMA hazır ✓</span>
            {s.botEars ? (
              <span className="ok"> · sesleri duyuyor 🎙️</span>
            ) : (
              !s.bridgeStt && <span> · sesleri duyması için köprüyü yeniden başlat</span>
            )}
          </>
        ) : (
          <>
            {s.bridge === 'off' ? 'köprü kapalı, tarayıcı sesi kullanılır.' : 'kontrol ediliyor…'}{' '}
            <button type="button" className="linkish" onClick={() => void room.checkBridge()}>
              Yeniden dene
            </button>
          </>
        )}
        {!editKey && key && (
          <>
            {' · '}
            <button
              type="button"
              className="linkish"
              onClick={() => {
                room.forgetBotKey()
                setKey('')
                setEditKey(true)
              }}
            >
              Anahtarı unut
            </button>
          </>
        )}
      </p>
      <label className="fun-check">
        <input type="checkbox" checked={s.botVoice} onChange={(e) => room.setBotVoice(e.target.checked)} />
        Botları sesli dinle
      </label>
    </>
  )
}
