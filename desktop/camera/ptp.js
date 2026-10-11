// Protocole PTP (ISO 15740), commun à Nikon et Canon : codes et lecture /
// écriture des données échangées avec l'appareil.
// Les codes viennent de la documentation publique du protocole (et de
// libgphoto2, qui la recense).
'use strict';

const OP = {
  GetDeviceInfo: 0x1001,
  GetObjectInfo: 0x1008,
  GetObject: 0x1009,
  DeleteObject: 0x100b,
  GetDevicePropDesc: 0x1014,
  GetDevicePropValue: 0x1015,
  SetDevicePropValue: 0x1016,
  GetPartialObject: 0x101b,
};

const RC = {
  OK: 0x2001,
  GeneralError: 0x2002,
  OperationNotSupported: 0x2005,
  ParameterNotSupported: 0x2006,
  InvalidObjectHandle: 0x2009,
  DevicePropNotSupported: 0x200a,
  StoreFull: 0x200c,
  AccessDenied: 0x200f,
  DeviceBusy: 0x2019,
  InvalidDevicePropValue: 0x201c,
  InvalidParameter: 0x201d,
};

const DT = {
  INT8: 0x0001, UINT8: 0x0002, INT16: 0x0003, UINT16: 0x0004,
  INT32: 0x0005, UINT32: 0x0006, INT64: 0x0007, UINT64: 0x0008, STR: 0xffff,
};

const OFC_JPEG = 0x3801;
const OFC_ASSOCIATION = 0x3001;

class PtpError extends Error {
  constructor(message, code = 0, op = 0) {
    super(message);
    this.code = code;
    this.op = op;
  }
}

const hex = (n, w = 4) => `0x${(n >>> 0).toString(16).padStart(w, '0')}`;

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  get remaining() { return this.buf.length - this.pos; }

  need(n) {
    if (this.pos + n > this.buf.length) throw new PtpError('Réponse de l\'appareil incomplète.');
  }

  u8() { this.need(1); return this.buf.readUInt8(this.pos++); }

  i8() { this.need(1); return this.buf.readInt8(this.pos++); }

  u16() { this.need(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }

  i16() { this.need(2); const v = this.buf.readInt16LE(this.pos); this.pos += 2; return v; }

  u32() { this.need(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }

  i32() { this.need(4); const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }

  u64() { this.need(8); const v = Number(this.buf.readBigUInt64LE(this.pos)); this.pos += 8; return v; }

  i64() { this.need(8); const v = Number(this.buf.readBigInt64LE(this.pos)); this.pos += 8; return v; }

  skip(n) { this.need(n); this.pos += n; }

  // Chaîne PTP : nombre de caractères (zéro final compris) puis UTF-16LE.
  str() {
    const n = this.u8();
    if (!n) return '';
    this.need(n * 2);
    const s = this.buf.toString('utf16le', this.pos, this.pos + (n - 1) * 2);
    this.pos += n * 2;
    return s;
  }

  array(read) {
    const n = this.u32();
    const out = [];
    for (let i = 0; i < n; i++) out.push(read.call(this));
    return out;
  }

  value(type) {
    switch (type) {
      case DT.INT8: return this.i8();
      case DT.UINT8: return this.u8();
      case DT.INT16: return this.i16();
      case DT.UINT16: return this.u16();
      case DT.INT32: return this.i32();
      case DT.UINT32: return this.u32();
      case DT.INT64: return this.i64();
      case DT.UINT64: return this.u64();
      case DT.STR: return this.str();
      default:
        if (type & 0x4000) return this.array(function arr() { return this.value(type & ~0x4000); });
        throw new PtpError(`Type de donnée inconnu ${hex(type)}.`);
    }
  }
}

function encodeValue(type, value) {
  switch (type) {
    case DT.INT8: { const b = Buffer.alloc(1); b.writeInt8(value); return b; }
    case DT.UINT8: { const b = Buffer.alloc(1); b.writeUInt8(value); return b; }
    case DT.INT16: { const b = Buffer.alloc(2); b.writeInt16LE(value); return b; }
    case DT.UINT16: { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
    case DT.INT32: { const b = Buffer.alloc(4); b.writeInt32LE(value); return b; }
    case DT.UINT32: { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; }
    case DT.INT64: { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(value)); return b; }
    case DT.UINT64: { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; }
    default: throw new PtpError(`Écriture du type ${hex(type)} non prise en charge.`);
  }
}

function parseDeviceInfo(buf) {
  const r = new Reader(buf);
  const info = {
    standardVersion: r.u16(),
    vendorExtensionId: r.u32(),
    vendorExtensionVersion: r.u16(),
    vendorExtensionDesc: r.str(),
    functionalMode: r.u16(),
  };
  info.operations = r.array(r.u16);
  info.events = r.array(r.u16);
  info.properties = r.array(r.u16);
  info.captureFormats = r.array(r.u16);
  info.imageFormats = r.array(r.u16);
  info.manufacturer = r.str();
  info.model = r.str();
  info.deviceVersion = r.str();
  info.serialNumber = r.str();
  return info;
}

// Description d'un réglage : type, valeur actuelle et valeurs possibles.
function parsePropDesc(buf) {
  const r = new Reader(buf);
  const desc = { code: r.u16(), type: r.u16(), writable: r.u8() === 1 };
  desc.factory = r.value(desc.type);
  desc.current = r.value(desc.type);
  const form = r.remaining ? r.u8() : 0;
  desc.values = [];
  if (form === 1) {
    desc.range = { min: r.value(desc.type), max: r.value(desc.type), step: r.value(desc.type) };
    if (desc.range.step > 0 && (desc.range.max - desc.range.min) / desc.range.step <= 200) {
      for (let v = desc.range.min; v <= desc.range.max; v += desc.range.step) desc.values.push(v);
    }
  } else if (form === 2) {
    const n = r.u16();
    for (let i = 0; i < n; i++) desc.values.push(r.value(desc.type));
  }
  return desc;
}

function parseObjectInfo(buf) {
  const r = new Reader(buf);
  const oi = {
    storageId: r.u32(),
    format: r.u16(),
    protection: r.u16(),
    size: r.u32(),
  };
  r.skip(2 + 4 + 4 + 4); // miniature : format, taille, largeur, hauteur
  oi.width = r.u32();
  oi.height = r.u32();
  oi.bitDepth = r.u32();
  oi.parent = r.u32();
  oi.associationType = r.u16();
  r.skip(4 + 4); // AssociationDesc, SequenceNumber
  oi.filename = r.str();
  return oi;
}

function isJpeg(format, name) {
  return format === OFC_JPEG || /\.jpe?g$/i.test(name || '');
}

// Repère l'image JPEG dans des données qui ont un en-tête devant.
function extractJpeg(buf, from = 0) {
  for (let i = from; i < buf.length - 1; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8) {
      let end = buf.length;
      for (let j = buf.length - 2; j > i; j--) {
        if (buf[j] === 0xff && buf[j + 1] === 0xd9) {
          end = j + 2;
          break;
        }
      }
      return buf.subarray(i, end);
    }
  }
  return null;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

module.exports = {
  OP, RC, DT, OFC_JPEG, OFC_ASSOCIATION, PtpError, Reader, encodeValue, hex,
  parseDeviceInfo, parsePropDesc, parseObjectInfo, isJpeg, extractJpeg, sleep,
};
