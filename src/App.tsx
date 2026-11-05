import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { CerezRoom } from './core/room'
import { loadSettings, saveSettings, type Settings } from './core/storage'
import { JoinScreen, type JoinValues } from './ui/JoinScreen'
import { RoomView } from './ui/RoomView'
import { SettingsDialog } from './ui/SettingsDialog'
import { roomHash } from './ui/util'

/** "#/oda/kuzenler" (şifreli) ya da "#/acik/kuzenler" (açık) biçimindeki linkten odayı okur. */
function roomFromHash() {
  const m = location.hash.match(/^#\/(oda|acik)\/(.+)$/)
  if (!m) return null
  try {
    return { name: decodeURIComponent(m[2]), isPublic: m[1] === 'acik' }
  } catch {
    return null
  }
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [room, setRoom] = useState<CerezRoom | null>(null)
  const [joining, setJoining] = useState(false)
  const [endMessage, setEndMessage] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const updateSettings = useCallback((s: Settings) => {
    setSettings(s)
    saveSettings(s)
  }, [])

  const join = async (v: JoinValues) => {
    setJoining(true)
    setEndMessage(null)
    const next = { ...settings, name: v.name, lastRoom: v.roomName, lastRoomPublic: v.isPublic }
    updateSettings(next)
    try {
      const r = await CerezRoom.join({ ...v, settings: next })
      history.replaceState(null, '', roomHash(r.getState().roomName, v.isPublic))
      setRoom(r)
    } catch (err) {
      console.error(err)
      setEndMessage('Odaya bağlanılamadı. İnternet bağlantını kontrol edip tekrar dene.')
    } finally {
      setJoining(false)
    }
  }

  const leave = useCallback(() => {
    void room?.leave()
  }, [room])

  // Sekme kapanırken odadan düzgünce çık ki diğerleri seni hemen düşürsün.
  useEffect(() => {
    if (!room) return
    const onUnload = () => void room.leave()
    window.addEventListener('pagehide', onUnload)
    return () => window.removeEventListener('pagehide', onUnload)
  }, [room])

  const hashRoom = roomFromHash()

  return (
    <>
      {room ? (
        <RoomLifecycle
          room={room}
          onEnded={(status) => {
            setRoom(null)
            setEndMessage(
              status === 'full'
                ? 'Oda dolu. Çerezcord, odaların donmaması için en fazla 6 kişiye izin veriyor.'
                : null,
            )
          }}
        >
          <RoomView room={room} settings={settings} onOpenSettings={() => setSettingsOpen(true)} onLeave={leave} />
        </RoomLifecycle>
      ) : (
        <JoinScreen
          initialName={settings.name}
          initialRoom={hashRoom?.name ?? settings.lastRoom}
          initialPublic={hashRoom?.isPublic ?? settings.lastRoomPublic}
          endMessage={endMessage}
          joining={joining}
          onJoin={join}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          room={room}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </>
  )
}

function RoomLifecycle({
  room,
  onEnded,
  children,
}: {
  room: CerezRoom
  onEnded: (status: 'left' | 'full') => void
  children: ReactNode
}) {
  const status = useSyncExternalStore(room.subscribe, () => room.getState().status)
  useEffect(() => {
    if (status !== 'live') onEnded(status)
  }, [status, onEnded])
  return children
}
