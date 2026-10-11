// Outils communs aux pilotes Nikon et Canon.
'use strict';

const {
  OP, RC, PtpError, Reader, encodeValue, hex, parsePropDesc, parseObjectInfo,
} = require('./ptp');

class BaseCamera {
  constructor(transport, info, log) {
    this.t = transport;
    this.info = info;
    this.log = log;
    this.liveView = false;
  }

  // « Nikon Z 6_2 » → « Nikon Z 6II » ; les Canon ont déjà la marque dans le modèle.
  get model() {
    const brand = this.info.manufacturer.replace(/ (Corporation|Inc\.?)$/i, '').trim();
    const model = this.info.model.replace(/_2$/, 'II').replace(/_3$/, 'III').trim();
    return model.toLowerCase().startsWith(brand.toLowerCase()) ? model : `${brand} ${model}`.trim();
  }

  has(op) {
    return this.info.operations.includes(op);
  }

  hasProp(code) {
    return this.info.properties.includes(code);
  }

  exec(op, params = [], opts = {}) {
    return this.t.execute(op, params, opts);
  }

  call(op, params = [], opts = {}, what = '') {
    const r = this.exec(op, params, opts);
    if (r.code !== RC.OK) throw this.refused(op, r.code, what);
    return r;
  }

  refused(op, code, what) {
    return new PtpError(`${what || 'Commande'} refusée par l'appareil (${hex(op)} → ${hex(code)}).`, code, op);
  }

  getObjectInfo(handle) {
    return parseObjectInfo(this.call(OP.GetObjectInfo, [handle], { read: true }, 'Lecture de la photo').data);
  }

  getObject(handle) {
    return this.call(OP.GetObject, [handle], { read: true }, 'Transfert de la photo').data;
  }

  getPropDesc(code) {
    return parsePropDesc(this.call(OP.GetDevicePropDesc, [code], { read: true }).data);
  }

  getPropValue(code, type) {
    return new Reader(this.call(OP.GetDevicePropValue, [code], { read: true }).data).value(type);
  }

  setPropValue(code, type, value) {
    return this.call(OP.SetDevicePropValue, [code], { data: encodeValue(type, value) }, 'Réglage');
  }

  // Appelé régulièrement entre deux séances pour que l'appareil ne s'éteigne pas.
  keepAlive() {}
}

// Construit la liste affichée d'un réglage à partir des valeurs brutes.
function choice(values, current, label) {
  const labels = [];
  const byLabel = new Map();
  values.forEach((v) => {
    const l = label(v);
    if (!byLabel.has(l)) {
      byLabel.set(l, v);
      labels.push(l);
    }
  });
  return { values: labels, value: labels.find((l) => byLabel.get(l) === current) || '', byLabel };
}

module.exports = { BaseCamera, choice };
