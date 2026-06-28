// MirrorCam — логика студии камеры.
// Сцена рисуется на canvas во внутреннем разрешении (scene), а интерактивные
// рамки слоёв — это DOM-элементы, спозиционированные поверх canvas.
// Видео и звук — это РАЗНЫЕ потоки: камера всегда без звука, микрофон отдельно.

const $ = (id) => document.getElementById(id);

const els = {
  cameraSelect: $('cameraSelect'),
  resSelect: $('resSelect'),
  fitSelect: $('fitSelect'),
  startBtn: $('startBtn'),
  stopBtn: $('stopBtn'),
  emptyStartBtn: $('emptyStartBtn'),
  camError: $('camError'),
  micEnable: $('micEnable'),
  micSelect: $('micSelect'),
  micMeter: $('micMeter'),
  micMeterFill: $('micMeterFill'),
  micMonitor: $('micMonitor'),
  outputSelect: $('outputSelect'),
  outputHint: $('outputHint'),
  monitorAudio: $('monitorAudio'),
  mirrorOut: $('mirrorOut'),
  mirrorSelf: $('mirrorSelf'),
  addImageBtn: $('addImageBtn'),
  addGiftBtn: $('addGiftBtn'),
  layerList: $('layerList'),
  layerHint: $('layerHint'),
  fileInput: $('fileInput'),
  canvas: $('outputCanvas'),
  canvasHost: $('canvasHost'),
  overlayLayer: $('overlayLayer'),
  emptyState: $('emptyState'),
  selfview: $('selfview'),
  selfVideo: $('selfVideo'),
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  fpsMeta: $('fpsMeta'),
};

const ctx = els.canvas.getContext('2d', { alpha: false });

// ---------- Состояние ----------
const state = {
  videoStream: null,
  audioStream: null,
  video: document.createElement('video'),
  running: false,
  layers: [],        // { id, type:'image'|'emoji', img|text, x, y, w, h }
  selectedId: null,
  sceneW: 1280,
  sceneH: 720,
  // Аудио-анализ для индикатора уровня
  audioCtx: null,
  analyser: null,
  meterRaf: null,
};
state.video.autoplay = true;
state.video.playsInline = true;
state.video.muted = true;

let nextId = 1;

// ============================================================
//  УСТРОЙСТВА
// ============================================================
// Заполняет селект устройств заданного типа, сохраняя выбор.
function fillSelect(select, devices, fallbackName) {
  const prev = select.value;
  select.innerHTML = '';
  if (devices.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'Не найдено';
    opt.value = '';
    select.appendChild(opt);
    return;
  }
  devices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `${fallbackName} ${i + 1}`;
    select.appendChild(opt);
  });
  if (prev && devices.some((d) => d.deviceId === prev)) select.value = prev;
}

async function refreshDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    fillSelect(els.cameraSelect, devices.filter((d) => d.kind === 'videoinput'), 'Камера');
    fillSelect(els.micSelect, devices.filter((d) => d.kind === 'audioinput'), 'Микрофон');

    const outs = devices.filter((d) => d.kind === 'audiooutput');
    if (typeof els.monitorAudio.setSinkId === 'function') {
      fillSelect(els.outputSelect, outs, 'Аудиовыход');
      els.outputSelect.disabled = outs.length === 0;
      els.outputHint.textContent = outs.length
        ? 'Куда выводить прослушку микрофона.'
        : 'Устройства вывода не обнаружены.';
    } else {
      els.outputSelect.innerHTML = '<option>Системное устройство</option>';
      els.outputSelect.disabled = true;
      els.outputHint.textContent = 'Выбор вывода недоступен — используется системный по умолчанию.';
    }
  } catch (e) {
    console.error('Не удалось получить список устройств:', e);
  }
}

// Преобразует ошибку getUserMedia в понятный текст.
function describeMediaError(e, kind) {
  const name = e && e.name ? e.name : '';
  const what = kind === 'audio' ? 'микрофону' : 'камере';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `Доступ к ${what} запрещён. Открой Параметры Windows → Конфиденциальность → ${kind === 'audio' ? 'Микрофон' : 'Камера'} и включи доступ для классических приложений.`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `Устройство (${what}) не найдено. Проверь подключение и выбор устройства в списке.`;
    case 'NotReadableError':
    case 'AbortError':
      return `Не удалось открыть ${what === 'камере' ? 'камеру' : 'микрофон'} — возможно, оно занято другой программой (Zoom, Skype, браузер). Закрой её и попробуй снова.`;
    default:
      return `Ошибка доступа к ${what}: ${e && e.message ? e.message : e}`;
  }
}

function showCamError(msg) {
  if (!msg) { els.camError.hidden = true; els.camError.textContent = ''; return; }
  els.camError.hidden = false;
  els.camError.textContent = msg;
}

// ============================================================
//  КАМЕРА (видео-поток, всегда без звука)
// ============================================================
async function startCamera() {
  if (state.running) return;
  showCamError('');
  setStatus('connecting');

  const [w, h] = els.resSelect.value.split('x').map(Number);
  state.sceneW = w;
  state.sceneH = h;
  els.canvas.width = w;
  els.canvas.height = h;

  const deviceId = els.cameraSelect.value;
  const constraints = {
    audio: false,
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: w },
      height: { ideal: h },
    },
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.videoStream = stream;
    state.video.srcObject = stream;
    els.selfVideo.srcObject = stream;
    await state.video.play().catch(() => {});

    state.running = true;
    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    els.emptyState.classList.add('hidden');
    els.selfview.classList.add('show');
    setStatus('on');

    await refreshDevices(); // теперь с настоящими названиями
    startRenderLoop();
  } catch (e) {
    console.error('Ошибка доступа к камере:', e);
    setStatus('off');
    showCamError(describeMediaError(e, 'video'));
  }
}

function stopCamera() {
  if (state.videoStream) {
    state.videoStream.getTracks().forEach((t) => t.stop());
    state.videoStream = null;
  }
  state.video.srcObject = null;
  els.selfVideo.srcObject = null;
  state.running = false;
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  els.emptyState.classList.remove('hidden');
  els.selfview.classList.remove('show');
  setStatus('off');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);
}

function setStatus(s) {
  if (s === 'on') {
    els.statusDot.className = 'status status--on';
    els.statusText.textContent = 'Камера в эфире';
  } else if (s === 'connecting') {
    els.statusDot.className = 'status status--off';
    els.statusText.textContent = 'Подключение…';
  } else {
    els.statusDot.className = 'status status--off';
    els.statusText.textContent = 'Камера выключена';
  }
}

// ============================================================
//  МИКРОФОН (отдельный поток + индикатор уровня + прослушка)
// ============================================================
async function startMic() {
  await stopMic(); // на случай переключения устройства
  const deviceId = els.micSelect.value;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    state.audioStream = stream;

    // Индикатор уровня
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = state.audioCtx.createMediaStreamSource(stream);
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 512;
    src.connect(state.analyser);
    runMeter();

    applyMonitor(); // прослушка, если включена
    await refreshDevices();
  } catch (e) {
    console.error('Ошибка доступа к микрофону:', e);
    els.micEnable.checked = false;
    showCamError(describeMediaError(e, 'audio'));
  }
}

async function stopMic() {
  if (state.meterRaf) { cancelAnimationFrame(state.meterRaf); state.meterRaf = null; }
  els.micMeterFill.style.width = '0%';
  els.monitorAudio.srcObject = null;
  if (state.audioCtx) { try { await state.audioCtx.close(); } catch {} state.audioCtx = null; }
  state.analyser = null;
  if (state.audioStream) {
    state.audioStream.getTracks().forEach((t) => t.stop());
    state.audioStream = null;
  }
}

function runMeter() {
  const data = new Uint8Array(state.analyser.frequencyBinCount);
  const tick = () => {
    if (!state.analyser) return;
    state.meterRaf = requestAnimationFrame(tick);
    state.analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    const pct = Math.min(100, Math.round(peak * 140));
    els.micMeterFill.style.width = pct + '%';
    els.micMeterFill.classList.toggle('hot', pct > 85);
  };
  tick();
}

function applyMonitor() {
  if (!state.audioStream) return;
  if (els.micMonitor.checked) {
    els.monitorAudio.srcObject = state.audioStream;
    els.monitorAudio.play().catch(() => {});
  } else {
    els.monitorAudio.srcObject = null;
  }
}

async function applyOutput() {
  if (typeof els.monitorAudio.setSinkId !== 'function') return;
  const id = els.outputSelect.value;
  if (!id) return;
  try { await els.monitorAudio.setSinkId(id); } catch (e) { console.warn('setSinkId:', e); }
}

// ============================================================
//  РЕНДЕР СЦЕНЫ
// ============================================================
let rafId = null;
let frames = 0;
let fpsLast = performance.now();

function startRenderLoop() {
  if (rafId) return;
  const loop = () => {
    rafId = requestAnimationFrame(loop);
    drawScene();
    frames++;
    const now = performance.now();
    if (now - fpsLast >= 1000) {
      els.fpsMeta.textContent = `${frames} FPS · ${state.sceneW}×${state.sceneH}`;
      frames = 0;
      fpsLast = now;
    }
  };
  rafId = requestAnimationFrame(loop);
}

function computeFit(vidW, vidH, mode) {
  const cw = state.sceneW, ch = state.sceneH;
  if (mode === 'stretch') return { dx: 0, dy: 0, dw: cw, dh: ch };
  const scale = mode === 'contain'
    ? Math.min(cw / vidW, ch / vidH)
    : Math.max(cw / vidW, ch / vidH);
  const dw = vidW * scale, dh = vidH * scale;
  return { dx: (cw - dw) / 2, dy: (ch - dh) / 2, dw, dh };
}

function drawScene() {
  const cw = els.canvas.width, ch = els.canvas.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);

  const v = state.video;
  if (v.readyState >= 2 && v.videoWidth > 0) {
    const fit = computeFit(v.videoWidth, v.videoHeight, els.fitSelect.value);
    ctx.save();
    if (els.mirrorOut.checked) {
      ctx.translate(cw, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(v, fit.dx, fit.dy, fit.dw, fit.dh);
    ctx.restore();
  }

  for (const layer of state.layers) drawLayer(layer);
}

function drawLayer(layer) {
  ctx.save();
  if (layer.type === 'image' && layer.img && layer.img.complete) {
    ctx.drawImage(layer.img, layer.x, layer.y, layer.w, layer.h);
  } else if (layer.type === 'emoji') {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.floor(layer.h * 0.82)}px "Segoe UI Emoji", sans-serif`;
    ctx.fillText(layer.text, layer.x + layer.w / 2, layer.y + layer.h / 2);
  }
  ctx.restore();
}

// ============================================================
//  СЛОИ
// ============================================================
function addImageLayer(src, name) {
  const img = new Image();
  img.onload = () => {
    const maxW = state.sceneW * 0.35;
    const ratio = img.height / img.width;
    const w = Math.min(img.width, maxW);
    const h = w * ratio;
    const layer = {
      id: nextId++, type: 'image', img,
      name: name || `Картинка ${state.layers.length + 1}`,
      x: (state.sceneW - w) / 2, y: (state.sceneH - h) / 2,
      w, h, src,
    };
    state.layers.push(layer);
    selectLayer(layer.id);
    renderLayerList();
  };
  img.src = src;
}

function addEmojiLayer(emoji) {
  const size = Math.round(state.sceneH * 0.22);
  const layer = {
    id: nextId++, type: 'emoji', text: emoji,
    name: `Гифт ${emoji}`,
    x: (state.sceneW - size) / 2, y: (state.sceneH - size) / 2,
    w: size, h: size,
  };
  state.layers.push(layer);
  selectLayer(layer.id);
  renderLayerList();
}

function removeLayer(id) {
  state.layers = state.layers.filter((l) => l.id !== id);
  if (state.selectedId === id) state.selectedId = null;
  renderLayerList();
  renderHandles();
}

function selectLayer(id) {
  state.selectedId = id;
  renderLayerList();
  renderHandles();
}

function getSelected() {
  return state.layers.find((l) => l.id === state.selectedId) || null;
}

function renderLayerList() {
  els.layerList.innerHTML = '';
  els.layerHint.style.display = state.layers.length ? 'none' : 'block';
  [...state.layers].reverse().forEach((layer) => {
    const li = document.createElement('li');
    li.className = 'layer-item' + (layer.id === state.selectedId ? ' active' : '');
    li.onclick = (e) => { if (!e.target.classList.contains('layer-item__del')) selectLayer(layer.id); };

    let thumb;
    if (layer.type === 'image') {
      thumb = document.createElement('img');
      thumb.className = 'layer-item__thumb';
      thumb.src = layer.src;
    } else {
      thumb = document.createElement('div');
      thumb.className = 'layer-item__thumb';
      thumb.style.display = 'grid';
      thumb.style.placeItems = 'center';
      thumb.style.fontSize = '20px';
      thumb.textContent = layer.text;
    }
    const name = document.createElement('span');
    name.className = 'layer-item__name';
    name.textContent = layer.name;
    const del = document.createElement('button');
    del.className = 'layer-item__del';
    del.textContent = '✕';
    del.title = 'Удалить слой';
    del.onclick = () => removeLayer(layer.id);

    li.append(thumb, name, del);
    els.layerList.appendChild(li);
  });
}

// ============================================================
//  ИНТЕРАКТИВНЫЕ РАМКИ (перемещение / масштаб)
// ============================================================
function sceneToScreen() {
  const cRect = els.canvas.getBoundingClientRect();
  const hRect = els.canvasHost.getBoundingClientRect();
  const scale = cRect.width / state.sceneW;
  return { ox: cRect.left - hRect.left, oy: cRect.top - hRect.top, scale };
}

function renderHandles() {
  els.overlayLayer.innerHTML = '';
  const layer = getSelected();
  if (!layer) return;
  const t = sceneToScreen();

  const box = document.createElement('div');
  box.className = 'handle-box';
  box.style.left = t.ox + layer.x * t.scale + 'px';
  box.style.top = t.oy + layer.y * t.scale + 'px';
  box.style.width = layer.w * t.scale + 'px';
  box.style.height = layer.h * t.scale + 'px';

  const move = document.createElement('div');
  move.className = 'move-area';
  move.addEventListener('pointerdown', (e) => startDrag(e, layer, 'move'));
  box.appendChild(move);

  for (const pos of ['nw', 'ne', 'sw', 'se']) {
    const hd = document.createElement('div');
    hd.className = 'handle ' + pos;
    hd.addEventListener('pointerdown', (e) => startDrag(e, layer, pos));
    box.appendChild(hd);
  }
  els.overlayLayer.appendChild(box);
}

let drag = null;
function startDrag(e, layer, mode) {
  e.preventDefault();
  e.stopPropagation();
  const t = sceneToScreen();
  drag = {
    mode, layer, t,
    startX: e.clientX, startY: e.clientY,
    ox: layer.x, oy: layer.y, ow: layer.w, oh: layer.h,
    ratio: layer.h / layer.w,
  };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
}

function onDragMove(e) {
  if (!drag) return;
  const dx = (e.clientX - drag.startX) / drag.t.scale;
  const dy = (e.clientY - drag.startY) / drag.t.scale;
  const l = drag.layer;
  const min = 40;

  if (drag.mode === 'move') {
    l.x = drag.ox + dx;
    l.y = drag.oy + dy;
  } else {
    let nw = drag.ow, nx = drag.ox, ny = drag.oy;
    if (drag.mode === 'se') { nw = drag.ow + dx; }
    else if (drag.mode === 'ne') { nw = drag.ow + dx; ny = drag.oy - (nw - drag.ow) * drag.ratio; }
    else if (drag.mode === 'sw') { nw = drag.ow - dx; nx = drag.ox + (drag.ow - nw); }
    else if (drag.mode === 'nw') { nw = drag.ow - dx; nx = drag.ox + (drag.ow - nw); ny = drag.oy + (drag.ow - nw) * drag.ratio; }
    if (nw < min) nw = min;
    const nh = nw * drag.ratio;
    if (drag.mode === 'ne') ny = drag.oy + drag.oh - nh;
    if (drag.mode === 'nw') { nx = drag.ox + drag.ow - nw; ny = drag.oy + drag.oh - nh; }
    if (drag.mode === 'sw') { nx = drag.ox + drag.ow - nw; }
    l.w = nw; l.h = nh; l.x = nx; l.y = ny;
  }
  renderHandles();
}

function onDragEnd() {
  drag = null;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
}

els.canvasHost.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.handle-box') || e.target.closest('.empty-state')) return;
  const cRect = els.canvas.getBoundingClientRect();
  const sx = (e.clientX - cRect.left) / (cRect.width / state.sceneW);
  const sy = (e.clientY - cRect.top) / (cRect.height / state.sceneH);
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const l = state.layers[i];
    if (sx >= l.x && sx <= l.x + l.w && sy >= l.y && sy <= l.y + l.h) {
      selectLayer(l.id);
      return;
    }
  }
  selectLayer(null);
});

window.addEventListener('resize', () => renderHandles());

// ============================================================
//  ГИФТЫ (эмодзи-стикеры)
// ============================================================
const GIFTS = ['🎁', '❤️', '🌹', '👑', '🔥', '💎', '⭐', '🍾', '🎉', '😍', '💋', '🦄'];
let giftPopover = null;

function toggleGiftPicker() {
  if (giftPopover) { giftPopover.remove(); giftPopover = null; return; }
  const pop = document.createElement('div');
  pop.className = 'gift-popover';
  GIFTS.forEach((g) => {
    const b = document.createElement('button');
    b.className = 'gift-btn';
    b.textContent = g;
    b.onclick = () => { addEmojiLayer(g); pop.remove(); giftPopover = null; };
    pop.appendChild(b);
  });
  document.body.appendChild(pop);
  const r = els.addGiftBtn.getBoundingClientRect();
  pop.style.left = r.left + 'px';
  pop.style.top = r.bottom + 8 + 'px';
  giftPopover = pop;
  setTimeout(() => {
    const close = (ev) => {
      if (giftPopover && !giftPopover.contains(ev.target) && ev.target !== els.addGiftBtn) {
        giftPopover.remove(); giftPopover = null;
        document.removeEventListener('pointerdown', close);
      }
    };
    document.addEventListener('pointerdown', close);
  }, 0);
}

// ============================================================
//  СОБЫТИЯ
// ============================================================
els.startBtn.addEventListener('click', startCamera);
els.emptyStartBtn.addEventListener('click', startCamera);
els.stopBtn.addEventListener('click', stopCamera);
els.resSelect.addEventListener('change', () => { if (state.running) { stopCamera(); startCamera(); } });
els.cameraSelect.addEventListener('change', () => { if (state.running) { stopCamera(); startCamera(); } });

els.micEnable.addEventListener('change', () => {
  if (els.micEnable.checked) startMic(); else stopMic();
});
els.micSelect.addEventListener('change', () => { if (els.micEnable.checked) startMic(); });
els.micMonitor.addEventListener('change', applyMonitor);
els.outputSelect.addEventListener('change', applyOutput);

els.mirrorSelf.addEventListener('change', () => {
  els.selfVideo.style.transform = els.mirrorSelf.checked ? 'scaleX(-1)' : 'none';
});
els.fitSelect.addEventListener('change', renderHandles);

els.addImageBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => addImageLayer(reader.result, file.name);
  reader.readAsDataURL(file);
  els.fileInput.value = '';
});
els.addGiftBtn.addEventListener('click', toggleGiftPicker);

window.addEventListener('keydown', (e) => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId && document.activeElement.tagName !== 'INPUT') {
    removeLayer(state.selectedId);
  }
});

els.canvasHost.addEventListener('dragover', (e) => e.preventDefault());
els.canvasHost.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = () => addImageLayer(reader.result, file.name);
    reader.readAsDataURL(file);
  }
});

// ============================================================
//  ИНИЦИАЛИЗАЦИЯ
// ============================================================
els.selfVideo.style.transform = 'scaleX(-1)';
ctx.fillStyle = '#000';
ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);

navigator.mediaDevices.addEventListener?.('devicechange', refreshDevices);

// Запрашиваем доступ один раз при старте, чтобы получить настоящие названия
// устройств (без разрешения браузер/движок скрывает метки).
async function bootstrapDevices() {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    probe.getTracks().forEach((t) => t.stop());
  } catch (e) {
    // Не страшно: пользователь сможет нажать «Включить камеру» и увидит причину.
    console.warn('Предварительный доступ к камере не получен:', e);
  }
  await refreshDevices();
}
bootstrapDevices();

// ============================================================
//  АВТООБНОВЛЕНИЕ (Tauri updater)
// ============================================================
const updateEls = {
  toast: $('updateToast'),
  title: $('updateTitle'),
  text: $('updateText'),
  bar: $('updateBar'),
  barFill: $('updateBarFill'),
  btn: $('updateBtn'),
  later: $('updateLater'),
};

function tauri() {
  return typeof window !== 'undefined' ? window.__TAURI__ : undefined;
}

let pendingUpdate = null;

async function checkForUpdates() {
  const T = tauri();
  if (!T || !T.updater || typeof T.updater.check !== 'function') return;
  try {
    const update = await T.updater.check();
    if (update && update.available) {
      pendingUpdate = update;
      updateEls.title.textContent = `Обновление ${update.version || ''}`.trim();
      updateEls.text.textContent = update.body
        ? String(update.body).slice(0, 120)
        : 'Новая версия готова к установке.';
      updateEls.toast.classList.add('show');
    }
  } catch (e) {
    console.warn('Проверка обновлений не удалась:', e);
  }
}

async function applyUpdate() {
  const T = tauri();
  if (!pendingUpdate || !T) return;
  updateEls.btn.disabled = true;
  updateEls.later.disabled = true;
  updateEls.bar.classList.add('show');

  let total = 0;
  let downloaded = 0;
  try {
    await pendingUpdate.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          total = event.data?.contentLength || 0;
          updateEls.text.textContent = 'Скачивание обновления…';
          break;
        case 'Progress':
          downloaded += event.data?.chunkLength || 0;
          if (total > 0) {
            const pct = Math.min(100, Math.round((downloaded / total) * 100));
            updateEls.barFill.style.width = pct + '%';
            updateEls.text.textContent = `Скачивание… ${pct}%`;
          }
          break;
        case 'Finished':
          updateEls.barFill.style.width = '100%';
          updateEls.text.textContent = 'Установка и перезапуск…';
          break;
      }
    });
    if (T.process && typeof T.process.relaunch === 'function') {
      await T.process.relaunch();
    }
  } catch (e) {
    console.error('Ошибка обновления:', e);
    updateEls.text.textContent = 'Не удалось обновить. Попробуй позже.';
    updateEls.btn.disabled = false;
    updateEls.later.disabled = false;
  }
}

updateEls.btn.addEventListener('click', applyUpdate);
updateEls.later.addEventListener('click', () => updateEls.toast.classList.remove('show'));

setTimeout(checkForUpdates, 2500);
