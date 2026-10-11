// Pilote d'appareil photo intégré (sans digiCamControl) : Nikon et Canon EOS
// branchés en USB, pilotés par un processus séparé (camera/service.js) qui
// passe par le pilote d'appareils photo de Windows. S'il plante ou se bloque,
// il est relancé au prochain appel sans fermer le photobooth.
'use strict';

const { app, utilityProcess } = require('electron');
const childProcess = require('child_process');
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
  ping: 15000,
};
const LOG_MAX_BYTES = 2 * 1024 * 1024;

class CameraError extends Error {}

let child = null;
let seq = 0;
let wantLive = false;
let frameRequest = null;

/* ---------- Journal (camera.log) ---------- */

let logStream = null;
let logBytes = 0;
const recent = []; // dernières lignes, pour l'auto-test

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
    recent.push(line);
    if (recent.length > 300) recent.shift();
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

// Deux façons de lancer le pilote dans un processus séparé : le processus
// « utilitaire » d'Electron, ou l'application elle-même en mode Node. Le
// second sert de repli si le premier ne démarre pas sur ce PC.
let mode = process.env.PHOTOBOOTH_CAMERA_PROCESS === 'node' ? 'node' : 'utility';

function spawn(how) {
  if (how === 'utility') {
    const p = utilityProcess.fork(servicePath(), [], { serviceName: 'Photobooth - appareil photo', stdio: 'pipe' });
    p.on('error', (type, location) => log(`erreur du processus utilitaire : ${type} ${location || ''}`));
    return {
      send: (msg) => p.postMessage(msg),
      kill: () => p.kill(),
      onMessage: (fn) => p.on('message', fn),
      onExit: (fn) => p.on('exit', fn),
      streams: [p.stdout, p.stderr],
    };
  }
  const p = childProcess.fork(servicePath(), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'advanced', // les images passent telles quelles
    windowsHide: true,
  });
  let exited = false;
  const exitHandlers = [];
  const exit = (code) => {
    if (exited) return;
    exited = true;
    exitHandlers.forEach((fn) => fn(code));
  };
  p.on('exit', (code, signal) => exit(code ?? signal));
  p.on('error', (err) => {
    log(`lancement du pilote impossible : ${err.message}`);
    exit(-1);
  });
  return {
    send: (msg) => {
      try {
        p.send(msg);
      } catch (err) {
        log(`envoi au pilote impossible : ${err.message}`);
      }
    },
    kill: () => p.kill(),
    onMessage: (fn) => p.on('message', fn),
    onExit: (fn) => exitHandlers.push(fn),
    streams: [p.stdout, p.stderr],
  };
}

function start() {
  if (child) return child;
  const how = mode;
  const proc = spawn(how);
  proc.mode = how;
  proc.calls = new Map();
  proc.answered = false; // a déjà répondu avec succès
  proc.killed = false; // arrêté par l'application (délai dépassé, fermeture)
  proc.streams.forEach((stream) => stream && stream.on('data', (d) => {
    String(d).split(/\r?\n/).filter(Boolean).forEach((l) => log(`[pilote] ${l}`));
  }));
  proc.onMessage((msg) => {
    if (!msg) return;
    if (msg.log) {
      log(msg.log);
      return;
    }
    const entry = proc.calls.get(msg.id);
    if (!entry) return;
    if (msg.fired) {
      if (entry.onFired) entry.onFired();
      return;
    }
    proc.calls.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) {
      proc.answered = true;
      entry.resolve(msg.result);
    } else {
      entry.reject(new CameraError(msg.error));
    }
  });
  proc.onExit((code) => {
    if (child === proc) child = null;
    log(`pilote arrêté (code ${code})`);
    const pending = [...proc.calls.values()];
    proc.calls.clear();
    pending.forEach((entry) => clearTimeout(entry.timer));
    // Le processus utilitaire s'arrête avant d'avoir pu servir : on passe au
    // mode Node et on refait les demandes en cours.
    if (how === 'utility' && !proc.answered && !proc.killed) {
      mode = 'node';
      log('processus utilitaire indisponible : le pilote passe en mode Node');
      pending.forEach((entry) => call(entry.cmd, entry.args, { onFired: entry.onFired }).then(entry.resolve, entry.reject));
      return;
    }
    pending.forEach((entry) => entry.reject(new CameraError(
      `Le pilote de l'appareil photo s'est arrêté (code ${code}) : réessayez (il redémarre tout seul).`,
    )));
  });
  child = proc;
  return proc;
}

function stop(proc) {
  proc.killed = true;
  if (child === proc) child = null;
  proc.kill();
}

function call(cmd, args = {}, { onFired } = {}) {
  const proc = start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const entry = { cmd, args, resolve, reject, onFired };
    entry.timer = setTimeout(() => {
      proc.calls.delete(id);
      reject(new CameraError(cmd === 'frame'
        ? 'Pas d\'image de l\'appareil photo.'
        : 'L\'appareil photo ne répond plus. Vérifiez le câble USB et que l\'appareil est allumé.'));
      // Les images attendent derrière une photo en cours : rien d'anormal.
      // Une autre commande bloquée : le pilote est relancé.
      if (cmd !== 'frame' && child === proc) {
        log(`${cmd} sans réponse après ${TIMEOUT_MS[cmd] || 15000} ms : relance du pilote`);
        stop(proc);
      }
    }, TIMEOUT_MS[cmd] || 15000);
    proc.calls.set(id, entry);
    proc.send({ id, cmd, args });
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
  stop(proc);
}

// Auto-test : lance le pilote dans le mode demandé (« utility » ou « node »)
// et vérifie la liaison avec Windows.
async function probe(how) {
  const saved = { child, mode };
  child = null;
  mode = how;
  try {
    // Liaison USB d'abord, comme la connexion au lancement de l'application.
    const result = await call('selftest');
    const info = await call('ping');
    return { mode: child ? child.mode : how, ...info, ...result };
  } finally {
    if (child) stop(child);
    child = saved.child;
    mode = saved.mode;
  }
}

function recentLog() {
  return recent.slice();
}

function openLogPath() {
  const file = logFile();
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  return file;
}

module.exports = {
  test, startLiveView, stopLiveView, proxy, trigger, fetchCapture, testShot, getSettings, setSetting, shutdown,
  probe, recentLog, openLogPath, log, CameraError,
};
