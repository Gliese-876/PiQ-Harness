'use strict';

(() => {
  const valid = value => ['system', 'light', 'dark', 'midnight', 'rose', 'paper'].includes(value);
  const query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : { matches: true };
  let mode = 'system';
  try { const saved = localStorage.getItem('piq:theme'); if (valid(saved)) mode = saved; } catch { /* Storage is optional. */ }
  function apply() {
    const palette = mode === 'system' ? (query.matches ? 'dark' : 'light') : mode;
    document.documentElement.dataset.theme = palette;
    document.documentElement.dataset.themeMode = mode;
    document.documentElement.style.colorScheme = ['light', 'paper'].includes(palette) ? 'light' : 'dark';
    const select = document.getElementById('theme-mode');
    if (select) select.value = mode;
  }
  // This script runs in the head, before the stylesheet and first paint.
  apply();
  const systemChanged = () => { if (mode === 'system') apply(); };
  if (query.addEventListener) query.addEventListener('change', systemChanged);
  else if (query.addListener) query.addListener(systemChanged);
  window.addEventListener('storage', event => {
    if (event.key === 'piq:theme' || event.key === null) { mode = valid(event.newValue) ? event.newValue : 'system'; apply(); }
  });
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('theme-mode');
    if (!select) return;
    select.value = mode;
    select.addEventListener('change', () => {
      mode = valid(select.value) ? select.value : 'system';
      try { localStorage.setItem('piq:theme', mode); } catch { /* Selection still applies without storage. */ }
      apply();
    });
  });
})();
