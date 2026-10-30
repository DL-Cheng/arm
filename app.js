(() => {
  'use strict';

  /* ============ 設定 ============ */
  const DEFAULTS = {
    deviceId: 'DL-RobotArm',
    brokerUrl: 'wss://broker.emqx.io:8084/mqtt'
  };

  const AXES = [
    { name: 'Thumb',  ends: ['Extend', 'Curl'] },
    { name: 'Index',  ends: ['Extend', 'Curl'] },
    { name: 'Middle', ends: ['Extend', 'Curl'] },
    { name: 'Ring',   ends: ['Extend', 'Curl'] },
    { name: 'Little', ends: ['Extend', 'Curl'] },
    { name: 'Wrist',  ends: ['Left', 'Right'], wrist: true }
  ];

  // 拇 食 中 無 小 腕
  const POSES = [
    { name: 'Open',   v: [0, 0, 0, 0, 0, 50] },
    { name: 'Fist',   v: [100, 100, 100, 100, 100, 50] },
    { name: 'One',   v: [100, 0, 100, 100, 100, 50] },
    { name: 'Two',   v: [100, 0, 0, 100, 100, 50] },
    { name: 'Three',   v: [100, 0, 0, 0, 100, 50] },
    { name: 'Four',   v: [100, 0, 0, 0, 0, 50] },
    { name: 'OK',     v: [60, 60, 0, 0, 0, 50] },
    { name: 'Thumbs Up',   v: [0, 100, 100, 100, 100, 50] },
    { name: 'Rock',   v: [100, 0, 100, 100, 0, 50] }
  ];

  const DEMOS = [
    { id: 'show',  name: 'Play All',     desc: 'Run every demo in a loop', all: true },
    { id: 'wave',  name: 'Finger Wave',  desc: 'Fingers curl and release in turn' },
    { id: 'count', name: 'Count 1 – 5',  desc: 'Shows numbers one to five' },
    { id: 'rps',   name: 'Rock Paper Scissors', desc: 'Three game gestures' },
    { id: 'grab',  name: 'Grab & Turn',    desc: 'Grips an object and rotates the wrist' }
  ];

  /* ============ 狀態 ============ */
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  };

  let deviceId = store.get('deviceId', DEFAULTS.deviceId);
  let brokerUrl = store.get('brokerUrl', DEFAULTS.brokerUrl);
  let vals = [0, 0, 0, 0, 0, 50];        // 使用者設定值
  let shown = vals.slice();              // 手形圖顯示值
  let dev = null;                        // 最新裝置狀態
  let devAt = 0;                         // 最後收到狀態的時間
  let devOnline = false;
  let client = null;
  let dragging = false;
  let lastUser = 0;
  let speed = parseInt(store.get('speed', '250'), 10) || 250;

  /* ============ 工具 ============ */
  const base = () => `shutech/robotarm/${deviceId}`;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }
  function buzz() { try { navigator.vibrate && navigator.vibrate(12); } catch (e) { /* ignore */ } }

  function publish(obj) {
    if (client && client.connected) {
      client.publish(`${base()}/cmd`, JSON.stringify(obj), { qos: 0 });
      return true;
    }
    return false;
  }

  /* ============ 介面建立 ============ */
  const sliderEls = [];
  function buildSliders() {
    const box = $('sliders');
    AXES.forEach((ax, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'slider-box' + (ax.wrist ? ' wrist' : '');
      wrap.innerHTML =
        `<div class="slider-head"><b>${ax.name}</b><output id="o${i}"></output></div>` +
        `<input type="range" id="r${i}" min="0" max="100" step="1" value="${vals[i]}" aria-label="${ax.name}">` +
        `<div class="slider-ends"><span>${ax.ends[0]}</span><span>${ax.wrist ? 'Center' : ''}</span><span>${ax.ends[1]}</span></div>`;
      box.appendChild(wrap);
      const r = wrap.querySelector('input');
      sliderEls.push(r);

      const down = () => { dragging = true; };
      const up = () => { dragging = false; };
      r.addEventListener('pointerdown', down);
      r.addEventListener('touchstart', down, { passive: true });
      ['pointerup', 'pointercancel', 'touchend', 'touchcancel', 'change'].forEach((ev) => r.addEventListener(ev, up));

      r.addEventListener('input', () => {
        vals[i] = parseInt(r.value, 10);
        lastUser = Date.now();
        renderSlider(i);
        renderHand(vals);
        sendPositions();
      });
    });
  }

  function renderSlider(i) {
    const r = sliderEls[i];
    r.value = vals[i];
    r.style.setProperty('--p', vals[i] + '%');
    const o = $('o' + i);
    if (AXES[i].wrist) {
      const deg = Math.round((vals[i] - 50) * 1.8);
      o.textContent = (deg > 0 ? 'R ' : deg < 0 ? 'L ' : '') + Math.abs(deg) + '°';
    } else {
      o.textContent = vals[i] + '%';
    }
  }
  const renderSliders = () => vals.forEach((_, i) => renderSlider(i));

  function buildPoses() {
    const g = $('poseGrid');
    POSES.forEach((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pose';
      b.textContent = p.name;
      b.addEventListener('click', () => {
        buzz();
        vals = p.v.slice();
        lastUser = Date.now();
        renderSliders();
        renderHand(vals);
        if (!publish({ s: vals })) toast('Not connected – preview only');
      });
      g.appendChild(b);
    });
  }

  function buildDemos() {
    const g = $('demoGrid');
    DEMOS.forEach((d) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'demo' + (d.all ? ' all' : '');
      b.dataset.id = d.id;
      b.innerHTML = `<b>${d.all ? '▶ ' : ''}${d.name}</b><span>${d.desc}</span>`;
      b.addEventListener('click', () => {
        buzz();
        if (!publish({ mode: 'demo', demo: d.id })) toast('Not connected – cannot start demo');
        else toast('Demo started: ' + d.name);
      });
      g.appendChild(b);
    });
  }

  /* ============ Chibi hand ============ */
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k]));
    parent.appendChild(e);
    return e;
  };
  const FX = [0, 92, 120, 148, 176];       // finger x (index..little)
  const FL = [0, 84, 96, 88, 70];          // finger length
  const FW = 28;
  const parts = [];
  function buildHand() {
    const g = $('fingers');
    for (let k = 1; k <= 4; k++) {
      const grp = mk('g', {}, g);
      parts[k] = {
        body: mk('rect', { x: FX[k], width: FW, rx: 14 }, grp),
        nail: mk('rect', { x: FX[k] + 7, width: 14, height: 9, rx: 4.5, class: 'q-nail' }, grp),
        j1: mk('line', { x1: FX[k] + 6, x2: FX[k] + FW - 6, class: 'q-joint' }, grp),
        j2: mk('line', { x1: FX[k] + 6, x2: FX[k] + FW - 6, class: 'q-joint' }, grp)
      };
    }
    const t = $('f0g');
    parts[0] = {
      body: mk('rect', { x: -14, y: -62, width: 28, height: 76, rx: 14 }, t),
      nail: mk('rect', { x: -7, y: -57, width: 14, height: 9, rx: 4.5, class: 'q-nail' }, t),
      j1: mk('line', { x1: -8, x2: 8, y1: -20, y2: -20, class: 'q-joint' }, t),
      j2: mk('line', { x1: -8, x2: 8, y1: -38, y2: -38, class: 'q-joint' }, t)
    };
  }

  function renderHand(a) {
    for (let k = 1; k <= 4; k++) {
      const b = a[k] / 100;
      const len = FL[k] * (1 - 0.6 * b);
      const top = 142 - len;
      const p = parts[k];
      p.body.setAttribute('y', top);
      p.body.setAttribute('height', len + 14);
      p.body.style.fill = `hsl(3 82% ${60 - 15 * b}%)`;
      p.nail.setAttribute('y', top + 5);
      p.j1.setAttribute('y1', top + len * 0.42); p.j1.setAttribute('y2', top + len * 0.42);
      p.j2.setAttribute('y1', top + len * 0.72); p.j2.setAttribute('y2', top + len * 0.72);
    }
    const tb = a[0] / 100;
    parts[0].body.style.fill = `hsl(3 82% ${60 - 15 * tb}%)`;
    $('f0g').setAttribute('transform', `translate(96 198) rotate(${-55 + 50 * tb})`);
    $('handRot').setAttribute('transform', `rotate(${(a[5] - 50) * 0.9} 150 236)`);
    // Face: smile when relaxed, determined mouth when gripping
    const avg = (a[0] + a[1] + a[2] + a[3] + a[4]) / 5;
    $('mouth').setAttribute('d', avg < 45 ? 'M138 200 Q150 214 162 200' : 'M141 205 Q150 199 159 205');
  }

  /* ============ 傳送（節流） ============ */
  let sendTimer = null, lastSend = 0;
  function sendPositions() {
    const wait = Math.max(0, 70 - (performance.now() - lastSend));
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      lastSend = performance.now();
      publish({ s: vals.slice() });
    }, wait);
  }

  /* ============ MQTT ============ */
  function setPill(id, cls, text) {
    const el = $(id);
    el.className = 'pill ' + cls;
    if (text) el.lastChild.textContent = text;
  }

  function updateHeader() {
    const brokerOn = client && client.connected;
    setPill('pillBroker', brokerOn ? 'on' : (client ? 'wait' : ''), brokerOn ? 'Cloud' : (client ? 'Connecting' : 'Cloud'));
    setPill('pillDevice', devOnline ? 'on' : '', 'Arm');

    let txt;
    if (!brokerOn) txt = client ? 'Connecting to cloud…' : 'Not connected (preview mode)';
    else if (!devOnline) txt = 'Waiting for arm to come online…';
    else if (!dev) txt = 'Arm online';
    else if (dev.mode === 'demo') {
      const d = DEMOS.find((x) => x.id === dev.demo);
      txt = 'Demo running: ' + (d ? d.name : dev.demo);
    } else if (dev.mode === 'relax') txt = 'Motors relaxed';
    else txt = 'Manual control';
    $('modeText').textContent = txt;

    document.querySelectorAll('.demo').forEach((b) => {
      b.classList.toggle('active', !!dev && devOnline && dev.mode === 'demo' && dev.demo === b.dataset.id);
    });
    $('speedNow').textContent = dev && devOnline ? `WiFi signal ${dev.rssi} dBm` : '';
  }

  function onStatus(msg) {
    dev = msg;
    devAt = Date.now();
    if (Array.isArray(msg.s) && msg.s.length === 6) {
      shown = msg.s.map(Number);
      renderHand(shown);
      // 示範中或閒置時，讓滑桿跟隨手臂實際位置
      const idle = Date.now() - lastUser > 1500 && !dragging;
      if (idle && (msg.mode === 'demo' || msg.mode === 'relax')) {
        vals = shown.slice();
        renderSliders();
      }
    }
    if (typeof msg.spd === 'number' && Date.now() - lastUser > 1500) {
      speed = msg.spd;
      $('speed').value = speed;
      $('speedVal').textContent = speed;
    }
    updateHeader();
  }

  function connect() {
    if (client) { try { client.end(true); } catch (e) { /* ignore */ } client = null; }
    dev = null; devOnline = false;
    $('topicHint').textContent = `Topics: ${base()}/cmd, /status, /online`;

    if (typeof mqtt === 'undefined') { toast('Failed to load MQTT library'); updateHeader(); return; }

    const clientId = 'robotarm-web-' + Math.random().toString(16).slice(2, 10);
    client = mqtt.connect(brokerUrl, {
      clientId, clean: true, keepalive: 30, reconnectPeriod: 3000, connectTimeout: 8000
    });
    const c = client;

    c.on('connect', () => {
      c.subscribe([`${base()}/status`, `${base()}/online`], { qos: 0 });
      updateHeader();
    });
    c.on('reconnect', updateHeader);
    c.on('close', () => { devOnline = false; updateHeader(); });
    c.on('error', () => updateHeader());
    c.on('message', (topic, payload) => {
      const text = payload.toString();
      if (topic.endsWith('/online')) {
        devOnline = text === '1';
        if (!devOnline) dev = null;
        updateHeader();
      } else if (topic.endsWith('/status')) {
        devOnline = true;
        try { onStatus(JSON.parse(text)); } catch (e) { /* ignore */ }
      }
    });
    updateHeader();
  }

  /* ============ 初始化 ============ */
  function init() {
    buildHand();
    buildSliders();
    buildPoses();
    buildDemos();
    renderSliders();
    renderHand(vals);

    $('speed').value = speed;
    $('speedVal').textContent = speed;
    $('speed').addEventListener('input', (e) => {
      speed = parseInt(e.target.value, 10);
      $('speedVal').textContent = speed;
      lastUser = Date.now();
      store.set('speed', String(speed));
      clearTimeout(init.sp);
      init.sp = setTimeout(() => publish({ speed }), 120);
    });

    $('btnStop').addEventListener('click', () => {
      buzz();
      if (publish({ mode: 'manual' })) toast('Demo stopped');
      else toast('Not connected');
    });
    $('btnRelax').addEventListener('click', () => {
      buzz();
      if (publish({ mode: 'relax' })) toast('Motors relaxed');
      else toast('Not connected');
    });

    $('deviceId').value = deviceId;
    $('brokerUrl').value = brokerUrl;
    $('btnConnect').addEventListener('click', () => {
      const id = $('deviceId').value.trim().replace(/[^\w\-]/g, '');
      const url = $('brokerUrl').value.trim();
      if (!id || !/^wss?:\/\//.test(url)) { toast('Check device ID and URL'); return; }
      deviceId = id; brokerUrl = url;
      store.set('deviceId', id); store.set('brokerUrl', url);
      connect();
      toast('Reconnecting…');
    });

    // 安裝成 App
    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); deferred = e; $('btnInstall').hidden = false;
    });
    $('btnInstall').addEventListener('click', async () => {
      if (!deferred) return;
      deferred.prompt(); await deferred.userChoice; deferred = null; $('btnInstall').hidden = true;
    });

    // Status timeout: no report for 8 s
    setInterval(() => {
      if (dev && Date.now() - devAt > 8000) { dev = null; updateHeader(); }
    }, 2000);

    connect();

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* ignore */ });
    }
  }

  init();
})();
