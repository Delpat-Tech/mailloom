// Registers the service worker. Kept as a file (not inline) so the page's CSP can forbid inline scripts.
if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.debug('ServiceWorker registration skipped:', err);
    });
  });
}
