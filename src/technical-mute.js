const { createHash } = require('node:crypto');
const { createReadStream, promises: fs } = require('node:fs');
const path = require('node:path');
const { createWhisperCppAdapter } = require('./whisper-cpp-adapter');
const { transcribeChunks } = require('./transcription');
const { analyzeRisks } = require('./risk-analysis');
const { inspectPcmWav, renderMute } = require('./mute-audio');
const { atomicJson } = require('./transcription-run');

async function sha256(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function inspect(file) {
  const handle = await fs.open(file, 'r');
  try { return await inspectPcmWav(handle); }
  finally { await handle.close(); }
}

function validateApproval(approval, sample, sampleHash) {
  if (approval?.purpose !== 'technical_test' || approval.approved !== true ||
      approval.sampleSha256 !== sampleHash ||
      !Number.isSafeInteger(approval.startMs) || !Number.isSafeInteger(approval.endMs) ||
      approval.startMs < sample.interval.startMs || approval.endMs > sample.interval.endMs ||
      approval.endMs <= approval.startMs || typeof approval.reason !== 'string' ||
      !approval.reason.trim()) {
    throw new Error('Se requiere aprobación técnica explícita, ligada al hash y dentro de M05.');
  }
  return { type: 'mute', approved: true, category: 'technical_test',
    reason: approval.reason, startMs: approval.startMs - sample.interval.startMs,
    endMs: approval.endMs - sample.interval.startMs };
}

async function verifyRender(sourcePath, outputPath, interval, fadeSamples) {
  const sourceInfo = await inspect(sourcePath);
  const resultInfo = await inspect(outputPath);
  if (sourceInfo.size !== resultInfo.size || sourceInfo.sampleCount !== resultInfo.sampleCount ||
      sourceInfo.data.offset !== resultInfo.data.offset) throw new Error('El MUTE cambió duración o estructura.');
  const source = await fs.readFile(sourcePath);
  const output = await fs.readFile(outputPath);
  let mutedNonzeroFrames = 0, unchangedOutsideFrames = 0, changedOutsideFrames = 0;
  const frameBytes = sourceInfo.blockAlign;
  for (let frame = 0; frame < sourceInfo.sampleCount; frame++) {
    const at = sourceInfo.data.offset + frame * frameBytes;
    if (frame >= interval.startSample && frame < interval.endSample) {
      for (let byte = at; byte < at + frameBytes; byte++) {
        if (output[byte] !== 0) { mutedNonzeroFrames++; break; }
      }
    } else if (frame < interval.startSample - fadeSamples || frame >= interval.endSample + fadeSamples) {
      if (source.subarray(at, at + frameBytes).equals(output.subarray(at, at + frameBytes))) unchangedOutsideFrames++;
      else changedOutsideFrames++;
    }
  }
  if (mutedNonzeroFrames || changedOutsideFrames) throw new Error(
    `La verificación PCM del MUTE falló: ${mutedNonzeroFrames} muestras no nulas dentro; ${changedOutsideFrames} alteradas fuera.`);
  return { sampleCount: sourceInfo.sampleCount, mutedNonzeroFrames,
    changedOutsideFrames, unchangedOutsideFrames,
    sampleAlignment: 'same_indices_no_cut' };
}

async function run(approvalPath) {
  const root = path.join(__dirname, '..');
  const sample = JSON.parse(await fs.readFile(path.join(root, 'output', 'samples',
    'M05--0b6f2705996bd1c6d104.json'), 'utf8'));
  const sourcePath = sample.sample.path;
  const sampleHash = await sha256(sourcePath);
  const approval = JSON.parse(await fs.readFile(approvalPath, 'utf8'));
  const action = validateApproval(approval, sample, sampleHash);
  const runDir = path.join(root, 'output', 'runs', 'mute-test-M05');
  const adapter = await createWhisperCppAdapter();
  const transcript = await transcribeChunks({ inputPath: sourcePath, adapter,
    referenceOffsetMs: sample.interval.startMs, chunkMs: 30000,
    cacheRoot: path.join(root, 'cache', 'transcription-real') });
  const risks = analyzeRisks(transcript);
  await atomicJson(path.join(runDir, 'transcripcion.json'), transcript);
  await atomicJson(path.join(runDir, 'riesgos.json'), risks);
  if (risks.findings.length) await atomicJson(path.join(runDir, 'revision_pendiente.json'), {
    schemaVersion: '1.0', status: 'review_required', findings: risks.findings });
  const outputPath = path.join(root, 'output', 'cleaned', 'muestra_mute_prueba.wav');
  const render = await renderMute(sourcePath, outputPath, {
    schemaVersion: '1.0', source: transcript.source,
    preserveDuration: true, actions: [action] }, {
    marginMs: 80, fadeMs: 5,
    provenance: { purpose: 'technical_test', approvalPath: path.resolve(approvalPath),
      sourceSampleSha256: sampleHash, originalPath: sample.source.originalPath,
      musicReduction: 'not_applied' },
  });
  const verification = await verifyRender(sourcePath, outputPath, render.intervals[0],
    Math.round(render.parameters.fadeMs * render.source.sampleRateHz / 1000));
  const result = { ...render, status: 'technical_test_verified',
    sourceIntervalGlobalMs: { startMs: approval.startMs, endMs: approval.endMs },
    appliedIntervalsGlobalMs: render.intervals.map((interval) => ({
      startMs: sample.interval.startMs + Math.round(interval.startSample * 1000 / render.source.sampleRateHz),
      endMs: sample.interval.startMs + Math.round(interval.endSample * 1000 / render.source.sampleRateHz) })),
    approval: { purpose: 'technical_test', approved: true, reason: approval.reason,
      sampleSha256: sampleHash }, verification,
    realRiskCandidates: risks.findings.length,
    note: 'Silencio técnico; no representa una infracción ni una decisión de monetización.' };
  await atomicJson(path.join(runDir, 'mutes_prueba.json'), result);
  return { outputPath, reportPath: path.join(runDir, 'mutes_prueba.json'),
    riskCandidates: risks.findings.length, verification };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--approval') {
    console.error('Uso: node src/technical-mute.js --approval <approval.json>');
    process.exitCode = 2;
  } else run(args[1]).then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { validateApproval, verifyRender, run };
