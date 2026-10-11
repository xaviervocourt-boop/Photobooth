// Appareils simulés (Nikon Z, Canon EOS) qui répondent aux commandes PTP
// comme les vrais : sert à tester le photobooth sans appareil branché
// (variable d'environnement PHOTOBOOTH_CAMERA_SIM=nikon, canon ou canon1000d).
'use strict';

const fs = require('fs');
const path = require('path');
const { RC, DT, encodeValue, Reader } = require('./ptp');
const { readFormat, writeFormat } = require('./canon');

const asset = (f) => fs.readFileSync(path.join(__dirname, 'sim-assets', f));
const LV = [0, 1, 2, 3].map((i) => asset(`lv${i}.jpg`));
const PHOTO = asset('photo.jpg');

class Writer {
  constructor() {
    this.parts = [];
  }

  u8(v) { this.parts.push(Buffer.from([v & 0xff])); return this; }

  u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); this.parts.push(b); return this; }

  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this.parts.push(b); return this; }

  str(s) {
    if (!s) return this.u8(0);
    this.u8(s.length + 1);
    this.parts.push(Buffer.from(`${s}\0`, 'utf16le'));
    return this;
  }

  arr16(list) { this.u32(list.length); list.forEach((v) => this.u16(v)); return this; }

  value(type, v) { this.parts.push(encodeValue(type, v)); return this; }

  bytes(b) { this.parts.push(b); return this; }

  buf() { return Buffer.concat(this.parts); }
}

const ok = (data = null, params = []) => ({ code: RC.OK, params, data });
const fail = (code) => ({ code, params: [], data: null });

function deviceInfo(vendor, manufacturer, model, ops, props) {
  return new Writer().u16(100).u32(vendor).u16(100).str('').u16(0)
    .arr16(ops).arr16([]).arr16(props).arr16([]).arr16([0x3801])
    .str(manufacturer).str(model).str('1.00').str('0123456789').buf();
}

function objectInfo(format, size, name) {
  return new Writer().u32(0x00010001).u16(format).u16(0).u32(size)
    .u16(0).u32(0).u32(0).u32(0).u32(1800).u32(1200).u32(24).u32(0).u16(0).u32(0).u32(1)
    .str(name).str('20261011T120000').str('').str('').buf();
}

/* ---------- Nikon Z ---------- */

function nikon(options) {
  const props = {
    0x5007: { type: DT.UINT16, cur: 560, values: [180, 280, 400, 560, 710, 800, 1100, 1600] },
    0xd100: {
      type: DT.UINT32,
      cur: 0x0001007d,
      values: [0x0001001e, 0x0001003c, 0x0001007d, 0x000100c8, 0x000100fa, 0x000101f4, 0x000a000d, 0x00010001],
    },
    0x500f: { type: DT.UINT16, cur: 400, values: [100, 200, 400, 800, 1600, 3200, 6400] },
    0x5005: { type: DT.UINT16, cur: 2, values: [2, 4, 0x8010, 0x8011, 6, 5, 7] },
    0x5004: { type: DT.UINT8, cur: 4, values: [0, 2, 4, 5, 7, 12] },
    0xd10b: { type: DT.UINT8, cur: 0, values: [0, 1] },
    0xd17b: { type: DT.UINT8, cur: 0, values: [0, 1] },
    0xd1ac: { type: DT.UINT8, cur: 2, values: [1, 2, 3] },
  };
  const ops = [0x1001, 0x1008, 0x1009, 0x100b, 0x1014, 0x1015, 0x1016, 0x90c1, 0x90c7, 0x90c8, 0x9201, 0x9202, 0x9203, 0x9207, 0x941c];
  const info = deviceInfo(0x0a, 'Nikon Corporation', options.zf ? 'Z f' : 'Z 6_2', ops, [...Object.keys(props).map(Number), 0xd1a2, 0xd1a4]);
  let lv = 0;
  let frame = 0;
  let busy = 0;
  let events = [];
  let shots = 0;
  let nextHandle = 0xffff0001;
  const sdram = [];
  // Options : « samehandle » = toutes les images annoncées en 0xffff0001 (l'une
  // après l'autre), « keep » = l'image reste en mémoire jusqu'à DeleteObject.
  const find = (h) => sdram.findIndex((o) => o.handle === h);
  return {
    execute(op, params = [], { data } = {}) {
      switch (op) {
        case 0x1001: return ok(info);
        case 0x1014: {
          const p = props[params[0]];
          if (!p) return fail(RC.DevicePropNotSupported);
          const w = new Writer().u16(params[0]).u16(p.type).u8(1).value(p.type, p.values[0]).value(p.type, p.cur).u8(2).u16(p.values.length);
          p.values.forEach((v) => w.value(p.type, v));
          return ok(w.buf());
        }
        case 0x1015:
          if (params[0] === 0xd1a2) return ok(Buffer.from([lv]));
          if (params[0] === 0xd1a4) return ok(encodeValue(DT.UINT32, options.prohibit ? 0x80000000 : 0));
          return props[params[0]] ? ok(encodeValue(props[params[0]].type, props[params[0]].cur)) : fail(RC.DevicePropNotSupported);
        case 0x1016: {
          const p = props[params[0]];
          if (!p) return fail(RC.DevicePropNotSupported);
          const v = new Reader(data).value(p.type);
          if (!p.values.includes(v)) return fail(RC.InvalidDevicePropValue);
          if (options.lock && params[0] === 0x5007) return fail(0xa00a);
          p.cur = v;
          return ok();
        }
        case 0x9201:
          lv = 1;
          busy = 2;
          return ok();
        case 0x9202:
          lv = 0;
          return ok();
        case 0x90c8:
          if (busy > 0) {
            busy -= 1;
            return fail(RC.DeviceBusy);
          }
          return ok();
        case 0x9203:
          if (!lv) return fail(0xa00b);
          return ok(Buffer.concat([Buffer.alloc(384, 0x11), LV[frame++ % LV.length]]));
        case 0x9207: {
          if (params[0] !== 0xffffffff && params[0] !== 0xfffffffe) return fail(RC.InvalidParameter);
          shots += 1;
          busy = 3;
          const base = `DSC_${String(shots).padStart(4, '0')}`;
          const q = props[0x5004].cur;
          const added = [];
          // RAW (7) ou RAW + JPEG (≥ 8) : un fichier NEF en plus, annoncé en premier.
          if (q >= 7) added.push({ name: `${base}.NEF`, format: 0x3000 });
          if (q !== 7) added.push({ name: `${base}.JPG`, format: 0x3801 });
          added.forEach((o) => {
            o.handle = options.samehandle ? 0xffff0001 : nextHandle++;
            sdram.push(o);
            events.push({ code: 0xc101, params: [o.handle] });
          });
          events.push({ code: 0xc102, params: [] });
          return ok();
        }
        case 0x90c1:
          busy = 2;
          return ok();
        case 0x941c: {
          const w = new Writer().u16(events.length).u16(0);
          events.forEach((e) => {
            w.u16(e.code).u16(e.params.length);
            e.params.forEach((v) => w.u32(v));
          });
          events = [];
          return ok(w.buf());
        }
        case 0x1008: {
          const i = find(params[0]);
          return i >= 0 ? ok(objectInfo(sdram[i].format, PHOTO.length, sdram[i].name)) : fail(RC.InvalidObjectHandle);
        }
        case 0x1009: {
          const i = find(params[0]);
          if (i < 0) return fail(RC.InvalidObjectHandle);
          if (!options.keep) sdram.splice(i, 1);
          return ok(PHOTO);
        }
        case 0x100b: {
          const i = find(params[0]);
          if (i < 0) return fail(RC.InvalidObjectHandle);
          sdram.splice(i, 1);
          return ok();
        }
        default:
          return fail(RC.OperationNotSupported);
      }
    },
    state: () => ({ inMemory: sdram.length, liveView: lv === 1, shots }),
    close() {},
  };
}

/* ---------- Canon EOS ---------- */

function valueRecord(code, value) {
  const payload = Array.isArray(value) ? writeFormat(value) : encodeValue(DT.UINT32, value);
  return new Writer().u32(12 + payload.length).u32(0xc189).u32(code).bytes(payload).buf();
}

function listRecord(code, values) {
  const payload = Buffer.concat(values.map((v) => (Array.isArray(v) ? writeFormat(v) : encodeValue(DT.UINT32, v))));
  return new Writer().u32(20 + payload.length).u32(0xc18a).u32(code).u32(3).u32(values.length).bytes(payload).buf();
}

function transferRecord(handle, format, size, name) {
  const b = Buffer.alloc(Math.ceil((0x1c + name.length + 1) / 4) * 4);
  b.writeUInt32LE(b.length, 0);
  b.writeUInt32LE(0xc186, 4);
  b.writeUInt32LE(handle, 8);
  b.writeUInt16LE(format, 0x0c);
  b.writeUInt32LE(size, 0x14);
  b.write(name, 0x1c, 'latin1');
  return b;
}

function canon(options) {
  const model = options.model || 'Canon EOS 550D';
  const releaseOnOff = !/1000D/.test(model);
  const ops = [0x1001, 0x1008, 0x1009, 0x101b, 0x9110, 0x9114, 0x9115, 0x9116, 0x9117, 0x911a, 0x911d, 0x9151, 0x9152, 0x9153,
    ...(releaseOnOff ? [0x9128, 0x9129] : [0x910f])];
  const info = deviceInfo(0x0b, 'Canon Inc.', model, ops, []);
  const formats = [
    [{ type: 1, size: 0, comp: 3 }], [{ type: 1, size: 0, comp: 2 }], [{ type: 1, size: 1, comp: 3 }],
    [{ type: 6, size: 0, comp: 4 }], [{ type: 6, size: 0, comp: 4 }, { type: 1, size: 0, comp: 3 }],
  ];
  const props = new Map([
    [0xd101, { value: 0x30, values: [0x20, 0x23, 0x25, 0x28, 0x2b, 0x2d, 0x30, 0x33, 0x35, 0x38, 0x40] }],
    [0xd102, { value: 0x70, values: [0x60, 0x65, 0x68, 0x6d, 0x70, 0x75, 0x78, 0x80] }],
    [0xd103, { value: 0x50, values: [0x00, 0x48, 0x50, 0x58, 0x60, 0x68] }],
    [0xd109, { value: 0, values: [0, 1, 2, 8, 3, 4, 5] }],
    [0xd120, { value: formats[0], values: formats }],
    [0xd11c, { value: 2, values: [] }],
    [0xd11b, { value: 0, values: [] }],
    [0xd1b0, { value: 1, values: [] }],
    [0xd1b1, { value: 0, values: [] }],
  ]);
  let queue = [];
  let frame = 0;
  let shots = 0;
  const objects = new Map();
  const pushValue = (code) => queue.push(valueRecord(code, props.get(code).value));

  function shoot() {
    shots += 1;
    const base = `IMG_${String(shots).padStart(4, '0')}`;
    const fmt = props.get(0xd120).value;
    fmt.forEach((e, i) => {
      const handle = 0x91f00000 + shots * 4 + i;
      const jpeg = e.type === 1;
      objects.set(handle, PHOTO);
      queue.push(transferRecord(handle, jpeg ? 0x3801 : 0xb103, PHOTO.length, `${base}.${jpeg ? 'JPG' : 'CR2'}`));
    });
  }

  return {
    execute(op, params = [], { data } = {}) {
      switch (op) {
        case 0x1001: return ok(info);
        case 0x9114: return ok();
        case 0x9115:
          for (const [code, p] of props) {
            if (p.values.length) queue.push(listRecord(code, p.values));
            pushValue(code);
          }
          return ok();
        case 0x9116: {
          const out = Buffer.concat([...queue, new Writer().u32(8).u32(0).buf()]);
          queue = [];
          return ok(out);
        }
        case 0x9110: {
          const code = data.readUInt32LE(4);
          const p = props.get(code);
          if (!p) return fail(RC.GeneralError);
          const value = code === 0xd120 ? readFormat(data, 8).entries : data.readUInt32LE(8);
          if (p.values.length && !p.values.some((v) => JSON.stringify(v) === JSON.stringify(value))) return fail(RC.InvalidDevicePropValue);
          if (!(options.lock && code === 0xd101)) p.value = value; // molette pas en M : valeur gardée
          pushValue(code);
          if (code === 0xd11c && value === 4) {
            props.get(0xd11b).value = 9999;
            pushValue(0xd11b);
          }
          return ok();
        }
        case 0x911a: case 0x911d: case 0x9151: case 0x9152: case 0x9129:
          return ok();
        case 0x9153: {
          if (!(props.get(0xd1b0).value & 2)) return fail(0xa102);
          const jpeg = LV[frame++ % LV.length];
          const head = new Writer().u32(jpeg.length + 8).u32(1).buf();
          const histogram = new Writer().u32(16).u32(17).u32(0).u32(0).buf();
          return ok(Buffer.concat([head, jpeg, histogram]));
        }
        case 0x9128:
          if (params[0] === 2) shoot();
          return ok();
        case 0x910f:
          shoot();
          return ok(null, [0]);
        case 0x101b: {
          const o = objects.get(params[0]);
          return o ? ok(o.subarray(params[1], params[1] + params[2])) : fail(RC.InvalidObjectHandle);
        }
        case 0x9117:
          objects.delete(params[0]);
          return ok();
        default:
          return fail(RC.OperationNotSupported);
      }
    },
    state: () => ({ inMemory: objects.size, liveView: (props.get(0xd1b0).value & 2) === 2, shots }),
    close() {},
  };
}

// « nikon », « canon », « canon1000d », options après « : » (ex. nikon:zf,prohibit,lock).
// « none » : aucun appareil branché (renvoie null).
function createSimulator(spec) {
  const [name, opts = ''] = String(spec).split(':');
  const options = Object.fromEntries(opts.split(',').filter(Boolean).map((o) => [o, true]));
  if (name === 'none') return null;
  if (name === 'nikon') return nikon(options);
  if (name === 'canon1000d') return canon({ ...options, model: 'Canon EOS 1000D' });
  return canon(options);
}

module.exports = { createSimulator };
