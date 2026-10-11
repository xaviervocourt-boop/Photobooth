// Processus séparé qui parle à l'appareil photo (lancé par l'application) :
// si le pilote plante, le photobooth reste ouvert et le relance.
// Messages reçus : { id, cmd, args } ; réponses : { id, ok, result | error } ;
// journal : { log }.
'use strict';

const { OP, RC, parseDeviceInfo, PtpError, hex } = require('./ptp');
const { NikonCamera } = require('./nikon');
const { CanonCamera } = require('./canon');

// Lancé comme processus utilitaire d'Electron, ou par l'application en mode Node.
const port = process.parentPort
  ? {
    postMessage: (msg) => process.parentPort.postMessage(msg),
    listen: (fn) => process.parentPort.on('message', (e) => fn(e.data)),
  }
  : {
    postMessage: (msg) => process.send(msg),
    listen: (fn) => process.on('message', fn),
  };
// Application fermée : on libère l'appareil.
if (!process.parentPort) process.on('disconnect', () => process.exit(0));
const NOT_CONNECTED = 0x8007048f;

const NO_CAMERA = 'Aucun appareil photo Nikon ou Canon détecté. Branchez-le en USB, allumez-le, '
  + 'et fermez les logiciels qui peuvent l\'utiliser (Photos, EOS Utility, digiCamControl…).';

// Commandes répétées en continu (live view, événements) : notées seulement quand
// leur résultat change, pour garder un journal lisible.
const QUIET = new Set([0x9203, 0x90c8, 0x941c, 0x90c7, 0x9153, 0x9116, 0x911d, 0x1008]);

let transport = null;
let cam = null;
let failures = 0;
let lastUse = 0;
let openFailure = null;
const lastCode = new Map();

function log(msg) {
  port.postMessage({ log: msg });
}

// Une même erreur répétée (images du live view, appareil débranché) n'est
// notée qu'une fois, avec le nombre de répétitions.
let lastError = '';
let repeats = 0;
function logError(msg) {
  if (msg === lastError) {
    repeats += 1;
    if (repeats % 200 === 0) log(`${msg} (×${repeats})`);
    return;
  }
  clearError();
  lastError = msg;
  log(msg);
}

function clearError() {
  if (repeats) log(`(erreur précédente répétée ${repeats} fois)`);
  lastError = '';
  repeats = 0;
}

function logged(t) {
  return {
    execute(op, params = [], opts = {}) {
      const t0 = Date.now();
      let r;
      try {
        r = t.execute(op, params, opts);
      } catch (err) {
        logError(`${hex(op)} [${params.map((p) => hex(p, 1)).join(' ')}] → ${err.message}`);
        lastCode.delete(op);
        err.logged = true;
        throw err;
      }
      if (!QUIET.has(op) || lastCode.get(op) !== r.code) {
        const sent = opts.data ? ` +${opts.data.length} o` : '';
        const got = r.data ? ` ${r.data.length} o` : '';
        log(`${hex(op)} [${params.map((p) => hex(p, 1)).join(' ')}]${sent} → ${hex(r.code)}${got} (${Date.now() - t0} ms)`);
      }
      if (QUIET.has(op)) lastCode.set(op, r.code);
      return r;
    },
    close() {
      t.close();
    },
  };
}

function driverFor(info) {
  const brand = `${info.manufacturer} ${info.model}`;
  if (/nikon/i.test(brand)) {
    if (!info.operations.some((op) => [0x9207, 0x90c0, 0x90cb].includes(op))) {
      throw new PtpError(`Cet appareil Nikon (${info.model}) ne se pilote pas depuis l'ordinateur.`);
    }
    return NikonCamera;
  }
  if (/canon/i.test(brand)) {
    if (!info.operations.includes(0x9114)) {
      throw new PtpError(`Cet appareil Canon (${info.model}) n'est pas un EOS pilotable depuis l'ordinateur.`);
    }
    return CanonCamera;
  }
  return null;
}

function deviceInfo(t) {
  const r = t.execute(OP.GetDeviceInfo, [], { read: true });
  if (r.code !== RC.OK || !r.data) throw new PtpError(`L'appareil ne répond pas (${hex(r.code)}).`, r.code);
  return parseDeviceInfo(r.data);
}

// Ouvre le premier appareil Nikon ou Canon branché.
function open() {
  const sim = process.env.PHOTOBOOTH_CAMERA_SIM;
  if (sim) {
    const t = logged(require('./sim').createSimulator(sim));
    log(`appareil simulé : ${sim}`);
    return { t, info: deviceInfo(t) };
  }
  const { listDevices, WpdTransport } = require('./wpd');
  const devices = listDevices();
  log(`appareils vus par Windows : ${devices.map((d) => `${d.name || '?'} (${d.manufacturer || '?'})`).join(', ') || 'aucun'}`);
  // Nikon et Canon d'abord ; les autres (téléphones…) sont essayés ensuite.
  const score = (d) => (/nikon|canon/i.test(`${d.manufacturer} ${d.name} ${d.description}`) ? 1 : 0);
  const ranked = devices.map((d, i) => ({ d, i })).sort((a, b) => score(b.d) - score(a.d) || a.i - b.i).map((x) => x.d);
  let firstError = null;
  for (const d of ranked) {
    const raw = new WpdTransport(d.id);
    try {
      raw.open();
    } catch (err) {
      log(`ouverture de ${d.name} impossible : ${err.message}`);
      if (score(d)) firstError = firstError || err;
      continue;
    }
    const t = logged(raw);
    try {
      const info = deviceInfo(t);
      if (driverFor(info)) return { t, info };
      log(`${info.manufacturer} ${info.model} ignoré (ni Nikon ni Canon)`);
    } catch (err) {
      log(`${d.name} : ${err.message}`);
      if (score(d)) firstError = firstError || err;
    }
    try {
      raw.close();
    } catch {
      // déjà fermé
    }
  }
  throw firstError || new PtpError(NO_CAMERA);
}

function ensure(retryAfterMs = 0) {
  if (cam) return cam;
  // Images du live view sans appareil : on ne refait pas la recherche à chaque fois.
  if (openFailure && Date.now() - openFailure.at < retryAfterMs) throw openFailure.err;
  let opened;
  try {
    opened = open();
    openFailure = null;
  } catch (err) {
    openFailure = { at: Date.now(), err };
    throw err;
  }
  const { t, info } = opened;
  try {
    const Driver = driverFor(info);
    const c = new Driver(t, info, log);
    log(`connecté : ${c.model} (${hex(info.vendorExtensionId, 8)}, version ${info.deviceVersion}, `
      + `${info.operations.length} commandes)`);
    log(`commandes : ${info.operations.map((op) => hex(op)).join(' ')}`);
    c.connect();
    transport = t;
    cam = c;
    return cam;
  } catch (err) {
    try {
      t.close();
    } catch {
      // ignoré
    }
    throw err;
  }
}

function drop() {
  const t = transport;
  cam = null;
  transport = null;
  lastCode.clear();
  if (t) {
    try {
      t.close();
    } catch {
      // appareil déjà parti
    }
  }
}

const handlers = {
  connect() {
    const c = ensure();
    return { model: c.model, serial: c.info.serialNumber };
  },
  'liveview-start'() {
    const c = ensure();
    if (!c.liveView) c.startLiveView();
    return true;
  },
  'liveview-stop'() {
    if (cam) cam.stopLiveView();
    return true;
  },
  // L'application ne demande des images que si le live view est voulu : on le
  // (re)démarre au besoin (après une reconnexion ou un redémarrage du pilote).
  frame() {
    const c = ensure(2000);
    if (!c.liveView) c.startLiveView();
    return new Uint8Array(c.frame());
  },
  capture(args, id) {
    const photo = ensure().capture(() => port.postMessage({ id, fired: true }));
    log(`photo reçue : ${photo.name} (${photo.data.length} o)`);
    return { name: photo.name, data: new Uint8Array(photo.data) };
  },
  'get-settings'() {
    return ensure().getSettings();
  },
  'set-setting'({ name, value }) {
    const c = ensure();
    if (!c.settingDefs()[name]) throw new PtpError('Réglage inconnu.');
    return c.setSetting(name, String(value));
  },
  ping() {
    return { node: process.versions.node, platform: process.platform, arch: process.arch, pid: process.pid };
  },
  // Vérification de la mécanique Windows (lancée par la construction de l'installateur).
  selftest() {
    return require('./wpd').selfTest();
  },
  disconnect() {
    if (cam) {
      try {
        cam.stopLiveView();
      } catch {
        // ignoré
      }
    }
    drop();
    return true;
  },
};

port.listen((data) => {
  const { id, cmd, args } = data || {};
  const handler = handlers[cmd];
  lastUse = Date.now();
  let reply;
  try {
    if (!handler) throw new PtpError(`Commande inconnue : ${cmd}.`);
    reply = { id, ok: true, result: handler(args || {}, id) };
    failures = 0;
    clearError();
  } catch (err) {
    if (!err.logged) logError(`${cmd} : ${err.message}`);
    // Erreur Windows (câble, appareil éteint…) : on se reconnectera au prochain appel.
    if (err.hresult) {
      failures += 1;
      if (err.hresult === NOT_CONNECTED || failures >= 3 || cmd !== 'frame') drop();
    }
    reply = { id, ok: false, error: err.message || String(err) };
  }
  port.postMessage(reply);
});

// Entre deux séances, l'appareil reste éveillé (les Canon s'éteignent sinon
// au bout d'une minute) ; débranché ou éteint, on se reconnectera plus tard.
setInterval(() => {
  if (!cam || Date.now() - lastUse < 20000) return;
  try {
    cam.keepAlive();
  } catch (err) {
    log(`maintien en éveil : ${err.message}`);
    if (err.hresult) drop();
  }
}, 30000);

process.on('uncaughtException', (err) => {
  log(`erreur interne : ${err.stack || err}`);
});

log(`pilote démarré (Node ${process.versions.node}, ${process.arch})`);
