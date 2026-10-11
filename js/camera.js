// Sources d'image : webcam (getUserMedia, iPad ou PC) ou appareil photo
// reflex/hybride piloté par l'application Windows (pilote intégré pour Nikon
// et Canon, ou digiCamControl).
import { settings } from './settings.js';

export const DSLR_ID = 'dslr';
export const DCC_ID = 'dslr-dcc';
export const isDslrId = (id) => id === DSLR_ID || id === DCC_ID;
export const desktop = window.photoboothDesktop || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIVEVIEW_URL = '__camera/liveview.jpg';
const LIVEVIEW_INTERVAL_MS = 50;
const FIRST_FRAME_TIMEOUT_MS = 10000;
const DSLR_IDLE_STOP_MS = 120000;

class WebcamSource {
  constructor(video) {
    this.kind = 'webcam';
    this.el = video;
    this.stream = null;
  }

  get width() { return this.el.videoWidth; }

  get height() { return this.el.videoHeight; }

  // La webcam reste allumée en fond d'écran sur l'accueil.
  get showOnHome() { return true; }

  async start() {
    if (this.stream && this.stream.active) return;
    const base = { width: { ideal: 1920 }, height: { ideal: 1440 } };
    const wanted = settings.cameraId && settings.cameraId !== DSLR_ID ? settings.cameraId : '';
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: wanted ? { ...base, deviceId: { exact: wanted } } : { ...base, facingMode: 'user' },
      });
    } catch (err) {
      // Caméra choisie débranchée : on retombe sur la caméra par défaut.
      if (!wanted || !['OverconstrainedError', 'NotFoundError'].includes(err.name)) throw cameraError(err);
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: base }).catch((e) => {
        throw cameraError(e);
      });
    }
    this.el.srcObject = this.stream;
    await this.el.play().catch(() => {});
    if (!this.el.videoWidth) await new Promise((r) => this.el.addEventListener('loadedmetadata', r, { once: true }));
  }

  release() {}

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.el.srcObject = null;
  }

  // Copie immédiate de l'image courante : la vidéo continue de défiler.
  async capture() {
    const c = document.createElement('canvas');
    c.width = this.width;
    c.height = this.height;
    c.getContext('2d').drawImage(this.el, 0, 0);
    return { image: Promise.resolve({ source: c, width: c.width, height: c.height }) };
  }
}

class DslrSource {
  constructor(canvas) {
    this.kind = 'dslr';
    this.el = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = 0;
    this.height = 0;
    this.running = false;
    this.lastFrameAt = 0;
    this.stopTimer = null;
  }

  // Pas de live view sur l'accueil : économise la batterie et le capteur.
  get showOnHome() { return false; }

  async start() {
    clearTimeout(this.stopTimer);
    if (this.running && Date.now() - this.lastFrameAt < 3000) return;
    if (!this.running) {
      this.running = true;
      this.lastFrameAt = 0;
      try {
        await desktop.camera.startLiveView();
      } catch (err) {
        this.running = false;
        throw err;
      }
      this.loop();
    }
    const deadline = Date.now() + FIRST_FRAME_TIMEOUT_MS;
    while (Date.now() - this.lastFrameAt > 3000) {
      if (Date.now() > deadline) {
        this.stop();
        throw new Error(settings.cameraId === DCC_ID
          ? "L'appareil photo n'envoie pas d'image (live view). Vérifiez qu'il est allumé et détecté par digiCamControl."
          : "L'appareil photo n'envoie pas d'image (live view). Vérifiez qu'il est allumé et branché en USB.");
      }
      await sleep(100);
    }
  }

  async loop() {
    while (this.running) {
      const started = performance.now();
      try {
        const res = await fetch(`${LIVEVIEW_URL}?t=${Date.now()}`, { cache: 'no-store' });
        if (res.ok) {
          const bitmap = await createImageBitmap(await res.blob());
          if (this.el.width !== bitmap.width || this.el.height !== bitmap.height) {
            this.el.width = bitmap.width;
            this.el.height = bitmap.height;
            this.width = bitmap.width;
            this.height = bitmap.height;
            this.el.dispatchEvent(new Event('resize'));
          }
          this.ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          this.lastFrameAt = Date.now();
        }
      } catch {
        // image incomplète ou live view en redémarrage après une photo
      }
      await sleep(Math.max(0, LIVEVIEW_INTERVAL_MS - (performance.now() - started)));
    }
  }

  // Coupe le live view après un moment sans invité, pas tout de suite :
  // les séances qui s'enchaînent repartent sans attendre l'appareil.
  release() {
    clearTimeout(this.stopTimer);
    if (this.running) this.stopTimer = setTimeout(() => this.stop(), DSLR_IDLE_STOP_MS);
  }

  stop() {
    clearTimeout(this.stopTimer);
    if (!this.running) return;
    this.running = false;
    desktop.camera.stopLiveView().catch(() => {});
  }

  // Déclenche l'appareil (et donc son flash). La promesse se termine dès que
  // l'appareil est prêt pour la photo suivante ; le fichier arrive ensuite.
  async capture() {
    const id = await desktop.camera.trigger();
    const image = desktop.camera.fetch(id).then(async ({ data }) => {
      const blob = new Blob([data], { type: 'image/jpeg' });
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    });
    image.catch(() => {}); // évite une alerte si la séance est annulée avant
    return { image };
  }
}

function cameraError(err) {
  if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
    return new Error(desktop
      ? "Accès à la caméra refusé. Vérifiez Paramètres Windows > Confidentialité > Caméra."
      : "Accès à la caméra refusé. Autorisez-la dans Réglages > Safari > Caméra.");
  }
  if (err && err.name === 'NotFoundError') return new Error('Aucune caméra détectée.');
  return new Error(`Caméra indisponible : ${err && err.message ? err.message : err}`);
}

let webcam;
let dslr;
let current;

export function initCamera(video, canvas) {
  webcam = new WebcamSource(video);
  if (desktop) dslr = new DslrSource(canvas);
  return selectCamera();
}

// Choisit la source d'après les réglages, et éteint l'autre.
export function selectCamera() {
  const next = desktop && isDslrId(settings.cameraId) ? dslr : webcam;
  if (current && current !== next) current.stop();
  current = next;
  webcam.el.classList.toggle('hidden', current !== webcam);
  if (dslr) dslr.el.classList.toggle('hidden', current !== dslr);
  return current;
}

export function getCamera() {
  return current;
}

// Nom du flux vidéo utilisé, pour repérer un appareil photo branché en webcam.
export function webcamLabel() {
  const track = webcam && webcam.stream && webcam.stream.getVideoTracks()[0];
  return track ? track.label : '';
}

// Webcams et flux vidéo pour les réglages (les noms n'apparaissent qu'après autorisation).
export async function listWebcams() {
  const list = [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    devices.filter((d) => d.kind === 'videoinput').forEach((d, i) => {
      list.push({ id: d.deviceId, label: d.label || `Caméra ${i + 1}` });
    });
  } catch {
    // énumération impossible : seule l'option par défaut reste
  }
  return list;
}
