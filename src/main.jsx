import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { initServiceWorker } from './services/serviceWorkerManager.js';
import { initFrontendSentry, SentryErrorBoundary } from './services/sentryService.js';
import { migrateLegacyStorage } from './utils/legacyStorageMigration.js';

migrateLegacyStorage();
initFrontendSentry();
initServiceWorker();

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <SentryErrorBoundary>
        <App />
      </SentryErrorBoundary>
    </React.StrictMode>
  );
}
