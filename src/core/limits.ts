// Çerezcord'un tüm sınırları tek yerde. Mesh'in çökmemesi için bu değerlerle oynarken dikkatli olun.

export const APP_ID = 'cerezcord-v1'

/** Açık (şifresiz) odalar ayrı bir ad alanında; aynı adlı şifreli odayla karışmaz. */
export const PUBLIC_APP_ID = 'cerezcord-v1-acik'

/** Oda başına en fazla kişi (kendin dahil). 6 kişi = 15 P2P bağlantı. */
export const MAX_ROOM_SIZE = 6

/** Ses: Opus, mono. Bağlantı başına en fazla bit hızı (bps). */
export const AUDIO_MAX_BITRATE = 32_000

/** Sohbet */
export const CHAT_MAX_LENGTH = 500
export const CHAT_HISTORY_LIMIT = 200
/** Kişi başı: bu süre içinde en fazla bu kadar mesaj */
export const CHAT_RATE_WINDOW_MS = 5_000
export const CHAT_RATE_MAX = 5

/**
 * Dosya paylaşımı. Sunucu yok: gönderen dosyayı her kişiye ayrı ayrı yükler, bu yüzden boyut sınırlı
 * ve kişilere sırayla gönderilir (aynı anda değil), ses takılmasın.
 */
export const FILE_MAX_BYTES = 25 * 1024 ** 2
/** Kişi başı: bu süre içinde en fazla bu kadar dosya */
export const FILE_RATE_WINDOW_MS = 60_000
export const FILE_RATE_MAX = 5
/** Bir kişiden aynı anda gelebilecek dosya sayısı */
export const FILE_INCOMING_MAX = 3
export const FILE_NAME_MAX_LENGTH = 120

/** İsim ve oda adı */
export const NAME_MAX_LENGTH = 24
export const ROOM_MAX_LENGTH = 32

/** Ping ölçüm aralığı */
export const PING_INTERVAL_MS = 5_000

/** Konuşma algılama eşiği (0..1 RMS) ve kontrol sıklığı */
export const SPEAKING_THRESHOLD = 0.02
export const SPEAKING_POLL_MS = 100
/** Konuşma bittikten sonra halkanın sönmesi için bekleme */
export const SPEAKING_HOLD_MS = 250

/** Kişi başı ses seviyesi aralığı (%) */
export const VOLUME_MIN = 0
export const VOLUME_MAX = 200
