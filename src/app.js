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
  micGain: $('micGain'),
  micGainVal: $('micGainVal'),
  noiseSupp: $('noiseSupp'),
  echoCancel: $('echoCancel'),
  autoGain: $('autoGain'),
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
  gainNode: null,
  destNode: null,
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
    // Реальные камеры для ВХОДА: исключаем нашу виртуальную камеру softcam,
    // чтобы её нельзя было случайно выбрать источником (иначе «камера занята»/чёрный экран).
    const cams = devices.filter((d) => d.kind === 'videoinput' && !/softcam/i.test(d.label || ''));
    fillSelect(els.cameraSelect, cams, 'Камера');
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
        echoCancellation: els.echoCancel.checked,
        noiseSuppression: els.noiseSupp.checked,
        autoGainControl: els.autoGain.checked,
      },
    });
    state.audioStream = stream;

    // Граф: источник → усиление → (анализатор + вывод для прослушки)
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = state.audioCtx.createMediaStreamSource(stream);
    state.gainNode = state.audioCtx.createGain();
    state.gainNode.gain.value = Number(els.micGain.value) / 100;
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 512;
    state.destNode = state.audioCtx.createMediaStreamDestination();

    src.connect(state.gainNode);
    state.gainNode.connect(state.analyser);
    state.gainNode.connect(state.destNode);
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
  state.gainNode = null;
  state.destNode = null;
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
  if (!state.destNode) return;
  if (els.micMonitor.checked) {
    els.monitorAudio.srcObject = state.destNode.stream;
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
    ctx.filter = buildFilter();
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
els.micGain.addEventListener('input', () => {
  els.micGainVal.textContent = els.micGain.value + '%';
  if (state.gainNode) state.gainNode.gain.value = Number(els.micGain.value) / 100;
});
els.noiseSupp.addEventListener('change', () => { if (els.micEnable.checked) startMic(); });
els.echoCancel.addEventListener('change', () => { if (els.micEnable.checked) startMic(); });
els.autoGain.addEventListener('change', () => { if (els.micEnable.checked) startMic(); });
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
//  ЦВЕТА И ФИЛЬТРЫ
// ============================================================
const fx = {
  brightness: $('fxBrightness'), contrast: $('fxContrast'), saturate: $('fxSaturate'),
  hue: $('fxHue'), gray: $('fxGray'), sepia: $('fxSepia'), blur: $('fxBlur'),
  bVal: $('fxBrightnessVal'), cVal: $('fxContrastVal'), sVal: $('fxSaturateVal'),
  hVal: $('fxHueVal'), gVal: $('fxGrayVal'), seVal: $('fxSepiaVal'), blVal: $('fxBlurVal'),
  reset: $('fxReset'), presets: $('presets'),
};

const FX_DEFAULTS = { brightness: 100, contrast: 100, saturate: 100, hue: 0, gray: 0, sepia: 0, blur: 0 };
const FX_PRESETS = {
  normal:  { brightness: 100, contrast: 100, saturate: 100, hue: 0, gray: 0, sepia: 0, blur: 0 },
  warm:    { brightness: 105, contrast: 105, saturate: 120, hue: 350, gray: 0, sepia: 18, blur: 0 },
  cool:    { brightness: 100, contrast: 105, saturate: 110, hue: 190, gray: 0, sepia: 0, blur: 0 },
  bw:      { brightness: 105, contrast: 115, saturate: 0, hue: 0, gray: 100, sepia: 0, blur: 0 },
  vivid:   { brightness: 105, contrast: 115, saturate: 170, hue: 0, gray: 0, sepia: 0, blur: 0 },
  vintage: { brightness: 105, contrast: 95, saturate: 85, hue: 10, gray: 0, sepia: 45, blur: 0 },
};

function buildFilter() {
  return [
    `brightness(${fx.brightness.value}%)`,
    `contrast(${fx.contrast.value}%)`,
    `saturate(${fx.saturate.value}%)`,
    `hue-rotate(${fx.hue.value}deg)`,
    `grayscale(${fx.gray.value}%)`,
    `sepia(${fx.sepia.value}%)`,
    `blur(${fx.blur.value}px)`,
  ].join(' ');
}

function updateFxLabels() {
  fx.bVal.textContent = fx.brightness.value + '%';
  fx.cVal.textContent = fx.contrast.value + '%';
  fx.sVal.textContent = fx.saturate.value + '%';
  fx.hVal.textContent = fx.hue.value + '°';
  fx.gVal.textContent = fx.gray.value + '%';
  fx.seVal.textContent = fx.sepia.value + '%';
  fx.blVal.textContent = fx.blur.value + ' px';
}

function applyFx() {
  updateFxLabels();
  // Предпросмотр «как вижу я» — тот же фильтр через CSS
  els.selfVideo.style.filter = buildFilter();
  saveSettings();
}

function setFxValues(obj) {
  for (const k of Object.keys(FX_DEFAULTS)) {
    if (obj[k] != null) fx[k].value = obj[k];
  }
  applyFx();
}

['brightness', 'contrast', 'saturate', 'hue', 'gray', 'sepia', 'blur'].forEach((k) => {
  fx[k].addEventListener('input', applyFx);
});
fx.reset.addEventListener('click', () => setFxValues(FX_DEFAULTS));
fx.presets.addEventListener('click', (e) => {
  const btn = e.target.closest('.preset');
  if (!btn) return;
  setFxValues(FX_PRESETS[btn.dataset.preset] || FX_DEFAULTS);
});

// ============================================================
//  НАСТРОЙКИ ПОЛЬЗОВАТЕЛЯ (localStorage)
// ============================================================
const SETTINGS_KEY = 'mirrorcam.settings.v1';

function collectSettings() {
  return {
    res: els.resSelect.value,
    fit: els.fitSelect.value,
    mirrorOut: els.mirrorOut.checked,
    mirrorSelf: els.mirrorSelf.checked,
    micGain: els.micGain.value,
    noiseSupp: els.noiseSupp.checked,
    echoCancel: els.echoCancel.checked,
    autoGain: els.autoGain.checked,
    fx: {
      brightness: fx.brightness.value, contrast: fx.contrast.value, saturate: fx.saturate.value,
      hue: fx.hue.value, gray: fx.gray.value, sepia: fx.sepia.value, blur: fx.blur.value,
    },
  };
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(collectSettings())); } catch {}
  }, 250);
}

function loadSettings() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch { s = null; }
  if (!s) { updateFxLabels(); return; }
  if (s.res) els.resSelect.value = s.res;
  if (s.fit) els.fitSelect.value = s.fit;
  if (typeof s.mirrorOut === 'boolean') els.mirrorOut.checked = s.mirrorOut;
  if (typeof s.mirrorSelf === 'boolean') {
    els.mirrorSelf.checked = s.mirrorSelf;
    els.selfVideo.style.transform = s.mirrorSelf ? 'scaleX(-1)' : 'none';
  }
  if (s.micGain != null) { els.micGain.value = s.micGain; els.micGainVal.textContent = s.micGain + '%'; }
  if (typeof s.noiseSupp === 'boolean') els.noiseSupp.checked = s.noiseSupp;
  if (typeof s.echoCancel === 'boolean') els.echoCancel.checked = s.echoCancel;
  if (typeof s.autoGain === 'boolean') els.autoGain.checked = s.autoGain;
  if (s.fx) setFxValues(s.fx); else updateFxLabels();
}

// Сохраняем при изменении основных переключателей
[els.resSelect, els.fitSelect, els.mirrorOut, els.mirrorSelf, els.noiseSupp, els.echoCancel, els.autoGain]
  .forEach((el) => el.addEventListener('change', saveSettings));
els.micGain.addEventListener('input', saveSettings);

loadSettings();


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

// ============================================================
//  РАЗДЕЛ «ОБНОВЛЕНИЯ» — история версий с GitHub
// ============================================================
const APP_VERSION = '0.2.6';
const RELEASES_API = 'https://api.github.com/repos/kairozun2/mirrorcam/releases?per_page=15';

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return ''; }
}

async function loadChangelog() {
  const list = $('changelog');
  if (!list) return;
  list.innerHTML = '<li class="changelog__loading">Загрузка…</li>';
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const releases = await res.json();
    list.innerHTML = '';
    if (!Array.isArray(releases) || releases.length === 0) {
      list.innerHTML = '<li class="changelog__loading">Релизов пока нет.</li>';
      return;
    }
    releases.forEach((r) => {
      const ver = (r.tag_name || r.name || '').replace(/^v/, '');
      const li = document.createElement('li');
      li.className = 'changelog__item';
      if (ver === APP_VERSION) li.classList.add('current');
      const head = document.createElement('div');
      head.className = 'changelog__head';
      head.innerHTML = `<span class="changelog__ver">${ver || '—'}${ver === APP_VERSION ? ' · сейчас' : ''}</span><span class="changelog__date">${fmtDate(r.published_at)}</span>`;
      li.appendChild(head);
      const body = (r.body || '').trim();
      if (body) {
        const note = document.createElement('div');
        note.className = 'changelog__note';
        // первая содержательная строка
        const firstLine = body.split('\n').find((l) => l.trim()) || '';
        note.textContent = firstLine.replace(/^[#*\-\s]+/, '').slice(0, 160);
        li.appendChild(note);
      }
      list.appendChild(li);
    });
  } catch (e) {
    console.warn('Не удалось загрузить историю обновлений:', e);
    list.innerHTML = '<li class="changelog__loading">Не удалось загрузить (нет сети?).</li>';
  }
}

$('checkUpdBtn')?.addEventListener('click', () => {
  loadChangelog();
  checkForUpdates();
});

loadChangelog();

// ============================================================
//  ВИРТУАЛЬНАЯ КАМЕРА (вывод в Discord/браузеры через softcam)
// ============================================================
const vcamEls = {
  toggle: $('vcamToggle'),
  dot: $('vcamStatus'),
  text: $('vcamStatusText'),
};
const vcam = { active: false, sending: false, last: 0, raf: null, timer: null };

function vcamReady() {
  const T = tauri();
  return !!(T && T.core && typeof T.core.invoke === 'function');
}

function vcamSetStatus(s) {
  if (s === 'on') {
    vcamEls.dot.className = 'status status--on';
    vcamEls.text.textContent = 'Подключено';
  } else if (s === 'wait') {
    vcamEls.dot.className = 'status status--off';
    vcamEls.text.textContent = 'Ожидание приложения…';
  } else if (s === 'reg') {
    vcamEls.dot.className = 'status status--off';
    vcamEls.text.textContent = 'Установка камеры (подтверди запрос)…';
  } else if (s === 'na') {
    vcamEls.dot.className = 'status status--off';
    vcamEls.text.textContent = 'Недоступно (запусти приложение MirrorCam)';
  } else {
    vcamEls.dot.className = 'status status--off';
    vcamEls.text.textContent = 'Выключено';
  }
}

function vcamDims() {
  // Лёгкий поток ради плавности (превью остаётся в полном HD).
  // Для чат-рулеток 640px более чем достаточно.
  const MAX_W = 640;
  let w = state.sceneW, h = state.sceneH;
  if (w > MAX_W) { const k = MAX_W / w; w = MAX_W; h = Math.round(h * k); }
  w = Math.floor(w / 4) * 4;
  h = Math.floor(h / 4) * 4;
  if (w < 4) w = 4;
  if (h < 4) h = 4;
  return { w, h };
}

// Отдельный уменьшенный холст для захвата кадров в виртуальную камеру.
let vcamCanvas = null, vcamCtx = null;
function vcamEnsureCanvas(w, h) {
  if (!vcamCanvas) {
    vcamCanvas = document.createElement('canvas');
    vcamCtx = vcamCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  }
  if (vcamCanvas.width !== w || vcamCanvas.height !== h) {
    vcamCanvas.width = w;
    vcamCanvas.height = h;
  }
}

function vcamLoop() {
  if (!vcam.active) return;
  vcam.raf = requestAnimationFrame(vcamLoop);
  const now = performance.now();
  if (now - vcam.last < 50) return;   // ~20 fps — плавно и легко для чат-рулеток
  if (vcam.sending) return;           // дроп кадра, если предыдущий ещё в полёте
  const { w, h } = vcamDims();
  if (w <= 0 || h <= 0) return;
  vcamEnsureCanvas(w, h);
  let img;
  try {
    // Масштабируем основной холст в уменьшенный (на видеокарте — быстро),
    // и читаем пиксели уже с маленького холста.
    vcamCtx.drawImage(els.canvas, 0, 0, w, h);
    img = vcamCtx.getImageData(0, 0, w, h);
  } catch { return; }
  vcam.sending = true;
  vcam.last = now;
  tauri().core.invoke('vcam_send_frame', { width: w, height: h, frame: new Uint8Array(img.data.buffer) })
    .catch(() => {})
    .finally(() => { vcam.sending = false; });
}

async function vcamPoll() {
  if (!vcam.active || !vcamReady()) return;
  try {
    const connected = await tauri().core.invoke('vcam_status');
    vcamSetStatus(connected ? 'on' : 'wait');
  } catch {}
}

async function vcamStart() {
  if (!vcamReady()) return;
  // Сначала убеждаемся, что фильтр камеры зарегистрирован (один раз, с UAC).
  vcamSetStatus('reg');
  try {
    const reg = await tauri().core.invoke('vcam_ensure_registered');
    if (!reg) {
      vcamEls.toggle.checked = false;
      vcamSetStatus('off');
      alert('Камера не зарегистрирована. Нужно подтвердить запрос прав администратора (UAC).');
      return;
    }
  } catch (e) {
    console.error('vcam_ensure_registered:', e);
    vcamEls.toggle.checked = false;
    vcamSetStatus('off');
    alert('Не удалось установить виртуальную камеру:\n' + e);
    return;
  }
  const { w, h } = vcamDims();
  try {
    await tauri().core.invoke('vcam_start', { width: w, height: h, fps: 0 });
    vcam.active = true;
    vcamSetStatus('wait');
    vcamLoop();
    vcam.timer = setInterval(vcamPoll, 1000);
  } catch (e) {
    console.error('vcam_start:', e);
    vcamEls.toggle.checked = false;
    vcamSetStatus('off');
    alert('Не удалось запустить виртуальную камеру:\n' + e);
  }
}

async function vcamStop() {
  vcam.active = false;
  if (vcam.raf) cancelAnimationFrame(vcam.raf);
  if (vcam.timer) clearInterval(vcam.timer);
  vcam.raf = null;
  vcam.timer = null;
  vcamSetStatus('off');
  if (vcamReady()) { try { await tauri().core.invoke('vcam_stop'); } catch {} }
}

if (!vcamReady()) {
  vcamEls.toggle.disabled = true;
  vcamSetStatus('na');
} else {
  vcamEls.toggle.addEventListener('change', () => {
    if (vcamEls.toggle.checked) vcamStart(); else vcamStop();
  });
  window.addEventListener('beforeunload', () => { if (vcam.active) vcamStop(); });
}
