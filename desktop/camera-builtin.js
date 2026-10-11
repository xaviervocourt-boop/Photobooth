// Pilote d'appareil photo intégré (sans digiCamControl) : Nikon et Canon EOS
// branchés en USB, pilotés par un processus séparé (camera/service.js) qui
// passe par le pilote d'appareils photo de Windows. S'il plante ou se bloque,
// il est relancé au prochain appel sans fermer le photobooth.
'use strict';

const { app, utilityProcess } = require('electron');
const fs = require('fs');
const path = require('path');

const fsp = fs.promises;

const TIMEOUT_MS = {
  connect: 20000,
  'liveview-start': 15000,
  'liveview-stop': 5000,
  frame: 4000,
  capture: 90000,
  'get-settings': 15000,
  'set-setting': 10000,
  disconnect: 4000,
  selftest: 30000,
};
const LOG_MAX_BYTES = 2 * 1024 * 1024;

class CameraError extends Error {}

let child = null;
let seq = 0;
const calls = new Map();
let wantLive = false;
let frameRequest = null;

/* ---------- Journal (camera.log) ---------- */

let logStream = null;
let logBytes = 0;

function logFile() {
  return path.join(app.getPath('userData'), 'camera.log');
}

function log(line) {
  try {
    if (!logStream || logBytes > LOG_MAX_BYTES) {
      if (logStream) logStream.end();
      const file = logFile();
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        // pas encore de journal
      }
      if (size > LOG_MAX_BYTES) {
        fs.renameSync(file, file.replace(/\.log$/, '.old.log'));
        size = 0;
      }
      logStream = fs.createWriteStream(file, { flags: 'a' });
      logStream.on('error', () => { logStream = null; });
      logBytes = size;
    }
    const text = `${new Date().toISOString()} ${line}\n`;
    logBytes += Buffer.byteLength(text);
    logStream.write(text);
  } catch {
    // le journal ne doit jamais empêcher de prendre des photos
  }
}

/* ---------- Processus du pilote ---------- */

function servicePath() {
  // Dans l'application installée, le pilote est hors de l'archive app.asar.
  return path.join(__dirname, 'camera', 'service.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function start() {
  if (child) return child;
  const proc = utilityProcess.fork(servicePath(), [], { serviceName: 'Photobooth - appareil photo', stdio: 'pipe' });
  const output = (stream) => stream && stream.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => log(`[pilote] ${l}`)));
  output(proc.stdout);
  output(proc.stderr);
  proc.on('message', (msg) => {
    if (!msg) return;
    if (msg.log) {
      log(msg.log);
      return;
    }
    const call = calls.get(msg.id);
    if (!call) return;
    if (msg.fired) {
      if (call.onFired) call.onFired();
      return;
    }
    calls.delete(msg.id);
    clearTimeout(call.timer);
    if (msg.ok) call.resolve(msg.result);
    else call.reject(new CameraError(msg.error));
  });
  proc.on('exit', (code) => {
    if (child === proc) child = null;
    frameRequest = null;
    log(`pilote arrêté (code ${code})`);
    for (const [id, call] of calls) {
      calls.delete(id);
      clearTimeout(call.timer);
      call.reject(new CameraError('Le pilote de l\'appareil photo s\'est arrêté : réessayez (il redémarre tout seul).'));
    }
  });
  child = proc;
  return proc;
}

function call(cmd, args = {}, { onFired } = {}) {
  const proc = start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      calls.delete(id);
      reject(new CameraError(cmd === 'frame'
        ? 'Pas d\'image de l\'appareil photo.'
        : 'L\'appareil photo ne répond plus. Vérifiez le câble USB et que l\'appareil est allumé.'));
      // Les images attendent derrière une photo en cours : rien d'anormal.
      // Une autre commande bloquée : le pilote est relancé.
      if (cmd !== 'frame' && child === proc) {
        log(`${cmd} sans réponse après ${TIMEOUT_MS[cmd]} ms : relance du pilote`);
        proc.kill();
      }
    }, TIMEOUT_MS[cmd] || 15000);
    calls.set(id, { resolve, reject, timer, onFired });
    proc.postMessage({ id, cmd, args });
  });
}

/* ---------- Même interface que le mode digiCamControl ---------- */

async function test() {
  const { model } = await call('connect');
  return { cameras: [model], launched: false };
}

async function startLiveView() {
  wantLive = true;
  await call('liveview-start');
  return { launched: false };
}

async function stopLiveView() {
  wantLive = false;
  if (child) await call('liveview-stop').catch(() => {});
}

// Image de live view pour la page ; une seule demande à la fois au pilote.
async function proxy(file) {
  if (file !== 'liveview.jpg') return new Response(null, { status: 404 });
  if (!wantLive) return new Response(null, { status: 503 });
  if (!frameRequest) {
    frameRequest = call('frame');
    const done = () => { frameRequest = null; };
    frameRequest.then(done, done);
  }
  try {
    const data = await frameRequest;
    if (!data || !data.byteLength) return new Response(null, { status: 503 });
    return new Response(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' },
    });
  } catch {
    return new Response(null, { status: 503 });
  }
}

const captures = new Map();
let shots = 0;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Déclenche l'appareil (et son flash). Se termine dès que la photo est prise ;
// le fichier, en cours de transfert, se récupère avec fetchCapture().
function trigger(folder) {
  return new Promise((resolve, reject) => {
    shots += 1;
    const id = String(shots);
    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      resolve(id);
    };
    const photo = call('capture', {}, { onFired: fire }).then((result) => {
      const data = Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength);
      const name = path.basename(result.name || 'photo.jpg');
      // Copie de l'original en pleine définition (sans cadre), comme avant.
      fsp.mkdir(folder, { recursive: true })
        .then(() => fsp.writeFile(path.join(folder, `${stamp()}_${id}_${name}`), data))
        .catch((err) => log(`enregistrement de l'original impossible : ${err.message}`));
      return { name, data };
    });
    photo.catch(() => {}); // évite une alerte si la séance est annulée avant
    captures.set(id, photo);
    // Photos jamais récupérées (séance annulée) : on n'en garde que quelques-unes.
    if (captures.size > 8) captures.delete(captures.keys().next().value);
    photo.then(fire, (err) => {
      if (fired) return; // erreur transmise par fetchCapture()
      fired = true;
      captures.delete(id);
      reject(err);
    });
  });
}

async function fetchCapture(id) {
  const photo = captures.get(id);
  if (!photo) throw new CameraError('Photo introuvable.');
  captures.delete(id);
  return photo;
}

async function testShot(folder) {
  return fetchCapture(await trigger(folder));
}

async function getSettings() {
  return { settings: await call('get-settings'), launched: false };
}

function setSetting(name, value) {
  return call('set-setting', { name, value });
}

// Libère l'appareil (passage en mode digiCamControl, fermeture de l'application).
async function shutdown() {
  wantLive = false;
  if (!child) return;
  const proc = child;
  await call('disconnect').catch(() => {});
  if (child === proc) proc.kill();
}

function selfTest() {
  return call('selftest');
}

function openLogPath() {
  const file = logFile();
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  return file;
}

module.exports = {
  test, startLiveView, stopLiveView, proxy, trigger, fetchCapture, testShot, getSettings, setSetting, shutdown,
  selfTest, openLogPath, log, CameraError,
};
