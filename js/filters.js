// Chaque filtre est une liste d'opérations CSS. La même liste sert :
//  - à l'aperçu en direct (propriété CSS `filter` sur la vidéo),
//  - à la photo finale (matrice de couleur appliquée pixel par pixel),
// car `ctx.filter` sur canvas n'est pas fiable sur Safari iPad.

export const FILTERS = [
  { id: 'none', name: 'Normal', ops: [] },
  { id: 'bw', name: 'Noir & blanc', ops: [['grayscale', 1], ['contrast', 1.15]] },
  { id: 'sepia', name: 'Sépia', ops: [['sepia', 0.9], ['contrast', 1.05]] },
  { id: 'vintage', name: 'Vintage', ops: [['sepia', 0.35], ['saturate', 0.8], ['contrast', 0.9], ['brightness', 1.08]] },
  { id: 'warm', name: 'Chaud', ops: [['sepia', 0.2], ['saturate', 1.3], ['brightness', 1.03]] },
  { id: 'cool', name: 'Froid', ops: [['hue-rotate', 12], ['saturate', 0.9], ['brightness', 1.04]] },
  { id: 'pop', name: 'Pop', ops: [['saturate', 1.6], ['contrast', 1.15]] },
  { id: 'noir', name: 'Ciné', ops: [['grayscale', 1], ['contrast', 1.5], ['brightness', 0.95]] },
];

export function getFilter(id) {
  return FILTERS.find((f) => f.id === id) || FILTERS[0];
}

export function cssFilter(filter) {
  if (!filter.ops.length) return 'none';
  return filter.ops.map(([op, v]) => (op === 'hue-rotate' ? `hue-rotate(${v}deg)` : `${op}(${v})`)).join(' ');
}

// Matrices 3x4 (rgb -> rgb + décalage), formules de la spec Filter Effects.
function opMatrix(op, v) {
  switch (op) {
    case 'grayscale': {
      const a = 1 - v;
      return [
        [0.2126 + 0.7874 * a, 0.7152 - 0.7152 * a, 0.0722 - 0.0722 * a, 0],
        [0.2126 - 0.2126 * a, 0.7152 + 0.2848 * a, 0.0722 - 0.0722 * a, 0],
        [0.2126 - 0.2126 * a, 0.7152 - 0.7152 * a, 0.0722 + 0.9278 * a, 0],
      ];
    }
    case 'sepia': {
      const a = 1 - v;
      return [
        [0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a, 0],
        [0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a, 0],
        [0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a, 0],
      ];
    }
    case 'saturate':
      return [
        [0.213 + 0.787 * v, 0.715 - 0.715 * v, 0.072 - 0.072 * v, 0],
        [0.213 - 0.213 * v, 0.715 + 0.285 * v, 0.072 - 0.072 * v, 0],
        [0.213 - 0.213 * v, 0.715 - 0.715 * v, 0.072 + 0.928 * v, 0],
      ];
    case 'hue-rotate': {
      const r = (v * Math.PI) / 180;
      const c = Math.cos(r);
      const s = Math.sin(r);
      return [
        [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0],
        [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283, 0],
        [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0],
      ];
    }
    case 'brightness':
      return [[v, 0, 0, 0], [0, v, 0, 0], [0, 0, v, 0]];
    case 'contrast': {
      const o = 255 * (0.5 - 0.5 * v);
      return [[v, 0, 0, o], [0, v, 0, o], [0, 0, v, o]];
    }
    default:
      return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
  }
}

// next ∘ m
function compose(next, m) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const row = [];
    for (let j = 0; j < 3; j++) {
      row.push(next[i][0] * m[0][j] + next[i][1] * m[1][j] + next[i][2] * m[2][j]);
    }
    row.push(next[i][0] * m[0][3] + next[i][1] * m[1][3] + next[i][2] * m[2][3] + next[i][3]);
    out.push(row);
  }
  return out;
}

export function applyFilter(ctx, width, height, filter) {
  if (!filter.ops.length) return;
  let m = opMatrix();
  for (const [op, v] of filter.ops) m = compose(opMatrix(op, v), m);
  const [[a, b, c, d], [e, f, g, h], [i, j, k, l]] = m;
  const img = ctx.getImageData(0, 0, width, height);
  const px = img.data;
  for (let p = 0; p < px.length; p += 4) {
    const r = px[p];
    const gr = px[p + 1];
    const bl = px[p + 2];
    // Uint8ClampedArray borne automatiquement entre 0 et 255.
    px[p] = a * r + b * gr + c * bl + d;
    px[p + 1] = e * r + f * gr + g * bl + h;
    px[p + 2] = i * r + j * gr + k * bl + l;
  }
  ctx.putImageData(img, 0, 0);
}
