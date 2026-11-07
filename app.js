import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

env.allowLocalModels = false; 
env.useBrowserCache = true;

const MODEL = "onnx-community/whisper-base_timestamped";
let transcriber = null, mediaFile = null, mediaUrl = null, blocks = [], selected = -1, selectionOverride = -1, selectionToken = 0, drag = null, timelineScale = 60;
const style = { size: 36, color: "#ffffff", outline: "#000000", outlineWidth: 0, box: false, boxColor: "#000000", boxOpacity: 0.35 };
let manualDraft = [], manualSelected = -1;
const $ = id => document.getElementById(id), media = $("media"), lyrics = $("lyrics"), video = $("video"), overlay = $("overlay"), tracks = $("tracks");

const fmt = t => { t = Math.max(0, Number(t) || 0); return `${String(Math.floor(t / 60)).padStart(2, "0")}:${(t % 60).toFixed(2).padStart(5, "0")}`; };
const normArmenian = s => s.toLowerCase().replace(/[^\u0531-\u058F\u0561-\u0587a-z0-9]/gi, " ").replace(/\s+/g, " ").trim();
const getWords = s => normArmenian(s).split(" ").filter(Boolean);

function status(text, percent = null) {
  $("status").textContent = text;
  if (percent !== null) $("progress").style.width = Math.max(0, Math.min(100, percent)) + "%";
}

function duration() {
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (blocks.at(-1)?.end || 60);
}

function clampBlock(b) {
  const d = Math.max(.2, duration());
  const start = Number.isFinite(b.start) ? Number(b.start) : 0;
  const end = Number.isFinite(b.end) ? Number(b.end) : start + 1.5;
  b.start = Math.min(d, Math.max(0, start));
  b.end = Math.min(d, Math.max(b.start + 0.05, end));
  if (b.end <= b.start) b.end = Math.min(d, b.start + 0.05);
  b.x = Number.isFinite(b.x) ? Number(b.x) : 50;
  b.y = Number.isFinite(b.y) ? Number(b.y) : 86;
  b.x = Math.min(85, Math.max(15, b.x));
  b.y = Math.min(88, Math.max(12, b.y));
}

function normalizeBlocks() {
  if (!blocks.length) return;
  blocks.sort((a, b) => a.start - b.start);
  const d = Math.max(.2, duration()), minimum = .15;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i], previous = blocks[i - 1];
    b.start = Math.max(0, Math.min(d, Number(b.start) || 0));
    if (previous && b.start < previous.end) b.start = previous.end;
    if (!Number.isFinite(b.end) || b.end <= b.start) b.end = Math.min(d, b.start + minimum);
    const next = blocks[i + 1];
    if (next && b.end > next.start) {
      b.end = Math.max(b.start + minimum * .6, Math.min(d, next.start - .02));
    }
    b.end = Math.min(d, Math.max(b.start + minimum * .6, b.end));
    clampBlock(b);
  }
}

// 1. BANDPASS AUDIO FILTER: Isolates vocal frequencies (180Hz - 3800Hz) from song backing tracks
async function extractMono16kFiltered(file) {
  status("Isolating vocals & pre-filtering audio track...", 10);
  try {
    const decoder = new AudioContext();
    try {
      const decoded = await decoder.decodeAudioData(await file.arrayBuffer());
      if (!decoded || !decoded.length) throw Error("No audio samples were decoded.");
      const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
      const mono = offline.createBuffer(1, decoded.length, decoded.sampleRate), md = mono.getChannelData(0);
      for (let i = 0; i < decoded.length; i++) {
        let v = 0;
        for (let ch = 0; ch < decoded.numberOfChannels; ch++) v += decoded.getChannelData(ch)[i];
        md[i] = v / decoded.numberOfChannels;
      }
      const source = offline.createBufferSource(), highpass = offline.createBiquadFilter(), lowpass = offline.createBiquadFilter();
      source.buffer = mono;
      highpass.type = "highpass";
      highpass.frequency.value = 180;
      lowpass.type = "lowpass";
      lowpass.frequency.value = 3800;
      source.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(offline.destination);
      source.start();
      const rendered = await offline.startRendering();
      return { pcm: rendered.getChannelData(0), sampleRate: 16000 };
    } finally {
      await decoder.close();
    }
  } catch (nativeError) {
    console.warn("Native audio decoding failed; using FFmpeg fallback.", nativeError);
    status("Preparing audio decoder fallback...", 12);
    const encoder = await loadFFmpeg();
    const inputName = "timing-source" + (file.name.match(/\.[a-z0-9]+$/i)?.[0] || ".mp4");
    await encoder.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
    await encoder.exec(["-i", inputName, "-vn", "-ac", "1", "-ar", "16000", "-af", "highpass=f=180,lowpass=f=3800", "-f", "f32le", "timing-audio.pcm"]);
    const data = await encoder.readFile("timing-audio.pcm");
    if (typeof data === "string" || !data.length) throw Error("The selected file has no decodable audio track.");
    const pcm = new Float32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / Float32Array.BYTES_PER_ELEMENT));
    return { pcm: new Float32Array(pcm), sampleRate: 16000 };
  }
}

// 2. ENERGY VAD ENGINE: Calculates RMS audio energy to find exact voice activation points
function computeEnergyProfile(pcm, sampleRate = 16000, frameMs = 30) {
  const frameSize = Math.floor(sampleRate * (frameMs / 1000));
  const numFrames = Math.floor(pcm.length / frameSize);
  const energy = new Float32Array(numFrames);
  let maxE = 0;

  for (let i = 0; i < numFrames; i++) {
    let sum = 0;
    for (let j = 0; j < frameSize; j++) {
      const val = pcm[i * frameSize + j];
      sum += val * val;
    }
    const rms = Math.sqrt(sum / frameSize);
    energy[i] = rms;
    if (rms > maxE) maxE = rms;
  }

  return { energy, frameMs, maxE: maxE || 1 };
}

function findVocalBoundary(timeSec, { energy, frameMs, maxE }, searchDir = "start", windowSec = 1.2) {
  const frameIdx = Math.floor((timeSec * 1000) / frameMs);
  const windowFrames = Math.floor((windowSec * 1000) / frameMs);
  const threshold = maxE * 0.12;

  if (searchDir === "start") {
    for (let f = Math.max(0, frameIdx - windowFrames); f <= Math.min(energy.length - 1, frameIdx + windowFrames); f++) {
      if (energy[f] >= threshold) return (f * frameMs) / 1000;
    }
  } else {
    for (let f = Math.min(energy.length - 1, frameIdx + windowFrames); f >= Math.max(0, frameIdx - windowFrames); f--) {
      if (energy[f] >= threshold) return ((f + 1) * frameMs) / 1000;
    }
  }
  return timeSec;
}

function tokenSimilarity(expected, recognized) {
  if (!expected || !recognized) return 0;
  if (expected === recognized) return 1;
  if (expected.startsWith(recognized) || recognized.startsWith(expected)) return .78;
  const rows = Array.from({ length: expected.length + 1 }, (_, i) => i);
  for (let i = 1; i <= expected.length; i++) {
    let previous = rows[0];
    rows[0] = i;
    for (let j = 1; j <= recognized.length; j++) {
      const saved = rows[j];
      rows[j] = Math.min(
        rows[j] + 1,
        rows[j - 1] + 1,
        previous + (expected[i - 1] === recognized[j - 1] ? 0 : 1)
      );
      previous = saved;
    }
  }
  return Math.max(0, 1 - rows[recognized.length] / Math.max(expected.length, recognized.length));
}

function scoreLyricWindow(expectedWords, recognizedWords) {
  const rows = Array.from({ length: expectedWords.length + 1 }, () => Array(recognizedWords.length + 1).fill(0));
  for (let i = 1; i <= expectedWords.length; i++) rows[i][0] = rows[i - 1][0] - .75;
  for (let j = 1; j <= recognizedWords.length; j++) rows[0][j] = rows[0][j - 1] - .28;
  for (let i = 1; i <= expectedWords.length; i++) {
    for (let j = 1; j <= recognizedWords.length; j++) {
      const match = tokenSimilarity(expectedWords[i - 1], recognizedWords[j - 1]);
      rows[i][j] = Math.max(
        rows[i - 1][j - 1] + match * 2 - .75,
        rows[i - 1][j] - .75,
        rows[i][j - 1] - .28
      );
    }
  }
  return rows.at(-1).at(-1);
}

// Monotonic line aligner: weak recognitions are allowed to be skipped instead
// of forcing the rest of the song onto the wrong timestamps.
function alignArmenianLyrics(lines, detectedWords, energyProfile) {
  if (!detectedWords.length) return [];
  const matches = new Array(lines.length).fill(null);
  let cursor = 0;

  lines.forEach((lineText, lineIndex) => {
    const expected = getWords(lineText);
    if (!expected.length || cursor >= detectedWords.length) return;
    const minimum = Math.max(1, expected.length - 2);
    const maximum = Math.min(detectedWords.length - cursor, expected.length + 5);
    let best = null;

    for (let start = cursor; start < detectedWords.length; start++) {
      for (let length = minimum; length <= maximum && start + length <= detectedWords.length; length++) {
        const observed = detectedWords.slice(start, start + length).map(word => normArmenian(word.w));
        const score = scoreLyricWindow(expected, observed) - Math.max(0, start - cursor) * .035;
        if (!best || score > best.score) best = { start, end: start + length - 1, score };
      }
    }

    const confidence = best && best.score / Math.max(1, expected.length) >= .12;
    if (confidence) {
      const first = detectedWords[best.start], last = detectedWords[best.end];
      const start = findVocalBoundary(first.start, energyProfile, "start");
      const end = findVocalBoundary(last.end, energyProfile, "end");
      matches[lineIndex] = { start, end: Math.max(start + .35, end) };
      cursor = best.end + 1;
    }
  });

  const totalDuration = Math.max(
    duration(),
    detectedWords.at(-1)?.end || 0,
    matches.filter(Boolean).at(-1)?.end || 0
  );
  const result = [];
  let index = 0;
  while (index < lines.length) {
    if (matches[index]) {
      result.push({ text: lines[index], ...matches[index], x: 50, y: 86 });
      index++;
      continue;
    }
    const runStart = index;
    while (index < lines.length && !matches[index]) index++;
    const previousEnd = runStart ? result.at(-1)?.end || 0 : 0;
    const nextStart = index < lines.length ? matches[index].start : totalDuration;
    const slot = Math.max(.35, (nextStart - previousEnd) / Math.max(1, index - runStart));
    for (let j = runStart; j < index; j++) {
      const start = previousEnd + (j - runStart) * slot;
      result.push({ text: lines[j], start, end: Math.min(totalDuration, start + slot), x: 50, y: 86 });
    }
  }
  return result;
}

// GUI AND EVENT HANDLERS
media.onchange = () => {
  mediaFile = media.files?.[0] || null;
  if (!mediaFile) return;
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = URL.createObjectURL(mediaFile);
  if (mediaFile.type.startsWith("video/")) {
    video.src = mediaUrl;
    video.classList.remove("hidden");
    $("emptyStage").classList.add("hidden");
    video.onloadedmetadata = () => {
      video.style.objectFit = 'contain';
      video.style.width = '100%';
      video.style.height = '100%';
      $("videoWrap").style.aspectRatio = 'auto';
      blocks.forEach(clampBlock);
      renderAll();
    };
  } else {
    $("emptyStage").textContent = "Audio loaded. Timing editor is ready.";
    video.classList.add("hidden");
    $("emptyStage").classList.remove("hidden");
  }
};

video.ontimeupdate = () => {
  renderPreview();
  updatePlayhead();
};

function createEvenlyTimedBlocks(lineTexts) {
  const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration();
  if (!Number.isFinite(total) || total <= 0) throw Error("Load a video and wait until its duration is available.");
  const slice = total / lineTexts.length;
  return lineTexts.map((text, index) => ({
    text,
    start: index * slice,
    end: index === lineTexts.length - 1 ? total : (index + 1) * slice,
    x: 50,
    y: 86
  }));
}

function correctManualTiming(fromIndex = 0) {
  const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration();
  for (let i = Math.max(0, fromIndex); i < manualDraft.length; i++) {
    const block = manualDraft[i];
    const previous = manualDraft[i - 1];
    const minimumStart = previous ? previous.end : 0;
    block.start = Math.max(minimumStart, Math.min(total, Number(block.start) || 0));
    block.end = Math.max(block.start + 0.05, Number(block.end) || block.start + 0.05);
    block.end = Math.min(total, block.end);
    if (block.end <= block.start) block.end = Math.min(total, block.start + 0.05);
  }
}

function renderManualDraft() {
  const editor = $("manualEditor");
  if (!manualDraft.length) {
    editor.innerHTML = "";
    return;
  }
  editor.innerHTML = `<div class="manual-editor">${manualDraft.map((b, i) => `<div class="manual-row${i === manualSelected ? " selected" : ""}" data-manual-row="${i}"><strong>${i + 1}</strong><textarea data-manual-text="${i}" aria-label="Text block ${i + 1}">${escapeHtml(b.text)}</textarea><input data-manual-start="${i}" type="text" inputmode="decimal" autocomplete="off" value="${b.start.toFixed(2)}" aria-label="Start time ${i + 1}"><input data-manual-end="${i}" type="text" inputmode="decimal" autocomplete="off" value="${b.end.toFixed(2)}" aria-label="End time ${i + 1}"></div>`).join("")}</div><div class="row" style="margin-top:9px"><button type="button" class="ghost grow" id="refreshManualTiming" ${manualSelected >= 0 && manualSelected < manualDraft.length - 1 ? "" : "disabled"}>Refresh following timings</button><button type="button" class="primary grow" id="manualNext">Next: create text blocks</button></div>`;
  editor.querySelectorAll("[data-manual-row]").forEach(row => {
    row.onclick = () => {
      manualSelected = Number(row.dataset.manualRow);
      editor.querySelectorAll("[data-manual-row]").forEach(item => item.classList.toggle("selected", item === row));
      $("refreshManualTiming").disabled = manualSelected < 0 || manualSelected >= manualDraft.length - 1;
    };
  });
  editor.querySelectorAll("input, textarea").forEach(input => {
    input.onclick = e => {
      e.stopPropagation();
      const row = e.target.closest("[data-manual-row]");
      if (!row) return;
      manualSelected = Number(row.dataset.manualRow);
      editor.querySelectorAll("[data-manual-row]").forEach(item => item.classList.toggle("selected", item === row));
      $("refreshManualTiming").disabled = manualSelected < 0 || manualSelected >= manualDraft.length - 1;
    };
  });
  editor.querySelectorAll("[data-manual-text]").forEach(input => {
    input.oninput = e => { manualDraft[Number(e.target.dataset.manualText)].text = e.target.value; };
  });
  editor.querySelectorAll("[data-manual-start]").forEach(input => {
    input.oninput = e => { manualDraft[Number(e.target.dataset.manualStart)].start = Math.max(0, Number(e.target.value) || 0); };
  });
  editor.querySelectorAll("[data-manual-end]").forEach(input => {
    input.oninput = e => { manualDraft[Number(e.target.dataset.manualEnd)].end = Math.max(0, Number(e.target.value) || 0); };
  });
  $("refreshManualTiming").onclick = () => {
    if (manualSelected < 0 || manualSelected >= manualDraft.length - 1) return;
    correctManualTiming(0);
    const start = manualDraft[manualSelected].end;
    const remaining = manualDraft.length - manualSelected - 1;
    const slice = Math.max(0, video.duration - start) / remaining;
    for (let i = manualSelected + 1; i < manualDraft.length; i++) {
      manualDraft[i].start = start + (i - manualSelected - 1) * slice;
      manualDraft[i].end = i === manualDraft.length - 1 ? video.duration : start + (i - manualSelected) * slice;
    }
    correctManualTiming(manualSelected + 1);
    renderManualDraft();
    status(`Refreshed timings after block ${manualSelected + 1}. Earlier timings were preserved.`, 100);
  };
  $("manualNext").onclick = () => {
    correctManualTiming();
    const valid = manualDraft.every(b => b.text.trim() && b.end > b.start);
    if (!valid) return status("Each text block needs text and an end time greater than its start time.");
    blocks = manualDraft.map(b => ({ ...b, text: b.text.trim() }));
    manualDraft = [];
    normalizeBlocks();
    selected = blocks.length ? 0 : -1;
    renderManualDraft();
    renderAll();
    status(`Created ${blocks.length} manual text blocks.`, 100);
  };
}

$("manualTiming").onclick = () => {
  const lineTexts = lyrics.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!mediaFile) return status("Choose a video or audio file first.");
  if (!lineTexts.length) return status("Paste the lyrics first.");
  if (!Number.isFinite(video.duration) || video.duration <= 0) return status("Wait for the media duration to load, then try again.");
  try {
    manualDraft = createEvenlyTimedBlocks(lineTexts);
    manualSelected = -1;
    renderManualDraft();
    status(`Prepared ${manualDraft.length} text blocks. Check the text and timings, then click Next.`, 100);
  } catch (err) {
    console.error(err);
    status(`Manual timing error: ${err.message}`, 0);
  }
};

function activeBlock() {
  return blocks.findIndex(b => video.currentTime >= b.start && video.currentTime < b.end);
}

function renderPreview() {
  const i = activeBlock();
  
  const selectedIsActive = selected >= 0 && blocks[selected] &&
    video.currentTime >= blocks[selected].start - 0.01 && video.currentTime <= blocks[selected].end + 0.01;
  const overrideIsActive = selectionOverride >= 0 && blocks[selectionOverride] &&
    video.currentTime >= blocks[selectionOverride].start && video.currentTime < blocks[selectionOverride].end;
  if (selectionOverride >= 0 && blocks[selectionOverride]) {
    selected = selectionOverride;
  } else if (!selectedIsActive && i >= 0) {
    selected = i;
    renderInspector();
    renderBlocks();
  }

  const active = blocks.filter(b => video.currentTime >= b.start && video.currentTime < b.end);

  if (!active.length) {
    overlay.classList.add("hidden");
    const previewText = $("previewText");
    if (previewText) previewText.value = "";
    return;
  }

  const selectedBlock = blocks[selected];
  const selectedIsVisible = selectedBlock &&
    video.currentTime >= selectedBlock.start - 0.01 && video.currentTime <= selectedBlock.end + 0.01;
  const b = selectedIsVisible ? selectedBlock : active[0];
  if (selectionOverride < 0 && b !== blocks[selected]) {
    selected = blocks.indexOf(b);
    renderInspector();
    renderBlocks();
  }
  const wrap = $("videoWrap").getBoundingClientRect();
  const mediaBounds = getMediaBounds();

  overlay.textContent = b.text;
  overlay.style.left = `${mediaBounds.left - wrap.left + (b.x / 100) * mediaBounds.width}px`;
  overlay.style.top = `${mediaBounds.top - wrap.top + (b.y / 100) * mediaBounds.height}px`;
  overlay.style.fontSize = (b.size ?? style.size) + "px";
  overlay.style.maxWidth = `${b.width ?? 80}%`;
  overlay.style.color = style.color;
  overlay.style.webkitTextStroke = `${style.outlineWidth}px ${style.outline}`;
  
  const boxBackground = style.box ? `rgba(${hexToRgb(style.boxColor)}, ${style.boxOpacity})` : "transparent";
  overlay.style.background = boxBackground;
  overlay.style.padding = style.box ? "6px 12px" : "0";
  overlay.style.boxShadow = style.box ? `0 0 0 1px ${style.boxColor}66 inset` : "none";
  
  overlay.classList.remove("hidden");
  overlay.classList.toggle("selected", selected >= 0 && b === blocks[selected]);
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  const num = parseInt(full, 16);
  return `${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}`;
}

function getMediaBounds() {
  const wrap = $("videoWrap").getBoundingClientRect();
  if (!video.classList.contains("hidden") && video.videoWidth && video.videoHeight) {
    const videoRatio = video.videoWidth / video.videoHeight;
    const wrapRatio = wrap.width / wrap.height;
    let w = wrap.width, h = wrap.height, l = wrap.left, t = wrap.top;
    if (wrapRatio > videoRatio) {
      w = wrap.height * videoRatio;
      l += (wrap.width - w) / 2;
    } else {
      h = wrap.width / videoRatio;
      t += (wrap.height - h) / 2;
    }
    return { left: l, top: t, width: w, height: h };
  }
  return wrap;
}

overlay.onpointerdown = e => {
  if (selected < 0) return;
  e.preventDefault();
  drag = { type: "position", startX: e.clientX, startY: e.clientY, x: blocks[selected].x, y: blocks[selected].y };
  overlay.setPointerCapture(e.pointerId);
};

overlay.onpointermove = e => {
  if (!drag || drag.type !== "position") return;
  const r = getMediaBounds();
  blocks[selected].x = drag.x + ((e.clientX - drag.startX) / r.width) * 100;
  blocks[selected].y = drag.y + ((e.clientY - drag.startY) / r.height) * 100;
  clampBlock(blocks[selected]);
  renderPreview();
  renderInspector();
};

overlay.onpointerup = () => { drag = null; };

// GENERATE TIMING MAIN FUNCTION
$("generate").onclick = async () => {
  if (!mediaFile) return status("Choose a video or audio file first.");
  if (!lyrics.value.trim()) return status("Paste the lyrics first.");
  $("generate").disabled = true;

  try {
    if (!transcriber) {
      status("Loading Whisper speech engine...", 15);
      transcriber = await pipeline("automatic-speech-recognition", MODEL, { device: "wasm", dtype: "q8" });
    }

    if (video.src && video.readyState < 1) {
      await new Promise(resolve => video.addEventListener("loadedmetadata", resolve, { once: true }));
    }

    const { pcm, sampleRate } = await extractMono16kFiltered(mediaFile);
    const energyProfile = computeEnergyProfile(pcm, sampleRate);

    status("Transcribing Armenian vocals with prompt bias...", 50);

    const lyricText = lyrics.value.trim();
    const lyricLines = lyricText.split(/\n+/).map(x => x.trim()).filter(Boolean);

    // 4. PROMPT INJECTION: Supply first ~250 chars of Armenian lyrics to Whisper prompt context
    const promptContext = lyricText.slice(0, 250);

    const opts = {
      task: "transcribe",
      language: "hy",
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: "word",
      initial_prompt: promptContext
    };

    const result = await transcriber(pcm, opts);
    
    const detectedWords = (result.chunks || [])
      .map(c => ({ w: c.text, start: Number(c.timestamp?.[0]), end: Number(c.timestamp?.[1]) }))
      .filter(x => x.w && Number.isFinite(x.start) && Number.isFinite(x.end));

    status("Aligning lyrics with DP matrix & VAD energy...", 80);

    blocks = alignArmenianLyrics(lyricLines, detectedWords, energyProfile);

    if (blocks.length) {
      blocks[0].start = 0;
      normalizeBlocks();
    }

    selected = 0;
    renderAll();
    status(`Successfully generated Armenian timing for ${blocks.length} blocks!`, 100);

  } catch (err) {
    console.error(err);
    status(`Error: ${err.message}`, 0);
  } finally {
    $("generate").disabled = false;
  }
};

function renderInspector() {
  const box = $("inspector"), b = blocks[selected];
  if (!b) { box.innerHTML = '<div class="hint">Select a block from timeline or list to inspect.</div>'; return; }
  box.innerHTML = `<div class="field"><label>Text</label><textarea id="editText" class="lyrics" style="height:70px">${escapeHtml(b.text)}</textarea></div><div class="editor-row"><label>Text size<input id="editSize" type="number" min="12" max="160" value="${b.size ?? style.size}"></label><label>Window width (%)<input id="editWidth" type="number" min="20" max="100" value="${b.width ?? 80}"></label></div><div class="editor-row" style="margin-top:8px"><label>Start (s)<input id="editStart" type="number" step=".01" value="${b.start.toFixed(2)}"></label><label>End (s)<input id="editEnd" type="number" step=".01" value="${b.end.toFixed(2)}"></label></div><div class="row" style="margin-top:8px"><button class="ghost" id="setStart">Set start here</button><button class="ghost" id="setEnd">Set end here</button></div><div class="field" style="margin-top:14px"><label>Position <span class="hint">X ${Math.round(b.x)}% · Y ${Math.round(b.y)}%</span></label><input id="posX" class="range" type="range" min="5" max="95" value="${b.x}"><input id="posY" class="range" type="range" min="5" max="95" value="${b.y}"></div><button class="danger" id="deleteSelected" style="width:100%">Delete block</button>`;
  $("editText").oninput = e => { b.text = e.target.value; renderPreview(); renderBlocks(); renderTimeline(); };
  $("editSize").oninput = e => { b.size = Math.max(12, Math.min(160, Number(e.target.value) || style.size)); renderPreview(); };
  $("editWidth").oninput = e => { b.width = Math.max(20, Math.min(100, Number(e.target.value) || 80)); renderPreview(); };
  $("editStart").oninput = e => { b.start = +e.target.value; clampBlock(b); renderTimeline(); };
  $("editEnd").oninput = e => { b.end = +e.target.value; clampBlock(b); renderTimeline(); };
  $("setStart").onclick = () => { b.start = video.currentTime; clampBlock(b); renderInspector(); renderTimeline(); };
  $("setEnd").onclick = () => { b.end = video.currentTime; clampBlock(b); renderInspector(); renderTimeline(); };
  $("posX").oninput = e => { b.x = +e.target.value; renderPreview(); };
  $("posY").oninput = e => { b.y = +e.target.value; renderPreview(); };
  $("deleteSelected").onclick = () => { blocks.splice(selected, 1); selected = -1; renderAll(); };
}

function escapeHtml(s) { return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }

function selectBlock(i, seek = true) {
  if (!blocks[i]) return;
  selected = i;
  const token = ++selectionToken;
  selectionOverride = i;
  if (seek && video.src) {
    const releaseOverride = () => {
      if (token === selectionToken) selectionOverride = -1;
    };
    video.addEventListener("seeked", releaseOverride, { once: true });
    video.currentTime = blocks[i].start;
  } else {
    selectionOverride = -1;
  }
  renderAll();
}

function sortedBlockIndices() {
  return blocks.map((block, index) => ({ block, index }))
    .sort((a, b) => a.block.start - b.block.start || a.index - b.index)
    .map(entry => entry.index);
}

function renderBlocks() {
  const box = $("blockList");
  box.innerHTML = "";
  sortedBlockIndices().forEach((i, displayIndex) => {
    const b = blocks[i];
    const el = document.createElement("div");
    el.className = "block" + (i === selected ? " selected" : "");
    el.innerHTML = `<div class="block-top"><span>#${displayIndex + 1}</span><span>${fmt(b.start)} → ${fmt(b.end)}</span></div><div class="block-text">${escapeHtml(b.text)}</div><div class="block-actions"><button class="ghost" data-play>Play line</button><button class="ghost" data-split>Split</button></div>`;
    el.onclick = e => { if (e.target.tagName === "BUTTON") return; selectBlock(i, true); };
    el.querySelector("[data-play]").onclick = () => { selectBlock(i, true); video.play(); };
    el.querySelector("[data-split]").onclick = () => { const middle = (b.start + b.end) / 2; blocks.splice(i, 0, { ...b, end: middle }); blocks[i + 1].start = middle; selected = i; renderAll(); };
    box.appendChild(el);
  });
}

function renderEditBlocks() {
  const box = $("editBlockList");
  box.innerHTML = "";
  sortedBlockIndices().forEach((i, displayIndex) => {
    const b = blocks[i], row = document.createElement("div");
    row.className = "edit-block-row" + (i === selected ? " selected" : "");
    row.innerHTML = `<strong>${displayIndex + 1}</strong><textarea aria-label="Edit text block ${displayIndex + 1}">${escapeHtml(b.text)}</textarea><input type="text" inputmode="decimal" autocomplete="off" aria-label="Edit start time ${displayIndex + 1}" value="${b.start.toFixed(2)}"><input type="text" inputmode="decimal" autocomplete="off" aria-label="Edit end time ${displayIndex + 1}" value="${b.end.toFixed(2)}">`;
    const [textInput, startInput, endInput] = row.querySelectorAll("textarea, input");
    row.onclick = e => {
      if (e.target === textInput || e.target === startInput || e.target === endInput) return;
      selectBlock(i, true);
    };
    textInput.oninput = e => { b.text = e.target.value; renderPreview(); renderBlocks(); renderTimeline(); };
    startInput.oninput = e => { b.start = Number(e.target.value); clampBlock(b); renderPreview(); renderBlocks(); renderTimeline(); };
    endInput.oninput = e => { b.end = Number(e.target.value); clampBlock(b); renderPreview(); renderBlocks(); renderTimeline(); };
    startInput.onchange = () => renderEditBlocks();
    endInput.onchange = () => renderEditBlocks();
    box.appendChild(row);
  });
}

function updatePlayhead() {
  const d = Math.max(duration(), 0.01);
  const cur = video.currentTime || 0;
  const playhead = $("playhead");
  if (playhead) {
    playhead.style.left = (cur / d * 100 || 0) + "%";
    playhead.innerHTML = `<span class="playhead-label">${fmt(cur)}</span>`;
  }
  $("clock").textContent = fmt(cur);
  $("timelineReadout").textContent = `${fmt(cur)} / ${fmt(d)}`;
  $("timelinePlay").textContent = video.paused ? "Play" : "Pause";
}

function renderTimeline() {
  const tracks = $("tracks"), ruler = $("ruler"), inner = $("timelineInner");
  tracks.querySelectorAll(".clip").forEach(x => x.remove());
  tracks.querySelectorAll(".track-row").forEach(x => x.remove());
  ruler.innerHTML = "";
  const d = Math.max(duration(), 0.01), width = Math.max(720, d * timelineScale);
  inner.style.width = width + "px";
  
  const minPixelBufferInSeconds = (14 / width) * d;

  const laneEnds = [], laneMap = new Map();
  for (const block of [...blocks].sort((a, b) => a.start - b.start)) {
    let lane = 0;
    while (lane < laneEnds.length && (laneEnds[lane] + minPixelBufferInSeconds) > block.start) {
      lane++;
    }
    laneEnds[lane] = block.end;
    laneMap.set(block, lane);
    block.lane = lane;
  }
  const totalLanes = Math.max(1, laneEnds.length);
  tracks.style.minHeight = `${Math.max(90, totalLanes * 42 + 18)}px`;
  const rows = [];
  for (let i = 0; i < totalLanes; i++) {
    const row = document.createElement("div");
    row.className = "track-row";
    tracks.appendChild(row);
    rows.push(row);
  }
  const step = d > 90 ? 10 : d > 45 ? 5 : 2;
  for (let t = 0; t <= d + 0.001; t += step) {
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.style.left = (t / d * 100) + "%";
    tick.textContent = fmt(t);
    ruler.appendChild(tick);
  }
  blocks.forEach((b, i) => {
    const lane = laneMap.get(b) || 0, row = rows[Math.min(lane, rows.length - 1)] || rows[0], el = document.createElement("div");
    el.className = "clip" + (i === selected ? " selected" : "");
    el.style.left = (b.start / d * 100) + "%";
    el.style.width = Math.max((b.end - b.start) / d * 100, 0.2) + "%";
    el.textContent = b.text;
    el.onclick = e => { if (e.target.classList.contains("handle")) return; selectBlock(i, true); };
    el.onpointerdown = e => { if (e.target.classList.contains("handle")) return; selectBlock(i); drag = { type: "move", index: i, startX: e.clientX, start: b.start, end: b.end }; };
    ["left", "right"].forEach(side => {
      const h = document.createElement("i");
      h.className = "handle " + side;
      h.onpointerdown = e => { e.stopPropagation(); drag = { type: side, index: i, startX: e.clientX, start: b.start, end: b.end }; };
      el.appendChild(h);
    });
    row.appendChild(el);
  });
  updatePlayhead();
}

function renderAll() { renderBlocks(); renderEditBlocks(); renderInspector(); renderTimeline(); renderPreview(); }

tracks.onpointermove = e => {
  if (!drag) return;
  const r = tracks.getBoundingClientRect(), delta = (e.clientX - drag.startX) / r.width * duration(), b = blocks[drag.index];
  if (!b) return;
  if (drag.type === "move") {
    const length = drag.end - drag.start;
    b.start = Math.max(0, Math.min(duration() - length, drag.start + delta));
    b.end = b.start + length;
  } else {
    const t = Math.max(0, Math.min(duration(), (e.clientX - r.left) / r.width * duration()));
    if (drag.type === "left") b.start = Math.min(t, b.end - .05);
    else if (drag.type === "right") b.end = Math.max(t, b.start + .05);
  }
  renderInspector(); renderTimeline(); renderPreview();
};
tracks.onpointerup = () => drag = null;
tracks.onpointerleave = () => drag = null;

function seekTimeline(e, element) {
  if (!video.src) return;
  const r = element.getBoundingClientRect();
  video.currentTime = Math.max(0, Math.min(duration(), (e.clientX - r.left) / r.width * duration()));
  updatePlayhead();
}
tracks.onclick = e => { if (e.target === tracks) seekTimeline(e, tracks); };
$("ruler").onclick = e => seekTimeline(e, $("ruler"));
$("timelineStart").onclick = () => { video.currentTime = 0; updatePlayhead(); };
$("timelinePlay").onclick = () => video.paused ? video.play() : video.pause();
$("timelinePrev").onclick = () => {
  const order = sortedBlockIndices(), position = order.indexOf(selected);
  if (position > 0) selectBlock(order[position - 1], true);
};
$("timelineNext").onclick = () => {
  const order = sortedBlockIndices(), position = order.indexOf(selected);
  if (position >= 0 && position < order.length - 1) selectBlock(order[position + 1], true);
};
$("timelineZoom").oninput = e => { timelineScale = Number(e.target.value); $("zoomValue").textContent = `${timelineScale} px/s`; renderTimeline(); };
$("addBlock").onclick = () => { const t = video.currentTime || 0; blocks.push({ text: "New lyric line", start: t, end: Math.min(duration(), t + 2), x: 50, y: 86 }); selected = blocks.length - 1; renderAll(); };
$("prevBlock").onclick = () => {
  const order = sortedBlockIndices(), position = order.indexOf(selected);
  if (position > 0) selectBlock(order[position - 1], true);
};
$("nextBlock").onclick = () => {
  const order = sortedBlockIndices(), position = order.indexOf(selected);
  if (position >= 0 && position < order.length - 1) selectBlock(order[position + 1], true);
};
$("loadText").onclick = () => $("textFile").click();
$("textFile").onchange = async e => { const f = e.target.files?.[0]; if (f) lyrics.value = await f.text(); };

function setActiveTab(tabName) {
  document.querySelectorAll(".tab-button").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tabName));
  document.querySelectorAll(".tab-content").forEach(panel => panel.classList.toggle("active", panel.dataset.panel === tabName));
}
document.querySelectorAll(".tab-button").forEach(btn => btn.onclick = () => setActiveTab(btn.dataset.tab));
setActiveTab("selected");

$("styleSize").oninput = e => { style.size = +e.target.value; renderPreview(); };
$("styleColor").oninput = e => { style.color = e.target.value; renderPreview(); };
$("styleOutline").oninput = e => { style.outline = e.target.value; renderPreview(); };
$("styleOutlineWidth").oninput = e => { style.outlineWidth = +e.target.value; renderPreview(); };
$("styleBox").onchange = e => { style.box = e.target.checked; renderPreview(); };
$("styleBoxColor").oninput = e => { style.boxColor = e.target.value; renderPreview(); };
$("styleBoxOpacity").oninput = e => { style.boxOpacity = +e.target.value; renderPreview(); };

function downloadFile(content, filename, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let ffmpeg=null,ffmpegLoaded=false;
async function loadFFmpeg(){
  if(ffmpegLoaded)return ffmpeg;
  status("Loading FFmpeg encoder into the browser...",2);
  const {FFmpeg}=await import("https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js");
  ffmpeg=new FFmpeg();
  ffmpeg.on("progress",({progress})=>{if(Number.isFinite(progress))status(`Converting to MP4... ${Math.round(Math.max(0,Math.min(1,progress))*100)}%`,70+progress*30)});
  const {toBlobURL}=await import("https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js");
  const baseURL="https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
  const workerBase="https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm";
  const workerSource=await (await fetch(`${workerBase}/worker.js`)).text();
  const workerModule=workerSource
    .replaceAll('"./const.js"',`"${workerBase}/const.js"`)
    .replaceAll('"./errors.js"',`"${workerBase}/errors.js"`);
  const classWorkerURL=URL.createObjectURL(new Blob([workerModule],{type:"text/javascript"}));
  try{
    await ffmpeg.load({coreURL:await toBlobURL(`${baseURL}/ffmpeg-core.js`,"text/javascript"),wasmURL:await toBlobURL(`${baseURL}/ffmpeg-core.wasm`,"application/wasm"),classWorkerURL});
  }finally{URL.revokeObjectURL(classWorkerURL)}
  ffmpegLoaded=true;
  return ffmpeg;
}

function drawSubtitleToCanvas(ctx,b,vw,vh,previewHeight){
  if(!b)return;
  const scale=Number.isFinite(previewHeight)&&previewHeight>0?vh/previewHeight:vh/1080;
  const fontSize=Math.max(12,Math.round((b.size ?? style.size)*scale));
  ctx.font=`800 ${fontSize}px Inter,system-ui,sans-serif`;ctx.textAlign="center";ctx.textBaseline="middle";
  const posX=b.x/100*vw,posY=b.y/100*vh,maxWidth=vw*((b.width ?? 80)/100),rawLines=String(b.text).split("\n"),lines=[];
  rawLines.forEach(text=>{
    const words=text.split(/\s+/),parts=[];let line="";
    words.forEach(word=>{const candidate=line?`${line} ${word}`:word;if(line&&ctx.measureText(candidate).width>maxWidth) { parts.push(line);line=word; } else line=candidate;});
    parts.push(line);
    lines.push(...parts);
  });
  const lineHeight=fontSize*1.2,totalHeight=lines.length*lineHeight;
  let maxW=0;for(const line of lines)maxW=Math.max(maxW,ctx.measureText(line).width);
  if(style.box){const padX=12*scale,padY=6*scale;ctx.fillStyle=`rgba(${hexToRgb(style.boxColor)},${style.boxOpacity})`;ctx.fillRect(posX-maxW/2-padX,posY-totalHeight/2-padY,maxW+padX*2,totalHeight+padY*2)}
  lines.forEach((line,i)=>{const lineY=posY-totalHeight/2+(i+.5)*lineHeight;if(style.outlineWidth>0){ctx.strokeStyle=style.outline;ctx.lineWidth=Math.max(1,style.outlineWidth*scale*2);ctx.lineJoin="round";ctx.strokeText(line,posX,lineY)}ctx.fillStyle=style.color;ctx.fillText(line,posX,lineY)});
}

async function recordCanvasVideo(canvas,ctx,vw,vh){
  status("Preparing media capture...",5);
  const canvasStream=canvas.captureStream(30);
  const previewHeight=getMediaBounds().height;
  status("Media capture ready...",10);
  const combinedStream=new MediaStream(canvasStream.getVideoTracks());
  const mimeType=["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"].find(m=>MediaRecorder.isTypeSupported(m));
  if(!mimeType)throw Error("This browser cannot record WebM video.");
  const recorder=new MediaRecorder(combinedStream,{mimeType,videoBitsPerSecond:30000000,audioBitsPerSecond:256000}),chunks=[];
  status("Recorder ready...",15);
  recorder.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data)};
  const stopped=new Promise((resolve,reject)=>{recorder.onstop=()=>resolve(new Blob(chunks,{type:mimeType}));recorder.onerror=e=>reject(e.error||Error("MediaRecorder export failed."))});
  const originalTime=video.currentTime;video.pause();
  if(originalTime>0.01){
    video.currentTime=0;
    await new Promise((resolve,reject)=>{video.addEventListener("seeked",resolve,{once:true});video.addEventListener("error",()=>reject(Error("Video seek failed during export.")),{once:true})});
  }
  if(video.readyState<2)await new Promise((resolve,reject)=>{video.addEventListener("loadeddata",resolve,{once:true});video.addEventListener("error",()=>reject(Error("Video could not be decoded.")),{once:true})});
  let raf=0;
  const draw=()=>{ctx.drawImage(video,0,0,vw,vh);drawSubtitleToCanvas(ctx,blocks.find(x=>video.currentTime>=x.start&&video.currentTime<x.end),vw,vh,previewHeight);if(video.duration)status(`Rendering video + subtitles... ${Math.round(video.currentTime/video.duration*100)}%`,video.currentTime/video.duration*70);if(!video.ended)raf=requestAnimationFrame(draw)};
  const finished=new Promise((resolve,reject)=>{
    const cleanup=()=>{video.removeEventListener("ended",onEnded);video.removeEventListener("error",onError)};
    const onEnded=()=>{cleanup();resolve()};
    const onError=()=>{cleanup();reject(Error("Video playback failed during export."))};
    video.addEventListener("ended",onEnded,{once:true});video.addEventListener("error",onError,{once:true});
  });
  status("Starting video playback...",20);
  const playPromise=video.play();
  if(playPromise?.catch)playPromise.catch(err=>console.warn("Video playback promise rejected:",err));
  await new Promise(resolve=>setTimeout(resolve,250));
  if(video.paused)throw Error("Video playback could not start. Click the video once, then try export again.");
  recorder.start();draw();await finished;
  cancelAnimationFrame(raf);ctx.drawImage(video,0,0,vw,vh);drawSubtitleToCanvas(ctx,blocks.find(x=>video.currentTime>=x.start&&video.currentTime<x.end),vw,vh,previewHeight);recorder.stop();
  const recordedBlob=await stopped;canvasStream.getTracks().forEach(t=>t.stop());combinedStream.getTracks().forEach(t=>t.stop());video.pause();video.currentTime=originalTime;return recordedBlob;
}

$("exportVideo").onclick=async(event)=>{
  event.preventDefault();
  event.stopPropagation();
  if(!video.src||video.classList.contains("hidden"))return status("Please load a video file first.",0);
  if(!blocks.length)return status("No timing blocks to render onto the video.",0);
  if(!window.MediaRecorder||!HTMLCanvasElement.prototype.captureStream)return status("This browser does not support video export.",0);
  const exportBtn=$("exportVideo");exportBtn.disabled=true;
  try{
    const vw=video.videoWidth,vh=video.videoHeight;if(!vw||!vh)throw Error("Could not read the original video dimensions.");
    status(`Preparing ${vw}×${vh} video export...`,0);
    const canvas=document.createElement("canvas");canvas.width=vw;canvas.height=vh;const ctx=canvas.getContext("2d",{alpha:false});if(!ctx)throw Error("Could not create export canvas.");
    const recordedBlob=await recordCanvasVideo(canvas,ctx,vw,vh);status("Loading MP4 encoder...",72);
    const enc=await loadFFmpeg(),inputName="lyrics-render.webm",sourceName="original-video",outputName="subtitled-video.mp4";
    await enc.writeFile(inputName,new Uint8Array(await recordedBlob.arrayBuffer()));
    await enc.writeFile(sourceName,new Uint8Array(await mediaFile.arrayBuffer()));
    await enc.exec(["-i",inputName,"-i",sourceName,"-map","0:v:0","-map","1:a:0?","-c:v","libx264","-preset","ultrafast","-crf","20","-pix_fmt","yuv420p","-c:a","aac","-b:a","256k","-shortest","-movflags","+faststart",outputName]);
    const data=await enc.readFile(outputName);downloadFile(new Blob([data],{type:"video/mp4"}),`subtitled-video-${vw}x${vh}.mp4`,"video/mp4");
    await enc.deleteFile(inputName);await enc.deleteFile(sourceName);await enc.deleteFile(outputName);status(`MP4 export completed: ${vw}×${vh} H.264/AAC`,100);video.currentTime=0;
  }catch(err){console.error(err);status(`Export error: ${err?.message||err}`,0);alert(`Export failed: ${err?.message||err}`)}
  finally{exportBtn.disabled=false}
};

$("saveProject").onclick = () => {
  const projectData = JSON.stringify({ blocks, style }, null, 2);
  downloadFile(projectData, "lyrics-project.json", "application/json");
};

$("loadProject").onclick = () => $("projectFile").click();
$("projectFile").onchange = async e => {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const json = JSON.parse(await f.text());
    if (json.blocks) blocks = json.blocks;
    if (json.style) Object.assign(style, json.style);
    selected = blocks.length ? 0 : -1;
    renderAll();
    status("Project loaded successfully.", 100);
  } catch (err) {
    status("Failed to parse project file.", 0);
  }
};

window.addEventListener("keydown", e => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
  if (e.code === "Space") {
    e.preventDefault();
    video.paused ? video.play() : video.pause();
  } else if (e.code === "Delete" || e.code === "Backspace") {
    if (selected >= 0) {
      blocks.splice(selected, 1);
      selected = -1;
      renderAll();
    }
  } else if (e.code === "ArrowLeft") {
    if (e.shiftKey) video.currentTime = Math.max(0, video.currentTime - 1);
    else selectBlock(Math.max(0, selected - 1), true);
  } else if (e.code === "ArrowRight") {
    if (e.shiftKey) video.currentTime = Math.min(duration(), video.currentTime + 1);
    else selectBlock(Math.min(blocks.length - 1, selected + 1), true);
  }
});
