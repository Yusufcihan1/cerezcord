import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
} from 'react'
import { isMobile } from '../core/device'
import { CHAT_MAX_LENGTH, FILE_MAX_BYTES, MAX_ROOM_SIZE, VOLUME_MAX, VOLUME_MIN } from '../core/limits'
import { SELF, type CerezRoom, type ChatEntry, type PeerInfo, type RoomState } from '../core/room'
import type { Settings } from '../core/storage'
import {
  CookieLogo,
  FileIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  LeaveIcon,
  LinkIcon,
  MicIcon,
  MicOffIcon,
  PaperclipIcon,
  PhoneIcon,
  SendIcon,
  SettingsIcon,
} from './icons'
import { hue, initials, isTypingTarget, keyLabel, roomHash, sizeLabel, timeLabel } from './util'

type Props = {
  room: CerezRoom
  settings: Settings
  onOpenSettings: () => void
  onLeave: () => void
}

export function RoomView({ room, settings, onOpenSettings, onLeave }: Props) {
  const s = useSyncExternalStore(room.subscribe, room.getState)
  const [tab, setTab] = useState<'people' | 'chat'>('people')
  const [copied, setCopied] = useState(false)
  const [seenChat, setSeenChat] = useState(0)

  usePttKeyboard(room, s.voiceMode === 'ptt' && !isMobile, settings.pttKey)

  const peers = Object.values(s.peers).sort((a, b) => a.joinedAt - b.joinedAt)
  const total = peers.length + 1
  const chatCount = s.chat.filter((c) => c.kind === 'message').length
  const unread = tab === 'chat' ? 0 : chatCount - seenChat

  const copyLink = async () => {
    const url = `${location.origin}${location.pathname}${roomHash(s.roomName, s.isPublic)}`
    try {
      if (isMobile && navigator.share) {
        await navigator.share({ title: 'Çerezcord', text: `"${s.roomName}" odasına gel`, url })
        return
      }
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* kullanıcı iptal etti */
    }
  }

  return (
    <div className="room">
      <header className="topbar">
        <CookieLogo width={28} height={28} />
        <div className="room-title">
          <strong>
            <span className="hash">#</span>
            {s.roomName}
          </strong>
          <span className="muted mono">
            {total}/{MAX_ROOM_SIZE} kişi
          </span>
        </div>
        <span
          className="chip"
          title={
            s.isPublic
              ? 'Şifresiz oda: adını bilen herkes girebilir. Ses yine doğrudan ve şifreli gider.'
              : 'Ses doğrudan kişiler arasında, şifreli gider'
          }
        >
          <span className="dot" /> {s.isPublic ? 'P2P · Açık oda' : 'P2P · Şifreli'}
        </span>
        <button className="icon-btn" onClick={copyLink} title="Oda linkini paylaş" aria-label="Oda linkini paylaş">
          <LinkIcon />
          {copied && <span className="tooltip">Kopyalandı</span>}
        </button>
        <button className="icon-btn" onClick={onOpenSettings} title="Ayarlar" aria-label="Ayarlar">
          <SettingsIcon />
        </button>
      </header>

      <nav className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'people'}
          onClick={() => {
            // Sohbetten çıkarken o ana kadarki mesajlar okunmuş sayılır.
            if (tab === 'chat') setSeenChat(chatCount)
            setTab('people')
          }}
        >
          Kişiler
        </button>
        <button role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>
          Sohbet {unread > 0 && <span className="badge">{unread}</span>}
        </button>
      </nav>

      <div className="content" data-tab={tab}>
        <section className="people">
          {s.notice && (
            <div className="banner warn" role="status">
              <span>{s.notice}</span>
              <button className="link" onClick={() => room.dismissNotice()}>
                Tamam
              </button>
            </div>
          )}
          <div className="grid">
            <SelfTile s={s} />
            {peers.map((p) => (
              <PeerTile key={p.id} peer={p} speaking={s.speaking.has(p.id)} onVolume={(v) => room.setVolume(p.id, v)} />
            ))}
          </div>
          {peers.length === 0 && (
            <p className="empty muted">
              Odada şimdilik tek başınasın. Linki paylaş,{' '}
              {s.isPublic ? 'arkadaşların linkle doğrudan girebilir.' : 'arkadaşların aynı oda adı ve şifreyle girsin.'}
            </p>
          )}
        </section>

        <Chat room={room} s={s} />
      </div>

      <footer className="controls">
        <button
          className={`ctl ${s.muted || s.micError ? 'danger' : ''}`}
          onClick={() => room.toggleMute()}
          disabled={!!s.micError}
          aria-pressed={s.muted}
          title={s.muted ? 'Mikrofonu aç' : 'Mikrofonu kapat'}
        >
          {s.muted || s.micError ? <MicOffIcon /> : <MicIcon />}
          <span>{s.micError ? 'Mikrofon yok' : s.muted ? 'Kapalı' : 'Mikrofon'}</span>
        </button>
        <button
          className={`ctl ${s.deafened ? 'danger' : ''}`}
          onClick={() => room.toggleDeafen()}
          aria-pressed={s.deafened}
          title={s.deafened ? 'Sesi aç' : 'Kimseyi duyma'}
        >
          {s.deafened ? <HeadphonesOffIcon /> : <HeadphonesIcon />}
          <span>{s.deafened ? 'Sağır' : 'Kulaklık'}</span>
        </button>

        {s.voiceMode === 'ptt' && !s.micError && <PttButton room={room} down={s.pttDown} keyName={keyLabel(settings.pttKey)} />}

        <button className="ctl leave" onClick={onLeave} title="Odadan ayrıl">
          <LeaveIcon />
          <span>Ayrıl</span>
        </button>
      </footer>
    </div>
  )
}

// ---------------- kişiler ----------------

function Avatar({ name, speaking }: { name: string; speaking: boolean }) {
  return (
    <div className={`avatar ${speaking ? 'speaking' : ''}`} style={{ '--h': hue(name) } as CSSProperties}>
      {initials(name)}
    </div>
  )
}

function SelfTile({ s }: { s: RoomState }) {
  const transmitting = s.speaking.has(SELF) && !s.muted && !s.deafened && (s.voiceMode === 'vad' || s.pttDown)
  return (
    <div className={`tile self ${transmitting ? 'active' : ''}`}>
      <Avatar name={s.name} speaking={transmitting} />
      <div className="tile-name">
        {s.name} <span className="muted">(sen)</span>
      </div>
      <StatusIcons muted={s.muted || !!s.micError} deafened={s.deafened} mobile={isMobile} />
      <div className="tile-sub muted">{s.voiceMode === 'ptt' ? 'Bas-konuş' : 'Sesle açılır'}</div>
    </div>
  )
}

function PeerTile({ peer, speaking, onVolume }: { peer: PeerInfo; speaking: boolean; onVolume: (v: number) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`tile ${peer.known ? '' : 'pending'} ${speaking && !peer.muted ? 'active' : ''}`}>
      <button className="tile-hit" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`${peer.name} ses ayarı`}>
        <Avatar name={peer.name} speaking={speaking && !peer.muted} />
      </button>
      <div className="tile-name">{peer.known ? peer.name : 'Bağlanıyor…'}</div>
      <StatusIcons muted={peer.muted} deafened={peer.deafened} mobile={peer.device === 'mobile'} />
      <div className="tile-sub muted">
        {peer.ping != null ? <PingLabel ms={peer.ping} /> : '—'}
        {peer.volume !== 100 && <> · %{peer.volume}</>}
      </div>
      {open && (
        <label className="volume">
          <span>Ses %{peer.volume}</span>
          <input
            type="range"
            min={VOLUME_MIN}
            max={VOLUME_MAX}
            step={5}
            value={peer.volume}
            onChange={(e) => onVolume(Number(e.target.value))}
            onDoubleClick={() => onVolume(100)}
          />
        </label>
      )}
    </div>
  )
}

function PingLabel({ ms }: { ms: number }) {
  const cls = ms < 80 ? 'good' : ms < 180 ? 'ok' : 'bad'
  return <span className={`ping mono ${cls}`}>{ms} ms</span>
}

function StatusIcons({ muted, deafened, mobile }: { muted: boolean; deafened: boolean; mobile: boolean }) {
  if (!muted && !deafened && !mobile) return null
  return (
    <div className="status-icons">
      {mobile && <PhoneIcon width={14} height={14} aria-label="Telefondan" />}
      {muted && <MicOffIcon width={14} height={14} className="red" aria-label="Mikrofon kapalı" />}
      {deafened && <HeadphonesOffIcon width={14} height={14} className="red" aria-label="Sağır" />}
    </div>
  )
}

// ---------------- bas-konuş ----------------

function PttButton({ room, down, keyName }: { room: CerezRoom; down: boolean; keyName: string }) {
  return (
    <button
      className={`ctl ptt ${down ? 'on' : ''}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        room.setPtt(true)
      }}
      onPointerUp={() => room.setPtt(false)}
      onPointerCancel={() => room.setPtt(false)}
      onContextMenu={(e) => e.preventDefault()}
      aria-pressed={down}
    >
      <MicIcon />
      <span>{down ? 'Konuşuyorsun' : isMobile ? 'Basılı tut' : `Basılı tut (${keyName})`}</span>
    </button>
  )
}

function usePttKeyboard(room: CerezRoom, enabled: boolean, code: string) {
  useEffect(() => {
    if (!enabled) return
    const down = (e: KeyboardEvent) => {
      if (e.code !== code || e.repeat || isTypingTarget(e.target)) return
      e.preventDefault()
      room.setPtt(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === code) room.setPtt(false)
    }
    const release = () => room.setPtt(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', release)
      room.setPtt(false)
    }
  }, [room, enabled, code])
}

// ---------------- sohbet ----------------

function Chat({ room, s }: { room: CerezRoom; s: RoomState }) {
  const [text, setText] = useState('')
  const [warn, setWarn] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const listRef = useRef<HTMLOListElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const stick = useRef(true)

  const sendFiles = (files: Iterable<File>) => {
    for (const f of files) {
      const err = room.sendFile(f)
      setWarn(err)
      if (err) break
      stick.current = true
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    sendFiles(e.dataTransfer.files)
  }

  // Panodan yapıştırılan ekran görüntüsü de dosya olarak gider.
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files]
    if (files.length === 0) return
    e.preventDefault()
    sendFiles(files)
  }

  useEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [s.chat])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    if (room.sendChat(text)) {
      setText('')
      setWarn(null)
      stick.current = true
    } else {
      setWarn('Çok hızlı yazıyorsun, biraz bekle.')
    }
  }

  return (
    <aside
      className={`chat ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <ol
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {s.chat.length === 0 && (
          <li className="system muted">Mesajlar ve dosyalar kaydedilmez; odadan çıkınca silinir.</li>
        )}
        {s.chat.map((m) =>
          m.kind === 'system' ? (
            <li key={m.id} className="system muted">
              {m.text}
            </li>
          ) : (
            <li key={m.id} className={m.fromId === s.selfId ? 'mine' : ''}>
              <div className="meta">
                <strong style={{ color: `hsl(${hue(m.name)} 70% 68%)` }}>{m.name}</strong>
                <time className="muted mono">{timeLabel(m.ts)}</time>
              </div>
              {m.file ? <FileCard file={m.file} /> : <p>{m.text}</p>}
            </li>
          ),
        )}
      </ol>
      {warn && <p className="chat-warn">{warn}</p>}
      <form className="composer" onSubmit={submit}>
        <input
          ref={fileRef}
          type="file"
          hidden
          multiple
          onChange={(e) => {
            sendFiles(e.target.files ?? [])
            e.target.value = ''
          }}
        />
        <button
          type="button"
          className="icon-btn"
          aria-label="Dosya gönder"
          title={`Dosya gönder (en fazla ${Math.round(FILE_MAX_BYTES / 1024 ** 2)} MB)`}
          onClick={() => fileRef.current?.click()}
        >
          <PaperclipIcon />
        </button>
        <input
          onPaste={onPaste}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={CHAT_MAX_LENGTH}
          placeholder="Mesaj yaz…"
          enterKeyHint="send"
          aria-label="Mesaj"
        />
        <button className="icon-btn primary" type="submit" aria-label="Gönder" disabled={!text.trim()}>
          <SendIcon />
        </button>
      </form>
    </aside>
  )
}

function FileCard({ file }: { file: NonNullable<ChatEntry['file']> }) {
  const busy = file.status === 'sending' || file.status === 'receiving'
  const pct = Math.round(file.progress * 100)
  const statusText =
    file.status === 'sending'
      ? `Gönderiliyor %${pct}`
      : file.status === 'receiving'
        ? `Alınıyor %${pct}`
        : file.status === 'failed'
          ? 'Aktarılamadı'
          : sizeLabel(file.size)
  return (
    <div className={`file-card ${file.status}`}>
      {file.isImage && file.url && file.status !== 'failed' && (
        <a href={file.url} download={file.name} className="file-preview" title="İndir">
          <img src={file.url} alt={file.name} />
        </a>
      )}
      <div className="file-row">
        <FileIcon width={18} height={18} />
        <span className="file-name" title={file.name}>
          {file.name}
        </span>
        <span className="file-status mono">{statusText}</span>
        {file.url && file.status === 'done' && (
          <a className="file-download" href={file.url} download={file.name}>
            İndir
          </a>
        )}
      </div>
      {busy && (
        <div className="file-progress" aria-hidden>
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}
