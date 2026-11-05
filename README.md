# 🍪 Çerezcord

Kuzenlerle, arkadaşlarla oyun oynarken konuşmak için **sunucusuz (P2P mesh)** sesli oda uygulaması.
Aynı link hem PC tarayıcısında hem telefon tarayıcısında çalışır; telefonda "Ana ekrana ekle" ile uygulama gibi kullanılır (PWA).

## Nasıl çalışır?

- Ses doğrudan kişiler arasında gider (WebRTC, uçtan uca şifreli DTLS-SRTP). Arada medya sunucusu yok.
- Eşleşme (sinyalleşme) [Trystero](https://github.com/dmotz/trystero) ile halka açık Nostr sunucuları üzerinden yapılır.
  Oda şifresi bu mesajları da şifreler.
- Odaya girmek için **oda adı + şifre** yeterli. Aynı ikisini giren herkes aynı odaya düşer.
- **Açık odalar:** isteyen şifresiz bir açık oda kurar; oda "Açık odalar" listesinde adı, doluluğu
  (ör. 3/6) ve içindekilerin adlarıyla görünür, isteyen tıklayıp girer (`.../#/acik/oda-adi`).
  Liste için sunucu yok: odadaki en eski kişi odayı 30 sn'de bir halka açık Nostr sunucularına ilan
  eder (`src/core/lobby.ts`); ilanı yenilenmeyen oda ~75 sn içinde, son kişi çıkınca hemen listeden düşer.
  Açık odalar şifreli odalardan ayrı bir ad alanındadır; aynı adlı şifreli odayla karışmaz.
  Ses yine doğrudan ve şifreli gider; oda adı ve içindekilerin adları ise herkese açıktır.

## Özellikler (Aşama 1)

- Sesli oda, konuşanın etrafında yeşil halka, kişi başı ping
- Mikrofon kapat / sağır ol, kişi başı ses seviyesi (%0–200, isimle hatırlanır)
- Konuşma modu: **sesle açılır** veya **bas-konuş** (PC'de tuş, telefonda basılı tutulan düğme)
- Yazılı sohbet (kaydedilmez; odadan çıkınca silinir)
- Sohbette dosya paylaşımı: ataç düğmesi, sürükle-bırak veya yapıştır. Resimler önizlenir, diğer dosyalar
  "İndir" ile iner. Dosyalar sunucuya gitmez, kişiler arasında doğrudan gider ve odadan çıkınca silinir.
- Telefon: ekran açık kalır (Wake Lock), sekme arka plandan dönünce ses toparlanır
- Mikrofon yoksa/izin verilmezse dinleyici olarak katılma
- İsteğe bağlı TURN sunucusu ayarı (CGNAT arkasındakiler için)

## Sınırlar (çökmemesi için)

Hepsi `src/core/limits.ts` içinde:

| Sınır | Değer |
|---|---|
| Oda başına kişi | 6 (fazlası kendiliğinden "Oda dolu" ile çıkar) |
| Ses bit hızı | 32 kbps, yüksek ağ önceliği |
| Sohbet | 500 karakter, kişi başı 5 sn'de en fazla 5 mesaj, son 200 mesaj |
| Dosya | en fazla 25 MB, kişi başı dakikada 5 dosya; kişilere sırayla gönderilir (ses takılmasın) |

## Geliştirme

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # dist/ klasörüne üretir
```

Mikrofon yalnızca HTTPS'te (veya localhost'ta) çalışır.
Aynı ağdaki telefondan denemek için yayınlanmış (HTTPS) sürümü kullanın.

### Kendi sinyal sunucularını kullanmak

Halka açık Nostr sunucuları yerine kendi listenizi vermek için:

```bash
VITE_NOSTR_RELAYS="wss://relay1.ornek.com,wss://relay2.ornek.com" npm run build
```

## Yayınlama (GitHub Pages, ücretsiz)

1. Bu klasörü bir GitHub deposuna gönderin (`main` dalı).
2. Depo → **Settings → Pages → Source: GitHub Actions** seçin.
3. Her `main` gönderiminde `.github/workflows/deploy.yml` otomatik yayınlar.
4. Link: `https://<kullanıcı>.github.io/<depo>/` — oda linki: `.../#/oda/kuzenler`, açık oda: `.../#/acik/kuzenler`

## Yol haritası

- **Aşama 2:** kamera, ekran paylaşımı (tek yayıncı, "İzle" ile abonelik), upload bütçesi, kalite bekçisi
- **Aşama 3:** Electron masaüstü sürümü (oyun öndeyken çalışan bas-konuş tuşu, `.exe`, otomatik güncelleme)
