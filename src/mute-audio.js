const { randomUUID } = require('node:crypto');
const { promises: fs } = require('node:fs');
const path = require('node:path');

class MuteError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function readAt(handle, length, position) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new MuteError('INVALID_WAV', 'WAV truncado.');
  return buffer;
}

async function inspectPcmWav(handle) {
  const size = (await handle.stat()).size;
  if (size < 44) throw new MuteError('INVALID_WAV', 'WAV demasiado corto.');
  const riff = await readAt(handle, 12, 0);
  if (riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE') {
    throw new MuteError('UNSUPPORTED_WAV', 'Se requiere RIFF/WAVE PCM.');
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= size) {
    const chunk = await readAt(handle, 8, offset);
    const id = chunk.toString('ascii', 0, 4);
    const bytes = chunk.readUInt32LE(4);
    const start = offset + 8;
    if (start + bytes > size) throw new MuteError('INVALID_WAV', 'Chunk WAV fuera de límites.');
    if (id === 'fmt ') {
      if (bytes < 16) throw new MuteError('INVALID_WAV', 'Formato WAV incompleto.');
      const info = await readAt(handle, 16, start);
      format = { codec: info.readUInt16LE(0), channels: info.readUInt16LE(2),
        sampleRateHz: info.readUInt32LE(4), blockAlign: info.readUInt16LE(12),
        bitsPerSample: info.readUInt16LE(14) };
    }
    if (id === 'data') data = { offset: start, bytes };
    offset = start + bytes + bytes % 2;
  }
  if (!format || !data || !format.sampleRateHz || !format.channels ||
      !((format.codec === 1 && format.bitsPerSample === 16) ||
        (format.codec === 3 && format.bitsPerSample === 32)) ||
      format.blockAlign !== format.channels * format.bitsPerSample / 8 ||
      data.bytes % format.blockAlign !== 0) {
    throw new MuteError('UNSUPPORTED_WAV', 'Se requiere WAV PCM s16le o f32le con datos completos.');
  }
  return { ...format, data, sampleCount: data.bytes / format.blockAlign, size };
}

function planMuteIntervals(actions, sampleRateHz, sampleCount, options = {}) {
  const marginMs = options.marginMs ?? 80;
  const fadeMs = options.fadeMs ?? 5;
  if (![marginMs, fadeMs].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 1000) ||
      !Array.isArray(actions)) throw new MuteError('INVALID_OPTIONS', 'Márgenes, fundidos o acciones inválidos.');
  const toSample = (ms) => Math.round(ms * sampleRateHz / 1000);
  const intervals = actions.map((action) => {
    if (action.type !== 'mute' || action.approved !== true ||
        !Number.isSafeInteger(action.startMs) || !Number.isSafeInteger(action.endMs) ||
        action.startMs < 0 || action.endMs <= action.startMs ||
        toSample(action.endMs) > sampleCount) {
      throw new MuteError('INVALID_ACTION', 'Solo se aceptan intervalos MUTE aprobados dentro del audio.');
    }
    return { startSample: Math.max(0, toSample(action.startMs - marginMs)),
      endSample: Math.min(sampleCount, toSample(action.endMs + marginMs)) };
  }).sort((a, b) => a.startSample - b.startSample);
  const merged = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval.startSample <= last.endSample) last.endSample = Math.max(last.endSample, interval.endSample);
    else merged.push({ ...interval });
  }
  return { intervals: merged, fadeSamples: toSample(fadeMs), marginMs, fadeMs };
}

async function writeAll(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    if (!bytesWritten) throw new MuteError('WRITE_FAILED', 'No se pudo escribir el WAV.');
    offset += bytesWritten;
  }
}

function gainFor(sample, intervals, index, fadeSamples) {
  const current = intervals[index];
  if (current && sample >= current.startSample && sample < current.endSample) return 0;
  if (!fadeSamples) return 1;
  const next = current && sample < current.startSample ? current : intervals[index + 1];
  const previous = current && sample >= current.endSample ? current : intervals[index - 1];
  let gain = 1;
  if (next && sample < next.startSample && sample >= next.startSample - fadeSamples) {
    gain = Math.min(gain, (next.startSample - sample) / fadeSamples);
  }
  if (previous && sample >= previous.endSample && sample < previous.endSample + fadeSamples) {
    gain = Math.min(gain, (sample - previous.endSample + 1) / fadeSamples);
  }
  return gain;
}

async function renderMute(inputPath, outputPath, actionDocument, options = {}) {
  if (actionDocument?.preserveDuration !== true || !Array.isArray(actionDocument.actions)) {
    throw new MuteError('INVALID_ACTIONS', 'Se requiere un documento de acciones con preserveDuration: true.');
  }
  const source = path.resolve(inputPath);
  const target = path.resolve(outputPath);
  if (source.toLowerCase() === target.toLowerCase()) throw new MuteError('SOURCE_DESTINATION_SAME', 'La salida no puede ser el original.');
  const input = await fs.open(source, 'r');
  let temp;
  let published = false;
  try {
    const info = await inspectPcmWav(input);
    const plan = planMuteIntervals(actionDocument.actions, info.sampleRateHz, info.sampleCount, options);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (await fs.access(target).then(() => true, () => false) ||
        await fs.access(`${target}.json`).then(() => true, () => false)) {
      throw new MuteError('OUTPUT_EXISTS', 'La salida o su informe ya existen.');
    }
    temp = path.join(path.dirname(target), `.${randomUUID()}.wav`);
    const output = await fs.open(temp, 'wx');
    try {
      const blockBytes = Math.max(info.blockAlign, Math.floor(65536 / info.blockAlign) * info.blockAlign);
      let intervalIndex = 0;
      for (let position = 0; position < info.size;) {
        const dataEnd = info.data.offset + info.data.bytes;
        const length = position < info.data.offset ? Math.min(blockBytes, info.data.offset - position) :
          position < dataEnd ? Math.min(blockBytes, dataEnd - position) :
            Math.min(blockBytes, info.size - position);
        const buffer = await readAt(input, length, position);
        for (let frameOffset = position < info.data.offset || position >= dataEnd ? position + length : position;
          frameOffset + info.blockAlign <= position + length; frameOffset += info.blockAlign) {
          const sample = (frameOffset - info.data.offset) / info.blockAlign;
          while (intervalIndex < plan.intervals.length && sample >= plan.intervals[intervalIndex].endSample) intervalIndex++;
          const gain = gainFor(sample, plan.intervals, intervalIndex, plan.fadeSamples);
          if (gain === 1) continue;
          for (let channel = 0; channel < info.channels; channel++) {
            const at = frameOffset - position + channel * info.bitsPerSample / 8;
            if (info.codec === 1) buffer.writeInt16LE(gain === 0 ? 0 :
              Math.round(buffer.readInt16LE(at) * gain), at);
            else buffer.writeFloatLE(gain === 0 ? 0 : buffer.readFloatLE(at) * gain, at);
          }
        }
        await writeAll(output, buffer, position);
        position += length;
      }
    } finally { await output.close(); }
    const check = await fs.open(temp, 'r');
    try {
      const result = await inspectPcmWav(check);
      if (result.sampleCount !== info.sampleCount || result.size !== info.size) {
        throw new MuteError('LENGTH_MISMATCH', 'La salida cambió de tamaño o de muestras.');
      }
    } finally { await check.close(); }
    const report = { schemaVersion: '1.0', source: { path: source, sampleCount: info.sampleCount,
      sampleRateHz: info.sampleRateHz, channels: info.channels },
    output: { path: target, sampleCount: info.sampleCount, sampleRateHz: info.sampleRateHz,
      channels: info.channels }, parameters: { marginMs: plan.marginMs, fadeMs: plan.fadeMs },
    actions: actionDocument.actions, intervals: plan.intervals,
    provenance: options.provenance ?? null,
    totalMutedSamples: plan.intervals.reduce((sum, item) => sum + item.endSample - item.startSample, 0),
    warnings: ['El MUTE conserva muestras; la idoneidad publicitaria requiere revisión contextual.'] };
    report.totalMutedMs = Math.round(report.totalMutedSamples * 1000 / info.sampleRateHz);
    const tempReport = path.join(path.dirname(target), `.${randomUUID()}.json`);
    try {
      await fs.writeFile(tempReport, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
      await fs.link(temp, target);
      published = true;
      await fs.link(tempReport, `${target}.json`);
    } catch (error) {
      if (published) await fs.rm(target, { force: true });
      throw error;
    } finally { await fs.rm(tempReport, { force: true }); }
    return report;
  } finally {
    await input.close();
    if (temp) await fs.rm(temp, { force: true });
  }
}

module.exports = { inspectPcmWav, planMuteIntervals, renderMute, MuteError };
