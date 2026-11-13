// Driver del ELM327: cola de comandos, inicialización, consultas de PIDs y diagnóstico.

import { decodeDtc } from './dtc.js';

export const PROTOCOLS = {
  '0': 'Automático',
  '1': 'SAE J1850 PWM (41.6 kbaud)',
  '2': 'SAE J1850 VPW (10.4 kbaud)',
  '3': 'ISO 9141-2 (5 baud init)',
  '4': 'ISO 14230-4 KWP (5 baud init)',
  '5': 'ISO 14230-4 KWP (fast init)',
  '6': 'ISO 15765-4 CAN (11 bit, 500 kbaud)',
  '7': 'ISO 15765-4 CAN (29 bit, 500 kbaud)',
  '8': 'ISO 15765-4 CAN (11 bit, 250 kbaud)',
  '9': 'ISO 15765-4 CAN (29 bit, 250 kbaud)',
  'A': 'SAE J1939 CAN',
};

const ERROR_PATTERNS = [
  'NO DATA', 'UNABLE TO CONNECT', 'BUS INIT', 'CAN ERROR', 'BUS ERROR', 'BUS BUSY',
  'STOPPED', 'FB ERROR', 'DATA ERROR', 'BUFFER FULL', 'RX ERROR', 'LV RESET', 'ERR',
];

const delay = ms => new Promise(r => setTimeout(r, ms));

/**
 * Formas de iniciar la comunicación con la ECU, en orden de prueba.
 * Muchas ECU Renault de la época (Sagem S2000 / Siemens Sirius 32, línea K) solo contestan
 * si se les habla "directo" (dirección física 10 = motor) en lugar de con la dirección
 * genérica OBD (33), por eso se incluyen los perfiles con ATSH 81 10 F1.
 */
export const STRATEGIES = [
  { id: 'auto', name: 'Automático', cmds: ['ATSP0'] },
  { id: 'renault-kwp-fast', name: 'Renault KWP2000 directo a motor (rápido)', cmds: ['ATSP5', 'ATSH8110F1', 'ATWM8110F13E', 'ATFI'] },
  { id: 'kwp-fast', name: 'KWP2000 genérico (rápido)', cmds: ['ATSP5', 'ATFI'] },
  { id: 'renault-kwp-slow', name: 'Renault KWP2000 directo a motor (lento)', cmds: ['ATSP4', 'ATIIA10', 'ATSH8110F1', 'ATWM8110F13E', 'ATSI'] },
  { id: 'kwp-slow', name: 'KWP2000 genérico (lento, 5 baud)', cmds: ['ATSP4', 'ATSI'] },
  { id: 'iso9141', name: 'ISO 9141-2', cmds: ['ATSP3', 'ATSI'] },
];

// PIDs que se prueban uno por uno si la ECU no informa cuáles soporta.
const COMMON_PIDS = ['01', '03', '04', '05', '06', '07', '0B', '0C', '0D', '0E', '0F', '10', '11', '13', '14', '15', '1C', '2F', '33', '42'];

export class ElmError extends Error {}

export class ELM327 {
  constructor(transport) {
    this.t = transport;
    this.buf = '';
    this.current = null;
    this.queue = Promise.resolve();
    this.needsFlush = false;
    this.protocol = null;
    this.protocolName = '';
    this.version = '';
    this.isCan = false;
    this.fastMode = false;
    this.supported = new Set();
    this.onTraffic = () => {}; // (dir, text, isPolling)
    transport.onData = s => this._onData(s);
  }

  _onData(chunk) {
    this.buf += chunk;
    const i = this.buf.indexOf('>');
    if (i < 0) return;
    const resp = this.buf.slice(0, i);
    this.buf = this.buf.slice(i + 1);
    if (this.current) {
      const c = this.current;
      this.current = null;
      clearTimeout(c.timer);
      c.resolve(resp);
    }
  }

  /**
   * Envía un comando y devuelve la respuesta limpia (líneas separadas por \n).
   * Los comandos se ejecutan uno a la vez, en orden.
   */
  send(cmd, { timeout = 2500, polling = false } = {}) {
    const run = async () => {
      if (this.needsFlush) {
        // Tras un timeout el ELM puede seguir ocupado: cualquier carácter lo interrumpe.
        // (Un espacio es inofensivo; un \r solo repetiría el último comando.)
        await this.t.write(' ');
        await delay(300);
        this.needsFlush = false;
      }
      this.buf = '';
      const raw = await new Promise((resolve, reject) => {
        this.current = {
          resolve,
          timer: setTimeout(() => {
            this.current = null;
            this.needsFlush = true;
            reject(new ElmError(`Sin respuesta a "${cmd}" (timeout)`));
          }, timeout),
        };
        this.t.write(cmd + '\r').catch(err => {
          clearTimeout(this.current?.timer);
          this.current = null;
          reject(err);
        });
      });
      const clean = cleanResponse(raw, cmd);
      this.onTraffic('tx', cmd, polling);
      this.onTraffic('rx', clean, polling);
      return clean;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Configuración base del adaptador (se repite al cambiar de estrategia). */
  async _baseSetup() {
    for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH0']) await this.send(c);
    await this.send(this.fastMode ? 'ATAT2' : 'ATAT1');
  }

  /**
   * Inicializa el adaptador y busca la forma de hablar con la ECU.
   * Prueba varias estrategias (ver STRATEGIES) hasta que una responda a 0100
   * con datos válidos. `preferred` = id de la estrategia que funcionó la vez anterior.
   */
  async init(log = () => {}, preferred = null) {
    log('Reiniciando ELM327 (ATZ)…');
    let r = await this.send('ATZ', { timeout: 5000 }).catch(() => '');
    await delay(300);
    if (!r) r = await this.send('ATZ', { timeout: 5000 });
    this.version = (await this.send('ATI')).trim();
    log(`Adaptador: ${this.version}`);

    const order = [...STRATEGIES].sort((a, b) => (b.id === preferred) - (a.id === preferred));
    const attempts = [];
    for (const st of order) {
      await this.send('ATPC').catch(() => {}); // cerrar protocolo anterior
      await this.send('ATD').catch(() => {});  // valores por defecto (borra encabezados)
      await this._baseSetup();
      log(`Probando: ${st.name}…`);
      for (const c of st.cmds) await this.send(c, { timeout: 8000 }).catch(() => {});
      let resp = '';
      try { resp = await this.send('0100', { timeout: 20000 }); }
      catch (e) { resp = e.message; }
      const bytes = isError(resp) ? null : extractPid(resp, '41', '00');
      attempts.push(`${st.name}: ${resp.replace(/\n/g, ' | ') || '(vacío)'}`);
      if (bytes && bytes.length >= 4) {
        this.strategy = st;
        log(`✔ La ECU respondió con: ${st.name}`);
        const dpn = (await this.send('ATDPN')).trim().replace(/^A/, '');
        this.protocol = dpn;
        this.protocolName = PROTOCOLS[dpn] || (await this.send('ATDP')).trim();
        this.isCan = ['6', '7', '8', '9', 'A'].includes(dpn);
        log(`Protocolo: ${this.protocolName}`);
        log('Leyendo PIDs soportados por la ECU…');
        await this.scanSupported(resp, log);
        log(`${this.supported.size} PIDs soportados.`);
        return;
      }
      log(`  sin respuesta válida: ${resp.replace(/\n/g, ' | ') || '(vacío)'}`);
    }
    this.attempts = attempts;
    throw new ElmError('La ECU no respondió con ningún método. Verifica que el contacto esté en ON (o el motor encendido). ' +
      'Usa "Diagnóstico → Prueba de conexión completa" y envía el reporte.');
  }

  /**
   * Prueba de conexión completa: ejecuta todas las estrategias con encabezados visibles
   * y guarda las respuestas tal cual, para poder diagnosticar qué entiende la ECU.
   */
  async runReport(log = () => {}) {
    const out = [];
    const run = async (cmd, timeout = 6000) => {
      let r;
      try { r = await this.send(cmd, { timeout }); } catch (e) { r = `!! ${e.message}`; }
      out.push(`> ${cmd}\n  ${(r || '(vacío)').replace(/\n/g, '\n  ')}`);
      return r;
    };
    out.push(`# Clio Cluster - prueba de conexión`, `# ${new Date().toISOString()}`, `# ${navigator.userAgent}`, '');
    log('Datos del adaptador…');
    await run('ATZ', 5000);
    for (const c of ['ATE0', 'ATL0', 'ATS1', 'ATI', 'AT@1', 'ATRV']) await run(c);
    for (const st of STRATEGIES) {
      log(`Probando: ${st.name}…`);
      out.push('', `## ${st.name}`);
      await run('ATPC');
      await run('ATD');
      for (const c of ['ATE0', 'ATL0', 'ATS1', 'ATH1']) await run(c);
      for (const c of st.cmds) await run(c, 8000);
      const r = await run('0100', 20000);
      await run('ATDP');
      if (!isError(r)) {
        await run('0101');
        await run('010C');
        await run('0105');
      }
      if (st.id.startsWith('renault')) {
        await run('10C0');  // iniciar sesión de diagnóstico (Renault)
        await run('2180');  // identificación de la ECU (Renault)
      }
    }
    await run('ATPC');
    await run('ATD');
    return out.join('\n');
  }

  async scanSupported(first0100, log = () => {}) {
    this.supported.clear();
    for (const base of [0x00, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0]) {
      const pid = hex(base);
      const bytes = base === 0 && first0100 ? extractPid(first0100, '41', pid) : await this.queryRaw(pid);
      if (!bytes || bytes.length < 4) break;
      const mask = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
      for (let i = 0; i < 32; i++) {
        if (mask & (1 << (31 - i))) this.supported.add(hex(base + i + 1));
      }
      if (!(mask & 1)) break;
    }
    // Si la ECU no reporta su lista (o viene vacía), se prueban uno por uno los PIDs más comunes.
    const real = [...this.supported].filter(p => !['20', '40', '60', '80', 'A0', 'C0', 'E0'].includes(p));
    if (!real.length) {
      log('La ECU no reportó su lista de sensores; probando los más comunes uno por uno…');
      for (const pid of COMMON_PIDS) {
        const b = await this.queryRaw(pid).catch(() => null);
        if (b && b.length) this.supported.add(pid);
      }
    }
  }

  /** Consulta un PID de modo 01 y devuelve sus bytes de datos, o null si no hay datos. */
  async queryRaw(pid, polling = false) {
    const suffix = this.fastMode ? '1' : '';
    const r = await this.send('01' + pid + suffix, { polling });
    if (isError(r)) return null;
    return extractPid(r, '41', pid);
  }

  async readVoltage(polling = false) {
    const r = await this.send('ATRV', { polling });
    const v = parseFloat(r.replace(/[^\d.]/g, ''));
    return Number.isFinite(v) ? v : null;
  }

  async readDtcs(mode = '03') {
    const respMode = hex(parseInt(mode, 16) + 0x40);
    const r = await this.send(mode, { timeout: 6000 });
    if (r.includes('NO DATA')) return [];
    if (isError(r)) throw new ElmError(r);
    const bytes = this._multiFrameBytes(r, respMode, 0, true);
    const codes = [];
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) continue;
      codes.push(decodeDtc(bytes[i], bytes[i + 1]));
    }
    return [...new Set(codes)];
  }

  async clearDtcs() {
    const r = await this.send('04', { timeout: 8000 });
    if (isError(r)) throw new ElmError(r);
    return r.replace(/\s/g, '').includes('44');
  }

  async readFreezeFrame(pid) {
    const r = await this.send('02' + pid + '00');
    if (isError(r)) return null;
    return extractPid(r, '42', pid + '00');
  }

  async readVin() {
    const r = await this.send('0902', { timeout: 5000 });
    if (isError(r)) return null;
    const bytes = this._multiFrameBytes(r, '4902', 1, false);
    const vin = bytes.filter(b => b >= 0x20 && b < 0x7f).map(b => String.fromCharCode(b)).join('').trim();
    return vin.length >= 11 ? vin : null;
  }

  /**
   * Junta los bytes de una respuesta de varias tramas.
   * - Línea K / J1850: cada línea empieza con el byte de respuesta (ej. 43) + datos.
   * - CAN: respuesta ISO-TP con prefijos "0:", "1:", y un byte de conteo inicial.
   */
  _multiFrameBytes(resp, prefix, skipAfterPrefix, canHasCount) {
    const lines = resp.split('\n').map(l => l.replace(/\s/g, '')).filter(Boolean);
    if (this.isCan) {
      const isMulti = lines.some(l => /^[0-9A-F]:/.test(l));
      let data = isMulti
        ? lines.filter(l => l.includes(':')).map(l => l.split(':')[1]).join('')
        : lines.join('');
      const idx = data.indexOf(prefix);
      if (idx < 0) return [];
      data = data.slice(idx + prefix.length);
      let bytes = toBytes(data);
      if (canHasCount) bytes = bytes.slice(1); // byte con la cantidad de DTCs
      return bytes.slice(skipAfterPrefix && !canHasCount ? skipAfterPrefix : 0);
    }
    const out = [];
    for (const l of lines) {
      if (!l.startsWith(prefix)) continue;
      out.push(...toBytes(l.slice(prefix.length)).slice(skipAfterPrefix));
    }
    return out;
  }
}

// ---------- utilidades ----------

export function hex(n) {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

function toBytes(hexStr) {
  const out = [];
  for (let i = 0; i + 1 < hexStr.length; i += 2) {
    const b = parseInt(hexStr.substr(i, 2), 16);
    if (Number.isNaN(b)) break;
    out.push(b);
  }
  return out;
}

export function isError(resp) {
  const r = resp.toUpperCase();
  if (r.trim() === '?' || r.trim() === '') return true;
  return ERROR_PATTERNS.some(e => r.includes(e)) && !/^[0-9A-F\s\n]+$/.test(r);
}

function cleanResponse(raw, cmd) {
  const cmdNorm = cmd.replace(/\s/g, '').toUpperCase();
  return raw
    .replace(/\r/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && l.replace(/\s/g, '').toUpperCase() !== cmdNorm)
    .map(l => l.replace(/^SEARCHING\.\.\.\s*/i, '').replace(/^BUS INIT:\s*\.*\s*OK\s*/i, ''))
    .filter(l => l && l.toUpperCase() !== 'SEARCHING...')
    .join('\n');
}

/** Busca la línea con la respuesta (ej. "410C...") y devuelve los bytes posteriores. */
function extractPid(resp, mode, pid) {
  const prefix = mode + pid;
  for (const line of resp.split('\n')) {
    let l = line.replace(/\s/g, '').toUpperCase();
    if (/^[0-9A-F]:/.test(l)) l = l.slice(2);
    if (!/^[0-9A-F]+$/.test(l)) continue;
    // Sin encabezados la respuesta empieza con "41xx". Si el adaptador ignora ATH0,
    // viene precedida de 3 bytes de encabezado (ej. "83F110" en línea K) o de un ID CAN.
    const idx = l.indexOf(prefix);
    // (idx 5 = ID CAN de 3 dígitos + byte de longitud, ej. "7E8 06 41 00 ...")
    if (idx >= 0 && idx <= 10 && (idx % 2 === 0 || idx === 5)) return toBytes(l.slice(idx + prefix.length));
  }
  return null;
}
