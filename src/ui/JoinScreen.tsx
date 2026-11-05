import { useEffect, useState, type FormEvent } from 'react'
import { capabilities } from '../core/device'
import { watchPublicRooms, type PublicRoomInfo } from '../core/lobby'
import { MAX_ROOM_SIZE, NAME_MAX_LENGTH, ROOM_MAX_LENGTH } from '../core/limits'
import { cleanName } from '../core/protocol'
import { CookieLogo } from './icons'

export type JoinValues = { name: string; roomName: string; password: string; isPublic: boolean }

type Props = {
  initialName: string
  initialRoom: string
  initialPublic: boolean
  endMessage: string | null
  joining: boolean
  onJoin: (v: JoinValues) => void
  onOpenSettings: () => void
}

export function JoinScreen({ initialName, initialRoom, initialPublic, endMessage, joining, onJoin, onOpenSettings }: Props) {
  const [name, setName] = useState(initialName)
  const [tab, setTab] = useState<'private' | 'public'>(initialPublic ? 'public' : 'private')
  const [roomName, setRoomName] = useState(initialPublic ? '' : initialRoom)
  const [password, setPassword] = useState('')
  const [newPublic, setNewPublic] = useState(initialPublic ? initialRoom : '')
  const [nameMissing, setNameMissing] = useState(false)

  const cleanedName = cleanName(name)
  const privateValid = cleanedName.length > 0 && roomName.trim().length > 0 && password.length >= 4

  const joinPublic = (room: string) => {
    if (!room.trim() || joining) return
    if (!cleanedName) {
      setNameMissing(true)
      return
    }
    onJoin({ name: cleanedName, roomName: room.trim(), password: '', isPublic: true })
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (tab === 'public') joinPublic(newPublic)
    else if (privateValid && !joining) onJoin({ name: cleanedName, roomName: roomName.trim(), password, isPublic: false })
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
            onChange={(e) => {
              setName(e.target.value)
              setNameMissing(false)
            }}
            maxLength={NAME_MAX_LENGTH}
            autoComplete="nickname"
            placeholder="ör. Yusuf"
            aria-invalid={nameMissing}
            required={tab === 'private'}
          />
          {nameMissing && <small className="error">Odaya girmeden önce adını yaz.</small>}
        </label>

        <div className="segmented" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'private'}
            className={tab === 'private' ? 'on' : ''}
            onClick={() => setTab('private')}
          >
            Şifreli oda
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'public'}
            className={tab === 'public' ? 'on' : ''}
            onClick={() => setTab('public')}
          >
            Açık odalar
          </button>
        </div>

        {tab === 'private' ? (
          <>
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

            <button className="primary big" type="submit" disabled={!privateValid || joining}>
              {joining ? 'Bağlanıyor…' : 'Odaya katıl'}
              {!joining && <span aria-hidden> →</span>}
            </button>
          </>
        ) : (
          <>
            <label>
              <span>Yeni açık oda kur</span>
              <div className="inline-field">
                <input
                  value={newPublic}
                  onChange={(e) => setNewPublic(e.target.value)}
                  maxLength={ROOM_MAX_LENGTH}
                  autoCapitalize="none"
                  autoCorrect="off"
                  placeholder="ör. akşam-valorant"
                />
                <button className="primary" type="submit" disabled={!newPublic.trim() || joining}>
                  {joining ? '…' : 'Kur'}
                </button>
              </div>
              <small className="muted">Şifre yok: oda aşağıdaki listede görünür, isteyen girer.</small>
            </label>

            <PublicRoomList joining={joining} onJoin={joinPublic} />
          </>
        )}

        <button type="button" className="link" onClick={onOpenSettings}>
          Ayarlar
        </button>
      </form>
    </main>
  )
}

function PublicRoomList({ joining, onJoin }: { joining: boolean; onJoin: (room: string) => void }) {
  const [rooms, setRooms] = useState<PublicRoomInfo[]>([])
  const [searching, setSearching] = useState(true)

  useEffect(() => {
    const stop = watchPublicRooms(setRooms)
    // İlk ilanlar birkaç saniyede gelir; o zamana kadar "yok" demeyelim.
    const t = setTimeout(() => setSearching(false), 4000)
    return () => {
      stop()
      clearTimeout(t)
    }
  }, [])

  return (
    <section className="lobby" aria-live="polite">
      <h2>
        <span className="dot" /> Şu an açık odalar
      </h2>
      {rooms.length === 0 ? (
        <p className="muted lobby-empty">{searching ? 'Odalar aranıyor…' : 'Şu an açık oda yok. İlk odayı sen kur.'}</p>
      ) : (
        <ul>
          {rooms.map((r) => {
            const full = r.count >= MAX_ROOM_SIZE
            return (
              <li key={r.room}>
                <button
                  type="button"
                  className="lobby-room"
                  disabled={full || joining}
                  onClick={() => onJoin(r.room)}
                  title={full ? 'Oda dolu' : `${r.room} odasına katıl`}
                >
                  <span className="lobby-name">
                    <span className="hash">#</span>
                    {r.room}
                  </span>
                  <span className={`lobby-count ${full ? 'full' : ''}`}>
                    {full ? 'Dolu' : `${r.count}/${MAX_ROOM_SIZE}`}
                  </span>
                  <span className="lobby-pips" aria-hidden>
                    {Array.from({ length: MAX_ROOM_SIZE }, (_, i) => (
                      <i key={i} className={i < r.count ? 'on' : ''} />
                    ))}
                  </span>
                  <span className="lobby-names muted">{r.names.join(', ')}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
