// Runs the MMS timing model in a background thread (a Web Worker). For a full song the model needs
// several minutes of computing; doing that here keeps the page responsive in the meantime.
//
// Messages from the page:  { type: "load" }  or  { type: "run", pcm: Float32Array (16 kHz mono) }
// Messages to the page:    { type: "progress", stage: "download", key, loaded, total }
//                          { type: "progress", stage: "listen", done: 0..1 }
//                          { type: "done", ... }  or  { type: "error", message }

import { AutoModelForCTC, AutoProcessor, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
import { logSoftmaxRows } from "./align.js";

env.allowLocalModels = false;
env.useBrowserCache = true; // the model is downloaded once, then read from the browser cache

// Meta's MMS forced-alignment model: wav2vec2 with about 300 million parameters, trained on more
// than 1000 languages including Armenian. The 8-bit version (about 300 MB) was the fastest in tests;
// the 4-bit one is smaller but slower in WebAssembly and gave the same times.
const MODEL = "onnx-community/mms-300m-1130-forced-aligner-ONNX";
// The model's memory use grows quickly with the length of the audio, so songs go in pieces.
const CHUNK_SECONDS = 30;

let model = null, processor = null;

async function load() {
  if (model) return;
  const progress_callback = p => {
    if (p.status === "progress" && p.file && p.total > 0) {
      self.postMessage({ type: "progress", stage: "download", key: `${p.name}/${p.file}`, loaded: p.loaded || 0, total: p.total });
    }
  };
  [model, processor] = await Promise.all([
    AutoModelForCTC.from_pretrained(MODEL, { dtype: "q8", device: "wasm", progress_callback }),
    AutoProcessor.from_pretrained(MODEL)
  ]);
}

// Returns the log-probability of every letter for every 20 ms frame of the song.
async function letterProbabilities(pcm) {
  const step = 16000 * CHUNK_SECONDS, parts = [];
  let frames = 0, vocabSize = 0, samples = 0;
  for (let start = 0; start < pcm.length; start += step) {
    const piece = pcm.subarray(start, Math.min(pcm.length, start + step));
    if (piece.length < 400) break; // shorter than one model frame
    const { logits } = await model(await processor(piece));
    vocabSize = logits.dims[2];
    frames += logits.dims[1];
    samples += piece.length;
    parts.push(Float32Array.from(logits.data));
    self.postMessage({ type: "progress", stage: "listen", done: samples / pcm.length });
  }
  if (!frames) throw Error("The song is too short.");
  const logProbs = new Float32Array(frames * vocabSize);
  let offset = 0;
  for (const part of parts) { logProbs.set(part, offset); offset += part.length; }
  logSoftmaxRows(logProbs, frames, vocabSize);
  return { logProbs, frames, vocabSize, secondsPerFrame: samples / 16000 / frames };
}

self.onmessage = async ({ data }) => {
  try {
    await load();
    if (data.type === "load") {
      self.postMessage({ type: "done" });
    } else if (data.type === "run") {
      const result = await letterProbabilities(data.pcm);
      self.postMessage({ type: "done", ...result }, [result.logProbs.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: "error", message: err?.message || String(err) });
  }
};
