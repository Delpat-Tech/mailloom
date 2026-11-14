// Applies the saved Light/Dark choice before the first paint. A file (not inline) so the CSP can forbid inline scripts.
try {
  var t = localStorage.getItem('mailloom.theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) { /* storage blocked: follow the system */ }
