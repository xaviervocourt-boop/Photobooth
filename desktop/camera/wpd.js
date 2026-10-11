// Transport USB par le pilote d'appareils photo intégré à Windows (WPD) :
// les commandes PTP passent par les « commandes MTP étendues » de Windows,
// sans logiciel ni pilote supplémentaire.
// Les interfaces COM sont appelées directement (koffi) d'après leurs
// définitions publiques (PortableDeviceApi.idl). Même principe que
// PortableDeviceLib de digiCamControl (licence MIT).
'use strict';

const koffi = require('koffi');
const { PtpError, sleep } = require('./ptp');

const GUID = koffi.struct('PB_GUID', {
  Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: koffi.array('uint8', 8),
});
koffi.struct('PB_PROPERTYKEY', { fmtid: GUID, pid: 'uint32' });

function guid(str) {
  const h = str.replace(/[{}-]/g, '');
  return {
    Data1: parseInt(h.slice(0, 8), 16),
    Data2: parseInt(h.slice(8, 12), 16),
    Data3: parseInt(h.slice(12, 16), 16),
    Data4: Array.from(Buffer.from(h.slice(16), 'hex')),
  };
}
const key = (fmtid, pid) => ({ fmtid: guid(fmtid), pid });

const CLSID = {
  PortableDeviceManager: guid('0af10cec-2ecd-4b92-9581-34f6ae0637f3'),
  PortableDeviceFTM: guid('f7c0039a-4762-488a-b4b3-760ef9a1ba9b'),
  PortableDevice: guid('728a21c5-3d9e-48d7-9810-864848f0f404'),
  PortableDeviceValues: guid('0c15d503-d017-47ce-9016-7b3f978721cc'),
  PortableDevicePropVariantCollection: guid('08a99e2f-6d6d-4b80-af5a-baf2bcbe4cb9'),
};
const IID = {
  IPortableDeviceManager: guid('a1567595-4c2f-4574-a6fa-ecef917b9a40'),
  IPortableDevice: guid('625e2df8-6392-4cf0-9ad1-3cfa5f17775c'),
  IPortableDeviceValues: guid('6848f6f2-3155-4f86-b6f5-263eeeab3143'),
  IPortableDevicePropVariantCollection: guid('89b2e422-4f1b-4316-bcef-a44afea83eb3'),
};

const COMMON = 'f0422a9c-5dc8-4440-b5bd-5df28835658a';
const CLIENT = '204d9f0c-2292-4080-9f42-40664e70f859';
const MTP = '4d545058-1a2e-4106-a357-771e0819fc56';
const MTP_CATEGORY = guid(MTP);
const K = {
  CommandCategory: key(COMMON, 1001),
  CommandId: key(COMMON, 1002),
  HResult: key(COMMON, 1003),
  ClientName: key(CLIENT, 2),
  ClientMajor: key(CLIENT, 3),
  ClientMinor: key(CLIENT, 4),
  ClientRevision: key(CLIENT, 5),
  ClientQoS: key(CLIENT, 8),
  OpCode: key(MTP, 1001),
  OpParams: key(MTP, 1002),
  RespCode: key(MTP, 1003),
  RespParams: key(MTP, 1004),
  Context: key(MTP, 1006),
  TotalSize: key(MTP, 1007),
  ToRead: key(MTP, 1008),
  Read: key(MTP, 1009),
  ToWrite: key(MTP, 1010),
  Data: key(MTP, 1012),
  Optimal: key(MTP, 1013),
};
// Commandes WPD_COMMAND_MTP_EXT_* (catégorie MTP_CATEGORY).
const CMD = { NoData: 12, WithRead: 13, WithWrite: 14, Read: 15, Write: 16, End: 17 };

// Rang des méthodes dans les tables virtuelles (IUnknown = 0 à 2).
const V = {
  Release: 2,
  GetDevices: 3, RefreshDeviceList: 4, GetDeviceFriendlyName: 5, GetDeviceDescription: 6, GetDeviceManufacturer: 7,
  Open: 3, SendCommand: 4, Close: 8,
  SetStringValue: 7, GetStringValue: 8, SetUnsignedIntegerValue: 9, GetUnsignedIntegerValue: 10,
  SetUnsignedLargeIntegerValue: 13, GetUnsignedLargeIntegerValue: 14, GetErrorValue: 20, SetGuidValue: 27,
  SetBufferValue: 29, GetBufferValue: 30, SetCollectionValue: 33, GetCollectionValue: 34,
  CollGetCount: 3, CollGetAt: 4, CollAdd: 5,
};

const HR = {
  BUSY: 0x800700aa,
  NOT_CONNECTED: 0x8007048f,
  NOT_READY: 0x80070015,
  GEN_FAILURE: 0x8007001f,
  ACCESS_DENIED: 0x80070005,
  CHANGED_MODE: 0x80010106,
};

let api = null;
let P = null;

function init() {
  if (api) return;
  const ole32 = koffi.load('ole32.dll');
  api = {
    CoInitializeEx: ole32.func('int32 __stdcall CoInitializeEx(void *reserved, uint32 coinit)'),
    CoCreateInstance: ole32.func('int32 __stdcall CoCreateInstance(PB_GUID *clsid, void *outer, uint32 ctx, PB_GUID *iid, _Out_ void **obj)'),
    CoTaskMemFree: ole32.func('void __stdcall CoTaskMemFree(void *ptr)'),
  };
  const proto = (decl) => koffi.proto(decl);
  P = {
    Release: proto('uint32 __stdcall PB_Release(void *self)'),
    GetDevices: proto('int32 __stdcall PB_GetDevices(void *self, void *ids, _Inout_ uint32 *count)'),
    Refresh: proto('int32 __stdcall PB_Refresh(void *self)'),
    DeviceString: proto('int32 __stdcall PB_DeviceString(void *self, const char16_t *id, void *buf, _Inout_ uint32 *len)'),
    Open: proto('int32 __stdcall PB_Open(void *self, const char16_t *id, void *info)'),
    SendCommand: proto('int32 __stdcall PB_SendCommand(void *self, uint32 flags, void *params, _Out_ void **results)'),
    Close: proto('int32 __stdcall PB_Close(void *self)'),
    SetString: proto('int32 __stdcall PB_SetString(void *self, PB_PROPERTYKEY *key, const char16_t *value)'),
    GetString: proto('int32 __stdcall PB_GetString(void *self, PB_PROPERTYKEY *key, _Out_ void **value)'),
    SetUInt: proto('int32 __stdcall PB_SetUInt(void *self, PB_PROPERTYKEY *key, uint32 value)'),
    GetUInt: proto('int32 __stdcall PB_GetUInt(void *self, PB_PROPERTYKEY *key, _Out_ uint32 *value)'),
    SetU64: proto('int32 __stdcall PB_SetU64(void *self, PB_PROPERTYKEY *key, uint64 value)'),
    GetU64: proto('int32 __stdcall PB_GetU64(void *self, PB_PROPERTYKEY *key, _Out_ uint64 *value)'),
    GetError: proto('int32 __stdcall PB_GetError(void *self, PB_PROPERTYKEY *key, _Out_ int32 *value)'),
    SetGuid: proto('int32 __stdcall PB_SetGuid(void *self, PB_PROPERTYKEY *key, PB_GUID *value)'),
    SetBuffer: proto('int32 __stdcall PB_SetBuffer(void *self, PB_PROPERTYKEY *key, void *value, uint32 size)'),
    GetBuffer: proto('int32 __stdcall PB_GetBuffer(void *self, PB_PROPERTYKEY *key, _Out_ void **value, _Out_ uint32 *size)'),
    SetColl: proto('int32 __stdcall PB_SetColl(void *self, PB_PROPERTYKEY *key, void *value)'),
    GetColl: proto('int32 __stdcall PB_GetColl(void *self, PB_PROPERTYKEY *key, _Out_ void **value)'),
    CollCount: proto('int32 __stdcall PB_CollCount(void *self, _Out_ uint32 *count)'),
    CollGetAt: proto('int32 __stdcall PB_CollGetAt(void *self, uint32 index, void *value)'),
    CollAdd: proto('int32 __stdcall PB_CollAdd(void *self, void *value)'),
  };
  const hr = api.CoInitializeEx(null, 0); // COINIT_MULTITHREADED
  if (hr < 0 && (hr >>> 0) !== HR.CHANGED_MODE) throw comError(hr, 'Initialisation COM');
}

function comError(hr, what) {
  const code = hr >>> 0;
  const friendly = {
    [HR.NOT_CONNECTED]: 'L\'appareil photo a été débranché ou éteint.',
    [HR.NOT_READY]: 'L\'appareil photo n\'est pas prêt.',
    [HR.GEN_FAILURE]: 'L\'appareil photo ne répond plus : éteignez-le puis rallumez-le.',
    [HR.ACCESS_DENIED]: 'Accès refusé : fermez les logiciels qui utilisent l\'appareil (Photos, EOS Utility, Nikon Transfer…).',
    [HR.BUSY]: 'L\'appareil photo est occupé.',
  }[code];
  const err = new PtpError(friendly || `${what} : erreur Windows 0x${code.toString(16)}.`);
  err.hresult = code;
  return err;
}

function check(hr, what) {
  if (hr < 0) throw comError(hr, what);
  return hr;
}

function vcall(obj, index, proto, ...args) {
  const table = koffi.decode(obj, 'void *');
  const fn = koffi.decode(table, index * koffi.sizeof('void *'), 'void *');
  return koffi.call(fn, proto, obj, ...args);
}

function release(obj) {
  if (obj) vcall(obj, V.Release, P.Release);
}

function create(clsid, iid) {
  const out = [null];
  check(api.CoCreateInstance(clsid, null, 1 /* CLSCTX_INPROC_SERVER */, iid, out), 'Création d\'objet COM');
  return out[0];
}

/* ---------- IPortableDeviceValues ---------- */

const newValues = () => create(CLSID.PortableDeviceValues, IID.IPortableDeviceValues);
const setGuid = (v, k, g) => check(vcall(v, V.SetGuidValue, P.SetGuid, k, g), 'SetGuidValue');
const setUInt = (v, k, n) => check(vcall(v, V.SetUnsignedIntegerValue, P.SetUInt, k, n >>> 0), 'SetUnsignedIntegerValue');
const setU64 = (v, k, n) => check(vcall(v, V.SetUnsignedLargeIntegerValue, P.SetU64, k, n), 'SetUnsignedLargeIntegerValue');
const setString = (v, k, s) => check(vcall(v, V.SetStringValue, P.SetString, k, s), 'SetStringValue');
const setBuffer = (v, k, b) => check(vcall(v, V.SetBufferValue, P.SetBuffer, k, b, b.length), 'SetBufferValue');
const setColl = (v, k, c) => check(vcall(v, V.SetCollectionValue, P.SetColl, k, c), 'SetCollectionValue');

function getUInt(v, k) {
  const out = [0];
  return vcall(v, V.GetUnsignedIntegerValue, P.GetUInt, k, out) >= 0 ? out[0] : null;
}

function getU64(v, k) {
  const out = [0];
  return vcall(v, V.GetUnsignedLargeIntegerValue, P.GetU64, k, out) >= 0 ? Number(out[0]) : null;
}

function getError(v, k) {
  const out = [0];
  return vcall(v, V.GetErrorValue, P.GetError, k, out) >= 0 ? out[0] : 0;
}

function getString(v, k) {
  const out = [null];
  if (vcall(v, V.GetStringValue, P.GetString, k, out) < 0 || !out[0]) return null;
  const s = koffi.decode(out[0], 'char16_t', -1);
  api.CoTaskMemFree(out[0]);
  return s;
}

function getBuffer(v, k) {
  const ptr = [null];
  const size = [0];
  if (vcall(v, V.GetBufferValue, P.GetBuffer, k, ptr, size) < 0 || !ptr[0]) return Buffer.alloc(0);
  const buf = size[0] ? Buffer.from(koffi.view(ptr[0], size[0])) : Buffer.alloc(0);
  api.CoTaskMemFree(ptr[0]);
  return buf;
}

function getColl(v, k) {
  const out = [null];
  return vcall(v, V.GetCollectionValue, P.GetColl, k, out) >= 0 ? out[0] : null;
}

/* ---------- IPortableDevicePropVariantCollection (paramètres PTP) ---------- */

function newCollection(values) {
  const c = create(CLSID.PortableDevicePropVariantCollection, IID.IPortableDevicePropVariantCollection);
  for (const value of values) {
    const pv = Buffer.alloc(24); // PROPVARIANT x64 : vt sur 2 octets, valeur à l'octet 8
    pv.writeUInt16LE(19, 0); // VT_UI4
    pv.writeUInt32LE(value >>> 0, 8);
    check(vcall(c, V.CollAdd, P.CollAdd, pv), 'PropVariantCollection.Add');
  }
  return c;
}

function readCollection(c) {
  if (!c) return [];
  const n = [0];
  if (vcall(c, V.CollGetCount, P.CollCount, n) < 0) return [];
  const out = [];
  for (let i = 0; i < n[0]; i++) {
    const pv = Buffer.alloc(24);
    if (vcall(c, V.CollGetAt, P.CollGetAt, i, pv) >= 0) out.push(pv.readUInt32LE(8));
  }
  return out;
}

/* ---------- Appareils ---------- */

function deviceString(mgr, index, id) {
  const len = [0];
  if (vcall(mgr, index, P.DeviceString, id, null, len) < 0 || !len[0]) return '';
  const buf = Buffer.alloc(len[0] * 2);
  if (vcall(mgr, index, P.DeviceString, id, buf, len) < 0) return '';
  return buf.toString('utf16le').replace(/\0[\s\S]*$/, '');
}

function listDevices() {
  init();
  const mgr = create(CLSID.PortableDeviceManager, IID.IPortableDeviceManager);
  try {
    vcall(mgr, V.RefreshDeviceList, P.Refresh);
    const count = [0];
    check(vcall(mgr, V.GetDevices, P.GetDevices, null, count), 'Liste des appareils');
    if (!count[0]) return [];
    const ids = koffi.alloc('void *', count[0]);
    try {
      check(vcall(mgr, V.GetDevices, P.GetDevices, ids, count), 'Liste des appareils');
      return koffi.decode(ids, 'void *', count[0]).filter(Boolean).map((ptr) => {
        const id = koffi.decode(ptr, 'char16_t', -1);
        api.CoTaskMemFree(ptr);
        return {
          id,
          name: deviceString(mgr, V.GetDeviceFriendlyName, id),
          description: deviceString(mgr, V.GetDeviceDescription, id),
          manufacturer: deviceString(mgr, V.GetDeviceManufacturer, id),
        };
      });
    } finally {
      koffi.free(ids);
    }
  } finally {
    release(mgr);
  }
}

class WpdTransport {
  constructor(id) {
    init();
    this.id = id;
    this.dev = null;
  }

  open() {
    let dev;
    try {
      dev = create(CLSID.PortableDeviceFTM, IID.IPortableDevice);
    } catch {
      dev = create(CLSID.PortableDevice, IID.IPortableDevice);
    }
    const info = newValues();
    try {
      setString(info, K.ClientName, 'Photobooth');
      setUInt(info, K.ClientMajor, 1);
      setUInt(info, K.ClientMinor, 0);
      setUInt(info, K.ClientRevision, 0);
      setUInt(info, K.ClientQoS, 0x20000); // SECURITY_IMPERSONATION
      check(vcall(dev, V.Open, P.Open, this.id, info), 'Ouverture de l\'appareil');
      this.dev = dev;
    } catch (err) {
      release(dev);
      throw err;
    } finally {
      release(info);
    }
  }

  close() {
    if (!this.dev) return;
    vcall(this.dev, V.Close, P.Close);
    release(this.dev);
    this.dev = null;
  }

  // Envoie une commande MTP étendue et renvoie ses résultats (à libérer).
  command(id, setup) {
    const p = newValues();
    try {
      setGuid(p, K.CommandCategory, MTP_CATEGORY);
      setUInt(p, K.CommandId, id);
      setup(p);
      const out = [null];
      check(vcall(this.dev, V.SendCommand, P.SendCommand, 0, p, out), 'Commande');
      const hr = getError(out[0], K.HResult);
      if (hr < 0) {
        release(out[0]);
        throw comError(hr, 'Commande');
      }
      return out[0];
    } finally {
      release(p);
    }
  }

  response(r) {
    const coll = getColl(r, K.RespParams);
    try {
      return { code: getUInt(r, K.RespCode), params: readCollection(coll) };
    } finally {
      release(coll);
    }
  }

  execute(op, params = [], { data = null, read = false } = {}) {
    if (!this.dev) throw new PtpError('Appareil non connecté.');
    const coll = newCollection(params);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          if (data) return this.write(op, coll, data);
          if (read) return this.read(op, coll);
          return this.noData(op, coll);
        } catch (err) {
          if (err.hresult !== HR.BUSY || attempt >= 20) throw err;
          sleep(50);
        }
      }
    } finally {
      release(coll);
    }
  }

  noData(op, coll) {
    const r = this.command(CMD.NoData, (p) => {
      setUInt(p, K.OpCode, op);
      setColl(p, K.OpParams, coll);
    });
    try {
      return { ...this.response(r), data: null };
    } finally {
      release(r);
    }
  }

  read(op, coll) {
    let context;
    let total;
    let chunk;
    const r = this.command(CMD.WithRead, (p) => {
      setUInt(p, K.OpCode, op);
      setColl(p, K.OpParams, coll);
    });
    try {
      context = getString(r, K.Context);
      total = getU64(r, K.TotalSize) ?? getUInt(r, K.TotalSize) ?? 0;
      chunk = getUInt(r, K.Optimal) || 0x40000;
    } finally {
      release(r);
    }
    const chunks = [];
    let failure = null;
    try {
      let got = 0;
      while (got < total) {
        const n = Math.min(chunk, total - got);
        const rr = this.command(CMD.Read, (p) => {
          setString(p, K.Context, context);
          setBuffer(p, K.Data, Buffer.alloc(n));
          setUInt(p, K.ToRead, n);
        });
        try {
          const buf = getBuffer(rr, K.Data);
          const count = Math.min(getUInt(rr, K.Read) ?? buf.length, buf.length);
          if (!count) break;
          chunks.push(buf.subarray(0, count));
          got += count;
        } finally {
          release(rr);
        }
      }
    } catch (err) {
      failure = err;
    }
    const result = this.finish(context, failure);
    return { ...result, data: Buffer.concat(chunks) };
  }

  write(op, coll, data) {
    let context;
    const r = this.command(CMD.WithWrite, (p) => {
      setUInt(p, K.OpCode, op);
      setColl(p, K.OpParams, coll);
      setU64(p, K.TotalSize, data.length);
      setBuffer(p, K.Data, data);
    });
    try {
      context = getString(r, K.Context);
    } finally {
      release(r);
    }
    let failure = null;
    try {
      release(this.command(CMD.Write, (p) => {
        setString(p, K.Context, context);
        setBuffer(p, K.Data, data);
        setUInt(p, K.ToWrite, data.length);
      }));
    } catch (err) {
      failure = err;
    }
    return { ...this.finish(context, failure), data: null };
  }

  // Clôt toujours l'échange (sinon le pilote reste bloqué) et lit la réponse.
  finish(context, failure) {
    let end = null;
    try {
      end = this.command(CMD.End, (p) => setString(p, K.Context, context));
    } catch (err) {
      if (!failure) throw err;
    }
    try {
      if (failure) throw failure;
      return this.response(end);
    } finally {
      release(end);
    }
  }
}

// Vérifie la mécanique COM sans appareil branché (lancé par la construction).
function selfTest() {
  init();
  const assert = (cond, what) => {
    if (!cond) throw new Error(`auto-test WPD : ${what}`);
  };
  const v = newValues();
  try {
    setString(v, K.Context, 'contexte é');
    assert(getString(v, K.Context) === 'contexte é', 'chaîne');
    setUInt(v, K.OpCode, 0x9203);
    assert(getUInt(v, K.OpCode) === 0x9203, 'entier');
    setU64(v, K.TotalSize, 123456789012);
    assert(getU64(v, K.TotalSize) === 123456789012, 'entier 64 bits');
    setBuffer(v, K.Data, Buffer.from([1, 2, 3, 250]));
    assert(getBuffer(v, K.Data).equals(Buffer.from([1, 2, 3, 250])), 'tampon');
    setGuid(v, K.CommandCategory, MTP_CATEGORY);
    assert(getError(v, K.HResult) === 0, 'valeur absente');
    const c = newCollection([1, 0xffffffff, 0x00200000]);
    setColl(v, K.OpParams, c);
    release(c);
    const back = getColl(v, K.OpParams);
    const list = readCollection(back);
    release(back);
    assert(list.join() === [1, 0xffffffff, 0x00200000].join(), `collection (${list.join()})`);
  } finally {
    release(v);
  }
  return { devices: listDevices() };
}

module.exports = { listDevices, WpdTransport, selfTest };
