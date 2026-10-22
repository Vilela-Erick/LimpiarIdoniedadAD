# Contratos de datos

Estos contratos definen intercambio JSON entre módulos. **Probe 1.0**, **prepare 1.0** y las estructuras de la ruta de contenido descritas abajo están implementados en sus respectivos módulos. Whisper.cpp está conectado; DeepFilterNet se ensayó fuera de la CLI de producción. Los nombres de campo usan `camelCase` y cada documento lleva `schemaVersion`.

## Probe 1.0 (implementado)

```json
{
  "schemaVersion": "1.0",
  "source": { "path": "C:\\audio\\prueba.wav", "sizeBytes": 1644 },
  "audio": {
    "streams": [
      { "index": 0, "codec": "pcm_s16le", "sampleRateHz": 8000, "channels": 1, "durationMs": 100 }
    ],
    "selectedStreamIndex": 0,
    "multipleStreams": false
  },
  "timeline": { "startMs": 0, "durationMs": 100, "durationSource": "format" }
}
```

- `source.path` es una ruta absoluta; `sizeBytes` es el tamaño del archivo, no el de una pista. El sondeo no calcula todavía un hash.
- `audio.streams` incluye todas las pistas de audio válidas, en orden de `ffprobe`. Una pista válida declara códec, frecuencia de muestreo y canales. `selectedStreamIndex` señala la primera pista válida como **candidata inicial**, sin mezclar ni procesar pistas. `multipleStreams` obliga a revisar la selección antes de editar.
- `timeline.startMs` siempre es 0. `durationMs` puede ser `null` si `ffprobe` no informa una duración fiable. `durationSource` es `format`, `stream` o `unknown`. Se prefiere la duración del contenedor; si falta, se usa la máxima duración conocida de las pistas válidas. La duración de cada pista puede ser `null`.
- La CLI imprime solo este JSON en stdout cuando el sondeo termina bien. Los errores van a stderr y causan código de salida distinto de cero.

## Prepare 1.0 (implementado)

`--prepare` usa el sondeo anterior y produce un WAV y un archivo JSON con este resultado. Ejemplo abreviado:

```json
{
  "schemaVersion": "1.0",
  "source": { "path": "C:\\audio\\prueba.wav", "sizeBytes": 1644 },
  "audio": { "selectedStreamIndex": 0, "sourceCodec": "pcm_s16le", "sampleRateHz": 8000, "channels": 1 },
  "timeline": {
    "startMs": 0, "durationMs": 100, "durationSource": "format",
    "formatStartMs": 0, "streamStartMs": 0, "offsetMs": 0,
    "syncStatus": "aligned", "preparedDurationMs": 100, "durationDifferenceMs": 0
  },
  "prepared": {
    "path": "C:\\proyecto\\output\\prepared\\prueba--id.wav",
    "metadataPath": "C:\\proyecto\\output\\prepared\\prueba--id.json",
    "container": "wav", "codec": "pcm_f32le", "sampleFormat": "f32le",
    "sampleRateHz": 8000, "channels": 1, "sampleCount": 800,
    "durationMs": 100, "sizeBytes": 3280
  },
  "warnings": []
}
```

Los valores de rutas y tamaño del WAV del ejemplo son ilustrativos. `audio.selectedStreamIndex` es el índice **real** de FFprobe usado por `-map`. Si hay más de una pista, `--stream-index` es obligatorio. No se mezclan pistas.

`timeline.offsetMs = streamStartMs - formatStartMs` cuando ambos tiempos existen. Si falta alguno, `offsetMs` es `null`, `syncStatus` es `unverified` y se añade una advertencia. `aligned` solo confirma igualdad de tiempos de inicio declarados, no sincronización exacta de muestras. Un offset no nulo detectado provoca error antes de decodificar. `durationDifferenceMs` compara la duración decodificada con la declarada por la pista; puede ser `null`. Los códecs con pérdida pueden producir diferencias por padding o metadatos. No se recorta ni rellena audio automáticamente en esta fase.

`prepared.sampleCount` se valida desde la duración en muestras del WAV resultante. El archivo JSON contiene el mismo objeto impreso en stdout. Una segunda preparación con la misma identidad falla con `OUTPUT_EXISTS`; aún no existe reutilización de caché.

## Evaluation sample 1.0 (implementado)

El recorte para evaluación lee un JSON `prepare 1.0` y produce WAV y JSON en `output/samples/` con `schemaVersion`, `caseId` (`A`–`E`), `source` (ruta original, ruta del preparado, índice de pista y estado de sincronización), `interval` (`startMs`, `endMs`, `startSample`, `endSample` respecto del preparado), `sample` (rutas, códec, frecuencia, canales, muestras, duración) y `evaluationStatus: "not_evaluated"`. Los tiempos del intervalo heredan el estado de sincronización de `prepare`; si era `unverified`, no se afirma alineación exacta con el original. Los resultados de modelos y las puntuaciones humanas no forman parte de este contrato.

La fase 4B admite también `--input` para un WAV PCM s16le/f32le directo: `caseId: null`, `label` explícita, `source.preparedMetadataPath: null` y `syncStatus: "pcm_wav_sample_aligned"`. El intervalo entonces refiere a muestras del PCM original. No afirma sincronía acústica externa.

## Block run 1.0 (infraestructura experimental)

Un adaptador real debe declarar `id`, `version`, `parameters` y `run({ inputPath, outputPath, block, sampleRateHz, channels })`; puede devolver `outputOffsetSamples` y `peakMemoryBytes`. El módulo rechaza un offset declarado distinto de cero y toda variación de frecuencia, canales o cantidad de muestras. Un bloque guardado tiene `manifest.json` con `identity`, índice, límites de núcleo/contexto en muestras, SHA-256 del núcleo, `wallTimeMs`, `peakMemoryBytes` opcional y estado. El informe de unión lleva `schemaVersion`, `status: "processed_pending_listening"`, `qualityApproved: false`, `source`, `model`, `settings`, `output`, `chunks[]` y `warnings`. Este contrato no prueba calidad ni alineación acústica; no se ha producido un informe de un modelo real.

## Convención temporal compartida

Todos los intervalos de edición futuros usarán milisegundos enteros desde el inicio del original, con límite inicial incluido y final excluido: `[startMs, endMs)`. Para FFmpeg: `startSeconds = startMs / 1000` y `endSeconds = endMs / 1000`; se formatearán como segundos decimales sin redondear primero a segundos enteros. Para operaciones PCM, se convertirán a índices de muestra según la frecuencia de la pista de trabajo. Si `durationMs` es `null`, una etapa que requiera límites de duración deberá obtenerla o fallar explícitamente.

## Ruta de contenido 1.0 (módulos implementados; Whisper.cpp conectado)

- Transcripción: `schemaVersion`, `source` (ruta, SHA-256, `referenceOffsetMs`, frecuencia y muestras), `engine` (id, versión, parámetros), `chunkMs`, `overlapMs`, `language`, `segments[]`, `words[]`, `untimedWords[]`, `chunks[]`, `warnings`. Los tiempos de `segments` y `words` son milisegundos enteros relativos al original. Una palabra con tiempo nulo, invertido, fuera del fragmento o `start=end` permanece en `untimedWords[]` con el tiempo informado y no recibe duración ficticia. Las palabras válidas de whisper.cpp llevan `timingStatus: "approximate"`. Cada fragmento recuperable guarda identidad, límites del núcleo y contexto, resultado y SHA-256. La ejecución completa autorizada ahora usa `status: "complete_unverified"`: finalización técnica sin validación auditiva.

- Informe de ejecución parcial: `transcripcion.json` incluye `status: "partial_samples"`, `coverage[]`, `fullText`, segmentos, palabras, intervalos inciertos, bloques y errores. La ejecución completa guarda `transcripcion.json` y progreso en `estado.json` por bloque; un fallo conserva la caché para reanudar. `reporte.json` distingue transcripción, candidatos y MUTE efectivamente aplicado.
- Revisión y aprobación automática: `revision.json` enlaza `sourceSha256` y `transcriptSha256` con decisiones manuales opcionales (`approve`, `dismiss`, `review`). `dismiss` prevalece. Reglas `autoMute` de grosería fuerte pueden aprobar una coincidencia completa con confianza y tiempo válidos; una segunda ventana ASR de baja duración puede corroborar un candidato dudoso bajo umbrales estrictos. `mutes.json` incluye `ruleId`, `approvalType` (`automatic` o `manual`), tiempo original, tiempo de la acción, intervalo efectivo, motivo, `applied` y verificación del render. `appliedIntervals[]` y `totalMutedSamples`/`totalMutedMs` contienen exclusivamente silencios reales. Los candidatos no resueltos permanecen pendientes.
- Riesgos: `schemaVersion`, `source`, `settings` (sensibilidad, filtro de categorías y versión de reglas), `findings[]` con `id`, `category`, `severity`, `startMs`, `endMs`, `text`, `context`, `detection`, `confidence`, `decision`, `reason`, `warnings`. `confidence` es confianza ASR mínima disponible, **no** probabilidad de desmonetización. `decision` inicial es `review`; las reglas léxicas son candidatas incompletas.
- Acciones: `schemaVersion`, `source`, `preserveDuration: true`, `actions[]` con `type: "mute"`, `approved: true`, intervalo, regla, tipo de aprobación y motivo; `pendingReview[]`. Una regla automática verificada o una decisión manual explícita puede crear una acción. `cut` se rechaza en el render actual.
- Render de MUTE: `schemaVersion`, `source`, `output`, `parameters` (`marginMs`, `fadeMs`), `actions`, `intervals` unidos en muestras, `totalMutedSamples`, `totalMutedMs`, `provenance`, `warnings`. La salida PCM conserva frecuencia, canales y cantidad de muestras. El informe no acredita idoneidad publicitaria.

- Prueba técnica M05: `approval.json` exige `purpose: "technical_test"`, `approved: true`, SHA-256 del recorte, intervalo global y motivo. `mutes_prueba.json` agrega el intervalo global aplicado y `verification` con muestras no nulas dentro y modificadas fuera del intervalo más fundidos. Esta aprobación no equivale a un hallazgo de riesgo ni habilita MUTE automático de contenido.

## Estructuras reservadas (no implementadas)

| Contrato | Campos esenciales previstos |
| --- | --- |
| Resultado de separación de voces | `schemaVersion`, `source`, `model`, `tracks[]` con `role`, `path`, `startMs`, `durationMs` |
| Informe completo | `schemaVersion`, `source`, `output`, `timeline`, `actions`, `separation`, `transcription`, `risk`, `toolVersions`, `warnings` |

`mute` reemplaza muestras por silencio y mantiene duración. `cut` eliminaría tiempo y solo podría añadirse mediante una solicitud explícita futura con mapa temporal; no está disponible. Tampoco existe una opción de CLI para ejecutar el flujo completo.
