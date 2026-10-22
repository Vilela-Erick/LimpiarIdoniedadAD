const { execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { probeAudio } = require('./probe-audio');
const { inspectPrepared, selectStream } = require('./prepare-audio');

const execFileAsync = promisify(execFile);
const outputDirDefault = path.join(__dirname, '..', 'output', 'samples');

class SampleError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.code = code;
  }
}

function parseSampleArgs(args) {
  const options = {};
  const keys = { '--prepared-metadata': 'preparedMetadata', '--input': 'input',
    '--case': 'caseId', '--label': 'label', '--stream-index': 'streamIndex',
    '--start-ms': 'startMs', '--duration-ms': 'durationMs',
    '--ffmpeg-path': 'ffmpegPath', '--ffprobe-path': 'ffprobePath' };
  if (args.length === 1 && args[0] === '--help') return { help: true };
  for (let index = 0; index < args.length; index += 1) {
    const key = keys[args[index]];
    if (!key) throw new SampleError('INVALID_ARGUMENT', `Argumento desconocido: ${args[index]}`);
    const value = args[++index];
    if (!value || value.startsWith('--') || Object.hasOwn(options, key)) {
      throw new SampleError('INVALID_ARGUMENT', `Falta valor o se repitió ${args[index - 1]}.`);
    }
    options[key] = value;
  }
  if (Boolean(options.preparedMetadata) === Boolean(options.input) ||
      Boolean(options.caseId) === Boolean(options.label) ||
      !options.startMs || !options.durationMs) {
    throw new SampleError('INVALID_ARGUMENT', 'Use --prepared-metadata y --case, o --input y --label, además de --start-ms y --duration-ms.');
  }
  if (options.caseId && !/^[A-E]$/.test(options.caseId)) throw new SampleError('INVALID_ARGUMENT', '--case debe ser A, B, C, D o E.');
  if (options.label && !/^[A-Za-z0-9_-]{1,32}$/.test(options.label)) {
    throw new SampleError('INVALID_ARGUMENT', '--label debe tener 1–32 letras, números, guiones o guiones bajos.');
  }
  if (options.streamIndex !== undefined) {
    if (!/^(0|[1-9]\d*)$/.test(options.streamIndex) || !Number.isSafeInteger(Number(options.streamIndex))) {
      throw new SampleError('INVALID_ARGUMENT', '--stream-index debe ser un entero no negativo.');
    }
    options.streamIndex = Number(options.streamIndex);
  }
  if (options.preparedMetadata && options.streamIndex !== undefined) {
    throw new SampleError('INVALID_ARGUMENT', '--stream-index solo se usa con --input.');
  }
  for (const key of ['startMs', 'durationMs']) {
    if (!/^(0|[1-9]\d*)$/.test(options[key]) || !Number.isSafeInteger(Number(options[key]))) {
      throw new SampleError('INVALID_ARGUMENT', `${key} debe ser un entero no negativo en milisegundos.`);
    }
    options[key] = Number(options[key]);
  }
  if (options.durationMs < 15000 || options.durationMs > 30000) {
    throw new SampleError('INVALID_ARGUMENT', 'La duración debe estar entre 15000 y 30000 ms.');
  }
  return options;
}

async function readMetadata(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new SampleError('INVALID_METADATA', 'El archivo de metadatos no es válido.');
  let data;
  try { data = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { throw new SampleError('INVALID_METADATA', 'Los metadatos no son JSON válido.', error); }
  if (data.schemaVersion !== '1.0' || data.prepared?.codec !== 'pcm_f32le' ||
      typeof data.prepared.path !== 'string' || !Number.isSafeInteger(data.prepared.sampleCount) ||
      !Number.isSafeInteger(data.prepared.sampleRateHz) || !Number.isSafeInteger(data.prepared.channels) ||
      data.prepared.sampleRateHz <= 0 || data.prepared.channels <= 0) {
    throw new SampleError('INVALID_METADATA', 'Se requieren metadatos prepare 1.0 válidos.');
  }
  return data;
}

async function readDirectPcmMetadata(inputPath, ffprobePath, streamIndex) {
  const probe = await probeAudio(inputPath, { ffprobePath });
  const selected = selectStream(probe, streamIndex);
  if (!['pcm_s16le', 'pcm_f32le'].includes(selected.codec)) {
    throw new SampleError('UNSUPPORTED_SOURCE', 'El modo directo requiere WAV PCM s16le o f32le.');
  }
  const handle = await fs.open(probe.source.path, 'r');
  try {
    const header = Buffer.alloc(12);
    await handle.read(header, 0, 12, 0);
    if (!['RIFF', 'RF64'].includes(header.toString('ascii', 0, 4)) ||
        header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new SampleError('UNSUPPORTED_SOURCE', 'El modo directo requiere un contenedor WAV.');
    }
  } finally { await handle.close(); }
  let data;
  try {
    const { stdout } = await execFileAsync(ffprobePath, ['-v', 'error', '-select_streams', `${selected.index}`,
      '-show_entries', 'stream=duration_ts,time_base', '-of', 'json', probe.source.path],
    { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 30000 });
    data = JSON.parse(stdout);
  } catch (error) { throw new SampleError('FFPROBE_FAILED', 'No se pudo verificar el número de muestras del WAV original.', error); }
  const sampleCount = Number(data.streams?.[0]?.duration_ts);
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 0 ||
      data.streams?.[0]?.time_base !== `1/${selected.sampleRateHz}`) {
    throw new SampleError('INVALID_SOURCE_TIMELINE', 'FFprobe no informó una duración en muestras válida.');
  }
  return {
    schemaVersion: '1.0', source: probe.source,
    audio: { selectedStreamIndex: selected.index },
    timeline: { syncStatus: 'pcm_wav_sample_aligned' },
    prepared: { path: probe.source.path, codec: selected.codec, sampleCount,
      sampleRateHz: selected.sampleRateHz, channels: selected.channels },
  };
}

async function createEvaluationSample(options) {
  const metadataFile = options.preparedMetadata ? path.resolve(options.preparedMetadata) : null;
  const metadata = metadataFile ? await readMetadata(metadataFile) :
    await readDirectPcmMetadata(options.input, options.ffprobePath ?? 'ffprobe', options.streamIndex);
  const preparedPath = path.resolve(metadata.prepared.path);
  const sampleRateHz = metadata.prepared.sampleRateHz;
  const startSample = Math.round(options.startMs * sampleRateHz / 1000);
  const endSample = Math.round((options.startMs + options.durationMs) * sampleRateHz / 1000);
  const expectedSamples = endSample - startSample;
  if (endSample > metadata.prepared.sampleCount || expectedSamples <= 0) {
    throw new SampleError('OUT_OF_RANGE', 'El intervalo solicitado excede el WAV preparado.');
  }
  const ffprobePath = options.ffprobePath ?? 'ffprobe';
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const runFfmpeg = options.runFfmpeg ?? execFileAsync;
  const runFfprobe = options.runFfprobe ?? execFileAsync;
  const inputProbe = await probeAudio(preparedPath, { ffprobePath });
  if (inputProbe.audio.streams.find((stream) => stream.index === metadata.audio.selectedStreamIndex)?.codec !== metadata.prepared.codec ||
      inputProbe.audio.streams.find((stream) => stream.index === metadata.audio.selectedStreamIndex)?.sampleRateHz !== sampleRateHz ||
      inputProbe.audio.streams.find((stream) => stream.index === metadata.audio.selectedStreamIndex)?.channels !== metadata.prepared.channels) {
    throw new SampleError('INVALID_PREPARED_AUDIO', 'El WAV ya no coincide con sus metadatos.');
  }
  const outputDir = path.resolve(options.outputDir ?? outputDirDefault);
  const identity = createHash('sha256').update(JSON.stringify([
    metadataFile, preparedPath, metadata.prepared.sampleCount,
    options.caseId ?? options.label, options.startMs, options.durationMs,
  ])).digest('hex').slice(0, 20);
  const name = `${options.caseId ?? options.label}--${identity}`;
  const wavPath = path.join(outputDir, `${name}.wav`);
  const jsonPath = path.join(outputDir, `${name}.json`);
  await fs.mkdir(outputDir, { recursive: true });
  if (await fs.access(wavPath).then(() => true, () => false) ||
      await fs.access(jsonPath).then(() => true, () => false)) {
    throw new SampleError('OUTPUT_EXISTS', 'La muestra ya existe; no se sobrescribirá.');
  }
  const tempWav = path.join(outputDir, `.${randomUUID()}.wav`);
  const tempJson = path.join(outputDir, `.${randomUUID()}.json`);
  let linkedWav = false;
  let linkedJson = false;
  try {
    try {
      await runFfmpeg(ffmpegPath, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-i', preparedPath,
        '-map', `0:${metadata.audio.selectedStreamIndex}`, '-af', `atrim=start_sample=${startSample}:end_sample=${endSample},asetpts=PTS-STARTPTS`,
        '-c:a', 'pcm_f32le', '-f', 'wav', tempWav,
      ], { windowsHide: true, maxBuffer: 256 * 1024, timeout: 10 * 60 * 1000 });
    } catch (error) {
      throw new SampleError(error.code === 'ENOENT' ? 'FFMPEG_UNAVAILABLE' : 'FFMPEG_FAILED',
        'FFmpeg no pudo extraer la muestra.', error);
    }
    const actual = await inspectPrepared(tempWav,
      { sampleRateHz, channels: metadata.prepared.channels }, ffprobePath, runFfprobe);
    if (actual.sampleCount !== expectedSamples) {
      throw new SampleError('SAMPLE_LENGTH_MISMATCH', 'El recorte no produjo la cantidad de muestras esperada.');
    }
    const result = {
      schemaVersion: '1.0', caseId: options.caseId ?? null, label: options.label ?? null,
      source: { originalPath: metadata.source.path, preparedMetadataPath: metadataFile,
        preparedPath, selectedStreamIndex: metadata.audio.selectedStreamIndex,
        syncStatus: metadata.timeline.syncStatus },
      interval: { startMs: options.startMs, endMs: options.startMs + options.durationMs,
        startSample, endSample },
      sample: { path: wavPath, metadataPath: jsonPath, codec: 'pcm_f32le', sampleRateHz,
        channels: metadata.prepared.channels, sampleCount: actual.sampleCount,
        durationMs: actual.durationMs },
      evaluationStatus: 'not_evaluated',
    };
    await fs.writeFile(tempJson, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    await fs.link(tempWav, wavPath);
    linkedWav = true;
    await fs.link(tempJson, jsonPath);
    linkedJson = true;
    return result;
  } catch (error) {
    if (linkedJson) await fs.rm(jsonPath, { force: true });
    if (linkedWav) await fs.rm(wavPath, { force: true });
    if (error.code === 'EEXIST') throw new SampleError('OUTPUT_EXISTS', 'La muestra ya existe; no se sobrescribirá.', error);
    throw error;
  } finally {
    await Promise.all([fs.rm(tempWav, { force: true }), fs.rm(tempJson, { force: true })]);
  }
}

module.exports = { parseSampleArgs, createEvaluationSample, SampleError };
