// Pilotes Nikon / Canon testés contre les appareils simulés (npm test).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', 'desktop', 'camera');
const { parseDeviceInfo } = require(path.join(ROOT, 'ptp'));
const { NikonCamera } = require(path.join(ROOT, 'nikon'));
const { CanonCamera } = require(path.join(ROOT, 'canon'));
const { createSimulator } = require(path.join(ROOT, 'sim'));

const PHOTO = fs.readFileSync(path.join(ROOT, 'sim-assets/photo.jpg'));
const LV = [0, 1, 2, 3].map((i) => fs.readFileSync(path.join(ROOT, `sim-assets/lv${i}.jpg`)));

function open(spec) {
  const t = createSimulator(spec);
  const ops = [];
  const transport = {
    execute(op, params = [], opts = {}) {
      ops.push(op);
      return t.execute(op, params, opts);
    },
  };
  const info = parseDeviceInfo(t.execute(0x1001, [], { read: true }).data);
  const logs = [];
  const Driver = /nikon/i.test(info.manufacturer) ? NikonCamera : CanonCamera;
  const cam = new Driver(transport, info, (m) => logs.push(m));
  return { cam, t, ops, logs };
}

const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;

/* ---------- Nikon ---------- */

test('nikon: modèle, live view, images différentes', () => {
  const { cam, t } = open('nikon');
  assert.strictEqual(cam.model, 'Nikon Z 6II');
  cam.connect();
  cam.startLiveView();
  assert.ok(t.state().liveView);
  const a = cam.frame();
  const b = cam.frame();
  assert.ok(isJpeg(a) && isJpeg(b));
  assert.ok(!a.equals(b), 'deux images successives identiques');
  // La première image est sautée (souvent abîmée) : on reçoit lv1 puis lv2.
  assert.ok(a.equals(LV[1]) && b.equals(LV[2]));
});

test('nikon: photo JPEG en mémoire, live view relancé', () => {
  const { cam, t, ops } = open('nikon');
  cam.connect();
  cam.startLiveView();
  cam.frame();
  const photo = cam.capture();
  assert.strictEqual(photo.name, 'DSC_0001.JPG');
  assert.ok(photo.data.equals(PHOTO));
  assert.strictEqual(t.state().inMemory, 0);
  assert.ok(ops.includes(0x90c1), 'pas de mise au point avant la photo');
  assert.ok(isJpeg(cam.frame()));
  const p2 = cam.capture();
  assert.strictEqual(p2.name, 'DSC_0002.JPG');
});

test('nikon: réglages lus avec libellés', () => {
  const { cam } = open('nikon');
  cam.connect();
  const s = cam.getSettings();
  assert.deepStrictEqual(s.aperture, { values: ['1.8', '2.8', '4', '5.6', '7.1', '8', '11', '16'], value: '5.6' });
  assert.deepStrictEqual(s.shutterspeed.values, ['1/30', '1/60', '1/125', '1/200', '1/250', '1/500', '0.8', '1']);
  assert.strictEqual(s.shutterspeed.value, '1/125');
  assert.strictEqual(s.iso.value, '400');
  assert.ok(s.iso.values.includes('6400'));
  assert.strictEqual(s.whitebalance.value, 'Auto');
  assert.ok(s.whitebalance.values.includes('Nuageux'));
  assert.strictEqual(s.compressionsetting.value, 'JPEG Fine');
  assert.ok(s.compressionsetting.values.includes('RAW + JPEG Fine'));
});

test('nikon: changer un réglage', () => {
  const { cam } = open('nikon');
  cam.connect();
  cam.getSettings();
  assert.strictEqual(cam.setSetting('aperture', '8').value, '8');
  assert.strictEqual(cam.setSetting('shutterspeed', '1/250').value, '1/250');
  assert.strictEqual(cam.setSetting('iso', '1600').value, '1600');
  assert.strictEqual(cam.getSettings().aperture.value, '8');
  assert.throws(() => cam.setSetting('aperture', '99'), /Valeur inconnue/);
});

for (const spec of ['nikon', 'nikon:samehandle,keep', 'nikon:samehandle', 'nikon:keep']) {
  test(`${spec}: RAW + JPEG → la photo JPEG, mémoire vidée`, () => {
    const { cam, t } = open(spec);
    cam.connect();
    cam.startLiveView();
    cam.setSetting('compressionsetting', 'RAW + JPEG Fine');
    const photo = cam.capture();
    assert.strictEqual(photo.name, 'DSC_0001.JPG');
    assert.strictEqual(t.state().inMemory, 0, 'des images restent dans la mémoire de l\'appareil');
    const p2 = cam.capture();
    assert.strictEqual(p2.name, 'DSC_0002.JPG');
    assert.strictEqual(t.state().inMemory, 0);
  });
}

test('nikon: RAW seul → message clair', () => {
  const { cam, t } = open('nikon');
  cam.connect();
  cam.setSetting('compressionsetting', 'RAW (NEF)');
  assert.throws(() => cam.capture(), /RAW : réglez la qualité d'image sur JPEG/);
  assert.strictEqual(t.state().inMemory, 0);
});

test('nikon:prohibit → raison du refus du live view', () => {
  const { cam } = open('nikon:prohibit');
  cam.connect();
  assert.throws(() => cam.startLiveView(), /molette de l'appareil sur P, A, S ou M/);
});

test('nikon:lock → réglage bloqué par le mode', () => {
  const { cam } = open('nikon:lock');
  cam.connect();
  assert.throws(() => cam.setSetting('aperture', '8'), /molette sur M/);
  assert.strictEqual(cam.getSettings().aperture.value, '5.6');
});

test('nikon: live view coupé par l\'appareil → relancé', () => {
  const { cam, t } = open('nikon');
  cam.connect();
  cam.startLiveView();
  cam.frame();
  t.execute(0x9202); // l'appareil sort du live view tout seul
  assert.ok(isJpeg(cam.frame()));
  assert.ok(t.state().liveView);
});

/* ---------- Canon ---------- */

for (const spec of ['canon', 'canon1000d']) {
  test(`${spec}: connexion, photos vers le PC, live view`, () => {
    const { cam, t } = open(spec);
    assert.strictEqual(cam.model, spec === 'canon' ? 'Canon EOS 550D' : 'Canon EOS 1000D');
    cam.connect();
    assert.strictEqual(cam.props.get(0xd11c).value, 4, 'destination PC non réglée');
    cam.startLiveView();
    assert.ok(t.state().liveView);
    const a = cam.frame();
    const b = cam.frame();
    assert.ok(isJpeg(a) && isJpeg(b));
    assert.ok(a.equals(LV[0]) && b.equals(LV[1]));
    for (let i = 0; i < 12; i++) cam.frame(); // passe par KeepDeviceOn
    cam.stopLiveView();
    assert.ok(!t.state().liveView);
  });

  test(`${spec}: photo JPEG`, () => {
    const { cam, t } = open(spec);
    cam.connect();
    cam.startLiveView();
    const photo = cam.capture();
    assert.strictEqual(photo.name, 'IMG_0001.JPG');
    assert.ok(photo.data.equals(PHOTO));
    assert.strictEqual(t.state().inMemory, 0);
    assert.ok(isJpeg(cam.frame()));
    assert.strictEqual(cam.capture().name, 'IMG_0002.JPG');
  });
}

test('canon: réglages lus avec libellés', () => {
  const { cam } = open('canon');
  cam.connect();
  const s = cam.getSettings();
  assert.deepStrictEqual(s.aperture.values, ['2.8', '3.2', '3.5', '4.0', '4.5', '5.0', '5.6', '6.3', '7.1', '8.0', '11']);
  assert.strictEqual(s.aperture.value, '5.6');
  assert.strictEqual(s.shutterspeed.value, '1/125');
  assert.ok(s.shutterspeed.values.includes('1/500'));
  assert.strictEqual(s.iso.value, '200');
  assert.deepStrictEqual(s.iso.values, ['Auto', '100', '200', '400', '800', '1600']);
  assert.strictEqual(s.whitebalance.value, 'Auto');
  assert.strictEqual(s.compressionsetting.value, 'JPEG L Fine');
  assert.deepStrictEqual(s.compressionsetting.values, ['JPEG L Fine', 'JPEG L Normal', 'JPEG M Fine', 'RAW', 'RAW + JPEG L Fine']);
});

test('canon: changer un réglage', () => {
  const { cam } = open('canon');
  cam.connect();
  cam.getSettings();
  assert.strictEqual(cam.setSetting('aperture', '8.0').value, '8.0');
  assert.strictEqual(cam.setSetting('iso', '800').value, '800');
  assert.strictEqual(cam.setSetting('compressionsetting', 'JPEG M Fine').value, 'JPEG M Fine');
  assert.strictEqual(cam.getSettings().aperture.value, '8.0');
});

test('canon: RAW + JPEG → JPEG, RAW libéré', () => {
  const { cam, t } = open('canon');
  cam.connect();
  cam.setSetting('compressionsetting', 'RAW + JPEG L Fine');
  const photo = cam.capture();
  assert.strictEqual(photo.name, 'IMG_0001.JPG');
  assert.strictEqual(t.state().inMemory, 0, 'le RAW n\'a pas été libéré');
});

test('canon: RAW seul → message clair, sans attendre 20 s', () => {
  const { cam, t } = open('canon');
  cam.connect();
  cam.setSetting('compressionsetting', 'RAW');
  const t0 = Date.now();
  assert.throws(() => cam.capture(), /RAW : réglez la qualité d'image sur JPEG/);
  assert.ok(Date.now() - t0 < 5000, `trop long : ${Date.now() - t0} ms`);
  assert.strictEqual(t.state().inMemory, 0);
});

test('canon:lock → valeur gardée par l\'appareil', () => {
  const { cam } = open('canon:lock');
  cam.connect();
  cam.getSettings();
  assert.throws(() => cam.setSetting('aperture', '8.0'), /molette sur M/);
  assert.strictEqual(cam.getSettings().aperture.value, '5.6');
});
