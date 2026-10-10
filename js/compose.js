import { applyFilter } from './filters.js';

export const STRIP_ASPECT = 4 / 3;

const FONTS = {
  elegant: { title: '600 {s}px Georgia, "Times New Roman", serif', sub: 'italic {s}px Georgia, "Times New Roman", serif' },
  modern: { title: '700 {s}px -apple-system, "Helvetica Neue", Arial, sans-serif', sub: '400 {s}px -apple-system, "Helvetica Neue", Arial, sans-serif' },
  script: { title: '{s}px "Snell Roundhand", "Brush Script MT", "Segoe Script", cursive', sub: 'italic {s}px Georgia, serif' },
};

// Capture l'image courante de la vidéo, recadrée au centre au ratio demandé.
export function grabFrame(video, aspect, { mirror, filter, maxWidth = 1600 }) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  let sw = vw;
  let sh = vw / aspect;
  if (sh > vh) {
    sh = vh;
    sw = vh * aspect;
  }
  const sx = (vw - sw) / 2;
  const sy = (vh - sh) / 2;
  const w = Math.round(Math.min(sw, maxWidth));
  const h = Math.round(w / aspect);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (mirror) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  applyFilter(ctx, w, h, filter);
  return canvas;
}

function formatDate(s) {
  if (s.customDate && s.customDate.trim()) return s.customDate.trim();
  return new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function footerLines(s) {
  const title = (s.title || '').trim();
  const sub = [(s.footer || '').trim(), s.showDate ? formatDate(s) : ''].filter(Boolean).join(' · ');
  return { title, sub };
}

function fitFont(ctx, template, text, size, maxWidth) {
  let sz = size;
  ctx.font = template.replace('{s}', sz);
  while (sz > 10 && ctx.measureText(text).width > maxWidth) {
    sz -= 2;
    ctx.font = template.replace('{s}', sz);
  }
  return sz;
}

function drawFooter(ctx, s, x, y, w, h) {
  const { title, sub } = footerLines(s);
  if (!title && !sub) return;
  const fonts = FONTS[s.font] || FONTS.elegant;
  ctx.fillStyle = s.textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = x + w / 2;
  const maxW = w * 0.92;
  if (title && sub) {
    fitFont(ctx, fonts.title, title, Math.round(h * 0.38), maxW);
    ctx.fillText(title, cx, y + h * 0.38);
    fitFont(ctx, fonts.sub, sub, Math.round(h * 0.2), maxW);
    ctx.fillText(sub, cx, y + h * 0.76);
  } else {
    const text = title || sub;
    fitFont(ctx, title ? fonts.title : fonts.sub, text, Math.round(h * (title ? 0.42 : 0.28)), maxW);
    ctx.fillText(text, cx, y + h / 2);
  }
}

function hasFooter(s) {
  const { title, sub } = footerLines(s);
  return Boolean(title || sub);
}

// Une photo avec un cadre et le texte en bas.
export function composeSingle(frame, s) {
  const pw = frame.width;
  const ph = frame.height;
  const pad = Math.round(Math.max(pw, ph) * 0.035);
  const footerH = hasFooter(s) ? Math.round(Math.min(pw, ph) * 0.2) : 0;
  const canvas = document.createElement('canvas');
  canvas.width = pw + pad * 2;
  canvas.height = ph + pad * 2 + footerH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = s.frameColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(frame, pad, pad);
  if (footerH) drawFooter(ctx, s, pad, pad + ph + pad * 0.3, pw, footerH);
  return canvas;
}

// Bande verticale de 4 photos façon photomaton.
export function composeStrip(frames, s) {
  const W = 1200;
  const pad = 56;
  const gap = 28;
  const fw = W - pad * 2;
  const fh = Math.round(fw / STRIP_ASPECT);
  const footerH = hasFooter(s) ? 300 : pad;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = pad + frames.length * fh + (frames.length - 1) * gap + footerH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = s.frameColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  frames.forEach((f, i) => {
    ctx.drawImage(f, pad, pad + i * (fh + gap), fw, fh);
  });
  if (hasFooter(s)) drawFooter(ctx, s, pad, canvas.height - footerH + 20, fw, footerH - 40);
  return canvas;
}

// Cadre PNG personnalisé : photos dans les zones transparentes, PNG par-dessus.
export function composeWithFrame(frames, frame, slots, s) {
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = s.frameColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  frames.forEach((f, i) => {
    const slot = slots[i];
    // Recadrage centré si le ratio diffère légèrement de la zone.
    const ar = slot.w / slot.h;
    let sw = f.width;
    let sh = f.width / ar;
    if (sh > f.height) {
      sh = f.height;
      sw = f.height * ar;
    }
    ctx.drawImage(f, (f.width - sw) / 2, (f.height - sh) / 2, sw, sh, slot.x, slot.y, slot.w, slot.h);
  });
  ctx.drawImage(frame.img, 0, 0, frame.width, frame.height);
  return canvas;
}

export function makeThumb(canvas, size = 360) {
  const scale = size / Math.max(canvas.width, canvas.height);
  const t = document.createElement('canvas');
  t.width = Math.round(canvas.width * scale);
  t.height = Math.round(canvas.height * scale);
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return t;
}

export function toBlob(canvas, quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encodage impossible'))), 'image/jpeg', quality);
  });
}

// Photo factice pour l'aperçu du cadre dans les réglages.
export function sampleFrame(aspect) {
  const w = 1200;
  const h = Math.round(w / aspect);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#ff8a5b');
  g.addColorStop(1, '#6e56cf');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.font = `${Math.round(h * 0.4)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('😄', w / 2, h / 2);
  return c;
}
