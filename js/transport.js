// Capas de transporte. Todas exponen la misma interfaz:
//   connect(), write(text), close(), onData(text), onDisconnect(), label

import { Simulator } from './simulator.js';

const enc = new TextEncoder();
const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';

/**
 * ELM327 Bluetooth clásico (SPP) emparejado en Windows -> aparece como puerto COM.
 * También sirve para ELM327 USB. Usa la API Web Serial (Chrome / Edge).
 */
export class SerialTransport {
  constructor(baudRate = 38400) {
    this.baudRate = baudRate;
    this.label = 'Puerto serie / Bluetooth (COM)';
    this.onData = () => {};
    this.onDisconnect = () => {};
    this._keep = false;
  }

  static supported() {
    return 'serial' in navigator;
  }

  async connect() {
    if (!SerialTransport.supported()) {
      throw new Error('Este navegador no soporta Web Serial. Usa Google Chrome o Microsoft Edge en la PC.');
    }
    // SPP = perfil de puerto serie por Bluetooth clásico (el que usa el ELM327).
    // Necesario para que Chrome en Android muestre el ELM327 emparejado.
    this.port = await navigator.serial.requestPort({ allowedBluetoothServiceClassIds: [SPP_UUID] });
    await this.port.open({ baudRate: this.baudRate, bufferSize: 4096 });
    this.writer = this.port.writable.getWriter();
    this._keep = true;
    this._onPortDisconnect = () => this._lost();
    this.port.addEventListener('disconnect', this._onPortDisconnect);
    this._readLoop();
  }

  async _readLoop() {
    const decoder = new TextDecoder();
    while (this._keep && this.port?.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this.onData(decoder.decode(value, { stream: true }));
        }
      } catch (e) {
        if (this._keep) console.warn('Error de lectura serie', e);
        break;
      } finally {
        try { this.reader.releaseLock(); } catch {}
      }
    }
    if (this._keep) this._lost();
  }

  _lost() {
    if (!this._keep) return;
    this._keep = false;
    this.onDisconnect();
  }

  async write(text) {
    await this.writer.write(enc.encode(text));
  }

  async close() {
    this._keep = false;
    try { this.port?.removeEventListener('disconnect', this._onPortDisconnect); } catch {}
    try { await this.reader?.cancel(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
  }
}

// UUIDs de servicio usados por los ELM327 BLE más comunes (Vgate, Veepeak, clones...)
const BLE_SERVICES = [
  0xfff0, 0xffe0, 0x18f0, 0xffb0, 0xae30,
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '0000fff0-0000-1000-8000-00805f9b34fb',
];

/** ELM327 Bluetooth Low Energy (4.0) mediante Web Bluetooth. */
export class BleTransport {
  constructor() {
    this.label = 'Bluetooth LE';
    this.onData = () => {};
    this.onDisconnect = () => {};
  }

  static supported() {
    return 'bluetooth' in navigator;
  }

  async connect() {
    if (!BleTransport.supported()) {
      throw new Error('Este navegador no soporta Web Bluetooth. Usa Chrome o Edge.');
    }
    this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: BLE_SERVICES,
    });
    this._onGattDisc = () => this.onDisconnect();
    this.device.addEventListener('gattserverdisconnected', this._onGattDisc);
    const server = await this.device.gatt.connect();

    let notifyChar = null;
    let writeChar = null;
    const services = await server.getPrimaryServices();
    for (const svc of services) {
      let chars;
      try { chars = await svc.getCharacteristics(); } catch { continue; }
      let n = null, w = null;
      for (const c of chars) {
        if (!n && (c.properties.notify || c.properties.indicate)) n = c;
        if (!w && (c.properties.write || c.properties.writeWithoutResponse)) w = c;
      }
      if (n && w) { notifyChar = n; writeChar = w; break; }
      notifyChar ||= n; writeChar ||= w;
    }
    if (!notifyChar || !writeChar) {
      throw new Error('No se encontraron características BLE compatibles en este dispositivo. ¿Es un ELM327 BLE?');
    }
    this.writeChar = writeChar;
    const decoder = new TextDecoder();
    notifyChar.addEventListener('characteristicvaluechanged', e => {
      this.onData(decoder.decode(e.target.value));
    });
    await notifyChar.startNotifications();
  }

  async write(text) {
    const data = enc.encode(text);
    const noResp = this.writeChar.properties.writeWithoutResponse;
    for (let i = 0; i < data.length; i += 20) {
      const chunk = data.slice(i, i + 20);
      if (noResp) await this.writeChar.writeValueWithoutResponse(chunk);
      else await this.writeChar.writeValue(chunk);
    }
  }

  async close() {
    try { this.device?.removeEventListener('gattserverdisconnected', this._onGattDisc); } catch {}
    try { this.device?.gatt?.disconnect(); } catch {}
  }
}

/**
 * ELM327 por red (TCP) a través del puente local emulador/puente.py.
 * Sirve para el emulador ELM327-emulator y para adaptadores ELM327 WiFi.
 */
export class NetTransport {
  constructor(host = '127.0.0.1', port = 35000, bridge = 'ws://127.0.0.1:35001') {
    this.host = host;
    this.port = port;
    this.bridge = bridge;
    this.label = `Red ${host}:${port}`;
    this.onData = () => {};
    this.onDisconnect = () => {};
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = `${this.bridge}/?host=${encodeURIComponent(this.host)}&port=${this.port}`;
      let opened = false;
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        // el puente cierra de inmediato si no logra conectar al destino
        setTimeout(() => {
          if (this.ws.readyState === WebSocket.OPEN) { opened = true; resolve(); }
        }, 300);
      };
      this.ws.onmessage = e => this.onData(typeof e.data === 'string' ? e.data : '');
      this.ws.onerror = () => {
        if (!opened) reject(new Error('No se pudo conectar al puente de red. ¿Ejecutaste emulador.bat (o puente.bat)?'));
      };
      this.ws.onclose = e => {
        if (!opened) reject(new Error(e.reason || `No se pudo conectar a ${this.host}:${this.port}. ¿Está corriendo el emulador?`));
        else this.onDisconnect();
      };
    });
  }

  async write(text) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('Conexión de red cerrada');
    this.ws.send(text);
  }

  async close() {
    if (!this.ws) return;
    this.ws.onclose = null;
    try { this.ws.close(); } catch {}
  }
}

/** ECU simulada de un Clio II 1.6 16V: permite desarrollar y probar sin el auto. */
export class SimTransport {
  constructor() {
    this.label = 'Simulador';
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.sim = new Simulator();
    this._line = '';
  }

  async connect() {}

  async write(text) {
    this._line += text;
    let idx;
    while ((idx = this._line.indexOf('\r')) >= 0) {
      const cmd = this._line.slice(0, idx);
      this._line = this._line.slice(idx + 1);
      const { response, delay } = this.sim.handle(cmd);
      setTimeout(() => this.onData(response + '\r\r>'), delay);
    }
  }

  async close() {}
}
