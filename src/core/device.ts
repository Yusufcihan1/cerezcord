export type DeviceKind = 'pc' | 'mobile'

export const deviceKind: DeviceKind = (() => {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } }
  if (typeof nav.userAgentData?.mobile === 'boolean') return nav.userAgentData.mobile ? 'mobile' : 'pc'
  const ua = navigator.userAgent
  // iPadOS kendini Mac olarak tanıtıyor; dokunmatik ekranla ayırt ediyoruz.
  const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || iPadOS ? 'mobile' : 'pc'
})()

export const isMobile = deviceKind === 'mobile'

export const capabilities = {
  microphone: !!navigator.mediaDevices?.getUserMedia,
  // Telefon tarayıcılarında ekran paylaşımı yok (Aşama 2'de kullanılacak).
  screenShare: !isMobile && !!navigator.mediaDevices?.getDisplayMedia,
  wakeLock: 'wakeLock' in navigator,
  secureContext: window.isSecureContext,
}
