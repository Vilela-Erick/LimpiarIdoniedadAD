# Diagnóstico de calidad M05 (20-10-2026)

El usuario escuchó `output/cleaned/muestra_deepfilter.wav`: las conversaciones quedaron muy distorsionadas y prácticamente incomprensibles. **DeepFilterNet está rechazado para esta mezcla y no es un filtro predeterminado.** El resultado anterior se conserva como evidencia, sin procesar la hora completa.

## Comparación reproducible

[Original exacto de M05](../output/comparison/M05/original.wav) es una copia byte a byte de `output/samples/M05--0b6f2705996bd1c6d104.wav` (SHA-256 `B8E84FF41427BCAA7D1BF4239A9F456CE22B0FF9B290C32B744AC9FDA6E32DC6`), recortado de `input/prueba.wav` en `[05:00, 05:30)`. [Control de conversión](../output/comparison/M05/control_conversion.wav) recorre 44,1→48→44,1 kHz y float32→s16le **sin modelo**. [Control de volumen](../output/comparison/M05/control_volumen.wav) reduce el original 13,1236 dB para compararlo a nivel medio similar con el [resultado rechazado](../output/cleaned/muestra_deepfilter.wav). No son alternativas de separación. [Comparación JSON](../output/comparison/M05/comparacion.json) contiene parámetros, hashes y métricas. No se creó `alternativa_1.wav` porque no se verificó otro motor apto.

Comandos principales, desde la raíz del proyecto:

```powershell
ffmpeg -hide_banner -loglevel error -i output/comparison/M05/original.wav -ar 48000 -c:a pcm_s16le cache/deepfilter/M05-48k.wav
cache/deepfilter/deep-filter-0.5.6-x86_64-pc-windows-msvc.exe --compensate-delay --output-dir cache/deepfilter/result cache/deepfilter/M05-48k.wav
ffmpeg -hide_banner -loglevel error -i cache/deepfilter/M05-48k.wav -ar 44100 -c:a pcm_s16le cache/deepfilter/M05-roundtrip.wav
ffmpeg -hide_banner -loglevel error -i output/comparison/M05/original.wav -af "volume=-13.1236dB" -c:a pcm_f32le output/comparison/M05/control_volumen.wav
node cache/deepfilter/diagnose-quality.js
npm.cmd test
```

La ejecución original del modelo omitió `--pf` (**postfiltro apagado**) y `--atten-lim-db`, cuyo valor predeterminado informado por el ejecutable es **100 dB** (atenuación prácticamente sin límite). Se usó `--compensate-delay`. Entrada y salida del modelo conservaron dos canales, que en M05 contienen exactamente las mismas muestras; no hubo mezcla o intercambio de canales detectable. El pico original fue 0,923 FS y el derivado 0,399 FS, con **0 muestras saturadas**.

| Comprobación | Control sin modelo | Con DeepFilterNet |
| --- | ---: | ---: |
| Frecuencia final; muestras/canal | 44,1 kHz; 1 323 000 | 44,1 kHz; 1 323 000 tras relleno final |
| Correlación directa con original, canal 1 | 0,999999999 | 0,663 |
| Relación señal/residuo tras ajustar ganancia | 85,8 dB | −1,1 dB |
| Nivel RMS, canal 1 | −17,045 dB (igual al original) | −30,169 dB |
| Segmentos de Whisper.cpp | 12, mismo texto que original | 1: `[Música]` |

En la salida bruta de DeepFilterNet con compensación faltaban **1 440 muestras a 48 kHz (30 ms)** al final. La correlación en 48 kHz tuvo máximo en desfase 0 al comienzo con compensación; sin ella apareció un retraso de +1 440 muestras. Para el derivado anterior se rellenó solamente el final, luego se convirtió a 44,1 kHz. Esto conserva la cantidad de muestras y el inicio; no prueba que cada fonema quede alineado o preservado.

**Causa delimitada:** el control de conversión conservó nivel, forma de onda y texto ASR, de modo que los datos no respaldan la conversión de frecuencia ni la reducción a 16 bits como causa principal. La alteración grande aparece después de la inferencia de DeepFilterNet; la escucha del usuario confirma que su resultado no sirve. No se aisló el mecanismo interno exacto. La supresión de componentes de voz mezclados con música/canto es una hipótesis técnica compatible con el cambio de texto y la caída de nivel, no una medición de cada hablante. La inteligibilidad previa de la entrada tampoco fue calificada por escucha en este diagnóstico; M05 original ya daba letras poco plausibles con Whisper.

## Próximo modelo

No se encontró un segundo modelo local de **habla frente a música/canto** que pueda ejecutarse con seguridad en Windows CPU y ~1,9 GiB de RAM libre. [SAM Audio](https://github.com/facebookresearch/sam-audio) es el candidato semántico más próximo: permite describir el objetivo hablado, pero su documentación recomienda CUDA, exige PyTorch y [acceso aceptado a los pesos](https://huggingface.co/facebook/sam-audio-small). No se verificó su uso en CPU con esta memoria, ni se descargó. [Demucs](https://github.com/facebookresearch/demucs) y modelos MDX de `vocals` separan voz de instrumental, pero pueden conservar cantantes; por eso no constituyen solución final sin una etapa adicional y escucha. La recomendación actual para **este equipo** es conservar el original y no generar una pista «sin música» hasta tener un modelo viable probado sobre los mismos 30 s. La rama independiente Whisper → riesgos → MUTE aprobado sigue disponible.
