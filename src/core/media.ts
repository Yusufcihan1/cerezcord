export async function getMicrophone(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  })
}

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all.filter((d) => d.kind === 'audioinput')
  } catch {
    return []
  }
}

export function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Mikrofon izni verilmedi. Tarayıcının adres çubuğundaki kilit simgesinden izin verebilirsin.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Mikrofon bulunamadı. Takılı olduğundan emin ol veya Ayarlar’dan başka bir mikrofon seç.'
    case 'NotReadableError':
      return 'Mikrofon başka bir uygulama tarafından kullanılıyor olabilir.'
    default:
      return 'Mikrofon açılamadı.'
  }
}
