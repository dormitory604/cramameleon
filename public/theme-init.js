// Apply the saved appearance before the first paint, under script-src 'self'.
try {
  const theme = localStorage.getItem('cramameleon.theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {}
