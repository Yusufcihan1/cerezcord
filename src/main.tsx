import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import '@fontsource-variable/inter'
import '@fontsource/jetbrains-mono/500.css'
import './index.css'
import App from './App.tsx'

// Yeni sürüm yayınlanınca, sayfa bir sonraki açılışta kendiliğinden güncellenir.
registerSW({ immediate: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
