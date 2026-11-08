// Çerezcord masaüstü kabuğu. Web sürümünün aynısını (aynı adres, aynı odalar) bir pencerede açar;
// tarayıcının yapamadığı tek şeyi ekler: oyun öndeyken de çalışan bas-konuş tuşu.
const { app, BrowserWindow, ipcMain, session, shell, Menu } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// Web sürümü güncellendikçe uygulama da güncel kalır; yeni exe gerekmez.
const APP_URL = process.env.CEREZCORD_URL || 'https://yusufcihan1.github.io/cerezcord/'
const APP_ORIGIN = new URL(APP_URL).origin
const APP_PATH = new URL(APP_URL).pathname

/** Uygulamanın kendi sayfası mı (aynı site, aynı alt klasör)? */
const isAppUrl = (url) => {
  try {
    const u = new URL(url)
    return u.origin === APP_ORIGIN && u.pathname.startsWith(APP_PATH)
  } catch {
    return false
  }
}

if (!app.requestSingleInstanceLock()) app.quit()

/** @type {BrowserWindow | null} */
let win = null

// ---------- genel bas-konuş tuşu ----------

// KeyboardEvent.code -> uiohook tuş adı. İkisi de klavye düzeninden bağımsız (fiziksel tuş).
const CODE_ALIASES = {
  ControlLeft: 'Ctrl',
  ControlRight: 'CtrlRight',
  AltLeft: 'Alt',
  AltRight: 'AltRight',
  ShiftLeft: 'Shift',
  ShiftRight: 'ShiftRight',
  MetaLeft: 'Meta',
  MetaRight: 'MetaRight',
}

function uiohookName(code) {
  if (CODE_ALIASES[code]) return CODE_ALIASES[code]
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  return code
}

let hook = null
let pttKeycode = null
let pttDown = false

function sendPtt(down) {
  if (pttDown === down) return
  pttDown = down
  win?.webContents.send('ptt', down)
}

function startHook() {
  try {
    const { uIOhook, UiohookKey } = require('uiohook-napi')
    hook = { uIOhook, UiohookKey }
    // Pencere öndeyken tuşu web sayfası kendisi dinler (sohbete yazarken tetiklenmesin diye);
    // burası yalnız pencere arka plandayken devreye girer.
    uIOhook.on('keydown', (e) => {
      if (e.keycode === pttKeycode && !win?.isFocused()) sendPtt(true)
    })
    uIOhook.on('keyup', (e) => {
      if (e.keycode === pttKeycode) sendPtt(false)
    })
    uIOhook.start()
  } catch (err) {
    console.error('Genel tuş dinleyicisi başlatılamadı:', err)
    hook = null
  }
}

ipcMain.handle('ptt:set-key', (event, code) => {
  if (event.sender !== win?.webContents) return false
  if (typeof code !== 'string' || !hook) {
    pttKeycode = null
    sendPtt(false)
    return false
  }
  const keycode = hook.UiohookKey[uiohookName(code)]
  pttKeycode = typeof keycode === 'number' ? keycode : null
  sendPtt(false)
  return pttKeycode !== null
})

// ---------- pencere ----------

function errorPage(message) {
  const html = `<!doctype html><meta charset="utf-8"><title>Çerezcord</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#f2f2f2;font:15px system-ui">
<div style="text-align:center;max-width:360px">
<p style="color:#76b900;font-weight:700;letter-spacing:.06em">ÇEREZCORD</p>
<p>${message}</p>
<button onclick="location.href=${JSON.stringify(APP_URL)}" style="background:#76b900;border:0;padding:.7rem 1.2rem;font-weight:700;cursor:pointer">Tekrar dene</button>
</div></body>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#0a0a0a',
    title: 'Çerezcord',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Pencere küçültülünce de ses, konuşma algılama ve ping çalışmaya devam etsin.
      backgroundThrottling: false,
    },
  })

  // Uygulama dışı linkler varsayılan tarayıcıda açılır; pencere başka siteye gitmez.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (isAppUrl(url) || url.startsWith('data:text/html')) return
    e.preventDefault()
    if (/^https?:/.test(url)) void shell.openExternal(url)
  })

  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    // -3: kullanıcı/yönlendirme iptali, hata değil
    if (!isMainFrame || code === -3 || !isAppUrl(url)) return
    void win?.loadURL(errorPage('Çerezcord açılamadı. İnternet bağlantını kontrol et.'))
  })

  // Electron 45, sitenin service worker önbelleğini (CacheStorage) açarken render sürecini
  // öldürüyor ve pencere siyah kalıyor. Masaüstünde service worker kullanılmaz: açılışta
  // temizlenir, yine çökerse temizleyip bir kez yeniden yüklenir.
  let crashReloads = 0
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || !win || crashReloads >= 2) return
    crashReloads++
    void clearSwStorage().then(() => win?.loadURL(APP_URL))
  })

  win.on('closed', () => {
    win = null
  })

  void clearSwStorage().then(() => win?.loadURL(APP_URL))
}

function clearSwStorage() {
  return session.defaultSession
    .clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })
    .catch(() => {})
}

app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)

  // Yalnız uygulamanın kendi sayfası mikrofon ve pano isteyebilir; ekran/kamera vb. reddedilir.
  const allowed = new Set(['media', 'clipboard-sanitized-write', 'fullscreen'])
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const okOrigin = isAppUrl(details.requestingUrl || wc.getURL())
    if (permission === 'media') {
      const types = details.mediaTypes ?? []
      return callback(okOrigin && types.every((t) => t === 'audio'))
    }
    callback(okOrigin && allowed.has(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return requestingOrigin === APP_ORIGIN && allowed.has(permission)
  })

  startHook()
  createWindow()
})

app.on('window-all-closed', () => {
  try {
    hook?.uIOhook.stop()
  } catch {
    /* zaten durmuş */
  }
  app.quit()
})
