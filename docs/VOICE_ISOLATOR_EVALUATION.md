# Próximo aislador de habla: evaluación acotada (20-10-2026)

**Archivo preparado localmente:** `output/comparison/M05/original.wav`, copia byte a byte del recorte `[05:00, 05:30)` de `input/prueba.wav`; SHA-256 `B8E84FF41427BCAA7D1BF4239A9F456CE22B0FF9B290C32B744AC9FDA6E32DC6`, PCM float32 estéreo 44,1 kHz, 10 584 092 bytes. No se subió ni envió a ningún servicio.

## Prueba externa propuesta: ElevenLabs Voice Isolator

La [descripción oficial](https://elevenlabs.io/docs/overview/capabilities/voice-isolator) lo orienta a aislar **habla** de ruido, música y ambiente; advierte que no está específicamente optimizado para aislar voces musicales del acompañamiento. Esto lo hace más pertinente que un extractor genérico `vocals/instrumental`, pero no garantiza conservar todos los participantes ni suprimir cantantes. Probar solo M05 y comparar por escucha con el original y con una muestra de conversación sin canto antes de considerar una integración.

- **Precio consultado:** la [tarifa API](https://elevenlabs.io/pricing/api) muestra **USD 0,12/min**; 30 s equivaldrían nominalmente a USD 0,06 antes de reglas de redondeo, plan e impuestos. La [tarifa en producto](https://elevenlabs.io/docs/overview/capabilities/voice-isolator) indica 1 000 créditos/min. Confirmar cobro real en la cuenta antes de enviar.
- **Límites:** hasta **500 MB o 1 hora** por archivo. M05 (30 s, 10,6 MB) cabe en esos límites. La [API](https://elevenlabs.io/docs/api-reference/audio-isolation/convert) recibe multipart con archivo; la clave se envía por `xi-api-key`, según su [documentación de autenticación](https://elevenlabs.io/docs/api-reference/authentication). No se creó cliente ni se guardó clave en el repositorio.
- **Privacidad:** al usarlo, la grabación se enviaría a ElevenLabs. Su [política](https://elevenlabs.io/privacy-policy) describe tratamiento de entradas y salidas, retención y posible uso para mejorar modelos; existe un [control de exclusión del uso para entrenamiento](https://elevenlabs.io/docs/help-center/legal/is-my-data-used-to-improve-eleven-labs-ai-models). Las opciones de retención especial dependen del producto y contrato; no se verificó una garantía de retención cero para este endpoint. Revisar autorización de los participantes y la configuración de la cuenta antes de cualquier carga.

**Criterio de aceptación:** escuchar cada voz principal y secundaria, música/canto residual, artefactos y volumen comparable. Verificar frecuencia, canales, muestras y desfase acustico de la salida frente a M05. No aplicar MUTE sobre el resultado externo ni promoverlo a flujo completo hasta alinear la pista con el original. La transcripción y los tiempos de riesgo siguen referidos al WAV original.

## Opciones locales

[SAM Audio](https://github.com/facebookresearch/sam-audio) puede aislar sonidos descritos por texto, pero recomienda CUDA y requiere pesos con acceso controlado; no se demostró que quepa en Windows CPU con la RAM libre local. [AudioSep](https://github.com/Audio-AGI/AudioSep) incluye inferencia CPU en código, pero depende de PyTorch y no hay medición local de memoria ni calidad para varias voces. No se instaló ninguno. Los modelos [Demucs](https://github.com/facebookresearch/demucs) de `vocals` pueden conservar canto y no resuelven por sí solos habla frente a canción.
