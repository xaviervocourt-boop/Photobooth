// Pilote Canon EOS : mode « à distance », réglages reçus sous forme
// d'événements, live view, déclenchement et photo transférée au PC.
'use strict';

const {
  OP, RC, OFC_ASSOCIATION, PtpError, hex, isJpeg, extractJpeg, sleep,
} = require('./ptp');
const { BaseCamera, choice } = require('./base');

const COP = {
  RemoteRelease: 0x910f,
  SetDevicePropValueEx: 0x9110,
  SetRemoteMode: 0x9114,
  SetEventMode: 0x9115,
  GetEvent: 0x9116,
  TransferComplete: 0x9117,
  PCHDDCapacity: 0x911a,
  KeepDeviceOn: 0x911d,
  RemoteReleaseOn: 0x9128,
  RemoteReleaseOff: 0x9129,
  SetRequestOLCInfoGroup: 0x913d,
  InitiateViewfinder: 0x9151,
  TerminateViewfinder: 0x9152,
  GetViewFinderData: 0x9153,
};
const CEV = {
  ObjectAddedEx: 0xc181,
  RequestObjectTransfer: 0xc186,
  PropValueChanged: 0xc189,
  AvailListChanged: 0xc18a,
  CameraStatusChanged: 0xc18b,
};
const PROP = {
  Aperture: 0xd101,
  ShutterSpeed: 0xd102,
  ISO: 0xd103,
  WhiteBalance: 0xd109,
  AvailableShots: 0xd11b,
  CaptureDestination: 0xd11c,
  ImageFormat: 0xd120,
  ImageFormatCF: 0xd121,
  ImageFormatSD: 0xd122,
  EVFOutputDevice: 0xd1b0,
  EVFMode: 0xd1b1,
};
const FORMAT_PROPS = [PROP.ImageFormat, PROP.ImageFormatCF, PROP.ImageFormatSD];
const CAPTURE_TO_PC = 4;
const NOT_READY = 0xa102;

const APERTURE = {
  0x00: 'Auto', 0x08: '1.0', 0x0b: '1.1', 0x0c: '1.2', 0x0d: '1.2', 0x10: '1.4', 0x13: '1.6', 0x14: '1.8',
  0x15: '1.8', 0x18: '2.0', 0x1b: '2.2', 0x1c: '2.5', 0x1d: '2.5', 0x20: '2.8', 0x23: '3.2', 0x24: '3.5',
  0x25: '3.5', 0x28: '4.0', 0x2b: '4.5', 0x2c: '4.5', 0x2d: '5.0', 0x30: '5.6', 0x33: '6.3', 0x34: '6.7',
  0x35: '7.1', 0x38: '8.0', 0x3b: '9.0', 0x3c: '9.5', 0x3d: '10', 0x40: '11', 0x43: '13', 0x44: '13',
  0x45: '14', 0x48: '16', 0x4b: '18', 0x4c: '19', 0x4d: '20', 0x50: '22', 0x53: '25', 0x54: '27',
  0x55: '29', 0x58: '32', 0x5b: '36', 0x5c: '38', 0x5d: '40', 0x60: '45', 0x63: '51', 0x64: '54',
  0x65: '57', 0x68: '64', 0x6b: '72', 0x6c: '76', 0x6d: '81', 0x70: '91',
};
const SHUTTER = {
  0x00: 'Auto', 0x04: 'Pose B', 0x0c: 'Pose B', 0x10: '30', 0x13: '25', 0x14: '20', 0x15: '20', 0x18: '15',
  0x1b: '13', 0x1c: '10', 0x1d: '10', 0x20: '8', 0x23: '6', 0x24: '6', 0x25: '5', 0x28: '4', 0x2b: '3.2',
  0x2c: '3', 0x2d: '2.5', 0x30: '2', 0x33: '1.6', 0x34: '1.5', 0x35: '1.3', 0x38: '1', 0x3b: '0.8',
  0x3c: '0.7', 0x3d: '0.6', 0x40: '0.5', 0x43: '0.4', 0x44: '0.3', 0x45: '0.3', 0x48: '1/4', 0x4b: '1/5',
  0x4c: '1/6', 0x4d: '1/6', 0x50: '1/8', 0x53: '1/10', 0x54: '1/10', 0x55: '1/13', 0x58: '1/15',
  0x5b: '1/20', 0x5c: '1/20', 0x5d: '1/25', 0x60: '1/30', 0x63: '1/40', 0x64: '1/45', 0x65: '1/50',
  0x68: '1/60', 0x6b: '1/80', 0x6c: '1/90', 0x6d: '1/100', 0x70: '1/125', 0x73: '1/160', 0x74: '1/180',
  0x75: '1/200', 0x78: '1/250', 0x7b: '1/320', 0x7c: '1/350', 0x7d: '1/400', 0x80: '1/500', 0x83: '1/640',
  0x84: '1/750', 0x85: '1/800', 0x88: '1/1000', 0x8b: '1/1250', 0x8c: '1/1500', 0x8d: '1/1600',
  0x90: '1/2000', 0x93: '1/2500', 0x94: '1/3000', 0x95: '1/3200', 0x98: '1/4000', 0x9b: '1/5000',
  0x9c: '1/6000', 0x9d: '1/6400', 0xa0: '1/8000',
};
const ISO = {
  0x00: 'Auto', 0x40: '50', 0x43: '64', 0x45: '80', 0x48: '100', 0x4b: '125', 0x4d: '160', 0x50: '200',
  0x53: '250', 0x55: '320', 0x58: '400', 0x5b: '500', 0x5d: '640', 0x60: '800', 0x63: '1000', 0x65: '1250',
  0x68: '1600', 0x6b: '2000', 0x6d: '2500', 0x70: '3200', 0x73: '4000', 0x75: '5000', 0x78: '6400',
  0x7b: '8000', 0x7d: '10000', 0x80: '12800', 0x83: '16000', 0x85: '20000', 0x88: '25600',
};
const WB = {
  0: 'Auto', 1: 'Lumière du jour', 2: 'Nuageux', 3: 'Tungstène', 4: 'Fluorescent', 5: 'Flash',
  6: 'Manuelle', 8: 'Ombre', 9: 'Température de couleur', 10: 'Personnalisée 1', 11: 'Personnalisée 2',
  12: 'Personnalisée 3', 15: 'Manuelle 2', 16: 'Manuelle 3', 18: 'Manuelle 4', 19: 'Manuelle 5',
  20: 'Personnalisée 4', 21: 'Personnalisée 5', 23: 'Auto (blanc)',
};
const RELEASE_ERRORS = {
  1: 'L\'appareil n\'arrive pas à faire la mise au point : passez l\'objectif en mise au point manuelle (MF) ou éclairez davantage.',
  3: 'Le miroir de l\'appareil est levé.',
  7: 'La carte mémoire de l\'appareil est pleine.',
  8: 'La carte mémoire est protégée en écriture.',
};

// Format d'image Canon : liste d'entrées [type, taille, compression].
const FORMAT_SIZE = { 0: 'L', 1: 'M', 2: 'S', 5: 'M1', 6: 'M2', 0xe: 'S1', 0xf: 'S2', 0x10: 'S3' };
function formatLabel(entries) {
  if (!entries || !entries.length) return 'Inconnu';
  const parts = entries.map((e) => {
    const size = FORMAT_SIZE[e.size] || `taille ${e.size}`;
    if (e.type === 6) return e.size === 0 ? 'RAW' : `${size}-RAW`;
    const comp = e.comp === 3 ? 'Fine' : e.comp === 2 ? 'Normal' : '';
    return `JPEG ${size} ${comp}`.trim();
  });
  // RAW en premier, comme sur l'appareil : « RAW + JPEG L Fine ».
  return parts.sort((a, b) => (a.includes('RAW') ? -1 : 0) - (b.includes('RAW') ? -1 : 0)).join(' + ');
}

function readFormat(buf, pos) {
  const n = buf.readUInt32LE(pos);
  let p = pos + 4;
  const entries = [];
  for (let i = 0; i < n && p + 16 <= buf.length; i++) {
    const len = buf.readUInt32LE(p);
    entries.push({ type: buf.readUInt32LE(p + 4), size: buf.readUInt32LE(p + 8), comp: buf.readUInt32LE(p + 12) });
    p += Math.max(16, len);
  }
  return { entries, next: p };
}

function writeFormat(entries) {
  const b = Buffer.alloc(4 + entries.length * 16);
  b.writeUInt32LE(entries.length, 0);
  entries.forEach((e, i) => {
    b.writeUInt32LE(16, 4 + i * 16);
    b.writeUInt32LE(e.type, 8 + i * 16);
    b.writeUInt32LE(e.size, 12 + i * 16);
    b.writeUInt32LE(e.comp, 16 + i * 16);
  });
  return b;
}

function cstring(buf, pos) {
  const end = buf.indexOf(0, pos);
  return buf.toString('latin1', pos, end < 0 ? buf.length : end);
}

class CanonCamera extends BaseCamera {
  constructor(transport, info, log) {
    super(transport, info, log);
    this.props = new Map();
    this.pending = [];
    this.frames = 0;
    this.settingsCache = {};
  }

  connect() {
    this.call(COP.SetRemoteMode, [1], {}, 'Passage en mode à distance');
    this.call(COP.SetEventMode, [1], {}, 'Activation des événements');
    if (this.has(COP.SetRequestOLCInfoGroup)) this.exec(COP.SetRequestOLCInfoGroup, [0x1fff]);
    this.pollEvents(); // l'appareil envoie alors tous ses réglages
    for (let i = 0; i < 10 && !this.props.has(PROP.EVFOutputDevice); i++) {
      sleep(50);
      this.pollEvents();
    }
    this.captureToPc();
  }

  pollEvents() {
    const r = this.exec(COP.GetEvent, [], { read: true });
    if (r.code !== RC.OK || !r.data) return;
    const buf = r.data;
    let pos = 0;
    while (pos + 8 <= buf.length) {
      const size = buf.readUInt32LE(pos);
      const code = buf.readUInt32LE(pos + 4);
      if (size < 8 || pos + size > buf.length || (size === 8 && code === 0)) break;
      const rec = buf.subarray(pos, pos + size);
      if (code === CEV.PropValueChanged && size >= 16) {
        this.propValue(rec.readUInt32LE(8), rec, 12);
      } else if (code === CEV.AvailListChanged && size >= 20) {
        this.propList(rec.readUInt32LE(8), rec.readUInt32LE(12), rec.readUInt32LE(16), rec);
      } else if (code === CEV.ObjectAddedEx && size > 0x28) {
        this.pending.push({
          handle: rec.readUInt32LE(8), format: rec.readUInt16LE(0x10), size: rec.readUInt32LE(0x1c),
          name: cstring(rec, 0x28), transfer: false,
        });
      } else if (code === CEV.RequestObjectTransfer && size > 0x1c) {
        this.pending.push({
          handle: rec.readUInt32LE(8), format: rec.readUInt16LE(0x0c), size: rec.readUInt32LE(0x14),
          name: cstring(rec, 0x1c), transfer: true,
        });
      } else if (code === CEV.CameraStatusChanged && size >= 12) {
        this.status = rec.readUInt32LE(8);
      }
      pos += size;
    }
  }

  prop(code) {
    if (!this.props.has(code)) this.props.set(code, { value: null, values: [] });
    return this.props.get(code);
  }

  propValue(code, rec, pos) {
    const p = this.prop(code);
    if (FORMAT_PROPS.includes(code)) p.value = readFormat(rec, pos).entries;
    else if (rec.length - pos >= 4) p.value = rec.readUInt32LE(pos);
    else if (rec.length - pos >= 2) p.value = rec.readUInt16LE(pos);
    else p.value = rec[pos];
  }

  propList(code, type, count, rec) {
    if (type !== 3 || count > 1000) return;
    const p = this.prop(code);
    p.values = [];
    let pos = 20;
    for (let i = 0; i < count && pos + 4 <= rec.length; i++) {
      if (FORMAT_PROPS.includes(code)) {
        const f = readFormat(rec, pos);
        p.values.push(f.entries);
        pos = f.next;
      } else {
        p.values.push(rec.readUInt32LE(pos));
        pos += 4;
      }
    }
  }

  setProp(code, value) {
    const payload = Array.isArray(value) ? writeFormat(value) : null;
    const data = Buffer.alloc(8 + (payload ? payload.length : 4));
    data.writeUInt32LE(data.length, 0);
    data.writeUInt32LE(code, 4);
    if (payload) payload.copy(data, 8);
    else data.writeUInt32LE(value >>> 0, 8);
    return this.exec(COP.SetDevicePropValueEx, [], { data });
  }

  // Photos envoyées directement au PC (pas besoin de carte mémoire).
  captureToPc() {
    const dest = this.props.get(PROP.CaptureDestination);
    if (!dest || dest.value === CAPTURE_TO_PC) return;
    const r = this.setProp(PROP.CaptureDestination, CAPTURE_TO_PC);
    if (r.code !== RC.OK) {
      this.log(`destination PC refusée (${hex(r.code)}) : les photos passeront par la carte`);
      return;
    }
    this.exec(COP.PCHDDCapacity, [0x0fffffff, 0x1000, 1]);
    const end = Date.now() + 2000;
    while (Date.now() < end) {
      this.pollEvents();
      const shots = this.props.get(PROP.AvailableShots);
      if (shots && shots.value > 0) break;
      sleep(50);
    }
  }

  startLiveView() {
    if (this.has(COP.InitiateViewfinder)) this.exec(COP.InitiateViewfinder);
    const mode = this.props.get(PROP.EVFMode);
    if (mode && mode.value !== 1) {
      const r = this.setProp(PROP.EVFMode, 1);
      if (r.code !== RC.OK && r.code !== RC.DeviceBusy) this.log(`EVFMode=1 refusé (${hex(r.code)})`);
    }
    // Sortie vidéo vers le PC (2) plutôt que l'écran de l'appareil (1).
    const out = this.props.get(PROP.EVFOutputDevice);
    if (!out || ((out.value || 0) & ~1) === 0) {
      const r = this.setProp(PROP.EVFOutputDevice, 2);
      if (r.code !== RC.OK) throw this.refused(COP.SetDevicePropValueEx, r.code, 'Démarrage du live view');
      this.prop(PROP.EVFOutputDevice).value = 2;
    }
    this.exec(COP.KeepDeviceOn);
    this.liveView = true;
    this.frames = 0;
  }

  frame() {
    this.frames += 1;
    if (this.frames % 10 === 0) {
      this.pollEvents();
      this.exec(COP.KeepDeviceOn); // sinon l'appareil s'éteint tout seul
    }
    const start = Date.now();
    for (let tries = 1; ; tries++) {
      const r = this.exec(COP.GetViewFinderData, [0x00200000, 0, 0], { read: true });
      if (r.code === NOT_READY || r.code === RC.DeviceBusy) {
        if (Date.now() - start > 3000) throw new PtpError('Le live view de l\'appareil ne démarre pas.', r.code);
        sleep(Math.min(50, tries * 5));
        continue;
      }
      if (r.code !== RC.OK || !r.data) throw this.refused(COP.GetViewFinderData, r.code, 'Image du live view');
      // Blocs [longueur, type, données] : types 1 et 11 = JPEG.
      const buf = r.data;
      let pos = 0;
      while (pos + 8 <= buf.length) {
        const len = buf.readUInt32LE(pos);
        const type = buf.readUInt32LE(pos + 4);
        if (len < 8) break;
        if (type === 1 || type === 11) return buf.subarray(pos + 8, Math.min(buf.length, pos + len));
        pos += len;
      }
      const jpeg = extractJpeg(buf);
      if (jpeg) return jpeg;
      throw new PtpError('L\'appareil n\'envoie pas d\'image JPEG en live view.');
    }
  }

  stopLiveView() {
    if (!this.liveView) return;
    this.liveView = false;
    const out = this.props.get(PROP.EVFOutputDevice);
    const value = ((out && out.value) || 0) & ~2;
    if (this.setProp(PROP.EVFOutputDevice, value).code === RC.OK && out) out.value = value;
    if (this.has(COP.TerminateViewfinder)) this.exec(COP.TerminateViewfinder);
  }

  release() {
    if (this.has(COP.RemoteReleaseOn)) {
      // Comme le déclencheur : mi-course (mise au point), puis à fond.
      this.call(COP.RemoteReleaseOn, [1, 0], {}, 'Déclenchement');
      const end = Date.now() + 200;
      while (Date.now() < end) {
        this.pollEvents();
        sleep(40);
      }
      const r = this.exec(COP.RemoteReleaseOn, [2, 0]);
      if (r.code !== RC.OK) {
        this.exec(COP.RemoteReleaseOff, [1]);
        throw r.code === NOT_READY
          ? new PtpError(RELEASE_ERRORS[1], r.code)
          : this.refused(COP.RemoteReleaseOn, r.code, 'Déclenchement');
      }
      this.exec(COP.RemoteReleaseOff, [2]);
      this.pollEvents();
      this.exec(COP.RemoteReleaseOff, [1]);
      return;
    }
    const r = this.exec(COP.RemoteRelease);
    if (r.code !== RC.OK) throw this.refused(COP.RemoteRelease, r.code, 'Déclenchement');
    const result = r.params[0] || 0;
    if (result) throw new PtpError(RELEASE_ERRORS[result] || `Déclenchement impossible (code ${result}).`, result);
  }

  readPartial(handle, size) {
    const chunks = [];
    let offset = 0;
    while (offset < size) {
      const n = Math.min(1 << 20, size - offset);
      const r = this.call(OP.GetPartialObject, [handle, offset, n], { read: true }, 'Transfert de la photo');
      if (!r.data || !r.data.length) break;
      chunks.push(r.data);
      offset += r.data.length;
    }
    return Buffer.concat(chunks);
  }

  // Télécharge une image annoncée (seulement les JPEG ; les RAW sont libérés).
  download(obj) {
    const jpeg = isJpeg(obj.format, obj.name);
    if (obj.transfer) {
      const data = jpeg ? this.readPartial(obj.handle, obj.size) : null;
      this.exec(COP.TransferComplete, [obj.handle]);
      return data;
    }
    return jpeg ? this.getObject(obj.handle) : null;
  }

  // Libère les images restées en attente (ex. le RAW d'une photo RAW + JPEG),
  // sinon l'appareil finit par refuser de déclencher.
  flushPending() {
    for (const obj of this.pending.splice(0)) {
      if (obj.transfer) this.exec(COP.TransferComplete, [obj.handle]);
    }
  }

  // onFired : appelé dès que la photo est prise, avant son transfert.
  capture(onFired = () => {}) {
    this.pollEvents();
    this.flushPending();
    this.captureToPc();
    const dest = this.props.get(PROP.CaptureDestination);
    const shots = this.props.get(PROP.AvailableShots);
    if (dest && dest.value === CAPTURE_TO_PC && shots && shots.value < 100) {
      this.exec(COP.PCHDDCapacity, [0x0fffffff, 0x1000, 1]);
    }
    // RAW + JPEG : le RAW est libéré sans être lu (il peut arriver avant ou après).
    const format = this.props.get(FORMAT_PROPS.find((c) => this.props.has(c)) || PROP.ImageFormat);
    const withRaw = !!(format && Array.isArray(format.value) && format.value.some((e) => e.type === 6));
    this.release();
    onFired();
    let end = Date.now() + 20000;
    let photo = null;
    let rawAt = 0;
    let keepAt = Date.now();
    while (Date.now() < end) {
      this.pollEvents();
      while (this.pending.length) {
        const obj = this.pending.shift();
        if (obj.format === OFC_ASSOCIATION) continue;
        if (photo) {
          this.download({ ...obj, format: 0, name: '' });
          rawAt = rawAt || Date.now();
          continue;
        }
        const data = this.download(obj);
        if (data) {
          photo = { name: obj.name || 'IMG.JPG', data };
        } else if (!rawAt) {
          rawAt = Date.now();
          end = Math.min(end, rawAt + 3000); // le JPEG suit le RAW de près
        }
      }
      if (photo && (!withRaw || rawAt)) break;
      if (photo) end = Math.min(end, Date.now() + 1500);
      if (Date.now() - keepAt > 1000) {
        this.exec(COP.KeepDeviceOn);
        keepAt = Date.now();
      }
      if (Date.now() < end) sleep(50);
    }
    if (photo) return photo;
    throw new PtpError(rawAt
      ? 'L\'appareil a envoyé une photo RAW : réglez la qualité d\'image sur JPEG.'
      : 'La photo n\'est pas arrivée de l\'appareil (délai dépassé).');
  }

  keepAlive() {
    this.exec(COP.KeepDeviceOn);
    this.pollEvents();
  }

  /* ---------- Réglages ---------- */

  settingDefs() {
    const formatCode = FORMAT_PROPS.find((c) => this.props.has(c)) || PROP.ImageFormat;
    return {
      aperture: { code: PROP.Aperture, label: (v) => APERTURE[v] || `Réglage ${hex(v)}` },
      shutterspeed: { code: PROP.ShutterSpeed, label: (v) => SHUTTER[v] || `Réglage ${hex(v)}` },
      iso: { code: PROP.ISO, label: (v) => ISO[v] || `Réglage ${hex(v)}` },
      whitebalance: { code: PROP.WhiteBalance, label: (v) => WB[v] || `Réglage ${v}` },
      compressionsetting: { code: formatCode, format: true },
    };
  }

  readSetting(name) {
    const def = this.settingDefs()[name];
    const p = this.props.get(def.code);
    if (!p || p.value === null) return { values: [], value: '' };
    let c;
    if (def.format) {
      // Formats comparés via leur forme texte.
      const keys = (p.values.length ? p.values : [p.value]).map((e) => JSON.stringify(e));
      c = choice(keys, JSON.stringify(p.value), (k) => formatLabel(JSON.parse(k)));
      for (const [label, key] of c.byLabel) c.byLabel.set(label, JSON.parse(key));
    } else {
      c = choice(p.values.length ? p.values : [p.value], p.value, def.label);
    }
    this.settingsCache[name] = { code: def.code, byLabel: c.byLabel };
    return { values: c.values, value: c.value };
  }

  getSettings() {
    this.pollEvents();
    const out = {};
    for (const name of Object.keys(this.settingDefs())) out[name] = this.readSetting(name);
    return out;
  }

  setSetting(name, label) {
    if (!this.settingsCache[name]) this.getSettings();
    if (!this.settingsCache[name]) throw new PtpError('Réglage indisponible sur cet appareil.');
    const { code, byLabel } = this.settingsCache[name];
    if (!byLabel.has(label)) throw new PtpError('Valeur inconnue pour ce réglage.');
    const value = byLabel.get(label);
    const r = this.setProp(code, value);
    if (r.code === RC.AccessDenied || r.code === 0xa005) {
      throw new PtpError('Réglage bloqué par le mode de l\'appareil : mettez la molette sur M (manuel).', r.code);
    }
    if (r.code !== RC.OK) throw this.refused(COP.SetDevicePropValueEx, r.code, 'Réglage');
    // L'appareil confirme par un événement.
    const want = JSON.stringify(value);
    const end = Date.now() + 2000;
    let same = false;
    while (!same && Date.now() < end) {
      sleep(50);
      this.pollEvents();
      same = JSON.stringify(this.props.get(code).value) === want;
    }
    if (!same) {
      this.readSetting(name);
      throw new PtpError('L\'appareil a gardé l\'ancienne valeur : mettez la molette sur M (manuel).');
    }
    return this.readSetting(name);
  }
}

module.exports = { CanonCamera, formatLabel, readFormat, writeFormat };
