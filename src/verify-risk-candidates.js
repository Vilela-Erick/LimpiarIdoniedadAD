const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { createReadStream, promises: fs } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { createWhisperCppAdapter } = require('./whisper-cpp-adapter');
const { atomicJson } = require('./transcription-run');
const { inspectPcmWav } = require('./mute-audio');

const run = promisify(execFile);
const normalized = text => text.toLocaleLowerCase('es').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(file)) hash.update(block);
  return hash.digest('hex');
}

async function clipMatchesOriginal(originalPath, clipPath, startMs) {
  if (!originalPath) return false;
  const [original, clip] = await Promise.all([fs.open(originalPath, 'r'), fs.open(clipPath, 'r')]);
  try {
    const [a, b] = await Promise.all([inspectPcmWav(original), inspectPcmWav(clip)]);
    const startSample = Math.round(startMs * a.sampleRateHz / 1000);
    if (a.codec !== b.codec || a.sampleRateHz !== b.sampleRateHz || a.channels !== b.channels ||
        a.blockAlign !== b.blockAlign || b.sampleCount > 10 * a.sampleRateHz ||
        startSample + b.sampleCount > a.sampleCount) return false;
    const block = 1024 * 1024;
    for (let offset = 0; offset < b.data.bytes; offset += block) {
      const length = Math.min(block, b.data.bytes - offset);
      const left = Buffer.alloc(length);
      const right = Buffer.alloc(length);
      const [readA, readB] = await Promise.all([
        original.read(left, 0, length, a.data.offset + startSample * a.blockAlign + offset),
        clip.read(right, 0, length, b.data.offset + offset),
      ]);
      if (readA.bytesRead !== length || readB.bytesRead !== length || !left.equals(right)) return false;
    }
    return true;
  } finally { await Promise.all([original.close(), clip.close()]); }
}

async function verifyRiskCandidates(runDir, findings, transcriptSha256, options = {}) {
  const uncertain = findings.filter(f => f.category === 'strong_profanity' &&
    (f.confidence === null || f.confidence < (options.minConfidence ?? 0.9)));
  if (!uncertain.length) return [];
  const adapter = await createWhisperCppAdapter();
  const outputDir = path.join(runDir, 'verification');
  await fs.mkdir(outputDir, { recursive: true });
  const results = [];
  for (const finding of uncertain) {
    const clip = path.join(runDir, 'review-snippets', `${finding.id}.wav`);
    const file = path.join(outputDir, `${finding.id}.json`);
    let clipSha256;
    try { clipSha256 = await sha256(clip); }
    catch (error) {
      results.push({ findingId: finding.id, status: 'clip_unavailable', error: error.message });
      continue;
    }
    const identity = createHash('sha256').update(JSON.stringify({ findingId: finding.id,
      transcriptSha256, clipSha256, engine: adapter.id, version: adapter.version,
      parameters: adapter.parameters })).digest('hex');
    const clipStartMs = Math.max(0, finding.startMs - 3000);
    const sourceVerified = await clipMatchesOriginal(options.originalPath, clip, clipStartMs)
      .catch(() => false);
    if (!sourceVerified) {
      results.push({ findingId: finding.id, status: 'clip_source_unverified',
        reason: 'El recorte no coincide muestra por muestra con el original.', matches: [] });
      continue;
    }
    const assessMatches = (matches = []) => matches.map(match => ({ ...match,
      globalStartMs: clipStartMs + match.startMs,
      globalEndMs: clipStartMs + match.endMs,
      aligned: Number.isSafeInteger(match.startMs) && Number.isSafeInteger(match.endMs) &&
        match.endMs > match.startMs && clipStartMs + match.startMs < finding.endMs &&
        clipStartMs + match.endMs > finding.startMs }));
    let cached;
    try { cached = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cached?.identity === identity) {
      const enriched = { ...cached, clipStartMs, sourceVerified, matches: assessMatches(cached.matches) };
      delete enriched.decision;
      if (cached.decision !== undefined || cached.clipStartMs === undefined ||
          cached.sourceVerified === undefined) await atomicJson(file, enriched);
      results.push({ ...enriched, reused: true });
      continue;
    }
    const scratch = path.join(outputDir, `.tmp-${randomUUID()}.wav`);
    let result;
    try {
      await run(options.ffmpegPath ?? 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
        '-n', '-i', clip, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', scratch],
      { windowsHide: true, timeout: 60000, maxBuffer: 262144 });
      const raw = await adapter.run({ inputPath: scratch });
      const expected = normalized(finding.text);
      const matches = assessMatches(raw.segments.flatMap(s => s.words ?? []).filter(w =>
        normalized(w.text) === expected).map(w => ({ text: w.text, startMs: w.startMs,
        endMs: w.endMs, confidence: w.confidence })));
      result = { schemaVersion: '1.0', identity, findingId: finding.id, clipSha256,
        clipStartMs, sourceVerified, engine: adapter.id, model: adapter.parameters.model, wallTimeMs: raw.wallTimeMs,
        transcript: raw.segments.map(s => s.text).join(' ').trim(), matches,
        status: matches.length ? 'corroborated_by_second_pass_same_model' :
          'not_corroborated_by_second_pass',
        reason: 'La segunda pasada usa el mismo modelo y no verifica por sí sola la audibilidad ni el tiempo original.' };
    } catch (error) {
      result = { schemaVersion: '1.0', identity, findingId: finding.id,
        status: 'verification_failed', error: error.message };
    } finally { await fs.rm(scratch, { force: true }); }
    await atomicJson(file, result);
    results.push(result);
  }
  return results;
}

module.exports = { verifyRiskCandidates };
