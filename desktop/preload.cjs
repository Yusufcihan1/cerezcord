// Web sayfasına açılan tek kapı: genel bas-konuş tuşu. Başka hiçbir Node/Electron yeteneği verilmez.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('cerezDesktop', {
  version: 1,
  /** KeyboardEvent.code (ör. "KeyV"); null: kapat. Tuş desteklenmiyorsa false döner. */
  setPttKey: (code) => ipcRenderer.invoke('ptt:set-key', code),
  /** Pencere arka plandayken tuşa basılınca/bırakılınca çağrılır. Dinlemeyi bırakan fonksiyon döner. */
  onPtt: (fn) => {
    const listener = (_e, down) => fn(down === true)
    ipcRenderer.on('ptt', listener)
    return () => ipcRenderer.removeListener('ptt', listener)
  },
})
