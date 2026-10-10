import { db, uid } from './db.js';
import { settings, saveSettings } from './settings.js';
import { FILTERS, getFilter, cssFilter } from './filters.js';
import {
  grabFrame, composeSingle, composeStrip, composeWithFrame, makeThumb, toBlob, sampleFrame, STRIP_ASPECT,
} from './compose.js';
import { saveFrame, removeFrame, loadFrames, getFrame, frameSlots, describeFrame } from './frames.js';
import { initCamera, selectCamera, getCamera, listCameras, desktop, DSLR_ID } from './camera.js';
import {
  enqueueEmail, parseEmails, processOutbox, startOutboxWorker, onOutboxChange,
  getOutbox, retryErrors, clearSent, testRelay,
} from './outbox.js';

const VERSION = '1.2.0';
const IDLE_TIMEOUT_MS = 90000;
const EXPORT_BATCH = 25;

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const video = $('#video');
const liveCanvas = $('#liveview');
const viewfinder = $('#viewfinder');

const state = {
  screen: 'home',
  mode: 'single',
  filterId: 'none',
  busy: false,
  starting: false,
  shotIndex: 0,
  lastPhotoId: null,
  emailTargetId: null,
  viewerPhotoId: null,
};

let desktopInfo = null;

/* ---------------- Navigation ---------------- */

function showScreen(name) {
  state.screen = name;
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
  const cam = getCamera();
  if (name !== 'filter' && name !== 'capture' && !(name === 'home' && cam.showOnHome)) cam.release();
  if (name === 'home') {
    document.body.classList.remove('admin');
    renderHome();
  }
  layoutViewfinder();
  resetIdle();
}

let idleTimer;
function resetIdle() {
  clearTimeout(idleTimer);
  if (['filter', 'result', 'gallery'].includes(state.screen)) {
    idleTimer = setTimeout(() => {
      closeModals();
      showScreen('home');
    }, IDLE_TIMEOUT_MS);
  }
}
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, resetIdle, { passive: true }));

function closeModals() {
  document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
}

let toastTimer;
function toast(msg, ms = 4000) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').classList.add('hidden');
}

/* ---------------- Caméra ---------------- */

async function ensureCamera() {
  try {
    await getCamera().start();
    layoutViewfinder();
    return true;
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), 8000);
    return false;
  }
}

// Ratio de la photo à prendre : celui de la zone transparente du cadre PNG s'il y en a un.
function shotAspect(mode, i) {
  const frame = getFrame(mode);
  if (frame) {
    const slot = frameSlots(frame, mode)[i];
    return slot.w / slot.h;
  }
  return mode === 'strip' ? STRIP_ASPECT : null;
}

function currentAspect() {
  const shot = state.screen !== 'home' && shotAspect(state.mode, state.shotIndex);
  if (shot) return shot;
  const cam = getCamera();
  if (cam.width && cam.height) return cam.width / cam.height;
  return window.innerWidth / window.innerHeight;
}

function layoutViewfinder() {
  const ar = currentAspect();
  const W = window.innerWidth;
  const H = window.innerHeight;
  let w = W;
  let h = W / ar;
  if (h > H) {
    h = H;
    w = H * ar;
  }
  viewfinder.style.width = `${Math.floor(w)}px`;
  viewfinder.style.height = `${Math.floor(h)}px`;
}
window.addEventListener('resize', layoutViewfinder);
video.addEventListener('resize', layoutViewfinder);
liveCanvas.addEventListener('resize', layoutViewfinder);

function applyLiveSettings() {
  const filter = state.screen === 'home' ? 'none' : cssFilter(getFilter(state.filterId));
  [video, liveCanvas].forEach((el) => {
    el.classList.toggle('mirror', settings.mirror);
    el.style.filter = filter;
  });
}

/* ---------------- Sons ---------------- */

let audioCtx;
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    // pas de son, pas grave
  }
}

function beep(freq = 880, duration = 0.12, volume = 0.15) {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(volume, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
  o.connect(g).connect(audioCtx.destination);
  o.start();
  o.stop(audioCtx.currentTime + duration);
}

function shutterSound() {
  if (!audioCtx) return;
  const len = audioCtx.sampleRate * 0.08;
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = audioCtx.createBufferSource();
  const g = audioCtx.createGain();
  g.gain.value = 0.4;
  src.buffer = buf;
  src.connect(g).connect(audioCtx.destination);
  src.start();
}

/* ---------------- Accueil ---------------- */

function renderHome() {
  $('#home-title').textContent = settings.title || 'Photobooth';
  const choice = settings.mode === 'choice';
  $('#mode-choice').classList.toggle('hidden', !choice);
  $('#btn-start').classList.toggle('hidden', choice);
  $('#home-sub').textContent = choice ? 'Choisissez votre format' : 'Touchez pour commencer';
  $('#btn-gallery').classList.toggle('hidden', !settings.galleryPublic);
  document.body.classList.toggle('no-home-preview', !getCamera().showOnHome);
  applyLiveSettings();
  updateNetStatus();
}

async function begin(mode) {
  if (state.starting || state.busy) return;
  state.starting = true;
  unlockAudio();
  // L'appareil photo met quelques secondes à lancer son live view.
  let slowShown = false;
  const slow = setTimeout(() => {
    slowShown = true;
    toast("Préparation de l'appareil photo…", 15000);
  }, 600);
  try {
    if (!(await ensureCamera())) return;
    if (slowShown) hideToast();
    state.mode = mode;
    state.shotIndex = 0;
    state.filterId = 'none';
    renderFilterList();
    showScreen('filter');
    applyLiveSettings();
  } finally {
    clearTimeout(slow);
    state.starting = false;
  }
}

document.querySelectorAll('.big-choice').forEach((btn) => {
  btn.addEventListener('click', () => begin(btn.dataset.mode));
});
$('#btn-start').addEventListener('click', () => begin(settings.mode));
$('#screen-home').addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  // Toucher n'importe où démarre quand le format est imposé.
  if (settings.mode !== 'choice') begin(settings.mode);
  else if (getCamera().showOnHome) ensureCamera();
});

// Gros bouton USB ou clavier : Entrée / Espace lance la séance, puis la photo.
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select') || document.querySelector('.modal:not(.hidden)')) return;
  if (state.screen === 'home' && settings.mode === 'choice' && (e.key === '1' || e.key === '4')) {
    begin(e.key === '1' ? 'single' : 'strip');
    return;
  }
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const actions = {
    home: settings.mode !== 'choice' ? () => begin(settings.mode) : null,
    filter: runCapture,
    result: () => showScreen('home'),
  };
  const action = actions[state.screen];
  if (!action) return;
  e.preventDefault();
  action();
});
document.querySelectorAll('[data-action="home"]').forEach((b) => b.addEventListener('click', () => showScreen('home')));

/* ---------------- Filtres ---------------- */

let previewTimer;
function renderFilterList() {
  const list = $('#filter-list');
  list.innerHTML = '';
  FILTERS.forEach((f) => {
    const btn = document.createElement('button');
    btn.className = 'filter-btn';
    btn.dataset.id = f.id;
    const c = document.createElement('canvas');
    c.width = 192;
    c.height = 144;
    c.style.filter = cssFilter(f);
    const label = document.createElement('span');
    label.textContent = f.name;
    btn.append(c, label);
    btn.addEventListener('click', () => {
      state.filterId = f.id;
      markSelectedFilter();
      applyLiveSettings();
    });
    list.append(btn);
  });
  markSelectedFilter();
  clearInterval(previewTimer);
  drawFilterPreviews();
  previewTimer = setInterval(() => {
    if (state.screen !== 'filter') return clearInterval(previewTimer);
    drawFilterPreviews();
  }, 400);
}

function markSelectedFilter() {
  document.querySelectorAll('.filter-btn').forEach((b) => b.classList.toggle('selected', b.dataset.id === state.filterId));
}

function drawFilterPreviews() {
  const cam = getCamera();
  if (!cam.width || !cam.height) return;
  const vw = cam.width;
  const vh = cam.height;
  const ar = 4 / 3;
  let sw = vw;
  let sh = vw / ar;
  if (sh > vh) {
    sh = vh;
    sw = vh * ar;
  }
  document.querySelectorAll('.filter-btn canvas').forEach((c) => {
    const ctx = c.getContext('2d');
    ctx.save();
    if (settings.mirror) {
      ctx.translate(c.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(cam.el, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, c.width, c.height);
    ctx.restore();
  });
}

$('#btn-go').addEventListener('click', runCapture);

/* ---------------- Prise de vue ---------------- */

function flashScreen() {
  const flash = $('#flash');
  flash.classList.remove('go');
  void flash.offsetWidth;
  flash.classList.add('go');
}

async function runCapture() {
  if (state.busy || state.starting) return;
  state.busy = true;
  const cam = getCamera();
  const filter = getFilter(state.filterId);
  const shots = state.mode === 'strip' ? 4 : 1;
  const frame = getFrame(state.mode);
  const slots = frame && frameSlots(frame, state.mode);
  const pending = [];
  const cd = $('#countdown');
  const counter = $('#shot-counter');
  const processing = $('#processing');
  try {
    showScreen('capture');
    applyLiveSettings();
    await requestWakeLock();
    for (let i = 0; i < shots; i++) {
      state.shotIndex = i;
      layoutViewfinder();
      counter.textContent = shots > 1 ? `Photo ${i + 1} / ${shots}` : '';
      counter.classList.toggle('hidden', shots === 1);
      const seconds = Math.max(1, Math.round(Number(settings.countdown) || 3));
      for (let n = seconds; n > 0; n--) {
        cd.textContent = n;
        cd.classList.remove('hidden', 'pop');
        void cd.offsetWidth; // relance l'animation
        cd.classList.add('pop');
        beep(n === 1 ? 1320 : 880);
        await sleep(1000);
      }
      cd.classList.add('hidden');
      // La webcam copie l'image tout de suite ; l'appareil photo se déclenche
      // (avec son flash) et rend la main dès qu'il est prêt pour la suivante.
      const shot = cam.capture();
      if (cam.kind === 'webcam') shutterSound();
      flashScreen();
      pending.push((await shot).image);
      if (i < shots - 1) await sleep(Math.max(0, Number(settings.pause) || 0) * 1000 + 300);
    }
    counter.classList.add('hidden');
    processing.classList.remove('hidden');
    const images = await Promise.all(pending);
    const frames = images.map((img, i) => grabFrame(img, shotAspect(state.mode, i) || img.width / img.height, {
      mirror: settings.mirror,
      filter,
      maxWidth: slots ? Math.min(2400, slots[i].w) : 2400,
    }));
    images.forEach((img) => img.source.close && img.source.close());
    let final;
    if (frame) final = composeWithFrame(frames, frame, slots, settings);
    else final = shots > 1 ? composeStrip(frames, settings) : composeSingle(frames[0], settings);
    const photo = {
      id: uid(),
      createdAt: Date.now(),
      mode: state.mode,
      filter: filter.id,
      blob: await toBlob(final, 0.92),
      thumb: await toBlob(makeThumb(final), 0.8),
    };
    if (desktop) photo.filePath = await saveToFolder(photo);
    await db.put('photos', photo);
    state.lastPhotoId = photo.id;
    showResult(photo);
  } catch (err) {
    console.error(err);
    toast(`Oups, la photo a échoué : ${err.message || err}`, 8000);
    showScreen('home');
  } finally {
    state.busy = false;
    state.shotIndex = 0;
    cd.classList.add('hidden');
    counter.classList.add('hidden');
    processing.classList.add('hidden');
  }
}

// Application Windows : chaque photo est aussi enregistrée en JPEG dans un dossier.
async function saveToFolder(photo) {
  try {
    const bytes = new Uint8Array(await photo.blob.arrayBuffer());
    return await desktop.savePhoto(bytes, `photobooth-${fileStamp(photo.createdAt)}.jpg`);
  } catch (err) {
    toast(`Photo non copiée dans le dossier : ${err.message || err}`, 6000);
    return null;
  }
}

function fileStamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/* ---------------- Résultat ---------------- */

let resultUrl;
function showResult(photo) {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = URL.createObjectURL(photo.blob);
  $('#result-img').src = resultUrl;
  showScreen('result');
}

$('#btn-email').addEventListener('click', () => openEmail(state.lastPhotoId));
$('#btn-done').addEventListener('click', () => showScreen('home'));
$('#btn-retake').addEventListener('click', async () => {
  if (state.lastPhotoId) await db.del('photos', state.lastPhotoId);
  state.lastPhotoId = null;
  begin(state.mode);
});

/* ---------------- Email ---------------- */

function openEmail(photoId) {
  state.emailTargetId = photoId;
  $('#email-input').value = '';
  $('#email-error').classList.add('hidden');
  $('#email-modal').classList.remove('hidden');
  setTimeout(() => $('#email-input').focus(), 50);
}

$('#email-cancel').addEventListener('click', () => $('#email-modal').classList.add('hidden'));
$('#email-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const emails = parseEmails($('#email-input').value);
  if (!emails) {
    const err = $('#email-error');
    err.textContent = 'Adresse email invalide.';
    err.classList.remove('hidden');
    return;
  }
  $('#email-input').blur();
  $('#email-modal').classList.add('hidden');
  await enqueueEmail(state.emailTargetId, emails);
  if (navigator.onLine && settings.scriptUrl) {
    toast('Envoi en cours… ✉️');
    await processOutbox();
    const item = (await getOutbox()).find((i) => i.photoId === state.emailTargetId);
    if (item && item.status === 'sent') toast('Photo envoyée ! Pensez à vérifier vos spams. ✅', 5000);
    else toast("Pas de réseau pour l'instant : la photo partira automatiquement dès le retour de la connexion. 👍", 6000);
  } else {
    toast("Pas de réseau pour l'instant : la photo partira automatiquement dès le retour de la connexion. 👍", 6000);
  }
});

/* ---------------- Galerie ---------------- */

let galleryUrls = [];
async function renderGallery() {
  galleryUrls.forEach((u) => URL.revokeObjectURL(u));
  galleryUrls = [];
  const photos = (await db.all('photos')).sort((a, b) => b.createdAt - a.createdAt);
  const grid = $('#gallery-grid');
  grid.innerHTML = '';
  $('#gallery-count').textContent = photos.length ? `(${photos.length})` : '';
  $('#gallery-empty').classList.toggle('hidden', photos.length > 0);
  photos.forEach((p) => {
    const url = URL.createObjectURL(p.thumb || p.blob);
    galleryUrls.push(url);
    const btn = document.createElement('button');
    const img = document.createElement('img');
    img.src = url;
    img.loading = 'lazy';
    img.alt = '';
    btn.append(img);
    btn.addEventListener('click', () => openViewer(p));
    grid.append(btn);
  });
}

async function openGallery() {
  await renderGallery();
  showScreen('gallery');
}
$('#btn-gallery').addEventListener('click', openGallery);

let viewerUrl;
function openViewer(photo) {
  state.viewerPhotoId = photo.id;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(photo.blob);
  $('#viewer-img').src = viewerUrl;
  $('#viewer').classList.remove('hidden');
}

$('#viewer-close').addEventListener('click', () => $('#viewer').classList.add('hidden'));
$('#viewer-email').addEventListener('click', () => {
  $('#viewer').classList.add('hidden');
  openEmail(state.viewerPhotoId);
});
$('#viewer-share').addEventListener('click', async () => {
  const photo = await db.get('photos', state.viewerPhotoId);
  if (!photo) return;
  if (!desktop) {
    await sharePhotos([photo]);
    return;
  }
  if (!photo.filePath) {
    photo.filePath = await saveToFolder(photo);
    if (photo.filePath) await db.put('photos', photo);
  }
  if (photo.filePath) desktop.showInFolder(photo.filePath).catch((err) => toast(err.message));
});
$('#viewer-delete').addEventListener('click', async () => {
  if (!confirm('Supprimer cette photo ?')) return;
  await db.del('photos', state.viewerPhotoId);
  $('#viewer').classList.add('hidden');
  renderGallery();
  renderSettingsStats();
});

function photoFile(p) {
  return new File([p.blob], `photobooth-${fileStamp(p.createdAt)}.jpg`, { type: 'image/jpeg' });
}

async function sharePhotos(photos) {
  const files = photos.map(photoFile);
  try {
    if (navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files });
      return;
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.warn(err);
  }
  // Repli (ordinateur) : téléchargement direct.
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    await sleep(250);
  }
}

/* ---------------- Réglages ---------------- */

$('#btn-settings').addEventListener('click', () => {
  $('#pin-input').value = '';
  $('#pin-error').classList.add('hidden');
  $('#pin-modal').classList.remove('hidden');
  setTimeout(() => $('#pin-input').focus(), 50);
});
$('#pin-cancel').addEventListener('click', () => $('#pin-modal').classList.add('hidden'));
$('#pin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if ($('#pin-input').value !== String(settings.pin)) {
    $('#pin-error').classList.remove('hidden');
    return;
  }
  $('#pin-input').blur();
  $('#pin-modal').classList.add('hidden');
  openSettings();
});

function openSettings() {
  document.querySelectorAll('[data-setting]').forEach((el) => {
    const v = settings[el.dataset.setting];
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else el.value = v;
  });
  $('#frame-preview').classList.add('hidden');
  $('#test-relay-result').textContent = '';
  renderSettingsStats();
  renderOutbox();
  renderFrameUploads();
  renderCameraSelect();
  renderDesktopSettings();
  showScreen('settings');
  document.body.classList.add('admin');
}

document.querySelectorAll('[data-setting]').forEach((el) => {
  el.addEventListener('change', () => {
    const key = el.dataset.setting;
    if (el.type === 'checkbox') settings[key] = el.checked;
    else if (el.type === 'number') settings[key] = Number(el.value);
    else settings[key] = el.value.trim();
    if (key === 'pin' && !settings.pin) settings.pin = '0000';
    saveSettings();
    if (key === 'scriptUrl' || key === 'secret') processOutbox();
    if (key === 'dccUrl') configureDesktop();
  });
});

async function renderCameraSelect() {
  const select = $('#camera-select');
  const cameras = await listCameras();
  select.innerHTML = '';
  select.append(new Option(desktop ? 'Webcam par défaut' : 'Caméra avant (par défaut)', ''));
  cameras.forEach((c) => select.append(new Option(c.label, c.id)));
  select.value = cameras.some((c) => c.id === settings.cameraId) ? settings.cameraId : '';
  $('#camera-hint').textContent = settings.cameraId === DSLR_ID
    ? "digiCamControl doit être lancé, avec le serveur web activé, avant la séance (voir le README). L'appareil se déclenche avec son flash."
    : '';
  $('#dslr-settings').classList.toggle('hidden', settings.cameraId !== DSLR_ID);
}

$('#camera-select').addEventListener('change', async (e) => {
  settings.cameraId = e.target.value;
  saveSettings();
  const cam = selectCamera();
  if (cam.kind === 'webcam') cam.stop();
  renderCameraSelect();
  $('#test-camera-result').textContent = '';
  if (cam.showOnHome) ensureCamera();
});

async function configureDesktop() {
  if (!desktop) return;
  try {
    desktopInfo = await desktop.configure({ dccUrl: settings.dccUrl, photoFolder: settings.photoFolder });
  } catch (err) {
    toast(err.message || String(err));
  }
}

function renderDesktopSettings() {
  if (!desktop || !desktopInfo) return;
  $('#photo-folder').value = desktopInfo.photoFolder;
  $('#kiosk-toggle').checked = desktopInfo.kiosk;
}

if (desktop) {
  $('#test-camera').addEventListener('click', async () => {
    const out = $('#test-camera-result');
    out.style.color = '';
    out.textContent = 'Recherche de l\'appareil…';
    try {
      await configureDesktop(); // prend en compte une adresse tout juste modifiée
      const { cameras } = await desktop.camera.test();
      out.style.color = 'var(--ok)';
      out.textContent = `Appareil détecté ✅ (n° ${cameras.join(', ')})`;
    } catch (err) {
      out.style.color = 'var(--danger)';
      out.textContent = err.message || String(err);
    }
  });
  $('#choose-folder').addEventListener('click', async () => {
    const dir = await desktop.chooseFolder().catch((err) => toast(err.message));
    if (!dir) return;
    settings.photoFolder = dir;
    saveSettings();
    await configureDesktop();
    renderDesktopSettings();
  });
  $('#open-folder').addEventListener('click', () => desktop.openFolder().catch((err) => toast(err.message)));
  $('#kiosk-toggle').addEventListener('change', async (e) => {
    await desktop.setKiosk(e.target.checked);
    await configureDesktop();
  });
  $('#quit-app').addEventListener('click', () => {
    if (confirm('Quitter le photobooth ?')) desktop.quit();
  });
}

$('#settings-close').addEventListener('click', () => showScreen('home'));

function previewCanvas(mode) {
  const frame = getFrame(mode);
  if (frame) {
    const slots = frameSlots(frame, mode);
    return composeWithFrame(slots.map((s) => sampleFrame(s.w / s.h)), frame, slots, settings);
  }
  return mode === 'strip'
    ? composeStrip([0, 1, 2, 3].map(() => sampleFrame(STRIP_ASPECT)), settings)
    : composeSingle(sampleFrame(4 / 3), settings);
}

$('#preview-frame').addEventListener('click', async () => {
  const box = $('#frame-preview');
  box.querySelectorAll('img').forEach((i) => URL.revokeObjectURL(i.src));
  box.innerHTML = '';
  const modes = settings.mode === 'choice' ? ['single', 'strip'] : [settings.mode];
  for (const mode of modes) {
    const img = document.createElement('img');
    img.alt = 'Aperçu';
    img.src = URL.createObjectURL(await toBlob(previewCanvas(mode)));
    box.append(img);
  }
  box.classList.remove('hidden');
});

function renderFrameUploads() {
  document.querySelectorAll('.frame-upload').forEach((el) => {
    const mode = el.dataset.frameMode;
    const frame = getFrame(mode);
    const img = el.querySelector('img');
    const info = el.querySelector('.frame-info');
    if (img.src) URL.revokeObjectURL(img.src);
    if (frame) {
      img.src = URL.createObjectURL(frame.blob);
      const d = describeFrame(frame, mode);
      info.textContent = d.text;
      info.classList.toggle('warn', d.warn);
    } else {
      img.removeAttribute('src');
      info.textContent = '';
    }
    img.classList.toggle('hidden', !frame);
    el.querySelector('.frame-thumb span').classList.toggle('hidden', Boolean(frame));
    el.querySelector('.frame-remove').classList.toggle('hidden', !frame);
  });
}

document.querySelectorAll('.frame-upload').forEach((el) => {
  const mode = el.dataset.frameMode;
  const input = el.querySelector('input[type=file]');
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    try {
      await saveFrame(mode, file);
      renderFrameUploads();
      $('#frame-preview').classList.add('hidden');
      toast('Cadre enregistré ✓');
    } catch (err) {
      toast(`Impossible de lire ce fichier : ${err.message || err}`);
    }
  });
  el.querySelector('.frame-remove').addEventListener('click', async () => {
    if (!confirm('Retirer ce cadre ?')) return;
    await removeFrame(mode);
    renderFrameUploads();
    $('#frame-preview').classList.add('hidden');
  });
});

$('#test-relay').addEventListener('click', async () => {
  const out = $('#test-relay-result');
  out.style.color = '';
  out.textContent = 'Test en cours…';
  try {
    await testRelay();
    out.style.color = 'var(--ok)';
    out.textContent = 'Connexion OK ✅';
  } catch (err) {
    out.style.color = 'var(--danger)';
    out.textContent = `Échec : ${err.message || err}`;
  }
});

$('#outbox-retry').addEventListener('click', async () => {
  if (!navigator.onLine) toast(desktop ? "L'ordinateur est hors ligne." : "L'iPad est hors ligne.");
  else if (!settings.scriptUrl) toast("Renseignez d'abord l'URL du relais.");
  await processOutbox();
});
$('#outbox-retry-errors').addEventListener('click', retryErrors);
$('#outbox-clear-sent').addEventListener('click', clearSent);

const STATUS_LABEL = { pending: 'En attente', sent: 'Envoyé', error: 'Échec' };

async function renderOutbox() {
  const items = await getOutbox();
  const count = (st) => items.filter((i) => i.status === st).length;
  $('#outbox-summary').textContent =
    `${count('pending')} en attente · ${count('sent')} envoyé(s) · ${count('error')} en échec` +
    (settings.scriptUrl ? '' : ' — relais non configuré');
  const list = $('#outbox-list');
  list.innerHTML = '';
  items.slice(0, 100).forEach((i) => {
    const li = document.createElement('li');
    const who = document.createElement('span');
    who.textContent = `${i.email} — ${new Date(i.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
    const st = document.createElement('span');
    st.className = `st-${i.status}`;
    st.textContent = STATUS_LABEL[i.status] + (i.status !== 'sent' && i.lastError ? ` (${i.lastError})` : '');
    li.append(who, st);
    list.append(li);
  });
}

async function renderSettingsStats() {
  const photos = (await db.all('photos')).sort((a, b) => a.createdAt - b.createdAt);
  const box = $('#export-batches');
  box.innerHTML = '';
  if (desktop) {
    $('#photos-summary').textContent = `${photos.length} photo(s). Chaque photo est aussi enregistrée en JPEG dans le dossier des photos.`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary';
    btn.textContent = '📂 Ouvrir le dossier des photos';
    btn.addEventListener('click', () => desktop.openFolder().catch((err) => toast(err.message)));
    box.append(btn);
    return;
  }
  $('#photos-summary').textContent = `${photos.length} photo(s) enregistrée(s) sur l'iPad.`;
  for (let i = 0; i < photos.length; i += EXPORT_BATCH) {
    const batch = photos.slice(i, i + EXPORT_BATCH);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary';
    btn.textContent = photos.length <= EXPORT_BATCH
      ? '📤 Exporter toutes les photos'
      : `📤 Exporter ${i + 1}–${i + batch.length}`;
    btn.addEventListener('click', () => sharePhotos(batch));
    box.append(btn);
  }
}

$('#delete-all').addEventListener('click', async () => {
  if (!confirm('Supprimer définitivement TOUTES les photos ?')) return;
  const extra = desktop ? ' Les fichiers déjà copiés dans le dossier des photos sont conservés.' : '';
  if (!confirm(`Vraiment sûr ? Les mails encore en attente ne pourront plus partir.${extra}`)) return;
  await db.clear('photos');
  renderSettingsStats();
  toast('Toutes les photos ont été supprimées.');
});

/* ---------------- Réseau / file ---------------- */

async function updateNetStatus() {
  const pending = (await getOutbox()).filter((i) => i.status === 'pending').length;
  const parts = [];
  if (!navigator.onLine) parts.push('Hors ligne');
  if (pending) parts.push(`✉️ ${pending} en attente`);
  $('#net-status').textContent = parts.join(' · ');
}

onOutboxChange(() => {
  updateNetStatus();
  if (state.screen === 'settings') renderOutbox();
});
window.addEventListener('online', updateNetStatus);
window.addEventListener('offline', updateNetStatus);

/* ---------------- Écran toujours allumé ---------------- */

let wakeLock;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch {
    // non supporté : utiliser Réglages > Luminosité > Verrouillage auto > Jamais
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});
document.addEventListener('pointerdown', requestWakeLock, { once: true });

/* ---------------- Démarrage ---------------- */

$('#app-version').textContent = VERSION;
document.body.classList.toggle('desktop', Boolean(desktop));
if (desktop) $('#viewer-share').textContent = '📂 Afficher dans le dossier';
initCamera(video, liveCanvas);
renderHome();
loadFrames().catch((err) => console.warn('Cadres', err));
configureDesktop();
startOutboxWorker();
if (getCamera().showOnHome) ensureCamera();

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// Le cache hors ligne ne sert qu'à la version web (iPad).
if (!desktop && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW', err));
  });
}
