const { promises: fs } = require('node:fs');
const path = require('node:path');

const normalize = value => value.toLocaleLowerCase('es').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function loadLocalRiskEvidence(runDir, findings, transcript, transcriptSha256) {
  const evidence = [];
  const rate = transcript.source.sampleRateHz;
  const maxMs = transcript.source.sampleCount * 1000 / rate;
  for (const finding of findings) {
    for (const windowMs of [12000, 18000]) {
      const file = path.join(runDir, 'local-review', `${finding.id}-${windowMs / 1000}s.json`);
      let item;
      try { item = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const anchored = item.findingId === finding.id &&
        item.sourceSha256 === transcript.source.sha256 &&
        item.transcriptSha256 === transcriptSha256 &&
        item.engine === transcript.engine.id && item.engineVersion === transcript.engine.version &&
        item.modelSha256 === transcript.engine.parameters.modelSha256 &&
        item.windowMs === windowMs && Number.isSafeInteger(item.startSample) &&
        item.startSample >= 0 && item.endSample - item.startSample === windowMs * rate / 1000 &&
        item.endSample <= transcript.source.sampleCount &&
        item.startMs === Math.round(item.startSample * 1000 / rate) &&
        Math.abs(item.startMs + windowMs / 2 - (finding.startMs + finding.endMs) / 2) <= 500 &&
        Array.isArray(item.matches);
      const matches = anchored ? item.matches.filter(match =>
        normalize(match.text) === normalize(finding.text) &&
        Number.isSafeInteger(match.startMs) && Number.isSafeInteger(match.endMs) &&
        match.startMs >= 0 && match.endMs > match.startMs && match.endMs <= windowMs &&
        match.globalStartMs === item.startMs + match.startMs &&
        match.globalEndMs === item.startMs + match.endMs && match.globalEndMs <= maxMs &&
        Number.isFinite(match.confidence) && match.confidence >= 0 && match.confidence <= 1)
        .map(match => ({ ...match, aligned: match.globalStartMs < finding.endMs &&
          match.globalEndMs > finding.startMs })) : [];
      evidence.push({ findingId: finding.id, windowMs, sourceVerified: anchored,
        status: anchored ? 'localized_same_model' : 'invalid_provenance', matches, reportPath: file });
    }
  }
  return evidence;
}

module.exports = { loadLocalRiskEvidence };
