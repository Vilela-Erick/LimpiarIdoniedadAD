# Prueba real de Whisper (20-10-2026)

## Instalación y procedencia

- Binario oficial `whisper-cli.exe` de [ggml-org/whisper.cpp, release b5454](https://github.com/ggml-org/whisper.cpp/releases/tag/b5454), commit `d1be6fde11ac6e0407606b4e42fe72d34add8037`; informa versión **1.9.5**. ZIP CPU Windows x64: 8 928 640 bytes, SHA-256 `6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb`, igual al digest de GitHub Release API. Ejecutable extraído: SHA-256 `331dba46d6427105d2b802cdbc7eae916ea1c5abf9b0d3b5cfe460d8db8e4366`.
- Modelo `ggml-base.bin` **multilingüe** (no `base.en`) desde el [repositorio de modelos utilizado por el script oficial](https://github.com/ggml-org/whisper.cpp/blob/master/models/download-ggml-model.cmd): 147 951 465 bytes, SHA-256 `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`, igual al LFS oid publicado. Ambos están solo en `cache/whisper/`; [manifiesto local](../cache/whisper/installation.json). No se instaló PyTorch ni se cambió el Python global.

## Resultados de 30 segundos

`npm.cmd run limpiar-audio -- --input "input/prueba.wav" --transcribe` reutilizó los recortes originales M05, M25 y M50. FFmpeg produjo solo derivados temporales de 16 kHz, mono y PCM s16le; cada recorte tuvo 480 000 muestras. `whisper-cli` usó español forzado (`-l es`), CPU (`-ng`) y cuatro hilos. **«Idioma es» significa configuración, no detección independiente del idioma.** Las marcas de palabra se obtuvieron agrupando subpalabras y son aproximadas.

| Recorte | Segmentos | Palabras con tiempo aproximado | Observación del texto, sin escucha | Tiempo inicial observado | Working set máximo observado |
| --- | ---: | ---: | --- | ---: | ---: |
| M05 (05:00) | 12 | 98 | Predomina texto con marcas de canto y frases poco plausibles. | 5,18 s | 323 MB |
| M25 (25:00) | 14 | 96 | Reconoce fragmentos de habla, con numerosos pasajes poco inteligibles. | 9,62 s | 337 MB |
| M50 (50:00) | 2 | 17 | Repite «no»; un tiempo informado excede el recorte y se conserva como incierto. | 22,96 s | 354 MB |

Los máximos de memoria proceden de sondeos de `WorkingSet64` cada 250–500 ms; son aproximaciones inferiores al pico real. La ejecución a través del adaptador sumó **36,834 s** de inferencia en los tres recortes. No se ha escuchado el audio para corroborar palabras o presencia de voces secundarias. El número de candidatos léxicos encontrados fue **0**, que no significa contenido seguro: las reglas son incompletas y la transcripción tiene errores visibles.

## Estado de la ejecución

Archivos en `output/runs/prueba--1cc7eb562252ef08/`: `transcripcion.json` (solo las tres ventanas; 28 segmentos, 211 palabras aproximadas y texto), `riesgos.json`, `reporte.json`, `estado.json`, `quality-review.json` y `samples/M05|M25|M50/` con transcripción y riesgos por muestra. `mutes.json` no existe porque no hay aprobaciones ni MUTE aplicado. La hora completa se detuvo con `blocked_insufficient_sample_quality` después de revisar **plausibilidad del texto**, sin afirmar evaluación perceptual. El WAV original mantiene su SHA-256 `E01D519946CA44633AD159D0D558114AB5DBD670A6790106DF947C4428D94EF0`.

La hora completa solo se activa con `--quality-review <archivo.json>` cuyo `approved` sea `true` y cuyos `sourceSha256` y `sampleTranscriptSha256` coincidan con la ejecución. La revisión actual tiene `approved: false`. Cuando haya una revisión favorable tras escucha, el módulo usaría bloques de 30 s, 1,5 s de contexto solapado, pertenencia por punto medio para deduplicar, caché por bloque/modelo/parámetros y reanudación. Esa ruta **aún no se ha ejecutado con la hora real** y no se garantiza que preserve voces en bordes sin comprobarla.
