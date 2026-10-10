const KEY = 'photobooth.settings';

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
  galleryPublic: true,
  cameraId: '',
  dccUrl: 'http://127.0.0.1:5513',
  photoFolder: '',
  scriptUrl: '',
  secret: '',
  emailSubject: 'Votre photo 📸',
  emailBody: "Merci d'être passé au photobooth ! Voici votre photo.",
  pin: '0000',
};

export const settings = load();

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Stockage indisponible (navigation privée) : les réglages restent en mémoire.
  }
}
