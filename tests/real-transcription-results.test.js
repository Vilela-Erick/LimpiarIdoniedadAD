const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const run = path.join(root, 'output', 'runs', 'prueba--1cc7eb562252ef08');
const transcriptFile = path.join(run, 'transcripcion.json');
const stateFile = path.join(run, 'estado.json');

test('integración real: tres muestras tienen tiempos globales y bloqueo de calidad explícito',
  { skip: !existsSync(transcriptFile) || !existsSync(stateFile) }, () => {
    const transcript = JSON.parse(readFileSync(transcriptFile, 'utf8'));
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(transcript.status, 'partial_samples');
    assert.equal(transcript.language, 'es');
    assert.equal(transcript.languageMode, 'forced');
    assert.equal(transcript.coverage.length, 3);
    assert.equal(transcript.segments.length, 28);
    assert.ok(transcript.segments.every((segment) => segment.startMs === null ||
      transcript.coverage.some((window) => segment.startMs >= window.startMs &&
        segment.startMs < window.endMs)));
    assert.equal(state.fullTranscription, 'blocked_insufficient_sample_quality');
    assert.equal(state.musicReduction, 'pending_model');
    assert.equal(state.pipeline, 'incomplete');
    assert.equal(existsSync(path.join(run, 'mutes.json')), false);
  });
