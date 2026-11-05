// Masaüstü uygulamasında (Electron) çalışırken preload'un açtığı köprü; tarayıcıda null.

type DesktopBridge = {
  version: number
  /** KeyboardEvent.code; null: kapat. Tuş desteklenmiyorsa false döner. */
  setPttKey: (code: string | null) => Promise<boolean>
  /** Pencere arka plandayken (oyun öndeyken) tuşa basılıp bırakılınca çağrılır */
  onPtt: (fn: (down: boolean) => void) => () => void
}

export const desktop: DesktopBridge | null =
  (window as Window & { cerezDesktop?: DesktopBridge }).cerezDesktop ?? null
