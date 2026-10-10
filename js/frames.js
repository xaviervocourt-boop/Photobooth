// Cadres PNG personnalisés : les zones transparentes du PNG deviennent
// les emplacements des photos, le PNG est posé par-dessus.
import { db } from './db.js';

const ALPHA_THRESHOLD = 128;
const DETECT_SIZE = 400;
const MIN_HOLE_RATIO = 0.01;

const cache = {};

export const FRAME_SLOTS = { single: 1, strip: 4 };

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image illisible'));
    };
    img.src = url;
  });
}

// Repère les zones transparentes (composantes connexes) sur une version réduite
// de l'image, puis renvoie leurs rectangles englobants en pixels réels.
function detectHoles(img) {
  const scale = Math.min(1, DETECT_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const seen = new Uint8Array(w * h);
  const holes = [];
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || px[start * 4 + 3] >= ALPHA_THRESHOLD) continue;
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    let area = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop();
      const x = p % w;
      const y = (p - x) / w;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbours = [x > 0 && p - 1, x < w - 1 && p + 1, y > 0 && p - w, y < h - 1 && p + w];
      for (const n of neighbours) {
        if (n !== false && !seen[n] && px[n * 4 + 3] < ALPHA_THRESHOLD) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (area >= w * h * MIN_HOLE_RATIO) {
      holes.push({
        x: Math.round(minX / scale),
        y: Math.round(minY / scale),
        w: Math.round((maxX - minX + 1) / scale),
        h: Math.round((maxY - minY + 1) / scale),
      });
    }
  }
  // Ordre de lecture : de haut en bas, puis de gauche à droite.
  const rowTolerance = img.naturalHeight * 0.05;
  holes.sort((a, b) => (Math.abs(a.y - b.y) > rowTolerance ? a.y - b.y : a.x - b.x));
  return holes;
}

export async function saveFrame(mode, file) {
  const img = await loadImage(file);
  const holes = detectHoles(img);
  const record = { id: `frame-${mode}`, blob: file, width: img.naturalWidth, height: img.naturalHeight, holes };
  await db.put('assets', record);
  cache[mode] = { ...record, img };
  return cache[mode];
}

export async function removeFrame(mode) {
  await db.del('assets', `frame-${mode}`);
  delete cache[mode];
}

export async function loadFrames() {
  for (const mode of Object.keys(FRAME_SLOTS)) {
    const record = await db.get('assets', `frame-${mode}`);
    if (record) {
      try {
        cache[mode] = { ...record, img: await loadImage(record.blob) };
      } catch (err) {
        console.warn('Cadre illisible', mode, err);
      }
    }
  }
}

export function getFrame(mode) {
  return cache[mode] || null;
}

// Emplacements utilisés pour un format : sans zone transparente,
// la photo occupe toute l'image et le PNG se superpose.
export function frameSlots(frame, mode) {
  const holes = frame.holes.length ? frame.holes : [{ x: 0, y: 0, w: frame.width, h: frame.height }];
  return Array.from({ length: FRAME_SLOTS[mode] }, (_, i) => holes[i % holes.length]);
}

export function describeFrame(frame, mode) {
  const n = frame.holes.length;
  const expected = FRAME_SLOTS[mode];
  const base = `${frame.width} × ${frame.height} px · ${n} zone${n > 1 ? 's' : ''} transparente${n > 1 ? 's' : ''}`;
  if (n === 0) return { text: `${base}. La photo remplira toute l'image, avec le cadre par-dessus.`, warn: true };
  if (n < expected) return { text: `${base}. ${expected} attendues : certaines photos seront répétées.`, warn: true };
  if (n > expected) return { text: `${base}. Seules les ${expected} premières seront utilisées.`, warn: true };
  return { text: `${base} ✓`, warn: false };
}
