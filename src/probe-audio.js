const { execFile } = require('node:child_process');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

class ProbeError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'ProbeError';
    this.code = code;
  }
}

function durationMs(value) {
  if (value === null || value === undefined || value === '' || value === 'N/A') return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

async function inspectSource(inputPath) {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new ProbeError('INVALID_INPUT', 'La ruta de entrada debe ser una cadena no vacía.');
  }
  const absolutePath = path.resolve(inputPath);
  let handle;
  try {
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) throw new ProbeError('NOT_FILE', 'La ruta de entrada no es un archivo.');
    handle = await fs.open(absolutePath, 'r');
    return { path: absolutePath, sizeBytes: stats.size };
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    if (error.code === 'ENOENT') throw new ProbeError('FILE_NOT_FOUND', 'El archivo de entrada no existe.', error);
    throw new ProbeError('FILE_NOT_READABLE', 'No se puede leer el archivo de entrada.', error);
  } finally {
    if (handle) await handle.close();
  }
}

function decodeProbe(stdout, source) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch (error) {
    throw new ProbeError('INVALID_PROBE_OUTPUT', 'ffprobe devolvió JSON inválido.', error);
  }
  if (!data || !Array.isArray(data.streams)) {
    throw new ProbeError('INVALID_PROBE_OUTPUT', 'ffprobe no devolvió la lista de pistas.');
  }

  const video = data.streams.find((stream) =>
    stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
  if (video) throw new ProbeError('NOT_AUDIO_ONLY', 'El archivo contiene una pista de video.');

  const streams = data.streams
    .filter((stream) => stream.codec_type === 'audio')
    .map((stream) => ({
      index: Number(stream.index),
      codec: stream.codec_name,
      sampleRateHz: positiveInteger(stream.sample_rate),
      channels: positiveInteger(stream.channels),
      durationMs: durationMs(stream.duration),
    }))
    .filter((stream) => Number.isInteger(stream.index) && stream.index >= 0 &&
      typeof stream.codec === 'string' && stream.codec !== '' && stream.codec !== 'unknown' &&
      stream.sampleRateHz !== null && stream.channels !== null);

  if (streams.length === 0) throw new ProbeError('NO_AUDIO_STREAM', 'No se encontró una pista de audio válida.');

  const formatDuration = durationMs(data.format?.duration);
  const streamDurations = streams.map((stream) => stream.durationMs).filter((value) => value !== null);
  const timelineDuration = formatDuration ?? (streamDurations.length ? Math.max(...streamDurations) : null);
  const durationSource = formatDuration !== null ? 'format' :
    streamDurations.length ? 'stream' : 'unknown';

  return {
    schemaVersion: '1.0',
    source,
    audio: {
      streams,
      selectedStreamIndex: streams[0].index,
      multipleStreams: streams.length > 1,
    },
    timeline: { startMs: 0, durationMs: timelineDuration, durationSource },
  };
}

async function probeAudio(inputPath, options = {}) {
  const source = await inspectSource(inputPath);
  const ffprobePath = options.ffprobePath ?? 'ffprobe';
  if (typeof ffprobePath !== 'string' || ffprobePath.trim() === '') {
    throw new ProbeError('INVALID_INPUT', 'La ruta de ffprobe debe ser una cadena no vacía.');
  }
  const run = options.run ?? execFileAsync;
  let stdout;
  try {
    ({ stdout } = await run(ffprobePath, [
      '-v', 'error', '-show_entries',
      'stream=index,codec_type,codec_name,sample_rate,channels,duration:stream_disposition=attached_pic:format=duration',
      '-of', 'json', source.path,
    ], { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 30000 }));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new ProbeError('FFPROBE_UNAVAILABLE', 'No se encontró ffprobe. Use --ffprobe-path para indicar su ruta.', error);
    }
    throw new ProbeError('FFPROBE_FAILED', 'ffprobe no pudo inspeccionar el archivo.', error);
  }
  return decodeProbe(stdout, source);
}

module.exports = { probeAudio, ProbeError };
