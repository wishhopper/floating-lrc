const { contextBridge, ipcRenderer } = require('electron');
const SEND = ['config', 'interactive', 'delta', 'quit', 'drag', 'set-height', 'grow', 'ungrow'];
contextBridge.exposeInMainWorld('overlay', {
  onState: function (cb) {
    ipcRenderer.on('state', function (_e, payload) {
      cb(payload);
    });
  },
  onCmd: function (cb) {
    ipcRenderer.on('cmd', function (_e, c) {
      cb(c);
    });
  },
  getConfig: function () {
    return ipcRenderer.invoke('get-config');
  },
  send: function (ch, payload) {
    if (SEND.indexOf(ch) >= 0) ipcRenderer.send(ch, payload);
  },
});
