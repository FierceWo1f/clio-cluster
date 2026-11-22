// Prueba de enlace teléfono <-> estéreo (Fase 0).
// JavaScript conservador (ES2017, sin ?. ni ??) para que corra en WebViews viejos.
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var now = function () { return performance.now(); };
  var report = { fecha: new Date().toISOString(), equipo: {}, pantalla: {}, wifi: null, ble: null, teclas: [] };

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function pct(arr, p) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[Math.min(a.length - 1, Math.floor(a.length * p))];
  }
  function avg(arr) { var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i]; return arr.length ? s / arr.length : 0; }
  function r1(n) { return Math.round(n * 10) / 10; }
  function logTo(el, msg) {
    var t = new Date().toLocaleTimeString();
    el.textContent = (t + '  ' + msg + '\n' + el.textContent).slice(0, 6000);
  }
  function statsHtml(obj) {
    return Object.keys(obj).map(function (k) {
      return '<div class="stat"><small>' + esc(k) + '</small><span>' + esc(obj[k]) + '</span></div>';
    }).join('');
  }

  // ---------- Pestañas ----------
  $$('.tab').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('.tab').forEach(function (x) { x.classList.toggle('on', x === b); });
      $$('section').forEach(function (s) { s.classList.toggle('on', s.id === b.dataset.tab); });
      if (b.dataset.tab === 'reporte') renderReport();
    });
  });

  // ---------- Equipo ----------
  function detect() {
    var ua = navigator.userAgent;
    var m = ua.match(/Chrome\/(\d+)/);
    var gl = null, glRenderer = '—';
    try {
      var c = document.createElement('canvas');
      gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (gl) {
        var dbg = gl.getExtension('WEBGL_debug_renderer_info');
        glRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      }
    } catch (e) {}
    var voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    var es = voices.filter(function (v) { return /^es/i.test(v.lang); });
    var info = {
      'Chrome / WebView': m ? m[1] : 'no detectado',
      'Android': (ua.match(/Android ([\d.]+)/) || [])[1] || '—',
      'Núcleos CPU': navigator.hardwareConcurrency || '—',
      'Memoria (GB aprox.)': navigator.deviceMemory || '—',
      'Pantalla': screen.width + '×' + screen.height + ' @' + (window.devicePixelRatio || 1) + 'x',
      'Ventana': innerWidth + '×' + innerHeight,
      'Contexto seguro': window.isSecureContext ? 'sí' : 'no',
      'Web Bluetooth': 'bluetooth' in navigator ? 'sí' : 'no',
      'Web Serial': 'serial' in navigator ? 'sí' : 'no',
      'WebSocket': 'WebSocket' in window ? 'sí' : 'no',
      'WebGL': gl ? 'sí' : 'no',
      'GPU': glRenderer,
      'Web Audio': (window.AudioContext || window.webkitAudioContext) ? 'sí' : 'no',
      'Wake Lock': 'wakeLock' in navigator ? 'sí' : 'no',
      'Geolocalización': 'geolocation' in navigator ? 'sí' : 'no',
      'Service Worker': 'serviceWorker' in navigator ? 'sí' : 'no',
      'Voces TTS en español': window.speechSynthesis ? (es.length + ' de ' + voices.length) : 'no',
      'User agent': ua,
    };
    report.equipo = info;
    $('#equipoTbl').innerHTML = Object.keys(info).map(function (k) {
      var v = String(info[k]);
      var cls = v === 'sí' ? 'ok' : v === 'no' ? 'bad' : '';
      return '<tr><td>' + esc(k) + '</td><td class="' + cls + '">' + esc(v) + '</td></tr>';
    }).join('');
  }
  detect();
  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = detect;

  // ---------- Pantalla (benchmark de Canvas) ----------
  var cv = $('#bench'), ctx = cv.getContext('2d');
  var W = 1024, H = 600;
  var rnd = (function (seed) { return function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; })(42);

  // Red de calles falsa (parecida en cantidad a una zona urbana) y una ruta.
  var roads = [];
  for (var i = 0; i < 700; i++) {
    var x = rnd() * 4000 - 2000, y = rnd() * 4000 - 2000, pts = [x, y];
    var ang = Math.floor(rnd() * 4) * Math.PI / 2 + (rnd() - 0.5) * 0.3;
    var n = 2 + Math.floor(rnd() * 5);
    for (var j = 0; j < n; j++) {
      ang += (rnd() - 0.5) * 0.5;
      x += Math.cos(ang) * (60 + rnd() * 140); y += Math.sin(ang) * (60 + rnd() * 140);
      pts.push(x, y);
    }
    roads.push({ pts: pts, major: rnd() < 0.15 });
  }
  var route = [0, 0], rx = 0, ry = 0, ra = -Math.PI / 2;
  for (var k = 0; k < 60; k++) { ra += (rnd() - 0.5) * 0.6; rx += Math.cos(ra) * 80; ry += Math.sin(ra) * 80; route.push(rx, ry); }

  function poly(c, pts) {
    c.beginPath(); c.moveTo(pts[0], pts[1]);
    for (var i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
    c.stroke();
  }

  function drawMap(c, w, h, t) {
    var heading = t * 0.00025, px = Math.sin(t * 0.0003) * 400, py = -t * 0.04 % 2000;
    c.save();
    c.beginPath(); c.rect(0, 0, w, h); c.clip();
    c.fillStyle = '#05070c'; c.fillRect(0, 0, w, h);
    c.translate(w / 2, h * 0.68); c.rotate(-heading); c.translate(-px, -py);
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = '#1c2536'; c.lineWidth = 9;
    roads.forEach(function (r) { if (r.major) poly(c, r.pts); });
    c.strokeStyle = '#2b3850'; c.lineWidth = 4;
    roads.forEach(function (r) { poly(c, r.pts); });
    c.shadowColor = '#3fa9ff'; c.shadowBlur = 14;
    c.strokeStyle = '#3fa9ff'; c.lineWidth = 8;
    poly(c, route);
    c.shadowBlur = 0;
    c.restore();
    // auto
    c.save(); c.translate(w / 2, h * 0.68);
    c.fillStyle = '#ffffff'; c.beginPath(); c.moveTo(0, -16); c.lineTo(11, 12); c.lineTo(0, 6); c.lineTo(-11, 12); c.closePath(); c.fill();
    c.restore();
    // tarjeta de maniobra
    c.fillStyle = 'rgba(10,14,20,.85)'; c.fillRect(16, 16, 260, 74);
    c.fillStyle = '#fff'; c.font = 'bold 30px system-ui, sans-serif';
    c.fillText('↱ 350 m', 30, 52);
    c.fillStyle = '#8b96a8'; c.font = '16px system-ui, sans-serif'; c.fillText('Av. Ejemplo', 30, 78);
  }

  var barGrad = null;
  function drawViz(c, x0, w, h, t, bands) {
    c.fillStyle = '#000'; c.fillRect(x0, 0, w, h);
    if (!barGrad || barGrad._h !== h) {
      barGrad = c.createLinearGradient(0, h, 0, 0);
      barGrad.addColorStop(0, '#0a5cff'); barGrad.addColorStop(0.6, '#33d6ff'); barGrad.addColorStop(1, '#ffffff');
      barGrad._h = h;
    }
    var n = bands || 32, bw = (w - 20) / n;
    c.fillStyle = barGrad;
    for (var i = 0; i < n; i++) {
      var v = 0.5 + 0.5 * Math.sin(t * 0.006 + i * 0.5) * Math.sin(t * 0.0021 + i * 0.13);
      var bh = v * (h * 0.55);
      c.fillRect(x0 + 10 + i * bw, h * 0.7 - bh, bw - 3, bh);
    }
    c.fillStyle = '#fff'; c.font = 'bold 22px system-ui, sans-serif'; c.textAlign = 'center';
    c.fillText('Y la noche se hizo canción', x0 + w / 2, h * 0.8);
    c.fillStyle = '#8b96a8'; c.font = '18px system-ui, sans-serif';
    c.fillText('siguiente línea de la letra…', x0 + w / 2, h * 0.86);
    c.textAlign = 'left';
  }

  var scenes = {
    mapa: function (t) { drawMap(ctx, W, H, t); },
    dividida: function (t) {
      drawMap(ctx, 640, H, t);
      drawViz(ctx, 640, 384, H, t, 24);
    },
    visual: function (t) { drawViz(ctx, 0, W, H, t, 48); },
  };

  var benchRunning = false;
  function runScene(name, ms) {
    return new Promise(function (resolve) {
      var deltas = [], start = now(), last = start;
      function frame(t) {
        var tt = now();
        deltas.push(tt - last); last = tt;
        scenes[name](tt - start);
        if (tt - start < ms) requestAnimationFrame(frame);
        else {
          deltas.shift();
          var res = { fps: r1(1000 / avg(deltas)), p95_ms: r1(pct(deltas, 0.95)), peor_ms: r1(Math.max.apply(null, deltas)) };
          report.pantalla[name] = res;
          resolve(res);
        }
      }
      requestAnimationFrame(frame);
    });
  }
  function showBench() {
    $('#benchOut').textContent = Object.keys(report.pantalla).map(function (k) {
      var r = report.pantalla[k];
      var tag = r.fps >= 25 ? 'OK' : r.fps >= 18 ? 'justo' : 'LENTO';
      return k + ': ' + r.fps + ' fps  (p95 ' + r.p95_ms + ' ms, peor ' + r.peor_ms + ' ms)  ' + tag;
    }).join('\n') || 'Sin resultados.';
  }
  function benchBtns(on) { $$('[data-scene], #benchAll').forEach(function (b) { b.disabled = !on; }); }
  $$('[data-scene]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (benchRunning) return; benchRunning = true; benchBtns(false);
      $('#benchOut').textContent = 'Midiendo ' + b.dataset.scene + '…';
      runScene(b.dataset.scene, 8000).then(function () { benchRunning = false; benchBtns(true); showBench(); });
    });
  });
  $('#benchAll').addEventListener('click', function () {
    if (benchRunning) return; benchRunning = true; benchBtns(false);
    var names = ['mapa', 'dividida', 'visual'], i = 0;
    (function next() {
      if (i >= names.length) { benchRunning = false; benchBtns(true); showBench(); return; }
      $('#benchOut').textContent = 'Midiendo ' + names[i] + '…';
      runScene(names[i++], 8000).then(next);
    })();
  });
  scenes.dividida(0);

  // ---------- WiFi (WebSocket por el hub) ----------
  var hubDefault = (location.protocol === 'http:' || location.protocol === 'https:') && location.host
    ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'
    : 'ws://192.168.43.1:8080/ws';
  $('#hubUrl').value = hubDefault;

  var ws = null, wsTimer = null, wsUi = null, wsRole = null, wsStart = 0;
  var S = null; // estadísticas de la sesión actual
  var fftLast = new Uint8Array(32);
  var fv = $('#fftView'), fctx = fv.getContext('2d');

  function resetStats() {
    S = { enviados: 0, recibidos: 0, bytes: 0, rtts: [], gaps: [], lastObd: 0, porTipo: {}, pingsPend: {}, perdidos: 0, winMsgs: 0, winBytes: 0, winT: now(), rate: 0, bps: 0 };
  }

  function wsOpen(role) {
    if (ws) return;
    wsRole = role; resetStats();
    var url = $('#hubUrl').value.trim();
    url += (url.indexOf('?') < 0 ? '?' : '&') + 'role=' + (role === 'send' ? 'motor-prueba' : 'pantalla-prueba');
    logTo($('#wsLog'), 'Conectando a ' + url);
    try { ws = new WebSocket(url); } catch (e) { logTo($('#wsLog'), 'Error: ' + e.message); ws = null; return; }
    ws.binaryType = 'arraybuffer';
    $('#wsSend').disabled = $('#wsRecv').disabled = true; $('#wsStop').disabled = false;
    ws.onopen = function () {
      wsStart = now();
      logTo($('#wsLog'), 'Conectado como ' + (role === 'send' ? 'EMISOR' : 'RECEPTOR'));
      if (role === 'send') startSending();
    };
    ws.onmessage = onWsMessage;
    ws.onerror = function () { logTo($('#wsLog'), 'Error de conexión (¿hub corriendo? ¿misma red?)'); };
    ws.onclose = function (e) { logTo($('#wsLog'), 'Cerrado (' + e.code + ')'); wsCleanup(); };
    wsUi = setInterval(updateWsUi, 500);
  }

  function startSending() {
    var hz = +$('#rate').value, tick = 0, pingId = 0;
    wsTimer = setInterval(function () {
      if (!ws || ws.readyState !== 1) return;
      tick++;
      var t = now();
      // Datos de prueba del mismo tamaño que los reales
      var obd = JSON.stringify({ t: 'obd', rpm: 2500 + Math.round(Math.sin(t / 700) * 1500), vel: 60 + Math.round(Math.sin(t / 3000) * 30), temp: 89, marcha: 3, lh: 6.4, kml: 12.8, alertas: [] });
      send(obd);
      var fft = new Uint8Array(33); fft[0] = 0x46; // 'F'
      for (var i = 1; i < 33; i++) fft[i] = 128 + Math.round(127 * Math.sin(t / 120 + i / 3) * Math.sin(t / 900 + i / 9));
      send(fft.buffer);
      if (tick % hz === 0) send(JSON.stringify({ t: 'gps', lat: 19.4326 + tick * 1e-5, lon: -99.1332, rumbo: 90, vel: 60, prec: 5 }));
      if (tick % Math.max(1, Math.round(hz / 2)) === 0) {
        pingId++; S.pingsPend[pingId] = t;
        send(JSON.stringify({ t: 'ping', id: pingId, ts: t }));
        // pings sin respuesta en 3 s se cuentan como perdidos
        Object.keys(S.pingsPend).forEach(function (id) { if (t - S.pingsPend[id] > 3000) { delete S.pingsPend[id]; S.perdidos++; } });
      }
    }, 1000 / hz);
  }

  function send(data) {
    ws.send(data);
    S.enviados++;
  }

  function onWsMessage(e) {
    var t = now(), size = typeof e.data === 'string' ? e.data.length : e.data.byteLength;
    S.recibidos++; S.bytes += size; S.winMsgs++; S.winBytes += size;
    if (typeof e.data !== 'string') {
      var u = new Uint8Array(e.data);
      if (u[0] === 0x46) { fftLast = u.subarray(1); S.porTipo.fft = (S.porTipo.fft || 0) + 1; drawFft(); }
      return;
    }
    var m; try { m = JSON.parse(e.data); } catch (err) { return; }
    S.porTipo[m.t] = (S.porTipo[m.t] || 0) + 1;
    if (m.t === 'hub') { logTo($('#wsLog'), 'En el hub: ' + m.clients.join(', ')); return; }
    if (m.t === 'ping' && wsRole === 'recv') { ws.send(JSON.stringify({ t: 'pong', id: m.id, ts: m.ts })); return; }
    if (m.t === 'pong' && wsRole === 'send' && S.pingsPend[m.id]) { S.rtts.push(t - m.ts); delete S.pingsPend[m.id]; return; }
    if (m.t === 'obd') { if (S.lastObd) S.gaps.push(t - S.lastObd); S.lastObd = t; }
  }

  function drawFft() {
    var w = fv.width, h = fv.height, n = fftLast.length, bw = w / n;
    fctx.fillStyle = '#000'; fctx.fillRect(0, 0, w, h);
    fctx.fillStyle = '#33d6ff';
    for (var i = 0; i < n; i++) { var bh = fftLast[i] / 255 * h; fctx.fillRect(i * bw, h - bh, bw - 2, bh); }
  }

  function wsSummary() {
    var dur = (now() - wsStart) / 1000;
    if (wsRole === 'send') {
      return { rol: 'emisor', segundos: r1(dur), hz: +$('#rate').value, enviados: S.enviados,
        rtt_prom_ms: r1(avg(S.rtts)), rtt_p95_ms: r1(pct(S.rtts, 0.95)), rtt_max_ms: r1(S.rtts.length ? Math.max.apply(null, S.rtts) : 0),
        pings_perdidos: S.perdidos };
    }
    return { rol: 'receptor', segundos: r1(dur), recibidos: S.recibidos, msgs_s: S.rate, kb_s: r1(S.bps / 1024),
      por_tipo: S.porTipo, hueco_obd_p95_ms: r1(pct(S.gaps, 0.95)), hueco_obd_max_ms: r1(S.gaps.length ? Math.max.apply(null, S.gaps) : 0) };
  }

  function updateWsUi() {
    if (!S) return;
    var t = now(), dt = (t - S.winT) / 1000;
    if (dt >= 1) { S.rate = Math.round(S.winMsgs / dt); S.bps = S.winBytes / dt; S.winMsgs = 0; S.winBytes = 0; S.winT = t; }
    var s = wsSummary();
    var view = wsRole === 'send'
      ? { 'Enviados': s.enviados, 'RTT prom (ms)': s.rtt_prom_ms, 'RTT p95 (ms)': s.rtt_p95_ms, 'RTT máx (ms)': s.rtt_max_ms, 'Pings perdidos': s.pings_perdidos }
      : { 'Mensajes/s': s.msgs_s, 'KB/s': s.kb_s, 'Recibidos': s.recibidos, 'Hueco OBD p95 (ms)': s.hueco_obd_p95_ms, 'Hueco OBD máx (ms)': s.hueco_obd_max_ms };
    $('#wsStats').innerHTML = statsHtml(view);
  }

  function wsCleanup() {
    if (S && wsStart) {
      report.wifi = report.wifi || {};
      report.wifi[wsRole === 'send' ? 'emisor' : 'receptor'] = wsSummary();
    }
    clearInterval(wsTimer); clearInterval(wsUi); wsTimer = wsUi = null;
    if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} }
    ws = null; wsStart = 0;
    $('#wsSend').disabled = $('#wsRecv').disabled = false; $('#wsStop').disabled = true;
  }

  $('#wsSend').addEventListener('click', function () { wsOpen('send'); });
  $('#wsRecv').addEventListener('click', function () { wsOpen('recv'); });
  $('#wsStop').addEventListener('click', function () { updateWsUi(); wsCleanup(); logTo($('#wsLog'), 'Detenido. Resultado guardado en el reporte.'); });

  // ---------- Bluetooth LE (Nordic UART) ----------
  var NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  var NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // estéreo -> teléfono (write)
  var NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // teléfono -> estéreo (notify)
  var bleDev = null, bleRx = null, bleTx = null, B = null, bleUi = null;
  var dec = new TextDecoder(), enc = new TextEncoder();

  function bleLog(m) { logTo($('#bleLog'), m); }

  function bleConnect() {
    if (!navigator.bluetooth) { bleLog('Este navegador no tiene Web Bluetooth.'); return; }
    if (!window.isSecureContext) { bleLog('Web Bluetooth necesita contexto seguro: abre la página desde http://localhost:8080 (hub en el estéreo).'); return; }
    B = { notifs: 0, bytes: 0, gaps: [], last: 0, winN: 0, winB: 0, winT: now(), rate: 0, bps: 0, start: now(), rtts: [] };
    navigator.bluetooth.requestDevice({ filters: [{ services: [NUS] }], optionalServices: [NUS] })
      .catch(function () {
        bleLog('Sin dispositivos anunciando NUS; mostrando todos…');
        return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [NUS] });
      })
      .then(function (dev) {
        bleDev = dev;
        bleLog('Conectando a ' + (dev.name || dev.id) + '…');
        dev.addEventListener('gattserverdisconnected', function () { bleLog('Desconectado.'); bleCleanup(); });
        return dev.gatt.connect();
      })
      .then(function (srv) { return srv.getPrimaryService(NUS); })
      .then(function (svc) {
        return Promise.all([svc.getCharacteristic(NUS_RX), svc.getCharacteristic(NUS_TX)]);
      })
      .then(function (chs) {
        bleRx = chs[0]; bleTx = chs[1];
        bleTx.addEventListener('characteristicvaluechanged', onBle);
        return bleTx.startNotifications();
      })
      .then(function () {
        bleLog('Conectado. Esperando datos del teléfono…');
        $('#bleConn').disabled = true; $('#blePing').disabled = $('#bleStop').disabled = false;
        bleUi = setInterval(updateBleUi, 500);
      })
      .catch(function (e) { bleLog('Error: ' + e.message); });
  }

  function onBle(e) {
    var t = now(), dv = e.target.value, size = dv.byteLength;
    B.notifs++; B.bytes += size; B.winN++; B.winB += size;
    if (B.last) B.gaps.push(t - B.last); B.last = t;
    var text = dec.decode(dv);
    // Protocolo de prueba de la app BLE: "P<id>" -> respondemos "Q<id>" para que el teléfono mida el RTT.
    if (text.charAt(0) === 'P' && bleRx) { bleWrite('Q' + text.slice(1)); return; }
    if (B.notifs <= 20 || B.notifs % 50 === 0) bleLog('Recibido (' + size + ' B): ' + text.slice(0, 80));
  }

  function bleWrite(text) {
    var data = enc.encode(text);
    var p = bleRx.writeValueWithoutResponse ? bleRx.writeValueWithoutResponse(data) : bleRx.writeValue(data);
    return p.catch(function () { return bleRx.writeValue(data); });
  }

  function bleSummary() {
    return { dispositivo: bleDev ? (bleDev.name || '?') : '?', segundos: r1((now() - B.start) / 1000), notificaciones: B.notifs,
      notif_s: B.rate, kb_s: r1(B.bps / 1024), hueco_p95_ms: r1(pct(B.gaps, 0.95)), hueco_max_ms: r1(B.gaps.length ? Math.max.apply(null, B.gaps) : 0) };
  }

  function updateBleUi() {
    var t = now(), dt = (t - B.winT) / 1000;
    if (dt >= 1) { B.rate = Math.round(B.winN / dt); B.bps = B.winB / dt; B.winN = 0; B.winB = 0; B.winT = t; }
    var s = bleSummary();
    $('#bleStats').innerHTML = statsHtml({ 'Notificaciones': s.notificaciones, 'Notif/s': s.notif_s, 'KB/s': s.kb_s, 'Hueco p95 (ms)': s.hueco_p95_ms, 'Hueco máx (ms)': s.hueco_max_ms });
  }

  function bleCleanup() {
    if (B && B.notifs) report.ble = bleSummary();
    else if (bleDev) report.ble = { dispositivo: bleDev.name || '?', conectado: true, notificaciones: 0 };
    clearInterval(bleUi); bleUi = null;
    try { if (bleDev && bleDev.gatt.connected) bleDev.gatt.disconnect(); } catch (e) {}
    bleDev = bleRx = bleTx = null;
    $('#bleConn').disabled = false; $('#blePing').disabled = $('#bleStop').disabled = true;
  }

  $('#bleConn').addEventListener('click', bleConnect);
  $('#blePing').addEventListener('click', function () { bleWrite('hola').then(function () { bleLog('Enviado "hola".'); }, function (e) { bleLog('Error al enviar: ' + e.message); }); });
  $('#bleStop').addEventListener('click', function () { if (B) updateBleUi(); bleCleanup(); bleLog('Desconectado. Resultado guardado en el reporte.'); });

  // ---------- Teclas del volante ----------
  var keyLines = [];
  function onKey(e) {
    var line = e.type + '  key=' + e.key + '  code=' + e.code + '  keyCode=' + e.keyCode;
    keyLines.unshift(line); keyLines = keyLines.slice(0, 40);
    $('#keyLog').textContent = keyLines.join('\n');
    if (e.type === 'keydown' && report.teclas.indexOf(e.key + '/' + e.keyCode) < 0) report.teclas.push(e.key + '/' + e.keyCode);
  }
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  // Algunos estéreos mandan los botones del volante como acciones de medios.
  if ('mediaSession' in navigator) {
    ['play', 'pause', 'previoustrack', 'nexttrack'].forEach(function (a) {
      try {
        navigator.mediaSession.setActionHandler(a, function () {
          keyLines.unshift('mediaSession: ' + a); $('#keyLog').textContent = keyLines.join('\n');
          if (report.teclas.indexOf('media:' + a) < 0) report.teclas.push('media:' + a);
        });
      } catch (e) {}
    });
  }

  // ---------- Reporte ----------
  function renderReport() {
    if (ws && S) { report.wifi = report.wifi || {}; report.wifi[wsRole === 'send' ? 'emisor' : 'receptor'] = wsSummary(); }
    if (bleUi && B) report.ble = bleSummary();
    $('#repText').value = JSON.stringify(report, null, 2);
  }
  $('#refreshRep').addEventListener('click', renderReport);
  $('#copyRep').addEventListener('click', function () {
    renderReport();
    var ta = $('#repText');
    var done = function () { $('#copyRep').textContent = 'Copiado ✓'; setTimeout(function () { $('#copyRep').textContent = 'Copiar reporte'; }, 1500); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(ta.value).then(done, function () { ta.select(); document.execCommand('copy'); done(); });
    else { ta.select(); document.execCommand('copy'); done(); }
  });
})();
