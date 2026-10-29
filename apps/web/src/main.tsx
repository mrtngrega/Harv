import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './index.css';
import { App } from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { PhoneGate } from './components/phone/PhoneGate.tsx';
import { isPhone } from './lib/phone.ts';
import { startSocket } from './lib/socket.ts';
import './lib/layout.ts';
import './lib/desktop.ts';

// On the phone (docs/PLAN.md §6q) the connection waits for pairing and Face ID.
if (!isPhone) startSocket();
else document.documentElement.classList.add('phone');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary whole>
      {isPhone ? (
        <PhoneGate>
          <App />
        </PhoneGate>
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </StrictMode>,
);
