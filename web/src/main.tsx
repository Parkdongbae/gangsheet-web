import { installWebApi } from './api/webApi'
import { bootAutosaveRestore, installAutosave } from './api/autosave'
import './app.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@renderer/App'
import { Analytics } from '@vercel/analytics/react'

installWebApi()
installAutosave()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <Analytics />
  </StrictMode>
)

void bootAutosaveRestore()
