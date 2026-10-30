/* Whisper inside the browser, for a device that has no PC to write its words (the tablet). It runs in a
   worker so the page stays smooth, with transformers.js (Hugging Face) from a pinned version on jsDelivr; the
   model is downloaded from Hugging Face ONCE and kept by the browser (the Cache API), so only the first use
   is slow. The recording never leaves the device for this: it is decoded, listened to and written out here.

   Messages in:   {type: 'load', model}                                  get the model ready (downloads the first time)
                  {type: 'run', id, model, audio: Float32Array}          16 kHz mono samples -> words
   Messages out:  {type: 'progress', p}  {type: 'ready', device}  {type: 'result', id, chunks, text}  {type: 'error', id, message}

   The words it gives are a first DRAFT: this model is small. The PC writes a more accurate version, with
   Whisper medium, whenever it is on. */
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

env.allowLocalModels = false;

let asr = null;
let device = '';
let loading = null;

function progress(p) { postMessage({ type: 'progress', p: p }); }

async function make(model, opts) {
  return pipeline('automatic-speech-recognition', model, Object.assign({ progress_callback: progress }, opts));
}

function load(model) {
  if (asr) return Promise.resolve(asr);
  if (loading) return loading;
  /* Plain WebAssembly, 8-bit weights: about 77 MB for the base model, the same on every tablet. (The graphics
     chip is several times faster but needs 200+ MB of other weights and is not on every tablet; a draft does
     not need it.) */
  loading = make(model, { device: 'wasm', dtype: 'q8' }).then(function (p) { asr = p; device = 'wasm'; return p; });
  loading.then(function () { loading = null; }, function () { loading = null; });
  return loading;
}

self.onmessage = async function (e) {
  const m = e.data || {};
  try {
    if (m.type === 'load') {
      await load(m.model);
      postMessage({ type: 'ready', device: device });
    } else if (m.type === 'run') {
      const a = await load(m.model);
      const out = await a(m.audio, { language: 'english', task: 'transcribe', return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 });
      postMessage({ type: 'result', id: m.id, chunks: out.chunks || [], text: out.text || '', device: device });
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
