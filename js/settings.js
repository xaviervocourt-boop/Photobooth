const KEY = 'photobooth.settings';
const VERSION = 2;
const isDesktop = Boolean(window.photoboothDesktop);

export const DEFAULTS = {
  title: 'Photobooth',
  footer: '',
  showDate: true,
  customDate: '',
  frameColor: '#ffffff',
  textColor: '#1f1f1f',
  font: 'elegant',
  mode: 'choice',
  countdown: 3,
  pause: 1.5,
  mirror: true,
  // Application Windows : le vrai appareil photo par défaut.
  cameraId: isDesktop ? 'dslr' : '',
  dccUrl: 'http://127.0.0.1:5513',
  photoFolder: '',
  virtualKeyboard: true,
  scriptUrl: '',
  secret: '',
  emailSubject: 'Votre photo 📸',
  emailBody: "Merci d'être passé au photobooth ! Voici votre photo.",
  pin: '0000',
};

export const settings = load();

function load() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    // Stockage indisponible : réglages par défaut.
  }
  const s = { ...DEFAULTS, ...stored };
  // Version 1 : l'application Windows démarrait sur la webcam, qui ne prend
  // qu'une image de la vidéo. On passe sur le vrai appareil photo.
  if ((stored.version || 1) < 2 && isDesktop && !stored.cameraId) s.cameraId = 'dslr';
  s.version = VERSION;
  return s;
}

export function saveSettings() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Stockage indisponible (navigation privée) : les réglages restent en mémoire.
  }
}
