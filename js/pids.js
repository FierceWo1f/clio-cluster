// Definiciones de PIDs OBD-II (modo 01) y sus fórmulas de decodificación.
// Cada decoder recibe el arreglo de bytes de datos [A, B, C, D, ...].

const pct = b => (b[0] * 100) / 255;
const temp = b => b[0] - 40;
const trim = b => ((b[0] - 128) * 100) / 128;
const u16 = b => b[0] * 256 + b[1];

const FUEL_SYSTEM = {
  0: 'Apagado',
  1: 'Lazo abierto (motor frío)',
  2: 'Lazo cerrado (sonda O2)',
  4: 'Lazo abierto (desaceleración / corte)',
  8: 'Lazo abierto (falla del sistema)',
  16: 'Lazo cerrado (falla en sonda)',
};

const OBD_STD = {
  1: 'OBD-II (CARB)', 2: 'OBD (EPA)', 3: 'OBD y OBD-II', 4: 'OBD-I', 5: 'Sin OBD',
  6: 'EOBD (Europa)', 7: 'EOBD y OBD-II', 8: 'EOBD y OBD', 9: 'EOBD, OBD y OBD-II',
  10: 'JOBD', 11: 'JOBD y OBD-II', 12: 'JOBD y EOBD', 13: 'JOBD, EOBD y OBD-II',
};

const FUEL_TYPE = {
  1: 'Gasolina', 2: 'Metanol', 3: 'Etanol', 4: 'Diésel', 5: 'GLP', 6: 'GNC',
  7: 'Propano', 8: 'Eléctrico', 9: 'Bi-combustible gasolina',
};

function o2(sensor) {
  return {
    name: `Sonda O2 ${sensor} (voltaje)`,
    short: `O2 ${sensor}`,
    unit: 'V', min: 0, max: 1.275, decimals: 3, cat: 'o2',
    decode: b => b[0] / 200,
  };
}

const O2_NAMES = ['B1S1', 'B1S2', 'B1S3', 'B1S4', 'B2S1', 'B2S2', 'B2S3', 'B2S4'];

export const CATEGORIES = {
  motor: 'Motor',
  aire: 'Admisión de aire',
  combustible: 'Combustible',
  o2: 'Sondas lambda (O2)',
  emisiones: 'Emisiones',
  electrico: 'Eléctrico',
  estado: 'Estado / Contadores',
};

export const PIDS = {
  '01': {
    name: 'Estado de monitores / MIL', short: 'MIL', cat: 'estado', text: true,
    decode: b => decodeMonitorStatus(b),
    format: v => `${v.mil ? 'MIL ENCENDIDA' : 'MIL apagada'} · ${v.dtcCount} código(s)`,
  },
  '03': {
    name: 'Estado sistema de combustible', short: 'Sist. comb.', cat: 'combustible', text: true,
    decode: b => b[0],
    format: v => FUEL_SYSTEM[v] ?? `Desconocido (${v})`,
  },
  '04': { name: 'Carga calculada del motor', short: 'Carga', unit: '%', min: 0, max: 100, decimals: 0, cat: 'motor', decode: pct },
  '05': { name: 'Temperatura del refrigerante', short: 'Refrigerante', unit: '°C', min: -40, max: 130, decimals: 0, cat: 'motor', decode: temp },
  '06': { name: 'Corrección corto plazo (STFT) B1', short: 'STFT B1', unit: '%', min: -25, max: 25, decimals: 1, cat: 'combustible', decode: trim },
  '07': { name: 'Corrección largo plazo (LTFT) B1', short: 'LTFT B1', unit: '%', min: -25, max: 25, decimals: 1, cat: 'combustible', decode: trim },
  '08': { name: 'Corrección corto plazo (STFT) B2', short: 'STFT B2', unit: '%', min: -25, max: 25, decimals: 1, cat: 'combustible', decode: trim },
  '09': { name: 'Corrección largo plazo (LTFT) B2', short: 'LTFT B2', unit: '%', min: -25, max: 25, decimals: 1, cat: 'combustible', decode: trim },
  '0A': { name: 'Presión de combustible', short: 'P. comb.', unit: 'kPa', min: 0, max: 765, decimals: 0, cat: 'combustible', decode: b => b[0] * 3 },
  '0B': { name: 'Presión del múltiple (MAP)', short: 'MAP', unit: 'kPa', min: 0, max: 105, decimals: 0, cat: 'aire', decode: b => b[0] },
  '0C': { name: 'Revoluciones del motor', short: 'RPM', unit: 'rpm', min: 0, max: 7000, decimals: 0, cat: 'motor', decode: b => u16(b) / 4 },
  '0D': { name: 'Velocidad del vehículo', short: 'Velocidad', unit: 'km/h', min: 0, max: 220, decimals: 0, cat: 'motor', decode: b => b[0] },
  '0E': { name: 'Avance de encendido', short: 'Avance', unit: '°', min: -10, max: 50, decimals: 1, cat: 'motor', decode: b => b[0] / 2 - 64 },
  '0F': { name: 'Temperatura aire de admisión', short: 'Temp. admisión', unit: '°C', min: -40, max: 80, decimals: 0, cat: 'aire', decode: temp },
  '10': { name: 'Flujo de aire (MAF)', short: 'MAF', unit: 'g/s', min: 0, max: 100, decimals: 2, cat: 'aire', decode: b => u16(b) / 100 },
  '11': { name: 'Posición del acelerador', short: 'Acelerador', unit: '%', min: 0, max: 100, decimals: 0, cat: 'motor', decode: pct },
  '12': {
    name: 'Aire secundario', short: 'Aire sec.', cat: 'emisiones', text: true, decode: b => b[0],
    format: v => ({ 1: 'Antes del catalizador', 2: 'Después del catalizador', 4: 'Desde exterior / apagado', 8: 'Bomba encendida (diagnóstico)' }[v] ?? `Código ${v}`),
  },
  '13': {
    name: 'Sondas O2 presentes', short: 'Sondas O2', cat: 'o2', text: true, decode: b => b[0],
    format: v => O2_NAMES.filter((_, i) => i < 8 && (v >> i) & 1).join(', ') || 'Ninguna',
  },
  '14': o2('B1S1'), '15': o2('B1S2'), '16': o2('B1S3'), '17': o2('B1S4'),
  '18': o2('B2S1'), '19': o2('B2S2'), '1A': o2('B2S3'), '1B': o2('B2S4'),
  '1C': {
    name: 'Norma OBD del vehículo', short: 'Norma OBD', cat: 'estado', text: true, decode: b => b[0],
    format: v => OBD_STD[v] ?? `Código ${v}`,
  },
  '1F': { name: 'Tiempo desde arranque', short: 'T. motor', unit: 's', min: 0, max: 65535, decimals: 0, cat: 'estado', decode: u16 },
  '21': { name: 'Distancia con MIL encendida', short: 'Km con MIL', unit: 'km', min: 0, max: 65535, decimals: 0, cat: 'estado', decode: u16 },
  '22': { name: 'Presión riel (rel. vacío)', short: 'P. riel', unit: 'kPa', min: 0, max: 5177, decimals: 1, cat: 'combustible', decode: b => u16(b) * 0.079 },
  '23': { name: 'Presión riel combustible', short: 'P. riel', unit: 'kPa', min: 0, max: 655350, decimals: 0, cat: 'combustible', decode: b => u16(b) * 10 },
  '2C': { name: 'EGR comandado', short: 'EGR', unit: '%', min: 0, max: 100, decimals: 0, cat: 'emisiones', decode: pct },
  '2D': { name: 'Error EGR', short: 'Error EGR', unit: '%', min: -100, max: 100, decimals: 1, cat: 'emisiones', decode: trim },
  '2E': { name: 'Purga canister (EVAP)', short: 'Purga EVAP', unit: '%', min: 0, max: 100, decimals: 0, cat: 'emisiones', decode: pct },
  '2F': { name: 'Nivel de combustible', short: 'Combustible', unit: '%', min: 0, max: 100, decimals: 0, cat: 'combustible', decode: pct },
  '30': { name: 'Calentamientos desde borrado', short: 'Calentam.', unit: '', min: 0, max: 255, decimals: 0, cat: 'estado', decode: b => b[0] },
  '31': { name: 'Distancia desde borrado de códigos', short: 'Km desde borrado', unit: 'km', min: 0, max: 65535, decimals: 0, cat: 'estado', decode: u16 },
  '33': { name: 'Presión barométrica', short: 'Barométrica', unit: 'kPa', min: 0, max: 110, decimals: 0, cat: 'aire', decode: b => b[0] },
  '3C': { name: 'Temperatura catalizador B1S1', short: 'T. catalizador', unit: '°C', min: 0, max: 1000, decimals: 0, cat: 'emisiones', decode: b => u16(b) / 10 - 40 },
  '42': { name: 'Voltaje módulo de control', short: 'Voltaje ECU', unit: 'V', min: 0, max: 16, decimals: 2, cat: 'electrico', decode: b => u16(b) / 1000 },
  '43': { name: 'Carga absoluta', short: 'Carga abs.', unit: '%', min: 0, max: 100, decimals: 0, cat: 'motor', decode: b => (u16(b) * 100) / 255 },
  '44': { name: 'Lambda comandada', short: 'Lambda', unit: 'λ', min: 0.5, max: 1.5, decimals: 3, cat: 'combustible', decode: b => (u16(b) * 2) / 65536 },
  '45': { name: 'Acelerador relativo', short: 'Acel. rel.', unit: '%', min: 0, max: 100, decimals: 0, cat: 'motor', decode: pct },
  '46': { name: 'Temperatura ambiente', short: 'T. ambiente', unit: '°C', min: -40, max: 60, decimals: 0, cat: 'aire', decode: temp },
  '47': { name: 'Posición acelerador B', short: 'Acel. B', unit: '%', min: 0, max: 100, decimals: 0, cat: 'motor', decode: pct },
  '49': { name: 'Pedal acelerador D', short: 'Pedal D', unit: '%', min: 0, max: 100, decimals: 0, cat: 'motor', decode: pct },
  '4A': { name: 'Pedal acelerador E', short: 'Pedal E', unit: '%', min: 0, max: 100, decimals: 0, cat: 'motor', decode: pct },
  '4C': { name: 'Actuador acelerador comandado', short: 'Act. acel.', unit: '%', min: 0, max: 100, decimals: 0, cat: 'motor', decode: pct },
  '4D': { name: 'Tiempo con MIL encendida', short: 'Min con MIL', unit: 'min', min: 0, max: 65535, decimals: 0, cat: 'estado', decode: u16 },
  '4E': { name: 'Tiempo desde borrado de códigos', short: 'Min desde borrado', unit: 'min', min: 0, max: 65535, decimals: 0, cat: 'estado', decode: u16 },
  '51': {
    name: 'Tipo de combustible', short: 'Combustible', cat: 'estado', text: true, decode: b => b[0],
    format: v => FUEL_TYPE[v] ?? `Código ${v}`,
  },
  '5C': { name: 'Temperatura del aceite', short: 'T. aceite', unit: '°C', min: -40, max: 160, decimals: 0, cat: 'motor', decode: temp },
  '5E': { name: 'Consumo de combustible (ECU)', short: 'Consumo ECU', unit: 'L/h', min: 0, max: 30, decimals: 2, cat: 'combustible', decode: b => u16(b) / 20 },
};

// Valores que no vienen de un PID sino del propio ELM o calculados por la app.
export const VIRTUAL = {
  RV: { name: 'Voltaje batería (ELM)', short: 'Batería', unit: 'V', min: 10, max: 16, decimals: 1, cat: 'electrico' },
  FUEL_LH: { name: 'Consumo instantáneo (estimado)', short: 'Consumo', unit: 'L/h', min: 0, max: 20, decimals: 2, cat: 'combustible' },
  FUEL_L100: { name: 'Consumo por distancia (estimado)', short: 'Consumo', unit: 'L/100km', min: 0, max: 30, decimals: 1, cat: 'combustible' },
  GEAR: { name: 'Marcha estimada', short: 'Marcha', unit: '', cat: 'motor', text: true },
};

export function pidInfo(key) {
  return PIDS[key] || VIRTUAL[key] || { name: key, short: key, unit: '', decimals: 2 };
}

export function formatValue(key, value) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  const info = pidInfo(key);
  if (info.format) return info.format(value);
  if (typeof value !== 'number') return String(value);
  return value.toFixed(info.decimals ?? 1);
}

export function decodeMonitorStatus(b) {
  const [A, B, C, D] = b;
  const spark = ((B >> 3) & 1) === 0;
  const monitors = [];
  const add = (name, availBit, incompleteBit) =>
    monitors.push({ name, available: !!availBit, complete: !incompleteBit });

  add('Detección de fallo de encendido', B & 1, (B >> 4) & 1);
  add('Sistema de combustible', (B >> 1) & 1, (B >> 5) & 1);
  add('Componentes', (B >> 2) & 1, (B >> 6) & 1);

  const names = spark
    ? ['Catalizador', 'Catalizador calefactado', 'Sistema evaporativo (EVAP)', 'Aire secundario', 'Refrigerante A/C', 'Sonda O2', 'Calefactor sonda O2', 'Sistema EGR']
    : ['Catalizador NMHC', 'Catalizador NOx/SCR', '—', 'Presión de sobrealimentación', '—', 'Sensor gases de escape', 'Filtro de partículas', 'EGR / VVT'];
  names.forEach((n, i) => {
    if (n !== '—') add(n, (C >> i) & 1, (D >> i) & 1);
  });

  return { mil: !!(A & 0x80), dtcCount: A & 0x7f, spark, monitors };
}
