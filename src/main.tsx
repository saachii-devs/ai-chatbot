import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary'
import { SessionsProvider } from './state/SessionsContext'
import { CallProvider } from './state/CallContext'
import { FluidProvider } from './state/FluidContext'

// The boundary sits OUTSIDE SessionsProvider so it also catches a throw from
// the provider's lazy initializer reading corrupt localStorage.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <SessionsProvider>
        <CallProvider>
          <FluidProvider>
            <App />
          </FluidProvider>
        </CallProvider>
      </SessionsProvider>
    </ErrorBoundary>
  </StrictMode>,
)
