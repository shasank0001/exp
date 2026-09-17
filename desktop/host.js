window.desktop.runtimeInfo().then(info => {
  document.getElementById('runtime').textContent = `${info.platform} · Electron ${info.electron}`;
}).catch(() => {
  document.getElementById('runtime').textContent = 'Desktop bridge unavailable';
});
