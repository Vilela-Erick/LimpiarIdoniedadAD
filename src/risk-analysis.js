const { createHash } = require('node:crypto');
const rulesDefault = require('../config/risk-rules.json');

class RiskError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const levels = { low: 0, medium: 1, high: 2 };
const normalize = (value) => value.toLocaleLowerCase('es').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/([a-z])\1{2,}/g, '$1')
  .replace(/[^a-z0-9]+/g, ' ').trim();

function lexicalTokens(words) {
  return words.flatMap((word, wordIndex) => {
    const normalized = normalize(word.text);
    if (!normalized) return [];
    const parts = normalized.split(' ');
    const joinedLetters = parts.length >= 3 && parts.every((part) => part.length === 1);
    return (joinedLetters ? [parts.join('')] : parts).map((text) => ({ text, wordIndex }));
  });
}

function matchesForm(token, form) {
  const alternatives = Array.isArray(form) ? form : [form];
  return alternatives.some((candidate) => typeof candidate === 'string' && token === normalize(candidate));
}

function validateWords(words) {
  if (!Array.isArray(words)) throw new RiskError('INVALID_TRANSCRIPT', 'Se requieren palabras con tiempos.');
  for (const word of words) {
    if (typeof word.text !== 'string' || !Number.isSafeInteger(word.startMs) ||
        !Number.isSafeInteger(word.endMs) || word.startMs < 0 || word.endMs < word.startMs ||
        word.confidence !== undefined && word.confidence !== null &&
          (!Number.isFinite(word.confidence) || word.confidence < 0 || word.confidence > 1)) {
      throw new RiskError('INVALID_TRANSCRIPT', 'Palabra o intervalo inválido.');
    }
  }
}

function analyzeRisks(transcript, options = {}) {
  const words = transcript?.words;
  validateWords(words);
  const sensitivity = options.sensitivity ?? 'medium';
  if (!(sensitivity in levels)) throw new RiskError('INVALID_SENSITIVITY', 'Sensibilidad inválida.');
  const categories = options.categories ?? null;
  if (categories !== null && (!Array.isArray(categories) ||
      categories.some((category) => typeof category !== 'string'))) {
    throw new RiskError('INVALID_CATEGORIES', 'Categorías inválidas.');
  }
  const rules = options.rules ?? rulesDefault.rules;
  if (!Array.isArray(rules)) throw new RiskError('INVALID_RULES', 'Reglas inválidas.');
  const tokens = lexicalTokens(words);
  const findings = [];
  for (let i = 0; i < tokens.length; i++) {
    for (const rule of rules) {
      if (!Array.isArray(rule.tokens) || !rule.tokens.length ||
          !(rule.severity in levels) || typeof rule.category !== 'string' ||
          typeof rule.id !== 'string') throw new RiskError('INVALID_RULES', 'Regla inválida.');
      if (levels[rule.severity] < levels[sensitivity]) continue;
      if (categories !== null && !categories.includes(rule.category)) continue;
      if (i + rule.tokens.length > tokens.length ||
          !rule.tokens.every((form, offset) => matchesForm(tokens[i + offset].text, form))) continue;
      const firstIndex = tokens[i].wordIndex;
      const lastIndex = tokens[i + rule.tokens.length - 1].wordIndex;
      const matchedWords = words.slice(firstIndex, lastIndex + 1);
      if (matchedWords.some((word, offset) => offset > 0 &&
          word.startMs - matchedWords[offset - 1].endMs > 2000) ||
          words[lastIndex].endMs - words[firstIndex].startMs > 6000) continue;
      const startMs = words[firstIndex].startMs;
      const endMs = words[lastIndex].endMs;
      const context = words.slice(Math.max(0, firstIndex - 10), Math.min(words.length, lastIndex + 11))
        .map((word) => word.text).join(' ');
      const confidences = matchedWords.map((word) => word.confidence)
        .filter((value) => Number.isFinite(value));
      const confidence = confidences.length === matchedWords.length ? Math.min(...confidences) : null;
      const id = createHash('sha256').update(JSON.stringify([rule.id, firstIndex, lastIndex, startMs, endMs]))
        .digest('hex').slice(0, 16);
      const warnings = [];
      if (matchedWords.some((word) => word.endMs === word.startMs)) warnings.push('zero_duration');
      if (confidence === null || confidence < 0.6) warnings.push('uncertain_transcription');
      if (matchedWords.some((word) => word.timingStatus === 'approximate')) warnings.push('approximate_word_timing');
      findings.push({ id, ruleId: rule.id, category: rule.category, severity: rule.severity,
        startMs, endMs, text: matchedWords.map((word) => word.text).join(' '),
        context, detection: 'lexical_candidate', confidence,
        decision: 'review', reason: `${rule.reason ?? `Coincidencia con regla ${rule.id}`}; requiere contexto y revisión.`,
        warnings });
    }
  }
  // Una expresión completa tiene prioridad sobre sus palabras internas.
  const maximal = findings.filter((item) => !findings.some((other) => other !== item &&
    other.startMs <= item.startMs && other.endMs >= item.endMs &&
    (other.startMs < item.startMs || other.endMs > item.endMs) &&
    other.category === item.category));
  return { schemaVersion: '1.0', source: transcript.source ?? null,
    settings: { sensitivity, categories, ruleVersion: rulesDefault.schemaVersion },
    findings: maximal, warnings: ['La aprobación automática requiere regla habilitada, confianza suficiente y tiempos válidos; no determina monetización.'] };
}

function automaticMuteActions(analysis, reviews = [], options = {}) {
  const minConfidence = options.minConfidence ?? 0.9;
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new RiskError('INVALID_CONFIDENCE', 'Umbral de confianza inválido.');
  }
  const manual = approvedMuteActions(analysis, reviews);
  const rules = options.rules ?? rulesDefault.rules;
  const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
  const secondaryById = new Map((options.secondaryChecks ?? []).map(item => [item.findingId, item]));
  const localById = new Map();
  for (const item of options.localChecks ?? []) {
    if (!localById.has(item.findingId)) localById.set(item.findingId, []);
    localById.get(item.findingId).push(item);
  }
  const reviewById = new Map(reviews.map((review) => [review.id, review]));
  const actions = [...manual.actions];
  const assessments = [];
  const maxMs = Number.isSafeInteger(analysis.source?.sampleCount) &&
    Number.isSafeInteger(analysis.source?.sampleRateHz) && analysis.source.sampleRateHz > 0 ?
    analysis.source.sampleCount * 1000 / analysis.source.sampleRateHz : null;
  for (const finding of analysis.findings) {
    const decision = reviewById.get(finding.id)?.decision;
    let status = 'pending';
    let reason = 'La coincidencia requiere revisión contextual.';
    if (decision === 'dismiss') { status = 'dismissed'; reason = reviewById.get(finding.id).reason; }
    else if (decision === 'approve') { status = 'manual'; reason = reviewById.get(finding.id).reason; }
    else {
      const rule = ruleById.get(finding.ruleId);
      const validTime = Number.isSafeInteger(finding.startMs) && Number.isSafeInteger(finding.endMs) &&
        finding.startMs >= 0 && finding.endMs > finding.startMs && maxMs !== null &&
        finding.endMs <= maxMs && !finding.warnings.includes('zero_duration');
      const uncertainOverlap = (options.uncertainIntervals ?? []).some((item) =>
        Number.isSafeInteger(item.startMs) && Number.isSafeInteger(item.endMs) &&
        item.startMs < finding.endMs && item.endMs > finding.startMs);
      if (!rule?.autoMute || finding.category !== 'strong_profanity') reason = 'Regla sin MUTE automático; revisar contexto.';
      else if (!validTime || uncertainOverlap) reason = 'Tiempo inválido, fuera del original o superpuesto con segmento incierto.';
      else if (finding.confidence === null || finding.confidence < minConfidence ||
          finding.warnings.includes('uncertain_transcription')) {
        const second = secondaryById.get(finding.id);
        const confirmed = finding.confidence >= 0.2 && second?.sourceVerified === true &&
          second.status === 'corroborated_by_second_pass_same_model' &&
          second.matches?.find(match => normalize(match.text) === normalize(finding.text) &&
            match.aligned && match.confidence >= 0.95 &&
            match.globalStartMs >= 0 && match.globalEndMs <= maxMs &&
            Math.abs((match.globalStartMs + match.globalEndMs - finding.startMs - finding.endMs) / 2) <= 750);
        const local = (localById.get(finding.id) ?? []).filter(item =>
          item.sourceVerified === true && item.status === 'localized_same_model');
        const supports = [12000, 18000].map(windowMs => local
          .filter(item => item.windowMs === windowMs)
          .flatMap(item => item.matches ?? [])
          .find(match => normalize(match.text) === normalize(finding.text) &&
            match.aligned === true && match.confidence >= 0.65 &&
            Number.isSafeInteger(match.globalStartMs) &&
            Number.isSafeInteger(match.globalEndMs) &&
            match.globalStartMs >= 0 && match.globalEndMs <= maxMs &&
            match.globalEndMs > match.globalStartMs));
        const threeWindows = finding.confidence >= 0.65 && supports.every(Boolean) &&
          supports[0].globalStartMs < supports[1].globalEndMs &&
          supports[1].globalStartMs < supports[0].globalEndMs &&
          supports.every(match => Math.abs((match.globalStartMs + match.globalEndMs -
            finding.startMs - finding.endMs) / 2) <= 750);
        if (confirmed) {
          status = 'automatic';
          reason = `Regla ${rule.id}: dos ventanas ASR coinciden en la palabra y tiempo; segunda confianza ≥ 0.95. Revisar por escucha porque es el mismo modelo.`;
          actions.push({ type: 'mute', approved: true,
            startMs: Math.min(finding.startMs, confirmed.globalStartMs),
            endMs: Math.max(finding.endMs, confirmed.globalEndMs),
            findingId: finding.id, ruleId: rule.id, category: finding.category,
            text: finding.text, approval: 'automatic', reason,
            timingSource: 'union_of_two_asr_windows' });
        } else if (threeWindows) {
          status = 'automatic';
          reason = `Regla ${rule.id}: tres ventanas ASR de 30, 12 y 18 s reconocen la palabra completa, con confianza >= 0,65 y tiempos solapados; mismo modelo, pendiente de escucha.`;
          actions.push({ type: 'mute', approved: true,
            startMs: Math.min(finding.startMs, ...supports.map(match => match.globalStartMs)),
            endMs: Math.max(finding.endMs, ...supports.map(match => match.globalEndMs)),
            findingId: finding.id, ruleId: rule.id, category: finding.category,
            text: finding.text, approval: 'automatic', reason,
            timingSource: 'union_of_three_asr_windows' });
        } else reason = 'Confianza ASR insuficiente o ventanas localizadas sin palabra y tiempo concordantes. Pendiente de escucha.';
      } else {
        status = 'automatic';
        reason = `Regla ${rule.id}: coincidencia completa, confianza ASR ≥ ${minConfidence} y tiempo válido; MUTE conservador, sin concluir sobre monetización.`;
        actions.push({ type: 'mute', approved: true, startMs: finding.startMs, endMs: finding.endMs,
          findingId: finding.id, ruleId: rule.id, category: finding.category, text: finding.text,
          approval: 'automatic', reason });
      }
    }
    assessments.push({ findingId: finding.id, status, reason });
  }
  return { schemaVersion: '1.0', source: analysis.source, preserveDuration: true,
    settings: { minConfidence, ruleVersion: rulesDefault.schemaVersion }, actions, assessments,
    pendingReview: assessments.filter((item) => item.status === 'pending').map((item) => item.findingId) };
}

function approvedMuteActions(analysis, reviews) {
  if (!Array.isArray(reviews)) throw new RiskError('INVALID_REVIEWS', 'Se requiere una lista de decisiones.');
  const findings = new Map(analysis.findings.map((finding) => [finding.id, finding]));
  const actions = [];
  const seen = new Set();
  for (const review of reviews) {
    if (!findings.has(review.id) || seen.has(review.id) ||
        !['approve', 'dismiss', 'review'].includes(review.decision) ||
        typeof review.reason !== 'string' || !review.reason.trim()) {
      throw new RiskError('INVALID_REVIEWS', 'Decisión de revisión inválida o duplicada.');
    }
    seen.add(review.id);
    const finding = findings.get(review.id);
    if (review.decision === 'approve') {
      if (finding.endMs <= finding.startMs || finding.warnings.includes('zero_duration')) {
        throw new RiskError('UNRELIABLE_TIME', 'Un hallazgo sin duración no se puede silenciar automáticamente.');
      }
      actions.push({ type: 'mute', approved: true, startMs: finding.startMs, endMs: finding.endMs,
        findingId: finding.id, ruleId: finding.ruleId, category: finding.category, text: finding.text,
        approval: 'manual', reason: review.reason });
    }
  }
  return { schemaVersion: '1.0', source: analysis.source, preserveDuration: true,
    actions, pendingReview: analysis.findings.filter((finding) =>
      !reviews.some((review) => review.id === finding.id && review.decision !== 'review'))
      .map((finding) => finding.id) };
}

module.exports = { analyzeRisks, approvedMuteActions, automaticMuteActions, RiskError };
