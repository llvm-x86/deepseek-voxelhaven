/**
 * main.js — application entry point.
 *
 * Its only jobs are to find the canvas, construct the Game, and turn any
 * startup failure into a readable message on screen instead of a blank page.
 */

import { Game } from './Game.js';

/** Render a fatal startup error into the page. */
function showStartupError(message, detail) {
  const boot = document.getElementById('screen-boot');
  if (boot) boot.classList.add('is-hidden');
  const errorScreen = document.getElementById('screen-error');
  const errorMessage = document.getElementById('error-message');
  const errorDetail = document.getElementById('error-detail');
  if (errorScreen && errorMessage) {
    errorMessage.textContent = message;
    if (errorDetail) errorDetail.textContent = detail || '';
    errorScreen.classList.remove('is-hidden');
  } else {
    // The markup itself failed to load; fall back to plain text.
    document.body.textContent = `${message}\n\n${detail || ''}`;
  }
}

async function start() {
  const canvas = document.getElementById('game-canvas');
  if (!canvas) {
    showStartupError('The game canvas is missing from the page.', 'index.html did not load correctly.');
    return;
  }

  let game;
  try {
    game = new Game(canvas);
  } catch (err) {
    showStartupError(
      err && err.message ? err.message : 'The renderer could not be created.',
      err && err.stack ? err.stack : ''
    );
    return;
  }

  // Expose a small automation/debug surface. The integration tests drive the
  // game through this, and it is handy from the browser console.
  window.__VOXELHAVEN__ = game;

  // Surface any error that escapes the game loop rather than losing it to the
  // console where a player would never see it.
  window.addEventListener('error', (event) => {
    console.error('[main] uncaught error:', event.error || event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[main] unhandled promise rejection:', event.reason);
  });

  try {
    await game.boot();
  } catch (err) {
    showStartupError(
      'Voxelhaven failed to start.',
      err && err.stack ? err.stack : String(err)
    );
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
