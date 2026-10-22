const { execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, promises: fs } = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { promisify } = require('node:util');
const { probeAudio } = require('./probe-audio');
const { inspectPrepared, selectStream } = require('./prepare-audio');

const execFileAsync = promisify(execFile);
const cacheRootDefault = path.join(__dirname, '..', 'cache', 'block-runs');

class BlockError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.code = code;
  }
}

function planBlocks(totalSamples, sampleRateHz, chunkSeconds = 30, overlapMs = 0) {
  if (!Number.isSafeInteger(totalSamples) || totalSamples <= 0 ||
      !Number.isSafeInteger(sampleRateHz) || sampleRateHz <= 0 ||
      !Number.isFinite(chunkSeconds) || chunkSeconds <= 0 ||
      !Number.isFinite(overlapMs) || overlapMs < 0) {
    throw new BlockError('INVALID_PLAN', 'Parámetros de bloques inválidos.');
  }
  const chunkSamples = Math.round(chunkSeconds * sampleRateHz);
  const overlapSamples = Math.round(overlapMs * sampleRateHz / 1000);
  if (chunkSamples < 1 || overlapSamples >= chunkSamples) {
    throw new BlockError('INVALID_PLAN', 'El solapamiento debe ser menor que el bloque.');
  }
  const blocks = [];
  for (let coreStart = 0; coreStart < totalSamples; coreStart += chunkSamples) {
    const coreEnd = Math.min(totalSamples, coreStart + chunkSamples);
    blocks.push({ index: blocks.length, coreStart, coreEnd,
      expandedStart: Math.max(0, coreStart - overlapSamples),
      expandedEnd: Math.min(totalSamples, coreEnd + overlapSamples) });
  }
  return blocks;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function readPcmWavInfo(file, streamIndex, ffprobePath) {
  const probe = await probeAudio(file, { ffprobePath });
  const stream = selectStream(probe, streamIndex);
  if (!['pcm_s16le', 'pcm_f32le'].includes(stream.codec)) {
    throw new BlockError('UNSUPPORTED_SOURCE', 'Se requiere un WAV PCM s16le o f32le.');
  }
  const handle = await fs.open(probe.source.path, 'r');
  try {
    const header = Buffer.alloc(12);
    await handle.read(header, 0, 12, 0);
    if (!['RIFF', 'RF64'].includes(header.toString('ascii', 0, 4)) ||
        header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new BlockError('UNSUPPORTED_SOURCE', 'Se requiere un contenedor WAV.');
    }
  } finally { await handle.close(); }
  let data;
  try {
    const { stdout } = await execFileAsync(ffprobePath, ['-v', 'error', '-select_streams', `${stream.index}`,
      '-show_entries', 'stream=duration_ts,time_base', '-of', 'json', probe.source.path],
    { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 30000 });
    data = JSON.parse(stdout);
  } catch (error) { throw new BlockError('FFPROBE_FAILED', 'No se pudo medir el WAV en muestras.', error); }
  const sampleCount = Number(data.streams?.[0]?.duration_ts);
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0 ||
      data.streams?.[0]?.time_base !== `1/${stream.sampleRateHz}`) {
    throw new BlockError('INVALID_TIMELINE', 'El WAV no tiene una duración en muestras fiable.');
  }
  return { probe, stream, sampleCount };
}

async function runFfmpeg(args, ffmpegPath) {
  try {
    await execFileAsync(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', ...args],
      { windowsHide: true, maxBuffer: 256 * 1024, timeout: 30 * 60 * 1000 });
  } catch (error) {
    throw new BlockError(error.code === 'ENOENT' ? 'FFMPEG_UNAVAILABLE' : 'FFMPEG_FAILED',
      'FFmpeg falló durante un bloque.', error);
  }
}

async function checkDisk(dir, neededBytes) {
  const stats = await fs.statfs(dir);
  const freeBytes = stats.bavail * stats.bsize;
  if (freeBytes < neededBytes) {
    throw new BlockError('INSUFFICIENT_DISK', `Espacio libre insuficiente: ${freeBytes} bytes; se requieren al menos ${neededBytes}.`);
  }
  return freeBytes;
}

async function validateSavedChunk(dir, block, identity, channels) {
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const core = path.join(dir, 'core.f32');
  const stat = await fs.stat(core);
  if (meta.identity !== identity || meta.index !== block.index ||
      meta.coreStart !== block.coreStart || meta.coreEnd !== block.coreEnd ||
      stat.size !== (block.coreEnd - block.coreStart) * channels * 4 ||
      await sha256(core) !== meta.coreSha256) {
    throw new BlockError('INVALID_SAVED_CHUNK', `El bloque ${block.index} guardado no es válido.`);
  }
  return meta;
}

async function processOneBlock({ sourcePath, stream, block, model, runDir, identity,
  ffmpegPath, ffprobePath, channels, sampleRateHz }) {
  const targetDir = path.join(runDir, `chunk-${String(block.index).padStart(5, '0')}`);
  if (await fs.access(targetDir).then(() => true, () => false)) {
    return { meta: await validateSavedChunk(targetDir, block, identity, channels), reused: true };
  }
  const tempDir = path.join(runDir, `.tmp-${randomUUID()}`);
  await fs.mkdir(tempDir);
  try {
    const input = path.join(tempDir, 'input.wav');
    const processed = path.join(tempDir, 'processed.wav');
    const core = path.join(tempDir, 'core.f32');
    await runFfmpeg(['-i', sourcePath, '-map', `0:${stream.index}`,
      '-af', `atrim=start_sample=${block.expandedStart}:end_sample=${block.expandedEnd},asetpts=PTS-STARTPTS`,
      '-c:a', 'pcm_f32le', '-f', 'wav', input], ffmpegPath);
    const expandedSamples = block.expandedEnd - block.expandedStart;
    const inputInfo = await inspectPrepared(input, { sampleRateHz, channels }, ffprobePath, execFileAsync);
    if (inputInfo.sampleCount !== expandedSamples) throw new BlockError('INPUT_LENGTH_MISMATCH', 'El bloque de entrada perdió muestras.');

    const started = performance.now();
    const metrics = await model.run({ inputPath: input, outputPath: processed,
      block, sampleRateHz, channels });
    const wallTimeMs = Math.round(performance.now() - started);
    if (metrics?.outputOffsetSamples !== undefined && metrics.outputOffsetSamples !== 0) {
      throw new BlockError('UNSUPPORTED_MODEL_OFFSET', 'El modelo informó un desfase no compensado.');
    }
    const processedInfo = await inspectPrepared(processed, { sampleRateHz, channels }, ffprobePath, execFileAsync);
    if (processedInfo.sampleCount !== expandedSamples) {
      throw new BlockError('MODEL_LENGTH_MISMATCH', 'El modelo cambió la cantidad de muestras del bloque.');
    }
    const coreOffset = block.coreStart - block.expandedStart;
    const coreEndOffset = coreOffset + block.coreEnd - block.coreStart;
    await runFfmpeg(['-i', processed, '-map', '0:0',
      '-af', `atrim=start_sample=${coreOffset}:end_sample=${coreEndOffset},asetpts=PTS-STARTPTS`,
      '-f', 'f32le', core], ffmpegPath);
    const stat = await fs.stat(core);
    if (stat.size !== (block.coreEnd - block.coreStart) * channels * 4) {
      throw new BlockError('CORE_LENGTH_MISMATCH', 'El núcleo del bloque tiene un tamaño incorrecto.');
    }
    const meta = { schemaVersion: '1.0', identity, index: block.index,
      coreStart: block.coreStart, coreEnd: block.coreEnd,
      expandedStart: block.expandedStart, expandedEnd: block.expandedEnd,
      coreSha256: await sha256(core), wallTimeMs,
      peakMemoryBytes: Number.isSafeInteger(metrics?.peakMemoryBytes) ? metrics.peakMemoryBytes : null,
      status: 'complete' };
    await fs.writeFile(path.join(tempDir, 'manifest.json'), `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' });
    await Promise.all([fs.rm(input), fs.rm(processed)]);
    await fs.rename(tempDir, targetDir);
    return { meta, reused: false };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function wavHeader(sampleRateHz, channels, sampleCount) {
  const bytes = sampleCount * channels * 4;
  if (!Number.isSafeInteger(bytes) || bytes > 0xffffffff - 36) {
    throw new BlockError('WAV_TOO_LARGE', 'La salida excede el límite RIFF de 4 GiB; se requiere RF64.');
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(bytes + 36, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * channels * 4, 28);
  header.writeUInt16LE(channels * 4, 32); header.writeUInt16LE(32, 34);
  header.write('data', 36); header.writeUInt32LE(bytes, 40);
  return header;
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten <= 0) throw new BlockError('WRITE_FAILED', 'No se pudo escribir la salida.');
    offset += bytesWritten;
  }
}

async function joinCores(blocks, runDir, outputPath, sampleRateHz, channels, totalSamples, ffprobePath) {
  const temp = path.join(path.dirname(outputPath), `.${randomUUID()}.wav`);
  try {
    const handle = await fs.open(temp, 'wx');
    try {
      await writeAll(handle, wavHeader(sampleRateHz, channels, totalSamples));
      for (const block of blocks) {
        const core = path.join(runDir, `chunk-${String(block.index).padStart(5, '0')}`, 'core.f32');
        for await (const buffer of createReadStream(core)) await writeAll(handle, buffer);
      }
    } finally { await handle.close(); }
    const info = await inspectPrepared(temp, { sampleRateHz, channels }, ffprobePath, execFileAsync);
    if (info.sampleCount !== totalSamples) throw new BlockError('JOIN_LENGTH_MISMATCH', 'La unión cambió la duración.');
    await fs.link(temp, outputPath);
  } finally { await fs.rm(temp, { force: true }); }
}

async function processBlocks(options) {
  const { inputPath, model, outputPath } = options;
  if (!model || typeof model.run !== 'function' || !model.id || !model.version || !outputPath) {
    throw new BlockError('MODEL_REQUIRED', 'Se requiere un adaptador de modelo real y una ruta de salida.');
  }
  const ffprobePath = options.ffprobePath ?? 'ffprobe';
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const { probe, stream, sampleCount } = await readPcmWavInfo(inputPath, options.streamIndex, ffprobePath);
  const blocks = planBlocks(sampleCount, stream.sampleRateHz,
    options.chunkSeconds ?? 30, options.overlapMs ?? 0);
  const sourceSha256 = await sha256(probe.source.path);
  const identity = createHash('sha256').update(JSON.stringify({ sourceSha256,
    sourcePath: probe.source.path, streamIndex: stream.index, modelId: model.id,
    modelVersion: model.version, parameters: model.parameters ?? {},
    chunkSeconds: options.chunkSeconds ?? 30, overlapMs: options.overlapMs ?? 0,
  })).digest('hex');
  const runDir = path.join(path.resolve(options.cacheRoot ?? cacheRootDefault), identity.slice(0, 24));
  const finalPath = path.resolve(outputPath);
  const reportPath = `${finalPath}.json`;
  if (finalPath === probe.source.path) throw new BlockError('SOURCE_DESTINATION_SAME', 'La salida no puede reemplazar el original.');
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  if (await fs.access(finalPath).then(() => true, () => false) ||
      await fs.access(reportPath).then(() => true, () => false)) {
    throw new BlockError('OUTPUT_EXISTS', 'La salida ya existe.');
  }
  const bytesPerSample = stream.channels * 4;
  const finalBytes = sampleCount * bytesPerSample + 44;
  await checkDisk(path.dirname(finalPath), finalBytes + 1024 * 1024 * 1024);
  const records = [];
  for (const block of blocks) {
    const expandedBytes = (block.expandedEnd - block.expandedStart) * bytesPerSample;
    await checkDisk(runDir, expandedBytes * 3 + 1024 * 1024 * 1024);
    const record = await processOneBlock({ sourcePath: probe.source.path, stream, block,
      model, runDir, identity, ffmpegPath, ffprobePath,
      channels: stream.channels, sampleRateHz: stream.sampleRateHz });
    records.push(record);
    options.onProgress?.({ completed: records.length, total: blocks.length,
      index: block.index, reused: record.reused, wallTimeMs: record.meta.wallTimeMs });
  }
  await joinCores(blocks, runDir, finalPath, stream.sampleRateHz, stream.channels, sampleCount, ffprobePath);
  const report = { schemaVersion: '1.0', status: 'processed_pending_listening',
    qualityApproved: false, source: { path: probe.source.path, sha256: sourceSha256,
      sampleRateHz: stream.sampleRateHz, channels: stream.channels, sampleCount },
    model: { id: model.id, version: model.version, parameters: model.parameters ?? {} },
    settings: { chunkSeconds: options.chunkSeconds ?? 30, overlapMs: options.overlapMs ?? 0 },
    output: { path: finalPath, sampleRateHz: stream.sampleRateHz,
      channels: stream.channels, sampleCount },
    chunks: records.map((record) => ({ ...record.meta, reused: record.reused })),
    warnings: ['La duración en muestras coincide; la calidad vocal y la alineación acústica requieren evaluación.'] };
  const tempReport = path.join(path.dirname(finalPath), `.${randomUUID()}.json`);
  try {
    await fs.writeFile(tempReport, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    await fs.link(tempReport, reportPath);
  } catch (error) {
    await fs.rm(finalPath, { force: true });
    throw error;
  } finally { await fs.rm(tempReport, { force: true }); }
  return report;
}

module.exports = { planBlocks, processBlocks, BlockError };
