const { execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, promises: fs } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { inspectPcmWav } = require('./mute-audio');

const run = promisify(execFile);
class TranscriptionError extends Error {
  constructor(code, message, cause) { super(message, { cause }); this.code = code; }
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function planTranscriptionChunks(sampleCount, sampleRateHz, chunkMs = 30000, overlapMs = 0) {
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0 ||
      !Number.isSafeInteger(sampleRateHz) || sampleRateHz <= 0 ||
      !Number.isSafeInteger(chunkMs) || chunkMs < 1000 || chunkMs > 60000 ||
      !Number.isSafeInteger(overlapMs) || overlapMs < 0 || overlapMs >= chunkMs / 2) {
    throw new TranscriptionError('INVALID_PLAN', 'Duración o tamaño de fragmento inválido.');
  }
  const chunkSamples = Math.round(chunkMs * sampleRateHz / 1000);
  const overlapSamples = Math.round(overlapMs * sampleRateHz / 1000);
  const chunks = [];
  for (let startSample = 0; startSample < sampleCount; startSample += chunkSamples) {
    const endSample = Math.min(sampleCount, startSample + chunkSamples);
    chunks.push({ index: chunks.length, startSample, endSample,
      expandedStartSample: Math.max(0, startSample - overlapSamples),
      expandedEndSample: Math.min(sampleCount, endSample + overlapSamples) });
  }
  return chunks;
}

function normalizeChunk(raw, chunk, sampleRateHz, referenceOffsetMs = 0) {
  if (!raw || !Array.isArray(raw.segments)) {
    throw new TranscriptionError('INVALID_MODEL_OUTPUT', 'El adaptador debe devolver segments[].');
  }
  const expandedStart = chunk.expandedStartSample ?? chunk.startSample;
  const expandedEnd = chunk.expandedEndSample ?? chunk.endSample;
  const durationMs = Math.round((expandedEnd - expandedStart) * 1000 / sampleRateHz);
  const baseMs = referenceOffsetMs + Math.round(expandedStart * 1000 / sampleRateHz);
  const coreStartMs = Math.round((chunk.startSample - expandedStart) * 1000 / sampleRateHz);
  const coreEndMs = Math.round((chunk.endSample - expandedStart) * 1000 / sampleRateHz);
  const owned = (start, end) => (start + end) / 2 >= coreStartMs &&
    (start + end) / 2 < coreEndMs;
  const segments = [];
  const words = [];
  const untimedWords = [];
  for (const segment of raw.segments) {
    if (typeof segment.text !== 'string') throw new TranscriptionError('INVALID_MODEL_OUTPUT', 'Texto inválido.');
    const valid = Number.isSafeInteger(segment.startMs) && Number.isSafeInteger(segment.endMs) &&
      segment.startMs >= 0 && segment.endMs >= segment.startMs && segment.endMs <= durationMs;
    if (!valid || owned(segment.startMs, segment.endMs)) {
      segments.push({ text: segment.text, startMs: valid ? baseMs + segment.startMs : null,
        endMs: valid ? baseMs + segment.endMs : null, timingStatus: valid && segment.endMs > segment.startMs ?
          'reported' : 'review' });
    }
    for (const token of segment.words ?? []) {
      if (typeof token.text !== 'string') throw new TranscriptionError('INVALID_MODEL_OUTPUT', 'Token inválido.');
      const wordValid = Number.isSafeInteger(token.startMs) && Number.isSafeInteger(token.endMs) &&
        token.startMs >= 0 && token.endMs > token.startMs && token.endMs <= durationMs;
      const confidence = Number.isFinite(token.confidence) && token.confidence >= 0 &&
        token.confidence <= 1 ? token.confidence : null;
      if (wordValid && owned(token.startMs, token.endMs)) words.push({ text: token.text, startMs: baseMs + token.startMs,
        endMs: baseMs + token.endMs, confidence,
        timingStatus: token.timingStatus ?? 'approximate' });
      else if (!wordValid) untimedWords.push({ text: token.text, chunkIndex: chunk.index,
        reportedStartMs: token.startMs ?? null, reportedEndMs: token.endMs ?? null,
        reason: 'invalid_or_zero_duration' });
    }
  }
  return { segments, words, untimedWords,
    language: raw.language ?? null,
    wallTimeMs: Number.isSafeInteger(raw.wallTimeMs) ? raw.wallTimeMs : null };
}

async function transcribeChunks(options) {
  const { inputPath, adapter } = options;
  if (!adapter || !adapter.id || !adapter.version || typeof adapter.run !== 'function') {
    throw new TranscriptionError('ADAPTER_REQUIRED', 'Se requiere un adaptador Whisper real.');
  }
  const source = path.resolve(inputPath);
  const handle = await fs.open(source, 'r');
  let info;
  try { info = await inspectPcmWav(handle); } finally { await handle.close(); }
  const referenceOffsetMs = options.referenceOffsetMs ?? 0;
  if (!Number.isSafeInteger(referenceOffsetMs) || referenceOffsetMs < 0) {
    throw new TranscriptionError('INVALID_OFFSET', 'Referencia temporal inválida.');
  }
  const overlapMs = options.overlapMs ?? 0;
  const chunks = planTranscriptionChunks(info.sampleCount, info.sampleRateHz, options.chunkMs, overlapMs);
  const sourceHash = await sha256(source);
  const identity = createHash('sha256').update(JSON.stringify({ sourceHash, source,
    referenceOffsetMs, adapterId: adapter.id, adapterVersion: adapter.version,
    parameters: adapter.parameters ?? {}, chunkMs: options.chunkMs ?? 30000,
    overlapMs })).digest('hex');
  const cacheDir = path.join(path.resolve(options.cacheRoot ?? path.join(__dirname, '..', 'cache', 'transcription')),
    identity.slice(0, 24));
  await fs.mkdir(cacheDir, { recursive: true });
  const aggregate = { schemaVersion: '1.0', source: { path: source, sha256: sourceHash,
    referenceOffsetMs, sampleRateHz: info.sampleRateHz, sampleCount: info.sampleCount },
  engine: { id: adapter.id, version: adapter.version, parameters: adapter.parameters ?? {} },
  chunkMs: options.chunkMs ?? 30000, overlapMs, language: null,
  segments: [], words: [], untimedWords: [],
  chunks: [], warnings: ['Los tiempos de palabras son estimaciones; revisar tokens inciertos y habla simultánea.'] };
  for (const chunk of chunks) {
    const saved = path.join(cacheDir, `chunk-${String(chunk.index).padStart(5, '0')}.json`);
    let record;
    let reused = false;
    try {
      record = JSON.parse(await fs.readFile(saved, 'utf8'));
      if (record.identity !== identity || record.chunk.index !== chunk.index ||
          record.chunk.startSample !== chunk.startSample || record.chunk.endSample !== chunk.endSample ||
          !Array.isArray(record.result?.segments) || !Array.isArray(record.result?.words) ||
          !Array.isArray(record.result?.untimedWords) ||
          record.resultSha256 !== createHash('sha256').update(JSON.stringify(record.result)).digest('hex')) {
        throw new TranscriptionError('INVALID_CACHE', 'Fragmento de transcripción inválido.');
      }
      reused = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const scratch = path.join(cacheDir, `.tmp-${randomUUID()}.wav`);
      try {
        await run(options.ffmpegPath ?? 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
          '-n', '-i', source, '-map', '0:0',
          '-af', `atrim=start_sample=${chunk.expandedStartSample}:end_sample=${chunk.expandedEndSample},asetpts=PTS-STARTPTS`,
          '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', scratch],
        { windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 256 * 1024 });
        const raw = await adapter.run({ inputPath: scratch, chunk,
          language: options.language ?? 'es' });
        const result = normalizeChunk(raw, chunk, info.sampleRateHz, referenceOffsetMs);
        record = { schemaVersion: '1.0', identity, chunk, result,
          resultSha256: createHash('sha256').update(JSON.stringify(result)).digest('hex') };
        const tempJson = path.join(cacheDir, `.tmp-${randomUUID()}.json`);
        try {
          await fs.writeFile(tempJson, `${JSON.stringify(record)}\n`, { flag: 'wx' });
          await fs.link(tempJson, saved);
        } finally { await fs.rm(tempJson, { force: true }); }
      } finally { await fs.rm(scratch, { force: true }); }
    }
    aggregate.segments.push(...record.result.segments);
    aggregate.words.push(...record.result.words);
    aggregate.untimedWords.push(...record.result.untimedWords);
    if (record.result.language) aggregate.language = record.result.language;
    aggregate.chunks.push({ ...chunk, reused, wallTimeMs: record.result.wallTimeMs });
    await options.onProgress?.({ completed: aggregate.chunks.length, total: chunks.length, reused });
  }
  return aggregate;
}

module.exports = { planTranscriptionChunks, normalizeChunk, transcribeChunks, TranscriptionError };
