const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, promises: fs } = require('node:fs');
const path = require('node:path');
const { analyzeRisks, approvedMuteActions } = require('./risk-analysis');
const { inspectPcmWav, renderMute } = require('./mute-audio');

class ContentFlowError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(file)) hash.update(block);
  return hash.digest('hex');
}

async function persistStage(root, stage, data) {
  const dir = path.join(path.resolve(root), stage);
  await fs.mkdir(dir, { recursive: true });
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  const id = createHash('sha256').update(serialized).digest('hex');
  const target = path.join(dir, `${id}.json`);
  const temp = path.join(dir, `.tmp-${randomUUID()}.json`);
  try {
    await fs.writeFile(temp, serialized, { flag: 'wx' });
    try { await fs.link(temp, target); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally { await fs.rm(temp, { force: true }); }
  return target;
}

async function wavInfo(file) {
  const handle = await fs.open(file, 'r');
  try { return await inspectPcmWav(handle); }
  finally { await handle.close(); }
}

async function processContent(options) {
  const { originalPath, transcript } = options;
  if (!originalPath || !transcript || !Array.isArray(transcript.words)) {
    throw new ContentFlowError('INVALID_INPUT', 'Se requieren original y transcripción.');
  }
  const original = path.resolve(originalPath);
  const targetAudio = path.resolve(options.audioToMutePath ?? original);
  const sourceInfo = await wavInfo(original);
  if (targetAudio !== original) {
    if (options.audioAlignmentVerified !== true) {
      throw new ContentFlowError('UNVERIFIED_AUDIO_ALIGNMENT', 'La pista mejorada requiere alineación verificada.');
    }
    const targetInfo = await wavInfo(targetAudio);
    if (sourceInfo.sampleRateHz !== targetInfo.sampleRateHz ||
        sourceInfo.sampleCount !== targetInfo.sampleCount ||
        sourceInfo.channels !== targetInfo.channels) {
      throw new ContentFlowError('AUDIO_LENGTH_MISMATCH', 'La pista mejorada no coincide en muestras y formato.');
    }
  }
  if (transcript.source?.path && path.resolve(transcript.source.path) !== original &&
      options.transcriptAlignmentVerified !== true) {
    throw new ContentFlowError('UNVERIFIED_TRANSCRIPT_ALIGNMENT', 'La transcripción externa requiere alineación verificada.');
  }
  const cacheRoot = options.cacheRoot ?? path.join(__dirname, '..', 'cache', 'content');
  const transcriptPath = await persistStage(cacheRoot, 'transcription', transcript);
  const analysis = analyzeRisks(transcript, { sensitivity: options.sensitivity,
    categories: options.categories,
    rules: options.rules });
  const analysisPath = await persistStage(cacheRoot, 'risk', analysis);
  if (!options.reviewDecisions) {
    return { status: 'awaiting_review', transcriptPath, analysisPath,
      findings: analysis.findings, output: null };
  }
  const actions = approvedMuteActions(analysis, options.reviewDecisions);
  if (actions.pendingReview.length || transcript.untimedWords?.length) {
    throw new ContentFlowError('PENDING_REVIEW', 'Hay hallazgos o palabras sin tiempos que requieren revisión.');
  }
  if (!options.outputPath) throw new ContentFlowError('OUTPUT_REQUIRED', 'Falta ruta de salida.');
  const output = path.resolve(options.outputPath);
  const reportPath = `${output}.json`;
  const renderKey = createHash('sha256').update(JSON.stringify({
    audioSha256: await sha256(targetAudio), output, actions,
    marginMs: options.marginMs ?? 80, fadeMs: options.fadeMs ?? 5,
    transcriptPath, analysisPath,
  })).digest('hex');
  const renderDir = path.join(path.resolve(cacheRoot), 'render');
  const manifestPath = path.join(renderDir, `${renderKey}.json`);
  let saved;
  try { saved = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (saved) {
    let valid = false;
    try {
      valid = saved.key === renderKey && saved.output === output &&
        saved.outputSha256 === await sha256(output) &&
        saved.reportSha256 === await sha256(reportPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!valid) {
      throw new ContentFlowError('INVALID_RENDER_CACHE', 'La salida guardada no coincide con su caché.');
    }
    return { status: 'content_rendered_pending_listening', reused: true,
      transcriptPath, analysisPath, output, reportPath, render: saved.render };
  }
  const render = await renderMute(targetAudio, options.outputPath, actions, {
    marginMs: options.marginMs, fadeMs: options.fadeMs,
    provenance: { originalPath: original, transcriptionPath: transcriptPath,
      analysisPath, musicReduction: targetAudio === original ? 'not_applied' : 'external_verified' },
  });
  await fs.mkdir(renderDir, { recursive: true });
  const manifest = { key: renderKey, output, reportPath,
    outputSha256: await sha256(output), reportSha256: await sha256(reportPath), render };
  const tempManifest = path.join(renderDir, `.tmp-${randomUUID()}.json`);
  try {
    await fs.writeFile(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await fs.link(tempManifest, manifestPath);
  } finally { await fs.rm(tempManifest, { force: true }); }
  return { status: 'content_rendered_pending_listening', reused: false,
    transcriptPath, analysisPath, output, reportPath, render };
}

module.exports = { processContent, ContentFlowError };
