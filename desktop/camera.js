// Pilotage d'un appareil photo reflex/hybride via digiCamControl (Windows) :
// live view, déclenchement, puis récupération du JPEG que digiCamControl
// enregistre dans le dossier qu'on lui indique.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const fsp = fs.promises;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CAPTURE_TIMEOUT_MS = 45000;
const FILE_TIMEOUT_MS = 30000;
const LAUNCH_TIMEOUT_MS = 30000;

const NO_CAMERA = "digiCamControl ne voit aucun appareil photo. Branchez-le en USB, allumez-le et attendez qu'il apparaisse dans digiCamControl.";

class CameraError extends Error {}

function isLocal(base) {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname);
  } catch {
    return false;
  }
}

async function request(base, query, timeoutMs = 5000) {
  let res;
  try {
    res = await fetch(`${base}/?${query}`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new CameraError('digiCamControl ne répond pas (délai dépassé).');
    throw new CameraError(`digiCamControl est injoignable (${base}). Vérifiez qu'il est lancé et que son serveur web est activé.`);
  }
  return res.text();
}

// Les commandes « slc » répondent « OK », une liste ou un message d'erreur.
// Une page HTML veut dire que les actions par le serveur web sont désactivées.
function slcResult(text) {
  if (/^\s*</.test(text)) {
    throw new CameraError("Dans digiCamControl, cochez « Allow interaction via webserver » (File > Settings > Webserver), puis relancez-le.");
  }
  return text;
}

/* ---------- Lancement automatique de digiCamControl ---------- */

function exeCandidates() {
  return [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
    .filter(Boolean)
    .map((dir) => path.join(dir, 'digiCamControl', 'CameraControl.exe'));
}

async function ping(base, timeoutMs) {
  await request(base, 'slc=get&param1=session', timeoutMs);
}

let launching = null;

// Renvoie true si digiCamControl vient d'être lancé (sa fenêtre est alors devant).
async function ensureRunning(base) {
  try {
    await ping(base, 3000);
    return false;
  } catch (err) {
    if (process.platform !== 'win32' || !isLocal(base)) throw err;
  }
  if (!launching) launching = launch(base).finally(() => { launching = null; });
  await launching;
  return true;
}

async function launch(base) {
  const exe = exeCandidates().find((f) => fs.existsSync(f));
  if (!exe) {
    throw new CameraError("digiCamControl n'est pas lancé et il est introuvable dans Program Files. Installez-le depuis digicamcontrol.com.");
  }
  spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) }).unref();
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      await ping(base, 2000);
      await sleep(1500); // laisse le temps à l'appareil d'être détecté
      return;
    } catch {
      // pas encore prêt
    }
  }
  throw new CameraError("digiCamControl est lancé mais son serveur web ne répond pas. Activez-le dans File > Settings > Webserver (port 5513).");
}

/* ---------- Appareil et live view ---------- */

async function listCameras(base) {
  const text = slcResult(await request(base, 'slc=list&param1=cameras'));
  if (text.trim() === 'OK') return [];
  // Une ligne (terminée par un retour) par appareil, sinon c'est un message d'erreur.
  if (!text.includes('\n')) throw new CameraError(`digiCamControl : ${text.trim()}`);
  return text.split('\n').slice(0, -1).map((s, i) => s.trim() || `appareil ${i + 1}`);
}

async function test(base) {
  const launched = await ensureRunning(base);
  const cameras = await listCameras(base);
  if (!cameras.length) throw new CameraError(NO_CAMERA);
  return { cameras, launched };
}

async function startLiveView(base) {
  const { launched } = await test(base);
  await request(base, 'CMD=LiveViewWnd_Show');
  await sleep(700);
  // Même enchaînement que le mode « webcam » de digiCamControl : sa fenêtre
  // de live view est réduite, mais les images continuent d'arriver.
  await request(base, 'CMD=All_Minimize');
  await request(base, 'CMD=LiveView_NoProcess');
  return { launched };
}

async function stopLiveView(base) {
  await request(base, 'CMD=LiveViewWnd_Hide', 3000);
}

// Relais de l'image de live view pour la page (même origine, pas de souci CORS).
async function proxy(base, file) {
  if (file !== 'liveview.jpg') return new Response(null, { status: 404 });
  try {
    const res = await fetch(`${base}/liveview.jpg`, { signal: AbortSignal.timeout(2000), cache: 'no-store' });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.startsWith('image/')) return new Response(null, { status: 503 });
    return new Response(await res.arrayBuffer(), {
      headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' },
    });
  } catch {
    return new Response(null, { status: 503 });
  }
}

/* ---------- Déclenchement et récupération du fichier ---------- */

let seq = 0;
let chain = Promise.resolve();
const pending = new Map();
const claimed = new Set();

async function listJpegs(folder) {
  try {
    return (await fsp.readdir(folder)).filter((f) => /\.jpe?g$/i.test(f));
  } catch {
    return [];
  }
}

function friendlyCaptureError(text) {
  if (/object reference/i.test(text)) return NO_CAMERA;
  if (/focus/i.test(text)) {
    return "L'appareil n'arrive pas à faire la mise au point. Passez l'objectif en mise au point manuelle (MF) ou éclairez davantage.";
  }
  return `L'appareil photo a renvoyé une erreur : ${text}`;
}

// Déclenche l'appareil (et son flash). Se termine quand l'appareil est prêt
// pour la photo suivante ; le fichier se récupère ensuite avec fetchCapture().
async function trigger(base, folder) {
  await fsp.mkdir(folder, { recursive: true });
  const before = new Set(await listJpegs(folder));
  seq += 1;
  const name = `pb_${new Date().toISOString().replace(/\D/g, '').slice(0, 17)}_${seq}`;
  const target = encodeURIComponent(path.join(folder, name));
  for (let attempt = 1; ; attempt++) {
    const text = slcResult(await request(base, `slc=capture&param1=${target}`, CAPTURE_TIMEOUT_MS)).trim();
    if (text === 'OK') break;
    if (attempt < 3 && /busy|occup/i.test(text)) {
      await sleep(700);
      continue;
    }
    throw new CameraError(friendlyCaptureError(text));
  }
  const id = String(seq);
  // Les fichiers sont attendus dans l'ordre des déclenchements.
  const wait = chain.then(() => waitForFile(folder, name, before));
  chain = wait.catch(() => {});
  wait.catch(() => {}); // évite une alerte si la séance est annulée avant
  pending.set(id, wait);
  return id;
}

async function fetchCapture(id) {
  const wait = pending.get(id);
  if (!wait) throw new CameraError('Photo introuvable.');
  pending.delete(id);
  return fsp.readFile(await wait);
}

async function oldestFirst(folder, files) {
  const stats = await Promise.all(files.map(async (f) => {
    const st = await fsp.stat(path.join(folder, f)).catch(() => null);
    return { f, t: st ? st.mtimeMs : Infinity };
  }));
  return stats.sort((a, b) => a.t - b.t)[0].f;
}

// Fichier complet : taille stable et marqueur de fin JPEG (FF D9).
async function isComplete(file) {
  try {
    const a = await fsp.stat(file);
    if (a.size < 1024) return false;
    await sleep(150);
    const b = await fsp.stat(file);
    if (b.size !== a.size) return false;
    const fh = await fsp.open(file, 'r');
    try {
      const end = Buffer.alloc(2);
      await fh.read(end, 0, 2, b.size - 2);
      if (end[0] === 0xff && end[1] === 0xd9) return true;
    } finally {
      await fh.close();
    }
    await sleep(500);
    return (await fsp.stat(file)).size === b.size;
  } catch {
    return false; // encore en cours d'écriture par digiCamControl
  }
}

async function waitForFile(folder, name, before) {
  const deadline = Date.now() + FILE_TIMEOUT_MS;
  const prefix = name.toLowerCase();
  while (Date.now() < deadline) {
    const fresh = (await listJpegs(folder)).filter((f) => !before.has(f) && !claimed.has(path.join(folder, f)));
    // Notre nom de fichier en priorité ; sinon (option « nom d'origine » de
    // digiCamControl) le plus ancien des nouveaux fichiers.
    const pick = fresh.find((f) => f.toLowerCase().startsWith(prefix)) || (fresh.length ? await oldestFirst(folder, fresh) : null);
    if (pick) {
      const file = path.join(folder, pick);
      if (await isComplete(file)) {
        claimed.add(file);
        return file;
      }
    }
    await sleep(150);
  }
  throw new CameraError("La photo n'est pas arrivée sur l'ordinateur. Réglez l'appareil en JPEG et, dans digiCamControl, le transfert sur « Save to PC only ».");
}

module.exports = { test, startLiveView, stopLiveView, proxy, trigger, fetchCapture, CameraError };
