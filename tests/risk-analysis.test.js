const assert = require('node:assert/strict');
const test = require('node:test');
const { analyzeRisks, approvedMuteActions, automaticMuteActions } = require('../src/risk-analysis');

const transcript = (words) => ({ schemaVersion: '1.0', source: { path: 'audio.wav' }, words });
const word = (text, startMs, endMs, confidence = 0.9) => ({ text, startMs, endMs, confidence });

test('detecta palabra aislada y expresión compuesta sin aprobar silencios', () => {
  const result = analyzeRisks(transcript([
    word('Mierda', 0, 250), word('te', 500, 600), word('voy', 610, 700),
    word('a', 710, 750), word('matar', 760, 1100),
  ]));
  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.findings.map((f) => f.category), ['strong_profanity', 'threat']);
  assert.ok(result.findings.every((f) => f.decision === 'review'));
  assert.equal(approvedMuteActions(result, []).actions.length, 0);
  const approved = approvedMuteActions(result, [
    { id: result.findings[0].id, decision: 'dismiss', reason: 'Cita permitida en contexto' },
    { id: result.findings[1].id, decision: 'approve', reason: 'Amenaza revisada en el audio' },
  ]);
  assert.deepEqual(approved.actions.map((a) => [a.startMs, a.endMs, a.approved]), [[500, 1100, true]]);
  const compound = analyzeRisks(transcript([
    word('hijo', 1000, 1100), word('de', 1100, 1200), word('puta', 1200, 1400),
  ]));
  assert.ok(compound.findings.some((finding) => finding.text === 'hijo de puta'));
});

test('lenguaje permitido y contexto dudoso quedan separados de la detección léxica', () => {
  assert.equal(analyzeRisks(transcript([word('Qué', 0, 100), word('bonito', 100, 400)])).findings.length, 0);
  const result = analyzeRisks(transcript([
    word('Cito', 0, 200), word('mierda', 200, 200, 0.2), word('para', 250, 350),
    word('criticarlo', 360, 700),
  ]));
  assert.equal(result.findings[0].startMs, result.findings[0].endMs);
  assert.ok(result.findings[0].warnings.includes('zero_duration'));
  assert.ok(result.findings[0].context.includes('criticarlo'));
  assert.throws(() => approvedMuteActions(result, [
    { id: result.findings[0].id, decision: 'approve', reason: 'Prueba' },
  ]), { code: 'UNRELIABLE_TIME' });
  assert.equal(analyzeRisks(transcript([word('mierda', 0, 100)]), { sensitivity: 'high' }).findings.length, 0);
  assert.equal(analyzeRisks(transcript([word('mierda', 0, 100)]),
    { categories: ['threat'] }).findings.length, 0);
  const derogatory = analyzeRisks(transcript([
    word('las', 0, 100), word('mujeres', 100, 300), word('son', 300, 400), word('inferiores', 400, 700),
  ]));
  assert.equal(derogatory.findings[0].category, 'hateful_derogatory');
  assert.equal(derogatory.findings[0].decision, 'review');
});

test('rechaza tiempos corruptos y decisiones no asociadas a hallazgos', () => {
  assert.throws(() => analyzeRisks(transcript([word('x', 50, 40)])), { code: 'INVALID_TRANSCRIPT' });
  assert.throws(() => approvedMuteActions(analyzeRisks(transcript([])),
    [{ id: 'inventado', decision: 'approve', reason: 'x' }]), { code: 'INVALID_REVIEWS' });
});

test('variantes latinoamericanas y expresiones divididas conservan límites de palabra', () => {
  const result = analyzeRisks(transcript([
    word('hijue', 0, 120), word('puta', 130, 300),
    word('qué', 500, 600), word('chuuucha', 610, 900),
    word('p.u.t.a', 1200, 1500), word('computadora', 1800, 2200),
    word('te voy a matar', 2300, 3200),
  ]), { sensitivity: 'low' });
  assert.deepEqual(result.findings.map((f) => f.text),
    ['hijue puta', 'chuuucha', 'p.u.t.a', 'te voy a matar']);
  assert.ok(result.findings.every((f) => f.decision === 'review'));
  assert.equal(result.findings[3].startMs, 2300);
  assert.equal(result.findings[3].endMs, 3200);
});

test('una decisión pendiente no se convierte en aprobación y los tiempos cero se bloquean', () => {
  const result = analyzeRisks(transcript([
    word('concha', 0, 100), word('de', 100, 150), word('tu', 150, 200),
    word('madre', 200, 200, 0.3), word('disputa', 250, 500),
  ]), { sensitivity: 'low' });
  assert.equal(result.findings.length, 1);
  assert.ok(result.findings[0].warnings.includes('zero_duration'));
  const pending = approvedMuteActions(result, [
    { id: result.findings[0].id, decision: 'review', reason: 'Escuchar la frase' },
  ]);
  assert.equal(pending.actions.length, 0);
  assert.deepEqual(pending.pendingReview, [result.findings[0].id]);
  assert.throws(() => approvedMuteActions(result, [
    { id: result.findings[0].id, decision: 'approve', reason: 'Sin tiempo fiable' },
  ]), { code: 'UNRELIABLE_TIME' });
});

test('MUTE automático exige palabra completa, regla habilitada, confianza y tiempo válido', () => {
  const source = { path: 'audio.wav', sampleRateHz: 1000, sampleCount: 5000 };
  const analysis = analyzeRisks({ source, words: [
    word('computadora', 0, 400, 1), word('puta', 500, 750, 0.96),
    word('verga', 1000, 1300, 0.2), word('chucha', 1400, 1400, 0.99),
    word('mierda', 5100, 5300, 0.99),
  ] }, { sensitivity: 'low' });
  const result = automaticMuteActions(analysis, []);
  assert.deepEqual(result.actions.map(action => [action.text, action.approval, action.ruleId]),
    [['puta', 'automatic', 'puta']]);
  assert.equal(result.pendingReview.length, 3);
});

test('expresión compuesta tiene prioridad y una decisión manual de descartar bloquea el automático', () => {
  const source = { path: 'audio.wav', sampleRateHz: 1000, sampleCount: 5000 };
  const analysis = analyzeRisks({ source, words: [
    word('hijo', 0, 100, 0.98), word('de', 100, 150, 0.99), word('puta', 150, 400, 0.97),
    word('disputa', 600, 900, 0.99),
  ] }, { sensitivity: 'low' });
  assert.deepEqual(analysis.findings.map(f => f.ruleId), ['hijo-de-puta']);
  assert.equal(automaticMuteActions(analysis, []).actions.length, 1);
  const result = automaticMuteActions(analysis, [
    { id: analysis.findings[0].id, decision: 'dismiss', reason: 'Audio revisado: falso positivo' },
  ]);
  assert.equal(result.actions.length, 0);
  assert.equal(result.assessments[0].status, 'dismissed');
});

test('segunda ventana solo confirma un candidato débil con palabra y tiempo concordantes', () => {
  const source = { path: 'audio.wav', sampleRateHz: 1000, sampleCount: 10000 };
  const analysis = analyzeRisks({ source, words: [word('verga', 3000, 3500, 0.27)] },
    { sensitivity: 'low' });
  const id = analysis.findings[0].id;
  const check = { findingId: id, status: 'corroborated_by_second_pass_same_model', sourceVerified: true,
    matches: [{ text: 'verga', confidence: 0.99, aligned: true,
      globalStartMs: 2900, globalEndMs: 3300 }] };
  const accepted = automaticMuteActions(analysis, [], { secondaryChecks: [check] });
  assert.deepEqual(accepted.actions.map(a => [a.startMs, a.endMs, a.timingSource]),
    [[2900, 3500, 'union_of_two_asr_windows']]);
  assert.equal(automaticMuteActions(analysis, [], { secondaryChecks: [{ ...check,
    matches: [{ ...check.matches[0], confidence: 0.3 }] }] }).actions.length, 0);
  assert.equal(automaticMuteActions(analysis, [], { secondaryChecks: [{ ...check,
    matches: [{ ...check.matches[0], aligned: false }] }] }).actions.length, 0);
  assert.equal(automaticMuteActions(analysis, [], { secondaryChecks: [{ ...check,
    matches: [{ ...check.matches[0], text: 'otra' }] }] }).actions.length, 0);
  assert.equal(automaticMuteActions(analysis, [], { secondaryChecks: [{ ...check,
    sourceVerified: false }] }).actions.length, 0);
});

test('tres ventanas localizadas corroboran una grosería con confianza y tiempos concordantes', () => {
  const source = { path: 'audio.wav', sampleRateHz: 1000, sampleCount: 20000 };
  const analysis = analyzeRisks({ source, words: [word('chucha', 5000, 5500, 0.69)] },
    { sensitivity: 'low' });
  const findingId = analysis.findings[0].id;
  const checks = [12000, 18000].map((windowMs, index) => ({
    findingId, windowMs, sourceVerified: true, status: 'localized_same_model',
    matches: [{ text: 'chucha,', confidence: 0.7, aligned: true,
      globalStartMs: 5100 + index * 50, globalEndMs: 5600 + index * 50 }],
  }));
  const result = automaticMuteActions(analysis, [], { localChecks: checks });
  assert.deepEqual(result.actions.map(a => [a.startMs, a.endMs, a.timingSource]),
    [[5000, 5650, 'union_of_three_asr_windows']]);
  for (const changed of [
    [{ ...checks[0], sourceVerified: false }, checks[1]],
    [checks[0], { ...checks[1], matches: [{ ...checks[1].matches[0], confidence: 0.4 }] }],
    [checks[0], { ...checks[1], matches: [{ ...checks[1].matches[0], text: 'otra' }] }],
    [checks[0]],
  ]) assert.equal(automaticMuteActions(analysis, [], { localChecks: changed }).actions.length, 0);
});
