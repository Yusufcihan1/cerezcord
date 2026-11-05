export function initials(name: string) {
  const parts = name.trim().split(/\s+/)
  const s = (parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')
  return s.toLocaleUpperCase('tr') || '?'
}

/** İsimden sabit bir renk tonu (herkeste aynı görünür). */
export function hue(name: string) {
  let h = 2166136261
  for (const ch of name) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0
  return h % 360
}

export function keyLabel(code: string) {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  const map: Record<string, string> = {
    Space: 'Boşluk',
    Backquote: '"',
    CapsLock: 'Caps Lock',
    ShiftLeft: 'Sol Shift',
    ShiftRight: 'Sağ Shift',
    ControlLeft: 'Sol Ctrl',
    ControlRight: 'Sağ Ctrl',
    AltLeft: 'Sol Alt',
    AltRight: 'Sağ Alt',
    Tab: 'Tab',
  }
  return map[code] ?? code
}

export function timeLabel(ts: number) {
  return new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
}

export function isTypingTarget(el: EventTarget | null) {
  if (!(el instanceof HTMLElement)) return false
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
}
