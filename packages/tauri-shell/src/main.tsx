import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installBridge } from './bridge';
import '../app.css';

// Install window.costgoblin / costgoblinUpdate / costgoblinDebug BEFORE the
// renderer module is evaluated — App.tsx reads globalThis.costgoblinDebug at
// module-eval time, and getApi() reads globalThis.costgoblin on render. The
// dynamic import guarantees the App module evaluates only after the bridge is
// in place.
installBridge();

void import('../../desktop/src/renderer/App').then(({ App }) => {
  const rootElement = document.getElementById('root');
  if (rootElement !== null) {
    createRoot(rootElement).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  }
});
