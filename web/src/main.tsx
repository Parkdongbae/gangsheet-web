import { installWebApi } from './api/webApi'
import { installAutosave } from './api/autosave'
import './app.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@renderer/App'

installWebApi()
installAutosave()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
