const { promises: fs } = require('node:fs');
const { inspectPcmWav } = require('./mute-audio');

async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) throw new Error('WAV truncado durante la verificación.');
    offset += bytesRead;
  }
  return buffer;
}

async function verifyMute(sourcePath, outputPath, report) {
  const [source, output] = await Promise.all([fs.open(sourcePath, 'r'), fs.open(outputPath, 'r')]);
  try {
    const [a, b] = await Promise.all([inspectPcmWav(source), inspectPcmWav(output)]);
    if (a.size !== b.size || a.sampleCount !== b.sampleCount || a.data.offset !== b.data.offset ||
        a.data.bytes !== b.data.bytes || a.codec !== b.codec || a.channels !== b.channels ||
        a.sampleRateHz !== b.sampleRateHz || a.bitsPerSample !== b.bitsPerSample) {
      throw new Error('El WAV de salida difiere en tamaño, muestras o formato.');
    }
    const intervals = report.intervals;
    const fade = Math.round(report.parameters.fadeMs * a.sampleRateHz / 1000);
    const dataStart = a.data.offset;
    const dataEnd = dataStart + a.data.bytes;
    const allowed = intervals.map(item => ({
      start: dataStart + Math.max(0, item.startSample - fade) * a.blockAlign,
      end: dataStart + Math.min(a.sampleCount, item.endSample + fade) * a.blockAlign,
    }));
    const silenced = intervals.map(item => ({
      start: dataStart + item.startSample * a.blockAlign,
      end: dataStart + item.endSample * a.blockAlign,
    }));
    const blockSize = 1024 * 1024;
    let unchangedBytesChecked = 0;
    let zeroBytesChecked = 0;
    for (let position = 0; position < a.size; position += blockSize) {
      const length = Math.min(blockSize, a.size - position);
      const [left, right] = await Promise.all([
        readExact(source, length, position), readExact(output, length, position),
      ]);
      let cursor = position;
      for (const interval of allowed) {
        if (interval.end <= cursor || interval.start >= position + length) continue;
        const end = Math.min(interval.start, position + length);
        if (end > cursor) {
          if (!left.subarray(cursor - position, end - position)
            .equals(right.subarray(cursor - position, end - position))) {
            throw new Error(`Cambio fuera de MUTE/fundido en byte ${cursor}.`);
          }
          unchangedBytesChecked += end - cursor;
        }
        cursor = Math.max(cursor, Math.min(interval.end, position + length));
      }
      if (cursor < position + length) {
        if (!left.subarray(cursor - position).equals(right.subarray(cursor - position))) {
          throw new Error(`Cambio fuera de MUTE/fundido en byte ${cursor}.`);
        }
        unchangedBytesChecked += position + length - cursor;
      }
      for (const interval of silenced) {
        const start = Math.max(interval.start, position);
        const end = Math.min(interval.end, position + length);
        if (end <= start) continue;
        const bytes = right.subarray(start - position, end - position);
        if (bytes.some(value => value !== 0)) throw new Error(`MUTE no es silencio digital en byte ${start}.`);
        zeroBytesChecked += bytes.length;
      }
    }
    if (zeroBytesChecked !== report.totalMutedSamples * a.blockAlign) {
      throw new Error('El total de muestras silenciadas no coincide con el informe.');
    }
    return { sampleCount: a.sampleCount, sampleRateHz: a.sampleRateHz,
      channels: a.channels, outsideUnchanged: true, mutedSamplesVerified: report.totalMutedSamples,
      unchangedBytesChecked };
  } finally { await Promise.all([source.close(), output.close()]); }
}

module.exports = { verifyMute };
