#!/usr/bin/env node

const path = require('node:path');
const { promises: fs } = require('node:fs');
const { createWhisperCppAdapter } = require('./whisper-cpp-adapter');
const { transcribeChunks } = require('./transcription');
const { atomicJson } = require('./transcription-run');

async function main() {
  const inputPath = path.resolve(process.argv[2] ?? 'input/prueba.wav');
  const runDir = path.resolve(process.argv[3] ?? 'output/runs/prueba-content-20261020');
  await fs.mkdir(runDir, { recursive: true });
  const statePath = path.join(runDir, 'estado.json');
  const state = { schemaVersion: '1.0', transcription: 'running', completedBlocks: 0,
    totalBlocks: null, riskAnalysis: 'pending', mute: 'pending_approvals', errors: [] };
  await atomicJson(statePath, state);
  try {
    const adapter = await createWhisperCppAdapter();
    const transcript = await transcribeChunks({ inputPath, adapter, chunkMs: 30000,
      overlapMs: 1500, cacheRoot: path.resolve('cache/transcription-real'),
      onProgress: async ({ completed, total, reused }) => {
        state.completedBlocks = completed;
        state.totalBlocks = total;
        await atomicJson(statePath, state);
        process.stderr.write(`Bloques: ${completed}/${total}${reused ? ' (caché)' : ''}\n`);
      } });
    transcript.status = 'complete_unverified';
    transcript.languageMode = 'forced';
    transcript.fullText = transcript.segments.map((s) => s.text).join(' ').trim();
    transcript.uncertainIntervals = transcript.segments.filter((s) => s.timingStatus !== 'reported')
      .map((s) => ({ startMs: s.startMs, endMs: s.endMs, reason: 'invalid_segment_time' }));
    transcript.errors = [];
    await atomicJson(path.join(runDir, 'transcripcion.json'), transcript);
    state.transcription = 'complete_unverified';
    state.segments = transcript.segments.length;
    state.words = transcript.words.length;
    state.untimedWords = transcript.untimedWords.length;
    await atomicJson(statePath, state);
    process.stdout.write(`${JSON.stringify({ runDir, ...state })}\n`);
  } catch (error) {
    state.transcription = 'failed_recoverable';
    state.errors.push({ code: error.code ?? 'UNKNOWN', message: error.message });
    await atomicJson(statePath, state);
    process.stderr.write(`${error.code ?? 'UNKNOWN'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
