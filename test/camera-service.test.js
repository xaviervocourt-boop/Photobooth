// Processus du pilote (desktop/camera/service.js) avec un appareil simulé :
// débranchement en plein live view, journal sans répétitions, rebranchement.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const ROOT = path.join(__dirname, '..', 'desktop', 'camera');
const sim = require(path.join(ROOT, 'sim'));
const { PtpError } = require(path.join(ROOT, 'ptp'));

// Appareil simulé qu'on peut « débrancher ».
let plugged = true;
const realCreate = sim.createSimulator;
sim.createSimulator = (spec) => {
  if (!plugged) throw new PtpError('Aucun appareil photo Nikon ou Canon détecté.');
  const t = realCreate(spec);
  return {
    execute(op, params, opts) {
      if (!plugged) {
        const err = new PtpError('L\'appareil photo a été débranché ou éteint.');
        err.hresult = 0x8007048f;
        throw err;
      }
      return t.execute(op, params, opts);
    },
    close() {},
  };
};

// Électron fournit process.parentPort au processus du pilote.
const port = new EventEmitter();
const logs = [];
const replies = new Map();
port.postMessage = (msg) => {
  if (msg.log) logs.push(msg.log);
  else if (!msg.fired) replies.set(msg.id, msg);
};
process.parentPort = port;
process.env.PHOTOBOOTH_CAMERA_SIM = 'nikon';
require(path.join(ROOT, 'service'));

let seq = 0;
function call(cmd, args = {}) {
  const id = ++seq;
  port.emit('message', { data: { id, cmd, args } });
  return replies.get(id);
}
const isJpeg = (b) => b && b[0] === 0xff && b[1] === 0xd8;

test('connexion, live view, photo', () => {
  assert.deepStrictEqual(call('connect').result, { model: 'Nikon Z 6II', serial: '0123456789' });
  assert.ok(call('liveview-start').ok);
  assert.ok(isJpeg(call('frame').result));
  const photo = call('capture').result;
  assert.strictEqual(photo.name, 'DSC_0001.JPG');
  assert.ok(isJpeg(photo.data));
  assert.ok(logs.some((l) => l.startsWith('connecté : Nikon Z 6II')));
});

test('débranché en plein live view : erreurs notées une fois, puis reconnexion', async () => {
  plugged = false;
  const before = logs.length;
  const t0 = Date.now();
  for (let i = 0; i < 300; i++) {
    const r = call('frame');
    assert.strictEqual(r.ok, false);
  }
  assert.ok(Date.now() - t0 < 2000, 'les demandes d\'image sans appareil doivent rester rapides');
  const added = logs.slice(before);
  assert.ok(added.length <= 4, `journal trop bavard :\n${added.join('\n')}`);
  assert.match(call('connect').error, /Aucun appareil/);

  plugged = true;
  await new Promise((r) => setTimeout(r, 2100)); // délai avant nouvelle recherche
  const frame = call('frame');
  assert.ok(frame.ok, frame.error);
  assert.ok(isJpeg(frame.result));
  assert.ok(logs.some((l) => /répétée \d+ fois/.test(l)), 'le nombre de répétitions est noté');
  assert.strictEqual(call('capture').result.name, 'DSC_0001.JPG');
});

test('commande inconnue et réglage inconnu', () => {
  assert.match(call('bidule').error, /Commande inconnue/);
  assert.match(call('set-setting', { name: 'zoom', value: '2' }).error, /Réglage inconnu/);
  const s = call('set-setting', { name: 'iso', value: '800' });
  assert.ok(s.ok, s.error);
  assert.strictEqual(s.result.value, '800');
});

test('déconnexion', () => {
  assert.ok(call('disconnect').ok);
  assert.ok(call('connect').ok);
});

test.after(() => setImmediate(() => process.exit(0))); // minuterie de maintien en éveil
