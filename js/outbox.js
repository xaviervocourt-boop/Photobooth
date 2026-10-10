// File d'envoi des mails : chaque demande est enregistrée dans IndexedDB,
// puis envoyée au relais Apps Script dès qu'il y a du réseau.
import { db, uid } from './db.js';
import { settings } from './settings.js';

const MAX_SERVER_ATTEMPTS = 5;
const RETRY_INTERVAL_MS = 20000;

let current = null;
let again = false;
const listeners = new Set();

export function onOutboxChange(fn) {
  listeners.add(fn);
}

function notify() {
  listeners.forEach((fn) => fn());
}

export function parseEmails(text) {
  const list = text.split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);
  const valid = list.every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e));
  return valid && list.length ? list : null;
}

export async function enqueueEmail(photoId, emails) {
  const item = {
    id: uid(),
    photoId,
    email: emails.join(', '),
    subject: settings.emailSubject,
    body: settings.emailBody,
    status: 'pending',
    attempts: 0,
    createdAt: Date.now(),
  };
  await db.put('outbox', item);
  notify();
  return item;
}

export async function getOutbox() {
  const items = await db.all('outbox');
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function sendOne(item, photo) {
  const payload = {
    secret: settings.secret,
    id: item.id,
    to: item.email,
    subject: item.subject,
    body: item.body,
    filename: `photobooth-${new Date(photo.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`,
    mimeType: 'image/jpeg',
    image: await blobToBase64(photo.blob),
  };
  // text/plain évite la requête préalable CORS, que Apps Script ne gère pas.
  const res = await fetch(settings.scriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow',
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw Object.assign(new Error(`Réponse inattendue du relais (HTTP ${res.status})`), { server: true });
  }
  if (!data.ok) throw Object.assign(new Error(data.error || 'Erreur du relais'), { server: true, fatal: data.fatal });
}

// Si un envoi est déjà en cours, on attend sa fin puis on refait un passage
// pour inclure les éléments ajoutés entre-temps.
export function processOutbox() {
  if (current) {
    again = true;
    return current;
  }
  current = (async () => {
    try {
      do {
        again = false;
        await runOnce();
      } while (again);
    } finally {
      current = null;
      notify();
    }
  })();
  return current;
}

async function runOnce() {
  if (!navigator.onLine || !settings.scriptUrl) return;
  const pending = (await db.all('outbox'))
    .filter((i) => i.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const item of pending) {
    const photo = await db.get('photos', item.photoId);
    if (!photo) {
      Object.assign(item, { status: 'error', lastError: 'Photo supprimée' });
      await db.put('outbox', item);
      continue;
    }
    try {
      await sendOne(item, photo);
      Object.assign(item, { status: 'sent', sentAt: Date.now(), lastError: '' });
      await db.put('outbox', item);
      notify();
    } catch (err) {
      item.attempts += 1;
      item.lastError = err.message || String(err);
      if (err.server && (err.fatal || item.attempts >= MAX_SERVER_ATTEMPTS)) item.status = 'error';
      await db.put('outbox', item);
      notify();
      // Erreur réseau : inutile d'essayer les suivants, on retentera plus tard.
      if (!err.server) break;
    }
  }
}

export async function retryErrors() {
  const items = await db.all('outbox');
  for (const item of items.filter((i) => i.status === 'error')) {
    Object.assign(item, { status: 'pending', attempts: 0 });
    await db.put('outbox', item);
  }
  notify();
  processOutbox();
}

export async function clearSent() {
  const items = await db.all('outbox');
  for (const item of items.filter((i) => i.status === 'sent')) await db.del('outbox', item.id);
  notify();
}

export function startOutboxWorker() {
  window.addEventListener('online', () => processOutbox());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') processOutbox();
  });
  setInterval(processOutbox, RETRY_INTERVAL_MS);
  processOutbox();
}

export async function testRelay() {
  if (!settings.scriptUrl) throw new Error("Aucune URL n'est configurée");
  const url = new URL(settings.scriptUrl);
  url.searchParams.set('secret', settings.secret);
  const res = await fetch(url, { redirect: 'follow' });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Erreur du relais');
  return data;
}
