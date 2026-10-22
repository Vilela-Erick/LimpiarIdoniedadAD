# Prueba conjunta M05 (20-10-2026)

M05 es el recorte real `[05:00, 05:30)` de `input/prueba.wav`, WAV PCM float32 estéreo a 44,1 kHz, 1 323 000 muestras por canal. El SHA-256 del original completo se mantuvo en `E01D519946CA44633AD159D0D558114AB5DBD670A6790106DF947C4428D94EF0`.

## Mejora de habla frente a ruido

No había separador instalado. Se descargó el [ejecutable oficial DeepFilterNet v0.5.6 para Windows x64](https://github.com/Rikorose/DeepFilterNet/releases/tag/v0.5.6) (26 912 256 bytes, SHA-256 `75e11fa16445f560cb6b021521ddb89e89270d13b83089705d98776f58fd7915`) a `cache/deepfilter/`. El binario confirmó `deep_filter 0.5.6`; no requirió PyTorch. Su [documentación oficial](https://github.com/Rikorose/DeepFilterNet#deep-filter) lo describe como **supresión de ruido para mejorar habla** a 48 kHz, no como separador semántico de canto y conversación.

Se convirtió solo M05 a PCM s16le estéreo a 48 kHz y se ejecutó `deep-filter --compensate-delay`. Tiempo observado: 4,846 s; mayor working set observado: 81 326 080 bytes (sondeo cada 100 ms, no pico garantizado). El WAV bruto produjo 1 438 560 muestras frente a 1 440 000 de entrada: faltan 30 ms al final. La correlación del primer canal en los segundos 1–8 tuvo máximo en desfase 0 con compensación (`r≈0,597`); sin compensación, el máximo fue a +1 440 muestras. Un derivado para evaluación rellena exclusivamente ese extremo final y vuelve a 44,1 kHz: [muestra_deepfilter.wav](../output/cleaned/muestra_deepfilter.wav), 1 323 000 muestras/canal. Igual número de muestras y correlación no prueban fidelidad perceptual ni preservación de cada voz.

El volumen medio de M05 pasó de −17,0 a −30,2 dB según FFmpeg. **Bajar el volumen no demuestra quitar música.** Whisper.cpp sobre el original produjo 12 segmentos, mayormente canto y texto dudoso; sobre el derivado, uno: `[Música]`. Se ensayó M25 como control adicional de conservación de habla: 14 segmentos ASR en el original frente a uno `[Música]` en el derivado; ejecución DeepFilterNet 4,650 s, working set observado 80 334 848 bytes. No se escucharon las pistas, así que no puede afirmarse qué voces se perdieron ni cuánta música queda. El control ASR sí impide aprobar este modelo para el objetivo conjunto en estas condiciones.

## Contenido y exportación

Se reutilizó la transcripción real de M05 con tiempos globales 300 000–330 000 ms y Whisper base multilingüe, español forzado. `risk-analysis.js` obtuvo **0 candidatos léxicos** a sensibilidad media; el texto erróneo y las reglas incompletas impiden inferir seguridad publicitaria. `content-flow.js` devolvió `awaiting_review`; `approvedMuteActions` no produjo acciones. No se llamó a `renderMute`, no se creó `mutes.json` ni `muestra_final.wav`. Tampoco se creó `muestra_sin_musica.wav`: DeepFilterNet ejecutó una mejora real, pero no hay prueba suficiente de eliminación musical con voces conservadas.

Los artefactos de la prueba están en `output/runs/joint-M05--deepfilter-0.5.6/`: `transcripcion.json`, `riesgos.json` y `reporte.json`. Este último separa los estados de mejora, riesgos, MUTE y exportación. La prueba conjunta queda **incompleta** hasta escuchar original/derivado, escoger un modelo que preserve conversación frente a música y revisar cualquier hallazgo con tiempo fiable.

**Actualización tras escucha del usuario:** el derivado DeepFilterNet distorsiona las conversaciones hasta hacerlas prácticamente incomprensibles. Queda rechazado para esta mezcla y no se usará como filtro predeterminado. El [diagnóstico posterior](QUALITY_DIAGNOSIS_M05.md) conserva el resultado anterior y añade controles de conversión y volumen.
