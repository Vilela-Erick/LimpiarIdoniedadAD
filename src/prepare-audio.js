const { execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, promises: fs } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { probeAudio } = require('./probe-audio');

const execFileAsync = promisify(execFile);
const defaultOutputDir = path.join(__dirname, '..', 'output', 'prepared');

class PrepareError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'PrepareError';
    this.code = code;
  }
}

function selectStream(probe, streamIndex) {
  const streams = probe.audio.streams;
  if (streamIndex === undefined) {
    if (streams.length !== 1) {
      throw new PrepareError('STREAM_SELECTION_REQUIRED',
        `Hay ${streams.length} pistas de audio; indique --stream-index (${streams.map((s) => s.index).join(', ')}).`);
    }
    return streams[0];
  }
  const selected = streams.find((stream) => stream.index === streamIndex);
  if (!selected) throw new PrepareError('INVALID_STREAM_INDEX', `El stream ${streamIndex} no es una pista de audio válida.`);
  return selected;
}

async function runFfprobe(file, entries, ffprobePath, run) {
  let stdout;
  try {
    ({ stdout } = await run(ffprobePath,
      ['-v', 'error', '-show_entries', entries, '-of', 'json', file],
      { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 30000 }));
  } catch (error) {
    const code = error.code === 'ENOENT' ? 'FFPROBE_UNAVAILABLE' : 'FFPROBE_FAILED';
    throw new PrepareError(code, 'ffprobe no pudo inspeccionar la información temporal.', error);
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new PrepareError('INVALID_PROBE_OUTPUT', 'ffprobe devolvió JSON inválido.', error);
  }
}

function startMs(value) {
  if (value === undefined || value === null || value === 'N/A' || value === '') return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

async function inspectTiming(file, index, ffprobePath, run) {
  const data = await runFfprobe(file, 'format=start_time:stream=index,start_time,codec_type', ffprobePath, run);
  const stream = data.streams?.find((item) => item.index === index && item.codec_type === 'audio');
  if (!stream) throw new PrepareError('INVALID_PROBE_OUTPUT', 'ffprobe no devolvió la pista seleccionada para medir su inicio.');
  const formatStartMs = startMs(data.format?.start_time);
  const streamStartMs = startMs(stream.start_time);
  const offsetMs = formatStartMs !== null && streamStartMs !== null
    ? streamStartMs - formatStartMs : null;
  if (offsetMs !== null && offsetMs !== 0) {
    throw new PrepareError('UNSUPPORTED_OFFSET', `La pista comienza ${offsetMs} ms después del inicio del contenedor; no se preparará sin una política de alineación.`);
  }
  if (offsetMs === null && (formatStartMs !== null && formatStartMs !== 0 ||
    streamStartMs !== null && streamStartMs !== 0)) {
    throw new PrepareError('UNSUPPORTED_OFFSET', 'Hay un tiempo de inicio no nulo sin datos suficientes para alinearlo.');
  }
  return { formatStartMs, streamStartMs, offsetMs,
    syncStatus: offsetMs === 0 ? 'aligned' : 'unverified' };
}

async function hashSource(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function inspectPrepared(file, expected, ffprobePath, run) {
  const data = await runFfprobe(file,
    'stream=index,codec_name,sample_rate,channels,duration_ts,time_base', ffprobePath, run);
  const stream = data.streams?.[0];
  const sampleCount = Number(stream?.duration_ts);
  const timeBase = stream?.time_base;
  if (!stream || data.streams.length !== 1 || stream.codec_name !== 'pcm_f32le' ||
      Number(stream.sample_rate) !== expected.sampleRateHz ||
      Number(stream.channels) !== expected.channels ||
      !Number.isSafeInteger(sampleCount) || sampleCount < 0 ||
      timeBase !== `1/${expected.sampleRateHz}`) {
    throw new PrepareError('INVALID_PREPARED_WAV', 'No se pudieron validar el WAV PCM y su número de muestras.');
  }
  return { sampleCount, durationMs: Math.round(sampleCount * 1000 / expected.sampleRateHz) };
}

async function prepareAudio(inputPath, options = {}) {
  const probe = await (options.probe ?? probeAudio)(inputPath, { ffprobePath: options.ffprobePath });
  const selected = selectStream(probe, options.streamIndex);
  const ffprobePath = options.ffprobePath ?? 'ffprobe';
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const runFfprobeCommand = options.runFfprobe ?? execFileAsync;
  const runFfmpegCommand = options.runFfmpeg ?? execFileAsync;
  const timing = await inspectTiming(probe.source.path, selected.index, ffprobePath, runFfprobeCommand);

  const initialStat = await fs.stat(probe.source.path);
  const sourceHash = await hashSource(probe.source.path);
  const outputDir = path.resolve(options.outputDir ?? defaultOutputDir);
  const identity = createHash('sha256').update(JSON.stringify([
    probe.source.path, sourceHash, selected.index, 'pcm_f32le:v1',
  ])).digest('hex').slice(0, 24);
  const name = `${path.parse(probe.source.path).name.slice(0, 48)}--${identity}`;
  const wavPath = path.join(outputDir, `${name}.wav`);
  const metadataPath = path.join(outputDir, `${name}.json`);
  await fs.mkdir(outputDir, { recursive: true });
  if (await fs.access(wavPath).then(() => true, () => false) ||
      await fs.access(metadataPath).then(() => true, () => false)) {
    throw new PrepareError('OUTPUT_EXISTS', 'El resultado ya existe; no se sobrescribirá.');
  }

  const tempWav = path.join(outputDir, `.${randomUUID()}.wav`);
  const tempMetadata = path.join(outputDir, `.${randomUUID()}.json`);
  let linkedWav = false;
  let linkedMetadata = false;
  try {
    try {
      await runFfmpegCommand(ffmpegPath, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-n',
        '-i', probe.source.path, '-map', `0:${selected.index}`,
        '-vn', '-sn', '-dn', '-c:a', 'pcm_f32le', '-rf64', 'auto',
        '-f', 'wav', tempWav,
      ], { windowsHide: true, maxBuffer: 256 * 1024, timeout: 30 * 60 * 1000 });
    } catch (error) {
      const code = error.code === 'ENOENT' ? 'FFMPEG_UNAVAILABLE' : 'FFMPEG_FAILED';
      throw new PrepareError(code, 'FFmpeg no pudo decodificar la pista seleccionada.', error);
    }

    const preparedInfo = await inspectPrepared(tempWav, selected, ffprobePath, runFfprobeCommand);
    const [outputStat, finalSourceStat] = await Promise.all([fs.stat(tempWav), fs.stat(probe.source.path)]);
    if (initialStat.size !== finalSourceStat.size || initialStat.mtimeMs !== finalSourceStat.mtimeMs) {
      throw new PrepareError('SOURCE_CHANGED', 'El archivo original cambió durante la preparación.');
    }
    const durationDifferenceMs = selected.durationMs === null ? null :
      preparedInfo.durationMs - selected.durationMs;
    const warnings = [];
    if (timing.syncStatus === 'unverified') warnings.push('ffprobe no informó ambos tiempos de inicio; la alineación exacta no está verificada.');
    if (durationDifferenceMs !== null && durationDifferenceMs !== 0) {
      warnings.push('La duración decodificada difiere de la duración declarada por la pista; puede deberse a padding o metadatos del códec.');
    }
    const result = {
      schemaVersion: '1.0',
      source: probe.source,
      audio: { selectedStreamIndex: selected.index, sourceCodec: selected.codec,
        sampleRateHz: selected.sampleRateHz, channels: selected.channels },
      timeline: { ...probe.timeline, ...timing, preparedDurationMs: preparedInfo.durationMs,
        durationDifferenceMs },
      prepared: { path: wavPath, metadataPath, container: 'wav', codec: 'pcm_f32le',
        sampleFormat: 'f32le', sampleRateHz: selected.sampleRateHz, channels: selected.channels,
        sampleCount: preparedInfo.sampleCount, durationMs: preparedInfo.durationMs,
        sizeBytes: outputStat.size },
      warnings,
    };
    await fs.writeFile(tempMetadata, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    await fs.link(tempWav, wavPath);
    linkedWav = true;
    await fs.link(tempMetadata, metadataPath);
    linkedMetadata = true;
    return result;
  } catch (error) {
    if (linkedMetadata) await fs.rm(metadataPath, { force: true });
    if (linkedWav) await fs.rm(wavPath, { force: true });
    if (error.code === 'EEXIST') throw new PrepareError('OUTPUT_EXISTS', 'El resultado ya existe; no se sobrescribirá.', error);
    throw error;
  } finally {
    await Promise.all([fs.rm(tempWav, { force: true }), fs.rm(tempMetadata, { force: true })]);
  }
}

module.exports = { prepareAudio, PrepareError, selectStream, inspectPrepared };
