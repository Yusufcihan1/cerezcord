import { useEffect, useRef, useState } from 'react'
import type { CerezRoom, RoomState } from '../core/room'
import { SFX } from '../core/sfx'
import { VOICE_EFFECTS } from '../core/voicefx'

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
