// Simulador de ELM327 + ECU de un Renault Clio II 1.6 16V (K4M), protocolo ISO 14230 (KWP fast init).
// Responde a comandos AT y OBD como lo haría el adaptador real, con un modelo simple del motor.

import { hex } from './elm327.js';

// km/h por cada 1000 rpm en cada marcha (aprox. caja JB3 del Clio 1.6 16V)
export const DEFAULT_GEAR_RATIOS = [7.3, 13.2, 19.3, 25.6, 33.0];

// PIDs típicos que reporta una ECU de esa época
const SUPPORTED = ['01', '03', '04', '05', '06', '07', '0B', '0C', '0D', '0E', '0F', '11', '13', '14', '15', '1C'];

function mask(pids, base) {
  let m = 0;
  for (const p of pids) {
    const n = parseInt(p, 16) - base;
    if (n >= 1 && n <= 32) m |= 1 << (32 - n);
  }
  return (m >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

export class Simulator {
  constructor() {
    this.echo = true;
    this.searched = false;
    this.header = '';
    this.auto = true;
    this.requirePhysical = true;
    this.last = performance.now();
    this.time = 0;
    // estado del motor
    this.speed = 0;
    this.rpm = 850;
    this.throttle = 0;
    this.coolant = 28;
    this.iat = 24;
    this.gear = 0;
    this.phase = 'idle';
    this.phaseT = 0;
    this.targetSpeed = 0;
    this.o2 = 0.45;
    this.stft = 0;
    this.ltft = 128 + 6;
    this.dtcs = ['0171', '0130']; // P0171 y P0130 de ejemplo
    this.freeze = { rpm: 2350, speed: 64, coolant: 89, load: 41, map: 48, stft: 18 };
  }

  _step() {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.5);
    this.last = now;
    this.time += dt;
    this.phaseT += dt;

    // Guion de manejo: ralentí -> acelera -> crucero -> frena -> ralentí ...
    switch (this.phase) {
      case 'idle':
        this.targetSpeed = 0;
        if (this.phaseT > 6) this._setPhase('accel', 50 + Math.random() * 70);
        break;
      case 'accel':
        if (this.speed >= this.targetSpeed - 1) this._setPhase('cruise');
        break;
      case 'cruise':
        if (this.phaseT > 8 + Math.random() * 4) {
          Math.random() < 0.5 ? this._setPhase('brake', 0) : this._setPhase('accel', 30 + Math.random() * 100);
        }
        break;
      case 'brake':
        if (this.speed <= 0.5) this._setPhase('idle');
        break;
    }

    // Dinámica longitudinal muy simple
    const err = this.targetSpeed - this.speed;
    let throttle;
    if (this.phase === 'accel') throttle = Math.min(85, 35 + err * 1.2);
    else if (this.phase === 'cruise') throttle = Math.max(8, Math.min(40, 12 + this.speed * 0.15 + err * 2));
    else throttle = 0;
    this.throttle += (throttle - this.throttle) * Math.min(1, dt * 4);

    const accel = this.phase === 'brake' ? -9 : (this.throttle / 100) * (14 - this.speed * 0.05) - 0.6 - this.speed * 0.012;
    this.speed = Math.max(0, this.speed + accel * dt);

    // Selección de marcha
    if (this.speed < 4) this.gear = 0;
    else {
      // aceleraciones fuertes: estira las marchas hasta ~5500-6000 rpm (para probar SPORT)
      const k = this.phase === 'accel' && this.targetSpeed > 95 ? 1.75 : 1;
      const up = [0, 25 * k, 45 * k, 68 * k, 92 * k];
      let g = 1;
      for (let i = 1; i < up.length; i++) if (this.speed > up[i]) g = i + 1;
      this.gear = g;
    }

    let rpm = this.gear === 0 ? 850 + this.throttle * 25 : (this.speed / DEFAULT_GEAR_RATIOS[this.gear - 1]) * 1000;
    rpm = Math.max(780, Math.min(6500, rpm)) + (Math.random() - 0.5) * 25;
    this.rpm += (rpm - this.rpm) * Math.min(1, dt * 6);

    // Térmica: calienta hasta ~90 °C y el ventilador oscila entre 88-97
    const targetTemp = this.coolant > 96 ? 88 : 97;
    this.coolant += (targetTemp - this.coolant) * dt * (this.coolant < 80 ? 0.05 : 0.02);
    this.iat += ((this.speed > 20 ? 26 : 38) - this.iat) * dt * 0.02;

    // Sonda O2 oscilando en lazo cerrado
    this.o2 = this.coolant > 60 ? 0.45 + 0.4 * Math.sin(this.time * 6) + (Math.random() - 0.5) * 0.08 : 0.45;
    this.stft = Math.round(128 + Math.sin(this.time * 1.7) * 6 + (Math.random() - 0.5) * 4);
  }

  _setPhase(p, target) {
    this.phase = p;
    this.phaseT = 0;
    if (target !== undefined) this.targetSpeed = target;
  }

  get load() {
    return Math.min(100, 18 + this.throttle * 0.8);
  }

  get map() {
    if (this.phase === 'brake' && this.gear > 0) return 22;
    return Math.min(100, 30 + this.throttle * 0.75);
  }

  _pid(pid) {
    const rpm = Math.round(this.rpm * 4);
    switch (pid) {
      case '00': return mask(SUPPORTED, 0x00);
      case '01': return hex(this.dtcs.length ? 0x80 | this.dtcs.length : 0) + '076500';
      case '03': return hex(this.coolant < 50 ? 1 : this.phase === 'brake' && this.gear > 0 ? 4 : 2) + '00';
      case '04': return hex(Math.round((this.load * 255) / 100));
      case '05': return hex(Math.round(this.coolant + 40));
      case '06': return hex(this.stft);
      case '07': return hex(this.ltft);
      case '0B': return hex(Math.round(this.map));
      case '0C': return hex((rpm >> 8) & 0xff) + hex(rpm & 0xff);
      case '0D': return hex(Math.round(this.speed));
      case '0E': return hex(Math.round((12 + this.rpm / 300 - this.load * 0.08 + 64) * 2));
      case '0F': return hex(Math.round(this.iat + 40));
      case '11': return hex(Math.round(((6 + this.throttle * 0.9) * 255) / 100));
      case '13': return '03';
      case '14': return hex(Math.round(Math.max(0, Math.min(1.27, this.o2)) * 200)) + hex(this.stft);
      case '15': return hex(Math.round((0.65 + Math.sin(this.time * 0.3) * 0.05) * 200)) + 'FF';
      case '1C': return '06';
      default: return null;
    }
  }

  handle(rawCmd) {
    const cmd = rawCmd.replace(/\s/g, '').toUpperCase();
    const delay = 35 + Math.random() * 25; // línea K: ~10-15 respuestas por segundo
    const echo = this.echo ? rawCmd + '\r' : '';
    const out = r => ({ response: echo + r, delay });

    if (cmd === '') return out('');
    if (cmd.startsWith('AT')) {
      const at = cmd.slice(2);
      if (at === 'Z') { this.echo = true; this.searched = false; return { response: echo + '\r\rELM327 v1.5', delay: 600 }; }
      if (at === 'I') return out('ELM327 v1.5');
      if (at === 'E0') { this.echo = false; return { response: rawCmd + '\rOK', delay }; }
      if (at === 'E1') { this.echo = true; return out('OK'); }
      if (at === 'RV') { this._step(); return out((this.rpm > 600 ? 14.1 : 12.5 + Math.random() * 0.1).toFixed(1) + 'V'); }
      if (at.startsWith('SH')) { this.header = at.slice(2); return out('OK'); }
      if (at === 'D') { this.header = ''; this.echo = true; return out('OK'); }
      if (at === 'PC') { this.searched = false; return out('OK'); }
      if (at.startsWith('SP')) { this.auto = at === 'SP0'; this.searched = false; return out('OK'); }
      if (at === 'DPN') return out(this.auto ? 'A5' : '5');
      if (at === 'DP') return out('AUTO, ISO 14230-4 (KWP FAST)');
      if (at === '@1') return out('OBDII to RS232 Interpreter');
      return out('OK');
    }

    if (!/^[0-9A-F]+$/.test(cmd)) return out('?');
    // Como muchas ECU Renault de 2002: solo contesta si se le habla directo al motor (ATSH 81 10 F1)
    if (this.requirePhysical && this.header !== '8110F1') {
      return this.auto
        ? { response: echo + 'SEARCHING...\rUNABLE TO CONNECT', delay: 3000 }
        : { response: echo + 'BUS INIT: ...ERROR', delay: 1500 };
    }
    this._step();
    const mode = cmd.slice(0, 2);
    const prefix = !this.searched ? 'SEARCHING...\r' : '';
    const searchDelay = !this.searched ? 1800 : 0;
    this.searched = true;
    const res = r => ({ response: echo + prefix + r, delay: delay + searchDelay });

    if (mode === '01') {
      const pid = cmd.slice(2, 4);
      const data = this._pid(pid);
      return res(data === null ? 'NO DATA' : '41' + pid + data);
    }
    if (mode === '03') {
      const codes = [...this.dtcs];
      const lines = [];
      do {
        const chunk = codes.splice(0, 3);
        while (chunk.length < 3) chunk.push('0000');
        lines.push('43' + chunk.join(''));
      } while (codes.length);
      return res(lines.join('\r'));
    }
    if (mode === '07') return res('47000000000000');
    if (mode === '04') { this.dtcs = []; this.freeze = null; return res('44'); }
    if (mode === '02') {
      const pid = cmd.slice(2, 4);
      if (!this.freeze) return res('NO DATA');
      const f = this.freeze;
      const map = {
        '02': '0171',
        '04': hex(Math.round((f.load * 255) / 100)),
        '05': hex(f.coolant + 40),
        '06': hex(128 + Math.round((f.stft * 128) / 100)),
        '0B': hex(f.map),
        '0C': hex(((f.rpm * 4) >> 8) & 0xff) + hex((f.rpm * 4) & 0xff),
        '0D': hex(f.speed),
      };
      return res(map[pid] ? '42' + pid + '00' + map[pid] : 'NO DATA');
    }
    return res('NO DATA');
  }
}
