// Must stay the first import: installs the COSTGOBLIN_NOW fake clock (e2e
// only) before any app module can read Date.
import './fake-clock.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './app.css';

const rootElement = document.getElementById('root');
if (rootElement !== null) {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
