// Pont entre la page et l'application Windows (appareil photo, dossiers, fenêtre).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Les erreurs du processus principal arrivent préfixées : on ne garde que le message.
function call(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((err) => {
    throw new Error(String(err.message).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''));
  });
}

contextBridge.exposeInMainWorld('photoboothDesktop', {
  configure: (cfg) => call('desktop:configure', cfg),
  camera: {
    test: () => call('camera:test'),
    startLiveView: () => call('camera:liveview', true),
    stopLiveView: () => call('camera:liveview', false),
    trigger: () => call('camera:trigger'),
    fetch: (id) => call('camera:fetch', id),
  },
  savePhoto: (bytes, name) => call('photos:save', bytes, name),
  chooseFolder: () => call('photos:choose-folder'),
  openFolder: () => call('photos:open-folder'),
  showInFolder: (file) => call('photos:show', file),
  setKiosk: (on) => call('window:kiosk', on),
  quit: () => call('app:quit'),
});
