#!/usr/bin/env node

const { createHash } = require('node:crypto');
const { createReadStream, promises: fs } = require('node:fs');
const path = require('node:path');
const { processContent } = require('./content-flow');
const { analyzeRisks, automaticMuteActions } = require('./risk-analysis');
const { renderMute } = require('./mute-audio');
const { verifyMute } = require('./verify-mute');
const { verifyRiskCandidates } = require('./verify-risk-candidates');
const { loadLocalRiskEvidence } = require('./local-risk-evidence');
const { atomicJson } = require('./transcription-run');

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(file)) hash.update(block);
  return hash.digest('hex');
}

async function main() {
  const runDir = path.resolve(process.argv[2] ?? 'output/runs/prueba-content-20261020');
  const originalPath = path.resolve(process.argv[3] ?? 'input/prueba.wav');
  const requestedOutputPath = path.resolve(process.argv[4] ?? 'output/cleaned/prueba_muteada.wav');
  const reviewPath = path.join(runDir, 'revision.json');
  const transcriptPath = path.join(runDir, 'transcripcion.json');
  const transcriptBytes = await fs.readFile(transcriptPath);
  const transcript = JSON.parse(transcriptBytes.toString('utf8'));
  const transcriptSha256 = createHash('sha256').update(transcriptBytes).digest('hex');
  if (path.resolve(transcript.source.path) !== originalPath ||
      transcript.status !== 'complete_unverified' ||
      transcript.source.sha256 !== await sha256File(originalPath)) {
    throw new Error('Transcripción completa o fuente inválida.');
  }
  const cached = await processContent({ originalPath, transcript, sensitivity: 'low' });
  const analysis = analyzeRisks(transcript, { sensitivity: 'low' });
  let review = null;
  try { review = JSON.parse(await fs.readFile(reviewPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (review && (review.sourceSha256 !== transcript.source.sha256 ||
      review.transcriptSha256 !== transcriptSha256 || !Array.isArray(review.decisions))) {
    throw new Error('La revisión no coincide con el audio y la transcripción actuales.');
  }
  const decisions = review?.decisions ?? [];
  const secondaryChecks = await verifyRiskCandidates(runDir, analysis.findings,
    transcriptSha256, { minConfidence: 0.9, originalPath });
  const localChecks = await loadLocalRiskEvidence(runDir, analysis.findings, transcript, transcriptSha256);
  const actions = automaticMuteActions(analysis, decisions,
    { minConfidence: 0.9, uncertainIntervals: transcript.uncertainIntervals, secondaryChecks, localChecks });
  const secondaryById = new Map(secondaryChecks.map(item => [item.findingId, item]));
  const assessmentById = new Map(actions.assessments.map((item) => [item.findingId, item]));
  const findings = analysis.findings.map((finding) => ({ ...finding,
    decision: assessmentById.get(finding.id).status,
    decisionReason: assessmentById.get(finding.id).reason,
    secondaryVerification: secondaryById.get(finding.id)?.status ?? null }));
  const untimedGroups = new Map();
  for (const word of transcript.untimedWords) {
    if (!untimedGroups.has(word.chunkIndex)) untimedGroups.set(word.chunkIndex, []);
    untimedGroups.get(word.chunkIndex).push(word);
  }
  const uncertaintyPath = path.join(runDir, 'uncertainty-review.json');
  await atomicJson(uncertaintyPath, { schemaVersion: '1.0',
    sourceSha256: transcript.source.sha256, transcriptSha256,
    status: 'pending_localized_review',
    note: 'Los límites del bloque son solo una zona de búsqueda; no son tiempos de las palabras. El barrido de expresiones completas no produjo candidatos adicionales verificables.',
    uncertainIntervals: transcript.uncertainIntervals,
    untimedGroups: [...untimedGroups].map(([chunkIndex, words]) => {
      const chunk = transcript.chunks[chunkIndex];
      return { chunkIndex, searchWindowStartMs: Math.round(chunk.startSample * 1000 / transcript.source.sampleRateHz),
        searchWindowEndMs: Math.round(chunk.endSample * 1000 / transcript.source.sampleRateHz), words };
    }),
  });
  await atomicJson(path.join(runDir, 'riesgos.json'), { ...analysis, findings });
  if (!review) await atomicJson(reviewPath, {
    schemaVersion: '1.0', sourceSha256: transcript.source.sha256, transcriptSha256,
    instructions: 'approve/dismiss/review con motivo para casos pendientes; las reglas automáticas fiables no necesitan revisión manual.',
    decisions: findings.map((finding) => ({ id: finding.id, decision: 'review', reason: 'Pendiente de escuchar y revisar contexto' })),
  });
  let render = null;
  let verification = null;
  let outputPath = null;
  if (actions.actions.length) {
    outputPath = requestedOutputPath;
    render = await renderMute(originalPath, outputPath, actions,
      { marginMs: 80, fadeMs: 5, provenance: { originalPath,
        transcriptionPath: transcriptPath, analysisPath: path.join(runDir, 'riesgos.json'),
        musicReduction: 'not_applied', reviewPath } });
    verification = await verifyMute(originalPath, outputPath, render);
  }
  const appliedById = new Map(actions.actions.map((action) => [action.findingId, action]));
  const effectiveFor = (finding) => {
    if (!render || !appliedById.has(finding.id)) return null;
    const rate = render.source.sampleRateHz;
    const action = appliedById.get(finding.id);
    const start = Math.round(action.startMs * rate / 1000);
    const end = Math.round(action.endMs * rate / 1000);
    const interval = render.intervals.find((item) => item.startSample <= start && item.endSample >= end);
    return interval ? { ...interval, startMs: Math.round(interval.startSample * 1000 / rate),
      endMs: Math.round(interval.endSample * 1000 / rate) } : null;
  };
  await atomicJson(path.join(runDir, 'mutes.json'), {
    schemaVersion: '1.0', source: transcript.source, outputPath,
    preserveDuration: true, status: render ? 'preliminary_rendered' :
      findings.length ? 'pending_review' : 'not_applied_no_candidates',
    entries: findings.map((finding) => ({ findingId: finding.id, text: finding.text,
      category: finding.category, ruleId: finding.ruleId, reason: finding.decisionReason,
      startMs: finding.startMs, endMs: finding.endMs, approvalStatus: finding.decision,
      approvalType: appliedById.get(finding.id)?.approval ?? null,
      actionStartMs: appliedById.get(finding.id)?.startMs ?? null,
      actionEndMs: appliedById.get(finding.id)?.endMs ?? null,
      timingSource: appliedById.get(finding.id)?.timingSource ?? 'original_asr',
      secondaryVerification: finding.secondaryVerification,
      applied: appliedById.has(finding.id) && Boolean(render),
      effectiveMutedInterval: effectiveFor(finding),
    })),
    appliedIntervals: render?.intervals ?? [], totalMutedSamples: render?.totalMutedSamples ?? 0,
    totalMutedMs: render?.totalMutedMs ?? 0, verification,
  });
  const report = { schemaVersion: '1.0', source: transcript.source,
    transcription: transcript.status, segments: transcript.segments.length,
    words: transcript.words.length, untimedWords: transcript.untimedWords.length,
    uncertainIntervals: transcript.uncertainIntervals.length,
    secondaryChecks: secondaryChecks.map(item => ({ findingId: item.findingId,
      status: item.status, reportPath: path.join(runDir, 'verification', `${item.findingId}.json`) })),
    localChecks: localChecks.map(item => ({ findingId: item.findingId, windowMs: item.windowMs,
      status: item.status, matches: item.matches, reportPath: item.reportPath })),
    riskCandidates: findings.length, approved: actions.actions.length,
    automatic: actions.actions.filter((item) => item.approval === 'automatic').length,
    manual: actions.actions.filter((item) => item.approval === 'manual').length,
    pending: actions.pendingReview.length, dismissed: actions.assessments.filter((item) => item.status === 'dismissed').length,
    actualMuteIntervals: render?.intervals.length ?? 0, totalMutedMs: render?.totalMutedMs ?? 0,
    verification,
    outputPath, status: render ? 'preliminary_pending_listening' :
      findings.length ? 'awaiting_review' : 'no_candidates_unverified',
    warnings: [`La transcripción base, ${transcript.uncertainIntervals.length} segmentos inciertos y los tiempos de palabra no están validados por escucha.`,
      'Los candidatos pendientes, incluidos los tokens sin tiempo, no se declaran seguros.',
      'Un MUTE automático por alta confianza ASR no demuestra falta de idoneidad publicitaria.',
      'La reducción musical no forma parte de esta exportación.'],
    artifacts: { transcriptPath, risksPath: path.join(runDir, 'riesgos.json'),
      reviewPath, mutesPath: path.join(runDir, 'mutes.json'), outputPath,
      uncertaintyPath, transcriptionCache: cached.transcriptPath, riskCache: cached.analysisPath } };
  await atomicJson(path.join(runDir, 'reporte.json'), report);
  const statePath = path.join(runDir, 'estado.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.riskAnalysis = actions.pendingReview.length ? 'candidates_complete_review_pending' : 'candidates_complete';
  state.mute = render ? 'preliminary_rendered' :
    findings.length ? 'pending_approvals' : 'not_applied_no_candidates';
  state.approved = actions.actions.length;
  state.automatic = report.automatic;
  state.manual = report.manual;
  state.pending = actions.pendingReview.length;
  state.actualMuteIntervals = report.actualMuteIntervals;
  state.totalMutedSamples = render?.totalMutedSamples ?? 0;
  state.verification = verification;
  await atomicJson(statePath, state);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${error.code ?? 'ERROR'}: ${error.message}\n`);
  process.exitCode = 1;
});
