/*
 * controls.js — the page's only chrome: the three framing buttons and a pause,
 * which carino-navbar.js carries into its right cluster ([data-carino-actions]
 * in index.html). They exist so a touch screen can do what keys 1, 2 and 3 do;
 * the renderer knows nothing about them and is driven through the handle
 * main.js exports (setMode / setPaused), the same door the test suite uses.
 *
 * Keys added here, alongside main.js's 1/2/3: P or Space pauses and resumes,
 * F toggles fullscreen. There is no sound and no help overlay (an ambient
 * piece may skip it; every control is a visible button instead).
 */
import { jellyfish } from './main.js';

// The test harness loads every module under a shim with no real DOM, and
// there the page has nothing to wire.
if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') wire();

function wire() {
  const tr = (s) => (typeof window.t === 'function' ? window.t(s) : s);
  const modeButtons = Array.from(document.querySelectorAll('.jf-seg [data-mode]'));
  const pauseBtn = document.getElementById('jfPause');

  function paint() {
    for (const b of modeButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === jellyfish.mode));
    if (pauseBtn) {
      const p = !!jellyfish.paused;
      pauseBtn.setAttribute('aria-pressed', String(p));
      pauseBtn.textContent = p ? tr('Resume') : tr('Pause');
    }
  }

  function togglePause() {
    if (typeof jellyfish.setPaused !== 'function') return;
    jellyfish.setPaused(!jellyfish.paused);
    paint();
  }

  function toggleFullscreen() {
    const el = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen && document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  }

  for (const b of modeButtons) {
    b.addEventListener('click', () => {
      if (typeof jellyfish.setMode === 'function') jellyfish.setMode(b.dataset.mode);
      paint();
    });
  }
  if (pauseBtn) pauseBtn.addEventListener('click', togglePause);

  document.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
    const k = e.key;
    if (k === '1' || k === '2' || k === '3') { paint(); return; }   // main.js switched the framing
    if (k === 'p' || k === 'P' || (k === ' ' && !(t && t.tagName === 'BUTTON'))) {
      e.preventDefault();
      togglePause();
    } else if (k === 'f' || k === 'F') {
      toggleFullscreen();
    }
  });

  window.addEventListener('carino:langchange', paint);
  document.addEventListener('DOMContentLoaded', paint);
  paint();
}
