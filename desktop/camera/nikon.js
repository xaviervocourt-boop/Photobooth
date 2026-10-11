// Pilote Nikon (reflex et hybrides Z) : live view, déclenchement avec
// l'image envoyée directement au PC (mémoire de l'appareil), réglages.
'use strict';

const {
  OP, RC, DT, OFC_ASSOCIATION, PtpError, Reader, encodeValue, hex, isJpeg, extractJpeg, sleep, parseObjectInfo,
} = require('./ptp');
const { BaseCamera, choice } = require('./base');

const NOP = {
  InitiateCaptureRecInSdram: 0x90c0,
  AfDrive: 0x90c1,
  ChangeCameraMode: 0x90c2,
  GetEvent: 0x90c7,
  DeviceReady: 0x90c8,
  StartLiveView: 0x9201,
  EndLiveView: 0x9202,
  GetLiveViewImg: 0x9203,
  InitiateCaptureRecInMedia: 0x9207,
  GetEventEx: 0x941c,
};
const PROP = {
  Compression: 0x5004,
  WhiteBalance: 0x5005,
  FNumber: 0x5007,
  ExposureTime: 0x500d,
  ExposureIndex: 0x500f,
  NikonExposureTime: 0xd100,
  RecordingMedia: 0xd10b,
  LiveViewStatus: 0xd1a2,
  LiveViewProhibit: 0xd1a4,
  ApplyLiveViewSetting: 0xd17b, // « Appliquer réglages à la visée écran »
  LiveViewImageSize: 0xd1ac, // 1 = QVGA, 2 = VGA, 3 = XGA
};
const NRC = {
  OutOfFocus: 0xa002,
  InvalidStatus: 0xa004,
  CameraModeNotAdjustFNumber: 0xa00a,
  NotLiveView: 0xa00b,
  BulbBusy: 0xa200,
  SilentBusy: 0xa201,
};
const EV = {
  ObjectAdded: 0x4002,
  CaptureComplete: 0x400d,
  ObjectAddedInSdram: 0xc101,
  CaptureCompleteInSdram: 0xc102,
};
const SDRAM_OBJECT = 0xffff0001;
const isSdram = (h) => h >= SDRAM_OBJECT;
const AF = 0xfffffffe;
const NO_AF = 0xffffffff;

// Raisons pour lesquelles l'appareil refuse le live view (bits de 0xD1A4).
const PROHIBIT = [
  [31, 'Mettez la molette de l\'appareil sur P, A, S ou M.'],
  [8, 'La batterie de l\'appareil est vide.'],
  [17, 'L\'appareil est trop chaud.'],
  [12, 'Une photo attend encore dans la mémoire de l\'appareil : éteignez-le puis rallumez-le.'],
  [14, 'L\'appareil enregistre sur la carte mais il n\'y a pas de carte (ou elle est protégée).'],
  [20, 'La carte mémoire n\'est pas formatée.'],
  [19, 'Erreur de carte mémoire.'],
  [18, 'La carte mémoire est protégée.'],
  [21, 'L\'appareil est en pose B : choisissez une vitesse.'],
  [4, 'Le déclencheur est enfoncé.'],
  [15, 'Une prise de vue est en cours.'],
  [22, 'Le miroir est levé.'],
  [5, 'Ouverture minimale : vérifiez la bague de l\'objectif.'],
  [9, 'Erreur de mesure (TTL).'],
  [2, 'Erreur de séquence de l\'appareil.'],
];

const WB = {
  0x0001: 'Manuelle',
  0x0002: 'Auto',
  0x0003: 'Auto (un appui)',
  0x0004: 'Lumière du jour',
  0x0005: 'Fluorescent',
  0x0006: 'Tungstène',
  0x0007: 'Flash',
  0x8010: 'Nuageux',
  0x8011: 'Ombre',
  0x8012: 'Température de couleur',
  0x8013: 'Pré-réglage',
  0x8014: 'Désactivée',
  0x8015: 'Flash',
  0x8016: 'Lumière naturelle auto',
};

// Qualité d'image des Nikon récents (Z, D850…), avec les variantes « ★ ».
const QUALITY = [
  'JPEG Basic', 'JPEG Basic ★', 'JPEG Normal', 'JPEG Normal ★', 'JPEG Fine', 'JPEG Fine ★', 'TIFF',
  'RAW (NEF)', 'RAW + JPEG Basic', 'RAW + JPEG Basic ★', 'RAW + JPEG Normal', 'RAW + JPEG Normal ★',
  'RAW + JPEG Fine', 'RAW + JPEG Fine ★',
];

function fnumber(v) {
  const f = v / 100;
  return Number.isInteger(f) ? String(f) : f.toFixed(1);
}

// 0xD100 : numérateur sur 16 bits, dénominateur sur 16 bits.
function nikonShutter(v) {
  if (v === 0xffffffff) return 'Pose B';
  if (v === 0xfffffffe) return 'x200';
  if (v === 0xfffffffd) return 'Pose T';
  const x = v >>> 16;
  const y = v & 0xffff;
  if (y === 1) return String(x);
  if (x === 1) return `1/${y}`;
  return (x / y).toFixed(1);
}

// 0x500D standard : en dix-millièmes de seconde.
function standardShutter(v) {
  if (!v || v === 0xffffffff) return 'Pose B';
  if (v >= 10000) return String(Math.round(v / 1000) / 10);
  return `1/${Math.round(10000 / v)}`;
}

function parseEvents(buf) {
  const r = new Reader(buf);
  const n = r.u16();
  const out = [];
  for (let i = 0; i < n && r.remaining >= 6; i++) out.push({ code: r.u16(), params: [r.u32()] });
  return out;
}

function parseEventsEx(buf) {
  const r = new Reader(buf);
  const n = r.u16();
  r.skip(2);
  const out = [];
  for (let i = 0; i < n && r.remaining >= 4; i++) {
    const code = r.u16();
    const count = r.u16();
    const params = [];
    for (let j = 0; j < count && j < 5; j++) params.push(r.u32());
    out.push({ code, params });
  }
  return out;
}

class NikonCamera extends BaseCamera {
  constructor(transport, info, log) {
    super(transport, info, log);
    this.skipFrame = false;
    this.settingsCache = {};
  }

  connect() {
    if (this.has(NOP.ChangeCameraMode)) this.exec(NOP.ChangeCameraMode, [1]);
  }

  // Attend que l'appareil ait fini ce qu'il fait (DeviceReady).
  waitReady(timeoutMs, stepMs = 20) {
    const end = Date.now() + timeoutMs;
    let code;
    do {
      code = this.exec(NOP.DeviceReady).code;
      if (code === NRC.SilentBusy) return RC.OK;
      if (code !== RC.DeviceBusy && code !== NRC.BulbBusy) return code;
      sleep(stepMs);
    } while (Date.now() < end);
    return code;
  }

  pollEvents() {
    if (this.has(NOP.GetEventEx)) {
      const r = this.exec(NOP.GetEventEx, [], { read: true });
      if (r.code === RC.OK && r.data) return parseEventsEx(r.data);
    }
    const r = this.exec(NOP.GetEvent, [], { read: true });
    return r.code === RC.OK && r.data ? parseEvents(r.data) : [];
  }

  tryGetValue(code, type) {
    try {
      return this.getPropValue(code, type);
    } catch {
      return null;
    }
  }

  // Les photos vont dans la mémoire de l'appareil puis sur le PC : pas besoin de carte.
  useSdram() {
    const r = this.exec(OP.SetDevicePropValue, [PROP.RecordingMedia], { data: encodeValue(DT.UINT8, 1) });
    if (r.code !== RC.OK) this.log(`RecordingMedia=SDRAM refusé (${hex(r.code)})`);
  }

  // Image du live view la plus grande possible (plus nette à l'écran).
  largestLiveView() {
    if (!this.hasProp(PROP.LiveViewImageSize)) return;
    try {
      const desc = this.getPropDesc(PROP.LiveViewImageSize);
      const best = Math.max(...desc.values, desc.current);
      if (desc.writable && best !== desc.current) {
        const r = this.exec(OP.SetDevicePropValue, [PROP.LiveViewImageSize], { data: encodeValue(desc.type, best) });
        if (r.code !== RC.OK) this.log(`taille du live view refusée (${hex(r.code)})`);
      }
    } catch (err) {
      this.log(`taille du live view : ${err.message}`);
    }
  }

  startLiveView() {
    if (this.tryGetValue(PROP.LiveViewStatus, DT.UINT8) === 1) {
      this.liveView = true;
      return;
    }
    this.largestLiveView();
    this.useSdram();
    const prohibit = this.tryGetValue(PROP.LiveViewProhibit, DT.UINT32);
    if (prohibit) {
      const reason = PROHIBIT.find(([bit]) => prohibit & (2 ** bit));
      if (!(prohibit & (2 ** 24))) { // objectif en train de rentrer : on tente quand même
        throw new PtpError(`Live view impossible : ${reason ? reason[1] : `code ${hex(prohibit, 8)}`}`);
      }
    }
    const r = this.exec(NOP.StartLiveView);
    if (r.code !== RC.OK && r.code !== RC.DeviceBusy) throw this.refused(NOP.StartLiveView, r.code, 'Démarrage du live view');
    this.waitReady(3000);
    this.liveView = true;
    this.skipFrame = true; // la première image est parfois abîmée
  }

  frame() {
    for (let tries = 0; tries < 40; tries++) {
      const r = this.exec(NOP.GetLiveViewImg, [], { read: true });
      if (r.code === NRC.NotLiveView) {
        this.liveView = false;
        this.startLiveView();
        continue;
      }
      if (r.code === RC.OK && r.data) {
        if (this.skipFrame) {
          this.skipFrame = false;
          continue;
        }
        const jpeg = extractJpeg(r.data);
        if (!jpeg) throw new PtpError('L\'appareil n\'envoie pas d\'image JPEG en live view.');
        return jpeg;
      }
      if (r.code === RC.DeviceBusy || r.code === NRC.InvalidStatus) {
        sleep(15);
        continue;
      }
      throw this.refused(NOP.GetLiveViewImg, r.code, 'Image du live view');
    }
    throw new PtpError('L\'appareil est occupé (live view).', RC.DeviceBusy);
  }

  stopLiveView() {
    if (!this.liveView) return;
    this.liveView = false;
    this.exec(NOP.EndLiveView);
  }

  // Mise au point juste avant la photo (les déclenchements en live view se
  // font sans mise au point). Échec = photo prise quand même.
  autofocus() {
    if (!this.has(NOP.AfDrive)) return;
    const r = this.exec(NOP.AfDrive);
    if (r.code !== RC.OK) {
      this.log(`mise au point automatique indisponible (${hex(r.code)})`);
      return;
    }
    const code = this.waitReady(3000, 10);
    if (code !== RC.OK) this.log(`mise au point non obtenue (${hex(code)}), photo prise quand même`);
  }

  initiate(af) {
    const media = this.has(NOP.InitiateCaptureRecInMedia) || this.has(NOP.StartLiveView);
    if (!media) return this.exec(NOP.InitiateCaptureRecInSdram, [NO_AF]).code;
    // Second paramètre : 1 = mémoire de l'appareil (photo envoyée au PC).
    if (!this.oneParam) {
      const code = this.exec(NOP.InitiateCaptureRecInMedia, [af, 1]).code;
      if (code !== RC.ParameterNotSupported) return code;
      this.oneParam = true; // anciens boîtiers (D3x)
    }
    return this.exec(NOP.InitiateCaptureRecInMedia, [NO_AF]).code;
  }

  trigger() {
    const end = Date.now() + 3000;
    let code;
    do {
      code = this.initiate(NO_AF);
      // Certains boîtiers refusent le déclenchement sans mise au point.
      if (code === NRC.InvalidStatus) code = this.initiate(AF);
      if (code !== RC.DeviceBusy && code !== NRC.InvalidStatus && code !== 0xa207) break;
      sleep(20);
    } while (Date.now() < end);
    if (code === RC.OK) return;
    if (code === NRC.OutOfFocus) {
      throw new PtpError('L\'appareil n\'arrive pas à faire la mise au point : passez l\'objectif en mise au point manuelle (MF).', code);
    }
    if (code === RC.StoreFull) throw new PtpError('La mémoire de l\'appareil est pleine.', code);
    throw this.refused(NOP.InitiateCaptureRecInMedia, code, 'Déclenchement');
  }

  // Attend la ou les nouvelles images annoncées par l'appareil.
  waitObjects(timeoutMs) {
    const handles = [];
    let completeAt = 0;
    let firstAt = 0;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      for (const ev of this.pollEvents()) {
        if (ev.code === EV.ObjectAddedInSdram) handles.push(ev.params[0] || SDRAM_OBJECT);
        else if (ev.code === EV.ObjectAdded && ev.params[0]) handles.push(ev.params[0]);
        else if (ev.code === EV.CaptureComplete || ev.code === EV.CaptureCompleteInSdram) completeAt = completeAt || Date.now();
      }
      if (handles.length && !firstAt) firstAt = Date.now();
      // Image annoncée : on part dès la fin de prise de vue (ou une seconde après).
      if (handles.length && (completeAt || Date.now() - firstAt > 1000)) break;
      if (!handles.length && completeAt && Date.now() - completeAt > 1500) break;
      sleep(50);
    }
    // Pas de dédoublonnage : en RAW + JPEG les deux images peuvent être
    // annoncées sous le même numéro (0xffff0001), l'une après l'autre.
    return handles;
  }

  // Télécharge une image puis la retire de la mémoire de l'appareil.
  take(handle) {
    const oi = this.getObjectInfo(handle);
    if (oi.format === OFC_ASSOCIATION) return null;
    const data = this.getObject(handle);
    if (isSdram(handle)) this.free(handle, oi);
    return { oi, data };
  }

  // La plupart des boîtiers libèrent l'image une fois transférée et présentent
  // la suivante sous le même numéro : on n'efface que si elle est toujours là.
  free(handle, oi) {
    let still;
    try {
      still = parseObjectInfo(this.exec(OP.GetObjectInfo, [handle], { read: true }).data);
    } catch {
      return;
    }
    if (still.filename !== oi.filename || still.format !== oi.format) return;
    const code = this.exec(OP.DeleteObject, [handle, 0]).code;
    if (code !== RC.OK) this.log(`image ${hex(handle, 8)} non libérée (${hex(code)})`);
  }

  // onFired : appelé dès que la photo est prise, avant son transfert.
  capture(onFired = () => {}) {
    const wasLive = this.liveView;
    this.pollEvents(); // vide la file avant de déclencher
    this.useSdram();
    this.autofocus();
    this.trigger();
    this.waitReady(30000, 50);
    onFired();
    let handles = this.waitObjects(20000);
    if (!handles.length) handles = [SDRAM_OBJECT];
    let photo = null;
    for (let round = 0; round < 2; round++) {
      for (const h of handles) {
        let obj;
        try {
          obj = this.take(h);
        } catch (err) {
          this.log(`objet ${hex(h, 8)} : ${err.message}`);
          continue;
        }
        if (obj && !photo && isJpeg(obj.oi.format, obj.oi.filename)) {
          photo = { name: obj.oi.filename || 'DSC.JPG', data: obj.data };
        }
      }
      if (photo || round) break;
      // RAW + JPEG : le JPEG peut être annoncé juste après le RAW.
      handles = this.waitObjects(3000);
      if (!handles.length) break;
    }
    if (wasLive && this.tryGetValue(PROP.LiveViewStatus, DT.UINT8) !== 1) {
      this.liveView = false;
      try {
        this.startLiveView();
      } catch (err) {
        this.log(`relance du live view : ${err.message}`);
      }
    }
    if (!photo) throw new PtpError('L\'appareil a envoyé une photo RAW : réglez la qualité d\'image sur JPEG.');
    return photo;
  }

  keepAlive() {
    this.exec(NOP.DeviceReady);
  }

  /* ---------- Réglages ---------- */

  settingDefs() {
    const defs = {
      aperture: { code: PROP.FNumber, label: fnumber },
      shutterspeed: { code: PROP.ExposureTime, label: standardShutter },
      iso: { code: PROP.ExposureIndex, label: String },
      whitebalance: { code: PROP.WhiteBalance, label: (v) => WB[v] || `Réglage ${hex(v)}` },
      compressionsetting: { code: PROP.Compression, label: (v) => QUALITY[v] || `Qualité ${v}` },
    };
    if (this.nikonShutter !== false) defs.shutterspeed = { code: PROP.NikonExposureTime, label: nikonShutter, fallback: defs.shutterspeed };
    // Live view qui montre l'effet de l'ouverture, de la vitesse, des ISO et de la balance des blancs.
    if (this.hasProp(PROP.ApplyLiveViewSetting)) {
      defs.liveview = { code: PROP.ApplyLiveViewSetting, label: (v) => (v ? 'Oui' : 'Non') };
    }
    return defs;
  }

  readSetting(name) {
    let def = this.settingDefs()[name];
    let desc;
    try {
      desc = this.getPropDesc(def.code);
    } catch (err) {
      if (!def.fallback) throw err;
      this.nikonShutter = false; // ancien Nikon : vitesse standard 0x500D
      def = def.fallback;
      desc = this.getPropDesc(def.code);
    }
    const values = desc.values.length ? desc.values : [desc.current];
    const c = choice(values, desc.current, def.label);
    this.settingsCache[name] = { desc, byLabel: c.byLabel };
    // Non modifiable : fixé par une molette de l'appareil (ou par son mode).
    if (!desc.writable) return { values: [c.value].filter(Boolean), value: c.value, locked: true };
    return { values: c.values, value: c.value };
  }

  getSettings() {
    const out = {};
    for (const name of Object.keys(this.settingDefs())) {
      try {
        out[name] = this.readSetting(name);
      } catch (err) {
        this.log(`réglage ${name} indisponible : ${err.message}`);
        out[name] = { values: [], value: '' };
      }
    }
    return out;
  }

  setSetting(name, label) {
    if (!this.settingsCache[name]) this.readSetting(name);
    const { desc, byLabel } = this.settingsCache[name];
    if (!byLabel.has(label)) throw new PtpError('Valeur inconnue pour ce réglage.');
    const r = this.exec(OP.SetDevicePropValue, [desc.code], { data: encodeValue(desc.type, byLabel.get(label)) });
    if (r.code === NRC.CameraModeNotAdjustFNumber || r.code === RC.AccessDenied) {
      throw new PtpError(/^Z ?f$/i.test(this.info.model)
        ? 'Réglage bloqué par les molettes de l\'appareil : mode M, molette ISO sur C, molette des vitesses sur 1/3 STEP.'
        : 'Réglage bloqué par le mode de l\'appareil : mettez la molette sur M (manuel).', r.code);
    }
    if (r.code !== RC.OK) throw this.refused(OP.SetDevicePropValue, r.code, 'Réglage');
    this.waitReady(2000);
    return this.readSetting(name);
  }
}

module.exports = { NikonCamera, parseEvents, parseEventsEx, nikonShutter, standardShutter, fnumber };
