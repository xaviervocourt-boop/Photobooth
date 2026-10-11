// Clavier virtuel AZERTY de l'application Windows : sur un écran tactile, il
// s'affiche dès qu'on touche une zone de texte (le clavier de Windows ne
// sort pas toujours tout seul).

const ABC = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '{bksp}'],
  ['a', 'z', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['q', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm'],
  ['{shift}', 'w', 'x', 'c', 'v', 'b', 'n', '@', '.', '-'],
  ['{sym}', '_', '{space}', '.fr', '.com', '{close}', '{enter}'],
];
const SYM = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '{bksp}'],
  ['é', 'è', 'ê', 'à', 'â', 'ç', 'ù', 'û', 'ô', 'î'],
  ["'", '"', '(', ')', '!', '?', '&', '#', '/', ':'],
  ['{shift}', 'ë', 'ï', 'œ', '€', '%', '+', '=', '*', ','],
  ['{abc}', ';', '{space}', '~', '{close}', '{enter}'],
];
const NUM = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['.', '0', '{bksp}'],
  ['{close}', '{enter}'],
];
const LABELS = {
  '{bksp}': '⌫',
  '{shift}': '⇧',
  '{sym}': 'é&?',
  '{abc}': 'abc',
  '{space}': 'espace',
  '{close}': '⌄',
};
const TEXT_FIELDS = 'input[type=text], input[type=url], input[type=password], input[type=search], input[type=email], input[type=tel], textarea';

let panel;
let enabled = false;
let target = null;
let layout = 'abc';
let shift = false;
let startValue = '';
let repeatTimer = null;

function eligible(el) {
  return enabled && el && el.matches && el.matches(TEXT_FIELDS) && !el.readOnly && !el.disabled;
}

function keyLabel(k) {
  if (k === '{enter}') return target && target.tagName === 'TEXTAREA' ? '↵' : 'OK';
  if (LABELS[k]) return LABELS[k];
  return shift && k.length === 1 ? k.toUpperCase() : k;
}

function render() {
  const rows = { abc: ABC, sym: SYM, num: NUM }[layout];
  panel.className = `vkeyboard${layout === 'num' ? ' num' : ''}`;
  panel.innerHTML = '';
  rows.forEach((row) => {
    const r = document.createElement('div');
    r.className = 'kb-row';
    row.forEach((k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.tabIndex = -1;
      b.dataset.key = k;
      const special = k.startsWith('{');
      b.className = special ? `kb-key kb-special kb-${k.slice(1, -1)}` : `kb-key ${k.length > 1 ? 'kb-tld' : 'kb-char'}`;
      if (k === '{shift}' && shift) b.classList.add('active');
      b.textContent = keyLabel(k);
      r.append(b);
    });
    panel.append(r);
  });
}

// Insère à l'emplacement du curseur (ou à la fin si le champ ne le permet pas).
function insert(text) {
  const el = target;
  const v = el.value;
  let s = v.length;
  let e = v.length;
  try {
    if (el.selectionStart != null) {
      s = el.selectionStart;
      e = el.selectionEnd;
    }
  } catch {
    // champ sans sélection
  }
  el.value = v.slice(0, s) + text + v.slice(e);
  try {
    el.setSelectionRange(s + text.length, s + text.length);
  } catch {
    // idem
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function backspace() {
  const el = target;
  if (!el) return;
  const v = el.value;
  let s = v.length;
  let e = v.length;
  try {
    if (el.selectionStart != null) {
      s = el.selectionStart;
      e = el.selectionEnd;
    }
  } catch {
    // champ sans sélection
  }
  if (s === e) {
    if (s === 0) return;
    s -= 1;
  }
  el.value = v.slice(0, s) + v.slice(e);
  try {
    el.setSelectionRange(s, s);
  } catch {
    // idem
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function enter() {
  const el = target;
  if (el.tagName === 'TEXTAREA') {
    insert('\n');
    return;
  }
  if (el.form) el.form.requestSubmit();
  else el.blur();
}

function stopRepeat() {
  clearTimeout(repeatTimer);
  clearInterval(repeatTimer);
  repeatTimer = null;
}

function onKey(e) {
  e.preventDefault(); // le focus reste dans la zone de texte
  const btn = e.target.closest('button');
  if (!btn || !target) return;
  const k = btn.dataset.key;
  btn.classList.add('pressed');
  setTimeout(() => btn.classList.remove('pressed'), 120);
  switch (k) {
    case '{bksp}':
      backspace();
      // Effacement continu en gardant le doigt appuyé.
      repeatTimer = setTimeout(() => { repeatTimer = setInterval(backspace, 70); }, 450);
      break;
    case '{shift}':
      shift = !shift;
      render();
      break;
    case '{sym}':
      layout = 'sym';
      render();
      break;
    case '{abc}':
      layout = 'abc';
      render();
      break;
    case '{space}':
      insert(' ');
      break;
    case '{close}':
      target.blur();
      break;
    case '{enter}':
      enter();
      break;
    default:
      insert(shift && k.length === 1 ? k.toUpperCase() : k);
      if (shift) {
        shift = false;
        render();
      }
  }
}

// La page peut réagir sur « change » comme avec un vrai clavier.
function commit() {
  if (target && target.value !== startValue) target.dispatchEvent(new Event('change', { bubbles: true }));
}

function open(el) {
  if (target !== el) {
    commit();
    target = el;
    startValue = el.value;
    layout = el.dataset.kb || 'abc';
    shift = false;
  }
  render();
  document.body.classList.add('kb-open');
  document.documentElement.style.setProperty('--kb-h', `${panel.offsetHeight}px`);
  requestAnimationFrame(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
}

function close() {
  stopRepeat();
  if (!target) return;
  commit();
  target = null;
  panel.className = 'vkeyboard hidden';
  document.body.classList.remove('kb-open');
}

// Évite que le clavier de Windows sorte en même temps que le nôtre.
function applyInputMode() {
  document.querySelectorAll(TEXT_FIELDS).forEach((el) => {
    if (!el.dataset.kb) {
      const mode = el.getAttribute('inputmode') || '';
      el.dataset.kb = mode === 'numeric' || mode === 'decimal' ? 'num' : 'abc';
      el.dataset.inputmode = mode;
    }
    if (enabled) el.setAttribute('inputmode', 'none');
    else if (el.dataset.inputmode) el.setAttribute('inputmode', el.dataset.inputmode);
    else el.removeAttribute('inputmode');
  });
}

export function setKeyboardEnabled(on) {
  enabled = Boolean(on);
  applyInputMode();
  if (!enabled) close();
}

export function initKeyboard(on) {
  panel = document.createElement('div');
  panel.className = 'vkeyboard hidden';
  document.body.append(panel);
  panel.addEventListener('pointerdown', onKey);
  panel.addEventListener('mousedown', (e) => e.preventDefault());
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => panel.addEventListener(ev, stopRepeat));
  document.addEventListener('focusin', (e) => {
    if (eligible(e.target)) open(e.target);
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!eligible(document.activeElement)) close();
    }, 0);
  });
  setKeyboardEnabled(on);
}
