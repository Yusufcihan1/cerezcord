import { useEffect, useRef, useState } from 'react'
import { desktop } from '../core/desktop'
import { isMobile } from '../core/device'
import { listMicrophones } from '../core/media'
import type { CerezRoom } from '../core/room'
import type { Settings } from '../core/storage'
import { CloseIcon } from './icons'
import { keyLabel } from './util'

type Props = {
  settings: Settings
  room: CerezRoom | null
  onChange: (s: Settings) => void
  onClose: () => void
}

export function SettingsDialog({ settings, room, onChange, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    dialogRef.current?.showModal()
    void listMicrophones().then(setMics)
  }, [])

  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.code !== 'Escape') onChange({ ...settings, pttKey: e.code })
      setCapturing(false)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [capturing, settings, onChange])

  const update = (patch: Partial<Settings>) => onChange({ ...settings, ...patch })

  return (
    <dialog ref={dialogRef} className="dialog" onClose={onClose} onCancel={onClose}>
      <header>
        <h2>Ayarlar</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Kapat">
          <CloseIcon />
        </button>
      </header>

      <section>
        <h3>Mikrofon</h3>
        <select
          value={settings.micDeviceId}
          onChange={(e) => {
            update({ micDeviceId: e.target.value })
            void room?.setMicDevice(e.target.value)
          }}
        >
          <option value="">Varsayılan mikrofon</option>
          {mics.map((m, i) => (
            <option key={m.deviceId || i} value={m.deviceId}>
              {m.label || `Mikrofon ${i + 1}`}
            </option>
          ))}
        </select>
        {mics.length > 0 && !mics[0].label && (
          <small className="muted">Mikrofon adları, odaya bir kez girip izin verdikten sonra görünür.</small>
        )}
      </section>

      <section>
        <h3>Konuşma modu</h3>
        <div className="segmented" role="radiogroup">
          <button
            role="radio"
            aria-checked={settings.voiceMode === 'vad'}
            className={settings.voiceMode === 'vad' ? 'on' : ''}
            onClick={() => {
              update({ voiceMode: 'vad' })
              room?.setVoiceMode('vad')
            }}
          >
            Sesle açılır
          </button>
          <button
            role="radio"
            aria-checked={settings.voiceMode === 'ptt'}
            className={settings.voiceMode === 'ptt' ? 'on' : ''}
            onClick={() => {
              update({ voiceMode: 'ptt' })
              room?.setVoiceMode('ptt')
            }}
          >
            Bas-konuş
          </button>
        </div>
        {settings.voiceMode === 'ptt' &&
          (isMobile ? (
            <small className="muted">Telefonda ekrandaki büyük düğmeyi basılı tut.</small>
          ) : (
            <div className="row">
              <span>Tuş:</span>
              <button className={capturing ? 'primary' : ''} onClick={() => setCapturing(true)}>
                {capturing ? 'Bir tuşa bas… (Esc: iptal)' : keyLabel(settings.pttKey)}
              </button>
            </div>
          ))}
        {settings.voiceMode === 'ptt' && !isMobile && (
          <small className="muted">
            {desktop
              ? 'Masaüstü uygulamasında tuş, oyun öndeyken de çalışır.'
              : 'Tarayıcıda tuş yalnızca Çerezcord sekmesi öndeyken çalışır. Oyun öndeyken çalışması için masaüstü uygulamasını kullan.'}
          </small>
        )}
      </section>

      <section>
        <h3>TURN sunucusu (isteğe bağlı)</h3>
        <small className="muted">
          Biriyle bağlantı kurulamıyorsa (CGNAT, sıkı güvenlik duvarı) buraya bir TURN sunucusu gir. Sonraki girişte
          geçerli olur. Odadaki herkesin aynı sunucuyu girmesi en iyisi.
        </small>
        <input
          placeholder="turn:ornek.com:3478"
          value={settings.turnUrl}
          onChange={(e) => update({ turnUrl: e.target.value })}
        />
        <div className="row">
          <input
            placeholder="kullanıcı adı"
            value={settings.turnUsername}
            onChange={(e) => update({ turnUsername: e.target.value })}
          />
          <input
            placeholder="parola"
            type="password"
            value={settings.turnCredential}
            onChange={(e) => update({ turnCredential: e.target.value })}
          />
        </div>
      </section>
    </dialog>
  )
}
