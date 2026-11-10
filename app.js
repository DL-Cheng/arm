(() => {
  'use strict';

  const DEFAULTS = { deviceId: 'DL-RobotArm', brokerUrl: 'wss://broker.emqx.io:8084/mqtt' };
  const MOTORS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little', 'Wrist'];
  const REPEAT_MS = 80;          // 按住時重送指令的間隔 (ESP32 在 300 ms 沒收到就停止)

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  };

  let deviceId = store.get('jog.deviceId', DEFAULTS.deviceId);
  let brokerUrl = store.get('jog.brokerUrl', DEFAULTS.brokerUrl);
  let client = null;
  let devOnline = false;
  let devAt = 0;
  const base = () => `shutech/robotarm-jog/${deviceId}`;

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  function send(text) {
    if (client && client.connected) {
      client.publish(`${base()}/cmd`, text, { qos: 0, retain: false });
      return true;
    }
    return false;
  }

  /* ---------- 按住 / 放開 ---------- */
  const active = {};             // motor index -> { timer, btn }

  function stopHold(i) {
    const a = active[i];
    if (!a) return;
    clearInterval(a.timer);
    a.btn.classList.remove('down');
    delete active[i];
    send(`M,${i},0`);
    setTimeout(() => { if (!active[i]) send(`M,${i},0`); }, 60);   // 補送一次，確保停止
  }

  function startHold(i, d, btn) {
    stopHold(i);
    if (!send(`M,${i},${d}`)) toast('Not connected');
    btn.classList.add('down');
    try { navigator.vibrate && navigator.vibrate(10); } catch (e) { /* ignore */ }
    active[i] = { btn, timer: setInterval(() => send(`M,${i},${d}`), REPEAT_MS) };
  }

  function stopAllHolds() {
    Object.keys(active).forEach((i) => stopHold(Number(i)));
  }

  /* ---------- 介面 ---------- */
  const outEls = [];
  function buildMotors() {
    const box = $('motors');
    MOTORS.forEach((name, i) => {
      const row = document.createElement('div');
      row.className = 'motor';
      row.innerHTML =
        `<div class="m-head"><b>${i + 1}. ${name}</b><output>OFF</output></div>` +
                `<div class="m-btns">` +
        `<button type="button" class="hold" data-d="-1">&minus;<small>hold to move</small></button>` +
        `<button type="button" class="hold" data-d="1">+<small>hold to move</small></button></div>`;
      box.appendChild(row);
      outEls[i] = row.querySelector('output');

      row.querySelectorAll('.hold').forEach((btn) => {
        const d = Number(btn.dataset.d);
        btn.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          try { btn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
          startHold(i, d, btn);
        });
        ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) =>
          btn.addEventListener(ev, () => { if (active[i] && active[i].btn === btn) stopHold(i); }));
        btn.addEventListener('contextmenu', (e) => e.preventDefault());
      });
    });
  }

  // t: travel x10 (estimated from run time), m: current direction (0 = stopped)
  function showState(t, m) {
    t.forEach((v, i) => {
      if (!outEls[i]) return;
      const moving = m && m[i] !== 0;
      outEls[i].textContent = (moving ? (m[i] > 0 ? '▶ ' : '◀ ') : '') + 'Travel ' + (v >= 0 ? '+' : '') + (v / 10).toFixed(1);
      outEls[i].classList.toggle('live', !!moving);
    });
  }
  const resetState = () => outEls.forEach((o) => { o.textContent = 'OFF'; o.classList.remove('live'); });

  function setPill(id, cls, text) {
    const el = $(id);
    el.className = 'pill ' + cls;
    el.lastChild.textContent = text;
  }

  function updateHeader() {
    const on = client && client.connected;
    setPill('pillBroker', on ? 'on' : (client ? 'wait' : ''), on ? 'Cloud' : (client ? 'Connecting' : 'Cloud'));
    setPill('pillDevice', devOnline ? 'on' : '', 'Arm');
    $('modeText').textContent = !on ? (client ? 'Connecting to cloud…' : 'Not connected')
      : !devOnline ? 'Waiting for arm to come online…' : 'Ready (motors idle)';
  }

  /* ---------- MQTT ---------- */
  function connect() {
    stopAllHolds();
    if (client) { try { client.end(true); } catch (e) { /* ignore */ } client = null; }
    devOnline = false;
    resetState();
    $('topicHint').textContent = `Topics: ${base()}/cmd, /status, /online`;
    if (typeof mqtt === 'undefined') { toast('Failed to load MQTT library'); updateHeader(); return; }

    const c = client = mqtt.connect(brokerUrl, {
      clientId: 'robotjog-web-' + Math.random().toString(16).slice(2, 10),
      clean: true, keepalive: 20, reconnectPeriod: 3000, connectTimeout: 8000
    });
    c.on('connect', () => { c.subscribe([`${base()}/status`, `${base()}/online`], { qos: 0 }); updateHeader(); });
    c.on('reconnect', updateHeader);
    c.on('close', () => { devOnline = false; stopAllHolds(); updateHeader(); });
    c.on('error', updateHeader);
    c.on('message', (topic, payload) => {
      const text = payload.toString();
      if (topic.endsWith('/online')) {
        devOnline = text === '1';
        if (!devOnline) resetState();
        updateHeader();
      } else if (topic.endsWith('/status')) {
        devOnline = true;
        devAt = Date.now();
        try {
          const m = JSON.parse(text);
          if (Array.isArray(m.t)) showState(m.t, m.m);
          if (typeof m.v === 'number') {
            document.querySelectorAll('#speedSeg button').forEach((b) =>
              b.classList.toggle('on', Number(b.dataset.v) === m.v));
          }
        } catch (e) { /* ignore */ }
        updateHeader();
      }
    });
    updateHeader();
  }

  /* ---------- 初始化 ---------- */
  function init() {
    buildMotors();

    document.querySelectorAll('#speedSeg button').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#speedSeg button').forEach((x) => x.classList.toggle('on', x === b));
        if (!send(`V,${b.dataset.v}`)) toast('Not connected');
      });
    });

    $('btnStop').addEventListener('click', () => {
      stopAllHolds();
      send('S');
      setTimeout(() => send('S'), 80);
      toast('All motors stopped');
    });
    $('btnZero').addEventListener('click', () => {
      if (send('Z')) toast('Travel counters reset'); else toast('Not connected');
    });

    // 安全：離開頁面 / 切換 App / 失去焦點時，一律停止
    window.addEventListener('blur', stopAllHolds);
    window.addEventListener('pagehide', stopAllHolds);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopAllHolds(); });

    $('deviceId').value = deviceId;
    $('brokerUrl').value = brokerUrl;
    $('btnConnect').addEventListener('click', () => {
      const id = $('deviceId').value.trim().replace(/[^\w\-]/g, '');
      const url = $('brokerUrl').value.trim();
      if (!id || !/^wss?:\/\//.test(url)) { toast('Check device ID and URL'); return; }
      deviceId = id; brokerUrl = url;
      store.set('jog.deviceId', id); store.set('jog.brokerUrl', url);
      connect();
      toast('Reconnecting…');
    });

    connect();

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* ignore */ });
    }
  }

  init();
})();
