const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, promises: fs } = require('node:fs');
const path = require('node:path');
const { createEvaluationSample } = require('./evaluation-sample');
const { createWhisperCppAdapter } = require('./whisper-cpp-adapter');
const { transcribeChunks } = require('./transcription');
const { analyzeRisks } = require('./risk-analysis');

const windows = [
  { label: 'M05', startMs: 300000, durationMs: 30000 },
  { label: 'M25', startMs: 1500000, durationMs: 30000 },
  { label: 'M50', startMs: 3000000, durationMs: 30000 },
];

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(file)) hash.update(block);
  return hash.digest('hex');
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${randomUUID()}.json`);
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

async function findOrCreateSample(original, window, sampleDir, ffmpegPath, ffprobePath) {
  await fs.mkdir(sampleDir, { recursive: true });
  for (const name of await fs.readdir(sampleDir)) {
    if (!name.startsWith(`${window.label}--`) || !name.endsWith('.json')) continue;
    let data;
    try { data = JSON.parse(await fs.readFile(path.join(sampleDir, name), 'utf8')); }
    catch { continue; }
    if (data.source?.originalPath === original && data.label === window.label &&
        data.interval?.startMs === window.startMs &&
        data.interval?.endMs === window.startMs + window.durationMs &&
        await fs.access(data.sample?.path).then(() => true, () => false)) return data;
  }
  return createEvaluationSample({ input: original, label: window.label,
    startMs: window.startMs, durationMs: window.durationMs,
    outputDir: sampleDir, ffmpegPath, ffprobePath });
}

async function runTranscription(options) {
  const original = path.resolve(options.inputPath);
  const sourceSha256 = await sha256(original);
  const adapter = await createWhisperCppAdapter(options.whisper ?? {});
  const runId = createHash('sha256').update(JSON.stringify([sourceSha256, adapter.id,
    adapter.version, adapter.parameters])).digest('hex').slice(0, 16);
  const runDir = path.resolve(options.outputDir ?? path.join(__dirname, '..', 'output', 'runs',
    `${path.basename(original, path.extname(original))}--${runId}`));
  const sampleDir = path.join(__dirname, '..', 'output', 'samples');
  const statePath = path.join(runDir, 'estado.json');
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const ffprobePath = options.ffprobePath ?? 'ffprobe';
  const source = { path: original, sha256: sourceSha256 };
  const state = { schemaVersion: '1.0', source, engine: adapter.id,
    samples: {}, fullTranscription: 'pending_quality_review',
    riskAnalysis: 'pending', mute: 'pending_approvals',
    musicReduction: 'pending_model', pipeline: 'incomplete', errors: [] };
  await atomicJson(statePath, state);
  const sampleResults = [];
  for (const window of windows) {
    try {
      const sample = await findOrCreateSample(original, window, sampleDir, ffmpegPath, ffprobePath);
      const transcript = await transcribeChunks({ inputPath: sample.sample.path, adapter,
        referenceOffsetMs: window.startMs, chunkMs: 30000,
        cacheRoot: path.join(__dirname, '..', 'cache', 'transcription-real'),
        ffmpegPath });
      const risk = analyzeRisks(transcript);
      const sampleRunDir = path.join(runDir, 'samples', window.label);
      await atomicJson(path.join(sampleRunDir, 'transcripcion.json'), transcript);
      await atomicJson(path.join(sampleRunDir, 'riesgos.json'), risk);
      state.samples[window.label] = { status: 'complete', segments: transcript.segments.length,
        words: transcript.words.length, candidates: risk.findings.length,
        interval: { startMs: window.startMs, endMs: window.startMs + window.durationMs } };
      await atomicJson(statePath, state);
      sampleResults.push({ label: window.label, transcript, risk });
      options.onProgress?.({ stage: 'sample', label: window.label, ...state.samples[window.label] });
    } catch (error) {
      state.samples[window.label] = { status: 'failed', code: error.code ?? 'UNKNOWN', message: error.message };
      state.errors.push({ stage: window.label, code: error.code ?? 'UNKNOWN', message: error.message });
      state.fullTranscription = 'blocked_sample_failure';
      await atomicJson(statePath, state);
      throw error;
    }
  }
  const partial = { schemaVersion: '1.0', status: 'partial_samples', source,
    engine: { id: adapter.id, version: adapter.version, ...adapter.parameters },
    language: 'es', languageMode: 'forced', coverage: windows.map((window) => ({
      label: window.label, startMs: window.startMs, endMs: window.startMs + window.durationMs })),
    fullText: sampleResults.flatMap((item) => item.transcript.segments.map((s) => s.text)).join(' ').trim(),
    segments: sampleResults.flatMap((item) => item.transcript.segments),
    words: sampleResults.flatMap((item) => item.transcript.words),
    untimedWords: sampleResults.flatMap((item) => item.transcript.untimedWords),
    uncertainIntervals: windows.map((window) => ({ startMs: window.startMs,
      endMs: window.startMs + window.durationMs, reason: 'requires_audio_review' })),
    chunks: sampleResults.flatMap((item) => item.transcript.chunks.map((chunk) => ({
      index: chunk.index, startSample: chunk.startSample, endSample: chunk.endSample,
      expandedStartSample: chunk.expandedStartSample, expandedEndSample: chunk.expandedEndSample,
      wallTimeMs: chunk.wallTimeMs, sample: item.label, status: 'complete' }))), errors: [] };
  const transcriptPath = path.join(runDir, 'transcripcion.json');
  const riskPath = path.join(runDir, 'riesgos.json');
  await atomicJson(transcriptPath, partial);
  const risks = analyzeRisks(partial);
  await atomicJson(riskPath, risks);
  state.riskAnalysis = 'candidates_complete_review_pending';
  let qualityReview = null;
  if (options.qualityReviewPath) {
    qualityReview = JSON.parse(await fs.readFile(options.qualityReviewPath, 'utf8'));
  }
  const partialSha256 = await sha256(transcriptPath);
  const validQualityReview = qualityReview?.sourceSha256 === sourceSha256 &&
    qualityReview?.sampleTranscriptSha256 === partialSha256;
  if (qualityReview?.approved === true && validQualityReview) {
    state.fullTranscription = 'running';
    await atomicJson(statePath, state);
    try {
      const full = await transcribeChunks({ inputPath: original, adapter, chunkMs: 30000,
        overlapMs: 1500, cacheRoot: path.join(__dirname, '..', 'cache', 'transcription-real'),
        ffmpegPath, onProgress: async (progress) => {
          state.fullProgress = progress;
          await atomicJson(statePath, state);
          options.onProgress?.({ stage: 'full', ...progress });
        } });
      full.status = 'complete';
      full.languageMode = 'forced';
      full.fullText = full.segments.map((segment) => segment.text).join(' ').trim();
      full.uncertainIntervals = full.segments.filter((segment) => segment.timingStatus !== 'reported')
        .map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs,
          reason: 'invalid_segment_time' }));
      full.errors = [];
      await atomicJson(transcriptPath, full);
      await atomicJson(riskPath, analyzeRisks(full));
      state.fullTranscription = 'complete';
    } catch (error) {
      state.fullTranscription = 'failed_recoverable';
      state.errors.push({ stage: 'full', code: error.code ?? 'UNKNOWN', message: error.message });
    }
  } else if (qualityReview?.approved === false && validQualityReview) {
    state.fullTranscription = 'blocked_insufficient_sample_quality';
    state.qualityReason = qualityReview.reason ?? null;
  } else state.fullTranscription = qualityReview ? 'blocked_invalid_quality_review' : 'blocked_quality_review';
  const finalTranscript = JSON.parse(await fs.readFile(transcriptPath, 'utf8'));
  const finalRisks = JSON.parse(await fs.readFile(riskPath, 'utf8'));
  const report = { schemaVersion: '1.0', source, engine: partial.engine,
    transcriptionStatus: state.fullTranscription, musicReduction: state.musicReduction,
    pipeline: 'incomplete', segments: finalTranscript.segments.length,
    words: finalTranscript.words.length, riskCandidates: finalRisks.findings.length,
    totalInferenceMs: finalTranscript.chunks.reduce((sum, chunk) => sum + (chunk.wallTimeMs ?? 0), 0),
    peakMemoryBytes: null, qualityReason: state.qualityReason ?? null,
    warnings: ['Las marcas de palabra son aproximadas y el contexto requiere revisión.',
      'Sin aprobaciones no se renderiza MUTE; la reducción de música sigue pendiente.'],
    artifacts: { transcriptPath, riskPath, statePath, mutesPath: null, finalAudioPath: null } };
  await atomicJson(path.join(runDir, 'reporte.json'), report);
  await atomicJson(statePath, state);
  return { runDir, state, report };
}

module.exports = { runTranscription, atomicJson };
