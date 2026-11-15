import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import './index.css';
import './motion.css';
import { ConnectConsent } from './components/ConnectConsent.js';
import { parseConnectHash } from './services/connect.js';
import { applyThemeChoice, readThemeChoice } from './services/theme.js';

applyThemeChoice(readThemeChoice());

/** "#/connect/<id>" (Connect Mailloom, from another app) is its own screen; everything else is the mail app. */
function Root() {
  const [connectId, setConnectId] = useState(() => parseConnectHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setConnectId(parseConnectHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return connectId ? <ConnectConsent key={connectId} requestId={connectId} /> : <App />;
}

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>
  );
}
