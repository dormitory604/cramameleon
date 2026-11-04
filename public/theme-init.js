// Apply the saved appearance before the first paint, under script-src 'self'.
{
  let theme = 'light';
  try { if (localStorage.getItem('cramameleon.theme') === 'dark') theme = 'dark'; } catch {}
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#1b1a18' : '#fffbf5');
}
