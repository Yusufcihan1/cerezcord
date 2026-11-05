import { useState, type FormEvent } from 'react'
import { capabilities } from '../core/device'
import { NAME_MAX_LENGTH, ROOM_MAX_LENGTH } from '../core/limits'
import { cleanName } from '../core/protocol'
import { CookieLogo } from './icons'

export type JoinValues = { name: string; roomName: string; password: string }

type Props = {
  initialName: string
  initialRoom: string
  endMessage: string | null
  joining: boolean
  onJoin: (v: JoinValues) => void
  onOpenSettings: () => void
}

export function JoinScreen({ initialName, initialRoom, endMessage, joining, onJoin, onOpenSettings }: Props) {
  const [name, setName] = useState(initialName)
  const [roomName, setRoomName] = useState(initialRoom)
  const [password, setPassword] = useState('')

  const valid = cleanName(name).length > 0 && roomName.trim().length > 0 && password.length >= 4

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (valid && !joining) onJoin({ name: cleanName(name), roomName: roomName.trim(), password })
  }

  return (
    <main className="join">
      <form className="join-card" onSubmit={submit}>
        <div className="brand">
          <CookieLogo width={60} height={60} className="logo-glow" />
          <h1>Çerezcord</h1>
          <p className="tagline">{'// P2P sesli oda · uçtan uca şifreli'}</p>
        </div>

        {!capabilities.secureContext && (
          <p className="banner warn">Bu sayfa HTTPS üzerinden açılmadığı için mikrofon çalışmaz.</p>
        )}
        {endMessage && <p className="banner">{endMessage}</p>}

        <label>
          <span>Adın</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={NAME_MAX_LENGTH}
            autoComplete="nickname"
            placeholder="ör. Yusuf"
            required
          />
        </label>
        <label>
          <span>Oda adı</span>
          <input
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            maxLength={ROOM_MAX_LENGTH}
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="ör. kuzenler"
            required
          />
        </label>
        <label>
          <span>Oda şifresi</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            placeholder="en az 4 karakter"
            required
          />
          <small className="muted">Aynı oda adı ve şifreyi giren herkes aynı odaya düşer.</small>
        </label>

        <button className="primary big" type="submit" disabled={!valid || joining}>
          {joining ? 'Bağlanıyor…' : 'Odaya katıl'}
          {!joining && <span aria-hidden> →</span>}
        </button>
        <button type="button" className="link" onClick={onOpenSettings}>
          Ayarlar
        </button>
      </form>
    </main>
  )
}
