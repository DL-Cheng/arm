import { GestureTracker } from './gesture-tracker.js';

(() => {
  'use strict';

  const DEFAULTS = {
    deviceId: 'DL-RobotArm',
    brokerUrl: 'wss://broker.emqx.io:8084/mqtt'
  };
  const MOTORS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky', 'Wrist'];
  const MOTOR_ZH = ['拇指', '食指', '中指', '无名指', '小指', '手腕'];
  const GESTURE_ZH = {
    'Closed fist': '握拳',
    'Open palm': '张开手掌',
    'Thumbs up': '竖拇指',
    'Peace sign': 'V 字手势',
    Pointing: '指向',
    'Three fingers': '三指'
  };
  const MOVES_ZH = { rock: '石头', paper: '布', scissors: '剪刀' };
  const bi = (english, chinese) => `${english} · ${chinese}`;
  const setBilingualButton = (id, english, chinese) => {
    $(id).textContent = `${english}\n${chinese}`;
  };
  const $ = (id) => document.getElementById(id);
  const readStore = (key, fallback) => {
    try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
  };
  const writeStore = (key, value) => {
    try { localStorage.setItem(key, value); } catch { /* Storage may be disabled by the browser. */ }
  };

  let deviceId = readStore('deviceId', DEFAULTS.deviceId);
  let brokerUrl = readStore('brokerUrl', DEFAULTS.brokerUrl);
  let client = null;
  let deviceOnline = false;
  let lastStatusAt = 0;
  let status = null;
  let speed = Math.max(20, Math.min(400, Number(readStore('jogSpeed', '160')) || 160));
  let tracker = null;
  let cameraGesture = '';
  let cameraConfidence = 0;
  let gameLocked = false;
  const heldMotors = new Map();
  const scores = { you: 0, robot: 0 };

  const baseTopic = () => `shutech/robotarm-jog/${deviceId}`;
  let toastTimer;
  function toast(message) {
    const element = $('toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('show'), 2400);
  }

  function publish(payload) {
    if (!client?.connected) return false;
    client.publish(`${baseTopic()}/cmd`, payload, { qos: 0 }, (error) => {
      if (error) toast(`${bi('Command failed', '命令失败')}: ${error.message}`);
    });
    return true;
  }

  function setPill(id, state, label) {
    const pill = $(id);
    pill.className = `pill ${state}`;
    pill.lastChild.textContent = label;
  }

  function renderConnection() {
    const brokerConnected = Boolean(client?.connected);
    setPill('pillBroker', brokerConnected ? 'on' : client ? 'wait' : '', brokerConnected ? bi('Broker', '服务器') : client ? bi('Connecting', '连接中') : bi('Broker', '服务器'));
    setPill('pillDevice', deviceOnline ? 'on' : '', bi('Hand', '机械手'));
    $('networkStatus').textContent = deviceOnline ? bi('Device is online', '设备已连接') : brokerConnected ? bi('Waiting for ESP32', '等待 ESP32') : bi('Broker disconnected', '服务器已断开');
    $('modeText').textContent = deviceOnline ? bi('ESP32 online · manual jog available', 'ESP32 已连接 · 可手动点动') : brokerConnected ? bi('Connected to broker · waiting for device', '服务器已连接 · 等待设备') : bi('MQTT disconnected', 'MQTT 已断开');
    $('activeMode').textContent = deviceOnline ? bi('Manual jog', '手动点动') : bi('Offline', '离线');
  }

  function renderMotorStatus() {
    if (!status) {
      $('motorStatus').textContent = bi('No live motor data', '暂无电机数据');
      document.querySelectorAll('[data-travel-index]').forEach((element) => { element.textContent = bi('Travel —', '行程 —'); });
      return;
    }
    const active = status.m.map((direction, index) => direction ? `${MOTORS[index]} ${direction > 0 ? '+' : '−'} (${MOTOR_ZH[index]})` : null).filter(Boolean);
    $('motorStatus').textContent = active.length ? `${bi('Moving', '正在移动')}: ${active.join(' · ')}` : bi('All motors stopped', '所有电机已停止');
    status.t.forEach((value, index) => {
      const element = document.querySelector(`[data-travel-index="${index}"]`);
      if (element) element.textContent = `${bi('Travel', '行程')} ${(value / 10).toFixed(1)}`;
    });
  }

  function handleStatus(payload) {
    try {
      const message = JSON.parse(payload);
      if (!Array.isArray(message.t) || message.t.length !== 6 ||
          !Array.isArray(message.m) || message.m.length !== 6 ||
          !Number.isFinite(message.v)) return;
      status = {
        t: message.t.map(Number),
        m: message.m.map(Number),
        v: Number(message.v)
      };
      lastStatusAt = Date.now();
      deviceOnline = true;
      $('speed').value = status.v;
      $('speedVal').textContent = `${status.v} μs`;
      renderMotorStatus();
      renderConnection();
    } catch (error) {
      console.warn('Ignoring malformed ESP32 status packet.', error);
    }
  }

  function connect() {
    if (client) {
      client.end(true);
      client = null;
    }
    deviceOnline = false;
    status = null;
    $('topicHint').textContent = `Command: ${baseTopic()}/cmd · Status: ${baseTopic()}/status · Online: ${baseTopic()}/online`;
    if (typeof mqtt === 'undefined') {
      toast(bi('MQTT library failed to load.', 'MQTT 库加载失败。'));
      renderConnection();
      return;
    }

    client = mqtt.connect(brokerUrl, {
      clientId: `robotjog-web-${Math.random().toString(16).slice(2, 10)}`,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 3000,
      connectTimeout: 8000
    });
    const thisClient = client;
    thisClient.on('connect', () => {
      thisClient.subscribe([`${baseTopic()}/status`, `${baseTopic()}/online`], { qos: 0 });
      renderConnection();
    });
    thisClient.on('reconnect', renderConnection);
    thisClient.on('close', () => {
      deviceOnline = false;
      stopAllHeldMotors();
      renderConnection();
    });
    thisClient.on('error', (error) => {
      console.error('MQTT connection error.', error);
      renderConnection();
    });
    thisClient.on('message', (topic, payload) => {
      const text = payload.toString();
      if (topic.endsWith('/online')) {
        deviceOnline = text === '1';
        if (!deviceOnline) status = null;
        renderConnection();
      } else if (topic.endsWith('/status')) {
        handleStatus(text);
      }
    });
    renderConnection();
  }

  function startJog(motor, direction, button, pointerId) {
    if (!deviceOnline) {
      toast(bi('ESP32 is offline. No motor command sent.', 'ESP32 已离线，未发送电机指令。'));
      return;
    }
    const previous = heldMotors.get(motor);
    if (previous?.button === button && previous.pointerId === pointerId) return;
    if (previous) {
      clearInterval(previous.timer);
      previous.button.classList.remove('moving');
    }

    button.classList.add('moving');
    const held = { timer: null, button, pointerId, direction };
    const send = () => publish(`M,${motor},${held.direction}`);
    send();
    held.timer = setInterval(send, 100);
    heldMotors.set(motor, held);
  }

  function stopJog(motor, button, pointerId) {
    const active = heldMotors.get(motor);
    if (!active) return;
    if (button && (active.button !== button || active.pointerId !== pointerId)) return;
    clearInterval(active.timer);
    active.button.classList.remove('moving');
    heldMotors.delete(motor);
    publish(`M,${motor},0`);
  }

  function stopAllHeldMotors(sendStop = false) {
    heldMotors.forEach(({ timer, button }) => {
      clearInterval(timer);
      button.classList.remove('moving');
    });
    heldMotors.clear();
    return sendStop ? publish('S') : true;
  }

  function buildMotorControls() {
    const parent = $('motorControls');
    MOTORS.forEach((name, index) => {
      const row = document.createElement('div');
      row.className = 'motor-row';
      row.innerHTML = `<span class="motor-id"><span class="motor-name">${name} · ${MOTOR_ZH[index]}</span><small class="motor-value" data-travel-index="${index}">${bi('Travel —', '行程 —')}</small></span><button class="jog-btn" type="button" data-motor="${index}" data-dir="-1" aria-label="Hold to run ${name} in reverse / 按住使${MOTOR_ZH[index]}反转">− Reverse<small>− 反转</small></button><button class="jog-btn" type="button" data-motor="${index}" data-dir="1" aria-label="Hold to run ${name} forward / 按住使${MOTOR_ZH[index]}正转">+ Forward<small>+ 正转</small></button>`;
      row.querySelectorAll('.jog-btn').forEach((button) => {
        const motor = Number(button.dataset.motor);
        const direction = Number(button.dataset.dir);
        button.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          button.setPointerCapture?.(event.pointerId);
          startJog(motor, direction, button, event.pointerId);
        });
        ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((eventName) => {
          button.addEventListener(eventName, (event) => stopJog(motor, button, event.pointerId));
        });
        button.addEventListener('contextmenu', (event) => event.preventDefault());
      });
      parent.appendChild(row);
    });
  }

  function classifyMove(gesture) {
    if (/closed fist/i.test(gesture)) return 'rock';
    if (/open palm/i.test(gesture)) return 'paper';
    if (/peace sign/i.test(gesture)) return 'scissors';
    return null;
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function playGame(userMove) {
    if (gameLocked) return;
    if (!['rock', 'paper', 'scissors'].includes(userMove)) {
      toast(bi('Use a clear fist, open palm, or peace sign.', '请清晰地握拳、张开手掌或比出 V 字手势。'));
      return;
    }
    gameLocked = true;
    const robotMove = ['rock', 'paper', 'scissors'][Math.floor(Math.random() * 3)];
    $('gameResult').textContent = '…';
    $('gameMessage').textContent = `${bi(`Your move: ${userMove}`, `你的手势：${MOVES_ZH[userMove]}`)} · ${bi('Reveal in 3…', '3 秒后揭晓…')}`;
    for (let count = 2; count >= 0; count -= 1) {
      await wait(650);
      $('gameMessage').textContent = count ? `${bi(`Your move: ${userMove}`, `你的手势：${MOVES_ZH[userMove]}`)} · ${bi(`Reveal in ${count}…`, `${count} 秒后揭晓…`)}` : bi('Revealing robotic move…', '机器人正在出手…');
    }
    let result = 'DRAW';
    let resultZh = '平局';
    if (userMove !== robotMove) {
      const wins = (userMove === 'rock' && robotMove === 'scissors') ||
        (userMove === 'paper' && robotMove === 'rock') ||
        (userMove === 'scissors' && robotMove === 'paper');
      result = wins ? 'WIN' : 'LOSE';
      resultZh = wins ? '你赢了' : '你输了';
      scores[wins ? 'you' : 'robot'] += 1;
    }
    $('gameResult').textContent = bi(result, resultZh);
    $('gameMessage').textContent = `${bi('You', '你')}: ${userMove.toUpperCase()} (${MOVES_ZH[userMove]}) · ${bi('Robo', '机器人')}: ${robotMove.toUpperCase()} (${MOVES_ZH[robotMove]}) · ${bi('phone-side only; no motion sent', '仅手机端游戏；未发送动作')}`;
    $('scoreYou').textContent = scores.you;
    $('scoreRobot').textContent = scores.robot;
    gameLocked = false;
  }

  function renderCameraState(update) {
    const tracking = Boolean(update.tracking);
    const cameraActive = Boolean(tracker) && !update.stopped;
    $('trackingStatus').textContent = tracking ? bi('TRACKING', '追踪中') : cameraActive ? bi('SEARCHING', '搜索中') : bi('OFF', '关闭');
    $('cameraBadge').textContent = tracking ? bi('HAND DETECTED', '已检测到手') : cameraActive ? bi('SEARCHING', '搜索中') : bi('TRACKING OFF', '追踪已关闭');
    $('cameraBadge').classList.toggle('on', tracking);
    $('cameraFrame').classList.toggle('active', tracking || cameraActive);
    if (update.stopped) {
      tracker = null;
      cameraGesture = '';
      cameraConfidence = 0;
      $('cameraFrame').classList.remove('active');
      setBilingualButton('btnCamera', 'Start camera', '开启摄像头');
      $('cameraPlaceholder').querySelector('strong').textContent = bi('Camera is off', '摄像头已关闭');
      $('cameraPlaceholder').querySelector('small').textContent = bi('Allow camera permission to recognize hand gestures', '允许摄像头权限以识别手势');
      $('recognized').textContent = bi('No gesture detected', '未检测到手势');
      $('gestureName').textContent = '—';
      $('gestureConfidence').textContent = bi('Confidence —', '置信度 —');
      $('btnPlayCamera').disabled = true;
    }
    if (tracking) {
      cameraGesture = update.gesture === 'Stabilizing…' ? '' : update.gesture;
      cameraConfidence = update.confidence;
      const gestureLabel = update.gesture === 'Stabilizing…' ? bi('Stabilizing…', '识别中…') : `${update.gesture} · ${GESTURE_ZH[update.gesture] || '自定义手势'}`;
      $('recognized').textContent = gestureLabel;
      $('gestureName').textContent = gestureLabel;
      $('gestureConfidence').textContent = `${bi('Confidence', '置信度')} ${update.confidence}%`;
      $('btnPlayCamera').disabled = !classifyMove(cameraGesture) || gameLocked;
    } else if (!update.stopped) {
      cameraGesture = '';
      cameraConfidence = 0;
      $('recognized').textContent = cameraActive ? bi('Searching for hand…', '正在寻找手部…') : bi('No gesture detected', '未检测到手势');
      $('gestureName').textContent = cameraActive ? bi('Searching…', '搜索中…') : bi('No hand detected', '未检测到手');
      $('gestureConfidence').textContent = bi('Confidence —', '置信度 —');
      $('btnPlayCamera').disabled = true;
    }
  }

  async function toggleCamera() {
    if (tracker) {
      await tracker.stop();
      return;
    }
    $('btnCamera').disabled = true;
    setBilingualButton('btnCamera', 'Loading vision model…', '正在加载视觉模型…');
    try {
      tracker = new GestureTracker($('cameraVideo'), renderCameraState);
      await tracker.start();
      $('cameraFrame').classList.add('active');
      setBilingualButton('btnCamera', 'Stop camera', '关闭摄像头');
      $('cameraPlaceholder').querySelector('strong').textContent = bi('Looking for a hand…', '正在寻找手部…');
      $('cameraPlaceholder').querySelector('small').textContent = bi('Keep your hand in view', '请将手保持在画面中');
      $('trackingStatus').textContent = bi('SEARCHING', '搜索中');
      $('cameraBadge').textContent = bi('SEARCHING', '搜索中');
    } catch (error) {
      console.error('Could not start camera gesture tracking.', error);
      await tracker?.stop();
      tracker = null;
      toast(`${bi('Camera unavailable', '摄像头不可用')}: ${error.message}`);
      setBilingualButton('btnCamera', 'Start camera', '开启摄像头');
      $('cameraFrame').classList.remove('active');
      $('trackingStatus').textContent = bi('OFF', '关闭');
    } finally {
      $('btnCamera').disabled = false;
    }
  }

  function init() {
    buildMotorControls();
    $('deviceId').value = deviceId;
    $('brokerUrl').value = brokerUrl;
    $('speed').value = speed;
    $('speedVal').textContent = `${speed} μs`;

    $('speed').addEventListener('input', (event) => {
      speed = Number(event.target.value);
      $('speedVal').textContent = `${speed} μs`;
      writeStore('jogSpeed', String(speed));
      publish(`V,${speed}`);
    });
    $('btnStop').addEventListener('click', () => {
      stopAllHeldMotors();
      if (!publish('S')) toast(bi('ESP32 is offline. Stop command not delivered.', 'ESP32 已离线，停止指令未送达。'));
      else toast(bi('Stop-all command sent.', '已发送全部停止指令。'));
    });
    $('btnCamera').addEventListener('click', toggleCamera);
    document.querySelectorAll('[data-move]').forEach((button) => {
      button.addEventListener('click', () => playGame(button.dataset.move));
    });
    $('btnPlayCamera').addEventListener('click', () => {
      const move = classifyMove(cameraGesture);
      if (move) playGame(move);
    });
    $('btnResetGame').addEventListener('click', () => {
      scores.you = 0;
      scores.robot = 0;
      $('scoreYou').textContent = '0';
      $('scoreRobot').textContent = '0';
      $('scoreYou').textContent = '0';
      $('gameResult').textContent = bi('Ready?', '准备好了吗？');
      $('gameMessage').textContent = bi('Choose a move or use a recognized camera gesture.', '选择手势，或使用摄像头识别的手势。');
    });
    $('btnConnect').addEventListener('click', () => {
      const id = $('deviceId').value.trim();
      const url = $('brokerUrl').value.trim();
      if (!/^[\w-]{1,48}$/.test(id) || !/^wss?:\/\//i.test(url)) {
        toast(bi('Enter a valid device ID and MQTT WebSocket URL.', '请输入有效的设备编号和 MQTT WebSocket 地址。'));
        return;
      }
      deviceId = id;
      brokerUrl = url;
      writeStore('deviceId', id);
      writeStore('brokerUrl', url);
      connect();
      toast(bi('Reconnecting to device…', '正在重新连接设备…'));
    });

    let deferredInstall = null;
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredInstall = event;
      $('btnInstall').hidden = false;
    });
    $('btnInstall').addEventListener('click', async () => {
      if (!deferredInstall) return;
      await deferredInstall.prompt();
      deferredInstall = null;
      $('btnInstall').hidden = true;
    });

    setInterval(() => {
      if (deviceOnline && Date.now() - lastStatusAt > 7000) {
        deviceOnline = false;
        status = null;
        renderConnection();
        renderMotorStatus();
      }
    }, 1500);
    const stopMotorsBeforePause = () => stopAllHeldMotors(true);
    window.addEventListener('blur', stopMotorsBeforePause);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') stopMotorsBeforePause();
    });
    window.addEventListener('pagehide', () => {
      stopMotorsBeforePause();
      tracker?.stop();
    });
    connect();
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch((error) => console.error('Service worker registration failed.', error));
    }
  }

  init();
})();
