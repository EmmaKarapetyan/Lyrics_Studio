// Lyrics Studio: a browser-only editor for timed lyrics.
//
// Everything runs on the user's device:
// - AI timing: forced alignment of the known lyrics with Meta's MMS model (transformers.js,
//   WebAssembly) in a background thread, see aligner-worker.js and align.js
// - the timeline editor
// - video export: the video and the subtitles are drawn on a canvas and recorded with
//   MediaRecorder, then converted to MP4 with FFmpeg compiled to WebAssembly

import { tokenizeLines, ctcAlign, lineConfidence } from "./align.js";

const STORAGE_KEY = "lyricsStudio.session.v1";
const STEPS_HIDDEN_KEY = "lyricsStudio.stepsHidden";
// Size of the exported video when the source is an audio file (lyrics on a black background)
const AUDIO_EXPORT_WIDTH = 1920, AUDIO_EXPORT_HEIGHT = 1080;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Each block is one subtitle line: { text, start, end, x, y, size?, width? }.
// start and end are in seconds; x and y are the centre of the text in % of the video frame.
let blocks = [];
let selected = -1;
// While the video seeks to a line the user picked, keep that line selected instead of
// the one that happens to be under the playhead during the seek.
let selectionOverride = -1, selectionToken = 0;
let drag = null;
let timelineScale = 60; // pixels per second
let mediaFile = null, mediaUrl = null;
let savedMediaName = ""; // file name from a restored session or project, shown as a reminder
let manualDraft = [], manualSelected = -1;
const style = { size: 36, color: "#ffffff", outline: "#000000", outlineWidth: 0, box: false, boxColor: "#000000", boxOpacity: 0.35 };

const $ = id => document.getElementById(id);
const media = $("media"), lyrics = $("lyrics"), video = $("video"), overlay = $("overlay"), tracks = $("tracks");
const timelineBox = document.querySelector(".timeline");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const fmt = t => { t = Math.max(0, Number(t) || 0); return `${String(Math.floor(t / 60)).padStart(2, "0")}:${(t % 60).toFixed(2).padStart(5, "0")}`; };

// The lyric lines from the Lyrics box. Section tags such as "[Chorus]" (common in lyrics from AI
// song tools) are not sung, so they are skipped.
const lyricLines = () => lyrics.value.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^\[[^\]]*\]$/.test(line));
const shorten = (s, n = 40) => { s = String(s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const baseName = name => String(name || "").replace(/\.[^.]+$/, "").trim() || "lyrics";

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; } // storage full or disabled
}

function status(text, percent = null) {
  $("status").textContent = text;
  if (percent !== null) $("progress").style.width = Math.max(0, Math.min(100, percent)) + "%";
}

// Length of the song: the media duration, or the end of the last line if no media is loaded yet.
function duration() {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  const ends = blocks.map(b => b.end).filter(Number.isFinite);
  return ends.length ? Math.max(...ends) : 60;
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

// Sorts the lines by time and removes overlaps, keeping every line at least a short moment long.
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

// Turns lines from a project file or the autosave into valid blocks. Unlike clampBlock it does not
// limit the times to the current media, because the song may not be loaded yet.
function sanitizeBlocks(list) {
  if (!Array.isArray(list)) return [];
  const number = value => (value === null || value === "" || value === undefined ? NaN : Number(value));
  return list.filter(b => b && typeof b === "object").map(b => {
    const start = Math.max(0, number(b.start) || 0);
    const end = number(b.end) > start ? number(b.end) : start + 1.5;
    const x = Number.isFinite(number(b.x)) ? number(b.x) : 50;
    const y = Number.isFinite(number(b.y)) ? number(b.y) : 86;
    const block = { text: String(b.text ?? ""), start, end, x: Math.min(85, Math.max(15, x)), y: Math.min(88, Math.max(12, y)) };
    if (Number.isFinite(number(b.size))) block.size = Math.min(160, Math.max(12, number(b.size)));
    if (Number.isFinite(number(b.width))) block.width = Math.min(100, Math.max(20, number(b.width)));
    if (b.unsure === true) block.unsure = true;
    return block;
  });
}

function escapeHtml(s) { return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  const num = parseInt(full, 16);
  return `${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}`;
}

// ---------------------------------------------------------------------------
// Undo and redo
// ---------------------------------------------------------------------------

// Every change to the lines first saves the previous lines here, so it can be undone.
const undoStack = [], redoStack = [];
const snapshot = () => JSON.stringify(blocks);

function pushUndo(state = snapshot()) {
  if (undoStack.at(-1) === state) return;
  undoStack.push(state);
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}

function restoreBlocks(state) {
  blocks = JSON.parse(state);
  if (selected >= blocks.length) selected = blocks.length - 1;
  renderAll();
}

function undo() {
  const current = snapshot();
  // A saved state can equal the current one, for example when a field got focus but was not changed.
  while (undoStack.length && undoStack.at(-1) === current) undoStack.pop();
  if (!undoStack.length) { updateUndoButtons(); return status("Nothing to undo."); }
  redoStack.push(current);
  restoreBlocks(undoStack.pop());
  updateUndoButtons();
  status("Undone. Press Redo to go forward again.");
}

function redo() {
  if (!redoStack.length) return status("Nothing to redo.");
  undoStack.push(snapshot());
  restoreBlocks(redoStack.pop());
  updateUndoButtons();
  status("Redone.");
}

function updateUndoButtons() {
  $("undo").disabled = !undoStack.length;
  $("redo").disabled = !redoStack.length;
}

$("undo").onclick = undo;
$("redo").onclick = redo;

// Text and number fields: remember the lines when a field gets focus and save them as an undo
// step on the first change, so one Undo reverts the whole edit of that field.
let fieldSnapshot = null;
document.addEventListener("focusin", e => {
  fieldSnapshot = e.target.matches?.("input, textarea") && e.target.closest("#inspector, #editBlockList") ? snapshot() : null;
});
document.addEventListener("input", e => {
  if (fieldSnapshot && e.target.closest?.("#inspector, #editBlockList")) {
    pushUndo(fieldSnapshot);
    fieldSnapshot = null;
  }
}, true);

// Asks before AI timing or Split evenly replaces lines the user may have corrected by hand.
function confirmReplace() {
  return !blocks.length || confirm(`This replaces your ${blocks.length} timed lines. You can undo it afterwards. Continue?`);
}

// ---------------------------------------------------------------------------
// Loading the video or song
// ---------------------------------------------------------------------------

media.onchange = () => {
  const file = media.files?.[0];
  if (file) loadMedia(file);
};

// Optional vocals-only file (for example a stem from Suno). AI timing listens to it instead of the
// full song, because music under the voice is the main reason timing goes wrong.
let vocalsFile = null;
$("vocals").onchange = () => {
  vocalsFile = $("vocals").files?.[0] || null;
  if (vocalsFile) status(`AI timing will listen to "${vocalsFile.name}". The video keeps the full song.`);
};

function loadMedia(file) {
  // A vocals file from the previous song would time the wrong song.
  const clearedVocals = Boolean(vocalsFile);
  if (clearedVocals) {
    vocalsFile = null;
    $("vocals").value = "";
  }
  mediaFile = file;
  savedMediaName = file.name;
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = URL.createObjectURL(file);
  const isAudio = file.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i.test(file.name);
  // A <video> element plays audio files too. For a song without video, the preview shows the
  // lyrics on black, the same way the exported video will look.
  video.src = mediaUrl;
  video.classList.remove("hidden");
  $("emptyStage").classList.add("hidden");
  $("videoWrap").classList.toggle("audio-only", isAudio);
  status(`Loading ${file.name}...`);
  video.onloadedmetadata = () => {
    $("videoWrap").style.aspectRatio = video.videoWidth ? "auto" : "16 / 9";
    blocks.forEach(clampBlock);
    renderAll();
    status((blocks.length
      ? `${file.name} is ready. Your ${blocks.length} lines are on the timeline.`
      : `${file.name} is ready (${fmt(video.duration)}). Paste the lyrics, then time them.`)
      + (clearedVocals ? " The vocals-only file was cleared because the song changed." : ""));
  };
  video.onerror = () => status(`This browser cannot play ${file.name}. Try an MP4 video or an MP3 song.`, 0);
}

video.ontimeupdate = () => {
  renderPreview();
  updatePlayhead();
};

// timeupdate fires only about four times a second. While playing, redraw on every frame so the
// subtitle changes exactly on time, which matters when checking the timing.
function playbackLoop() {
  if (video.paused || video.ended) return;
  // While a line is held in Tap along, it stays on screen until the button is released.
  if (tap?.holding) blocks[tap.order[tap.position]].end = video.currentTime + 0.05;
  renderPreview();
  updatePlayhead();
  requestAnimationFrame(playbackLoop);
}
video.addEventListener("play", () => { updatePlayhead(); requestAnimationFrame(playbackLoop); });
video.addEventListener("pause", updatePlayhead);

function playVideo() {
  if (!video.src) return status("Choose a video or audio file first.");
  video.play().catch(err => status(`Playback could not start: ${err.message}`));
}

function togglePlay() {
  if (!video.src) return status("Choose a video or audio file first.");
  if (video.paused) playVideo(); else video.pause();
}

function seekBy(seconds) {
  if (!video.src) return;
  video.currentTime = Math.max(0, Math.min(duration(), video.currentTime + seconds));
  updatePlayhead();
}

// On a phone the preview is far below the Source panel, so bring it into view after timing.
function revealPreview() {
  const r = $("videoWrap").getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight) $("videoWrap").scrollIntoView({ behavior: "smooth", block: "center" });
}

function setTimingButtonsDisabled(disabled) {
  $("generate").disabled = disabled;
  $("manualTiming").disabled = disabled;
}

// ---------------------------------------------------------------------------
// Split evenly: a draft that can be edited before it becomes the timeline
// ---------------------------------------------------------------------------

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

// Keeps the draft in order: every line starts after the previous one ends and lasts a little.
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
  editor.innerHTML = `<div class="manual-editor"><div class="list-head"><span>#</span><span>Text</span><span>Start (s)</span><span>End (s)</span></div>${manualDraft.map((b, i) => `<div class="manual-row${i === manualSelected ? " selected" : ""}" data-manual-row="${i}"><strong>${i + 1}</strong><textarea data-manual-text="${i}" aria-label="Text of line ${i + 1}">${escapeHtml(b.text)}</textarea><input data-manual-start="${i}" type="text" inputmode="decimal" autocomplete="off" value="${b.start.toFixed(2)}" aria-label="Start time of line ${i + 1}"><input data-manual-end="${i}" type="text" inputmode="decimal" autocomplete="off" value="${b.end.toFixed(2)}" aria-label="End time of line ${i + 1}"></div>`).join("")}</div><div class="row" style="margin-top:9px"><button type="button" class="ghost grow" id="refreshManualTiming" ${manualSelected >= 0 && manualSelected < manualDraft.length - 1 ? "" : "disabled"}>Re-split the lines after the selected one</button><button type="button" class="primary grow" id="manualNext">Next: put the lines on the timeline</button></div>`;
  const selectRow = row => {
    manualSelected = Number(row.dataset.manualRow);
    editor.querySelectorAll("[data-manual-row]").forEach(item => item.classList.toggle("selected", item === row));
    $("refreshManualTiming").disabled = manualSelected < 0 || manualSelected >= manualDraft.length - 1;
  };
  editor.querySelectorAll("[data-manual-row]").forEach(row => {
    row.onclick = () => selectRow(row);
  });
  editor.querySelectorAll("input, textarea").forEach(input => {
    input.onclick = e => {
      e.stopPropagation();
      const row = e.target.closest("[data-manual-row]");
      if (row) selectRow(row);
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
  // Keeps the lines up to the selected one and splits the remaining time evenly among the rest.
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
    status(`Re-split the lines after line ${manualSelected + 1}. Earlier lines were kept.`, 100);
  };
  $("manualNext").onclick = () => {
    correctManualTiming();
    const valid = manualDraft.every(b => b.text.trim() && b.end > b.start);
    if (!valid) return status("Each line needs text and an end time after its start time.");
    pushUndo();
    blocks = manualDraft.map(b => ({ ...b, text: b.text.trim() }));
    manualDraft = [];
    normalizeBlocks();
    selected = blocks.length ? 0 : -1;
    renderManualDraft();
    renderAll();
    revealPreview();
    status(`Put ${blocks.length} lines on the timeline. Play the video and drag any line that is off.`, 100);
  };
}

$("manualTiming").onclick = () => {
  const lineTexts = lyricLines();
  if (!mediaFile) return status("Choose a video or audio file first.");
  if (!lineTexts.length) return status("Paste the lyrics first.");
  if (!Number.isFinite(video.duration) || video.duration <= 0) return status("Wait a moment until the file has loaded, then try again.");
  if (!confirmReplace()) return;
  try {
    manualDraft = createEvenlyTimedBlocks(lineTexts);
    manualSelected = -1;
    renderManualDraft();
    status(`Split the song into ${manualDraft.length} equal lines. Check the text and times below, then click Next.`, 100);
  } catch (err) {
    console.error(err);
    status(`Could not split the lines: ${err.message}`, 0);
  }
};

// ---------------------------------------------------------------------------
// Tap along: hold a button (or Space) while each line is sung
// ---------------------------------------------------------------------------

// People press and let go a little after they hear the change, so both times move back this much.
const TAP_REACTION_SECONDS = 0.15;
// While tapping: the lines in time order, the one being timed, and the lines not timed yet
// (hidden from the preview so old times do not flash up).
let tap = null; // { order, position, holding, pending: Set of block indices }

function startTapAlong() {
  if (!mediaFile) return status("Choose a video or audio file first.");
  if (!Number.isFinite(video.duration) || video.duration <= 0) return status("Wait a moment until the file has loaded, then try again.");
  const lineTexts = lyricLines();
  const sameLines = blocks.length && lineTexts.join("\n") === sortedBlockIndices().map(i => blocks[i].text).join("\n");
  if (!sameLines) {
    // Start from the Lyrics box, like the other timing buttons.
    if (!lineTexts.length) return status("Paste the lyrics first.");
    if (!confirmReplace()) return;
    pushUndo();
    blocks = createEvenlyTimedBlocks(lineTexts);
    selected = 0;
  } else {
    pushUndo();
  }
  manualDraft = [];
  renderManualDraft();
  const order = sortedBlockIndices();
  // With existing lines, tapping can start at the selected line, so one part of the song can be
  // redone. The selected line also changes by itself while the video plays, so ask first.
  let position = sameLines ? Math.max(0, order.indexOf(selected)) : 0;
  if (position > 0 && !confirm(`Start tapping from line ${position + 1}, "${shorten(blocks[order[position]].text)}"?\n\nOK: start from this line. The lines before it keep their times.\nCancel: start from the first line.`)) {
    position = 0;
  }
  tap = { order, position, holding: false, pending: new Set(order.slice(position)) };
  video.playbackRate = Number($("tapSpeed").value) || 1;
  video.currentTime = position === 0 ? 0 : Math.max(0, blocks[order[position]].start - 3);
  document.activeElement?.blur?.();
  document.body.classList.add("tapping");
  $("tapBar").classList.remove("hidden");
  renderAll();
  updateTapBar();
  // On a phone the preview is below the buttons; show it, so the subtitles can be seen while tapping.
  $("videoWrap").scrollIntoView({ behavior: "smooth", block: "start" });
  playVideo();
  status(`Tapping from line ${position + 1}. Hold the button (or Space) while each line is sung, and let go when it ends. Stop or Esc ends tapping.`);
}

function updateTapBar() {
  if (!tap) return;
  const b = blocks[tap.order[tap.position]];
  $("tapProgress").textContent = `Line ${tap.position + 1} of ${tap.order.length}${tap.holding ? " · singing" : " · next"}`;
  $("tapNext").textContent = b ? b.text : "";
  $("tapButton").classList.toggle("holding", tap.holding);
  $("tapButton").textContent = tap.holding ? "Let go when the line ends" : "Hold while the line is sung";
}

const tapTime = () => Math.max(0, video.currentTime - TAP_REACTION_SECONDS * video.playbackRate);

function tapDown() {
  if (!tap || tap.holding || tap.position >= tap.order.length) return;
  if (video.paused) playVideo();
  const index = tap.order[tap.position];
  tap.holding = true;
  tap.pending.delete(index);
  delete blocks[index].unsure;
  blocks[index].start = tapTime();
  blocks[index].end = video.currentTime + 0.05; // grows while the button is held (see playbackLoop)
  updateTapBar();
}

function tapUp() {
  if (!tap || !tap.holding) return;
  const b = blocks[tap.order[tap.position]];
  b.end = Math.max(b.start + 0.2, tapTime());
  tap.holding = false;
  tap.position++;
  renderTimeline();
  if (tap.position >= tap.order.length) finishTapAlong(true);
  else updateTapBar();
}

function finishTapAlong(completed) {
  if (!tap) return;
  if (tap.holding) tapUp();
  if (!tap) return; // tapUp finished the last line
  const { order, position: timed } = tap;
  tap = null;
  // Lines that were not tapped must stay after the tapped ones. If their earlier times are in the
  // way, share the rest of the song evenly between them.
  const rest = order.slice(timed);
  const lastEnd = timed > 0 ? blocks[order[timed - 1]].end : 0;
  if (rest.length && blocks[rest[0]].start < lastEnd) {
    const slice = Math.max(0.3, (duration() - lastEnd) / rest.length);
    rest.forEach((index, k) => {
      blocks[index].start = lastEnd + k * slice;
      blocks[index].end = lastEnd + (k + 1) * slice;
    });
  }
  video.pause();
  video.playbackRate = 1;
  document.body.classList.remove("tapping");
  $("tapBar").classList.add("hidden");
  normalizeBlocks();
  renderAll();
  status(completed
    ? `All ${blocks.length} lines are timed. Play the video to check them, and drag any line that is a little off.`
    : `Stopped after ${timed} lines. The lines you timed were kept; the others keep their earlier times.`);
}

$("tapAlong").onclick = startTapAlong;
$("tapStop").onclick = () => finishTapAlong(false);
$("tapSpeed").onchange = e => { if (tap) video.playbackRate = Number(e.target.value) || 1; };
$("tapButton").onpointerdown = e => {
  e.preventDefault(); // keeps focus and text selection away from the button
  try { $("tapButton").setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
  tapDown();
};
$("tapButton").onpointerup = $("tapButton").onpointercancel = () => tapUp();
$("tapButton").oncontextmenu = e => e.preventDefault(); // a long press must not open a menu on phones
video.addEventListener("ended", () => { if (tap) finishTapAlong(tap.position >= tap.order.length); });

// ---------------------------------------------------------------------------
// Preview: the subtitle drawn over the video
// ---------------------------------------------------------------------------

// Lines that are shown in the preview: all of them, except lines still waiting to be tapped.
const isShown = index => !tap || !tap.pending.has(index);

function activeBlock() {
  return blocks.findIndex((b, index) => isShown(index) && video.currentTime >= b.start && video.currentTime < b.end);
}

function renderPreview() {
  const i = activeBlock();

  const selectedIsActive = selected >= 0 && blocks[selected] && isShown(selected) &&
    video.currentTime >= blocks[selected].start - 0.01 && video.currentTime <= blocks[selected].end + 0.01;
  if (selectionOverride >= 0 && blocks[selectionOverride]) {
    selected = selectionOverride;
  } else if (!selectedIsActive && i >= 0) {
    selected = i;
    renderInspector();
    renderBlocks();
    markSelectedClip();
  }

  const active = blocks.filter((b, index) => isShown(index) && video.currentTime >= b.start && video.currentTime < b.end);

  if (!active.length) {
    overlay.classList.add("hidden");
    return;
  }

  const selectedBlock = blocks[selected];
  const selectedIsVisible = selectedBlock && isShown(selected) &&
    video.currentTime >= selectedBlock.start - 0.01 && video.currentTime <= selectedBlock.end + 0.01;
  const b = selectedIsVisible ? selectedBlock : active[0];
  if (selectionOverride < 0 && b !== blocks[selected]) {
    selected = blocks.indexOf(b);
    renderInspector();
    renderBlocks();
    markSelectedClip();
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

// The area inside the preview that the video picture really covers (without black bars).
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

// Dragging the subtitle in the preview moves the selected line.
overlay.onpointerdown = e => {
  if (selected < 0) return;
  e.preventDefault();
  drag = { type: "position", startX: e.clientX, startY: e.clientY, x: blocks[selected].x, y: blocks[selected].y, moved: false, undo: snapshot() };
  overlay.setPointerCapture(e.pointerId);
};

overlay.onpointermove = e => {
  if (!drag || drag.type !== "position") return;
  if (!drag.moved) {
    drag.moved = true;
    pushUndo(drag.undo);
  }
  const r = getMediaBounds();
  blocks[selected].x = drag.x + ((e.clientX - drag.startX) / r.width) * 100;
  blocks[selected].y = drag.y + ((e.clientY - drag.startY) / r.height) * 100;
  clampBlock(blocks[selected]);
  renderPreview();
  renderInspector();
};

overlay.onpointerup = overlay.onpointercancel = () => {
  if (drag?.type === "position") drag = null;
};

// ---------------------------------------------------------------------------
// Time with AI: forced alignment of the known lyrics (see align.js)
// ---------------------------------------------------------------------------

// Subtitles are easier to read when they appear a moment before the line is sung and stay a
// little after it. Gaps shorter than GAP_CLOSE are closed so the text does not flicker.
const LEAD = 0.15, TAIL = 0.5, GAP_CLOSE = 0.6;
// Lines whose letters the model found less likely than this are reported as worth checking.
const DOUBTFUL_CONFIDENCE = 0.3;

// The model runs in aligner-worker.js. workerRequest sends one message and resolves with the
// worker's "done" answer, passing progress messages to onProgress on the way.
let alignerWorker = null;

function workerRequest(message, onProgress) {
  if (!alignerWorker) alignerWorker = new Worker(new URL("./aligner-worker.js", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      alignerWorker.removeEventListener("message", onMessage);
      alignerWorker.removeEventListener("error", onError);
    };
    const onMessage = ({ data }) => {
      if (data.type === "progress") onProgress?.(data);
      else if (data.type === "done") { cleanup(); resolve(data); }
      else if (data.type === "error") { cleanup(); reject(Error(data.message)); }
    };
    const onError = e => {
      cleanup();
      alignerWorker = null; // start a fresh worker next time
      reject(Error(e.message || "The timing model could not start."));
    };
    alignerWorker.addEventListener("message", onMessage);
    alignerWorker.addEventListener("error", onError);
    alignerWorker.postMessage(message);
  });
}

// Downloads (the first time) and starts the model, showing the download progress.
function loadAligner() {
  const files = new Map();
  status("Starting the timing model. The first time, it downloads about 300 MB...", 3);
  return workerRequest({ type: "load" }, p => {
    if (p.stage !== "download") return;
    files.set(p.key, { loaded: Math.max(files.get(p.key)?.loaded || 0, p.loaded), total: p.total });
    let loaded = 0, total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    status(`Downloading the timing model (first time only)... ${Math.round(loaded / 1048576)} of ${Math.round(total / 1048576)} MB`, 3 + 32 * loaded / total);
  });
}

const minutesText = seconds => seconds < 90 ? "about a minute" : `about ${Math.round(seconds / 60)} minutes`;

// Lets the model listen to the song and returns the letter probabilities for every 20 ms.
function letterProbabilities(pcm) {
  const started = performance.now();
  status("Listening to the song. The first progress appears after a minute or two; you can keep using the page.", 40);
  return workerRequest({ type: "run", pcm }, p => {
    if (p.stage !== "listen") return;
    const elapsed = (performance.now() - started) / 1000;
    const left = p.done < 1 ? `, ${minutesText(elapsed * (1 - p.done) / p.done)} left` : "";
    status(`Listening to the song... ${Math.round(p.done * 100)}%${left}`, 40 + 50 * p.done);
  });
}

// Decodes the media file to 16 kHz mono audio, the format the timing model expects.
async function extractMono16k(file) {
  status("Preparing the audio...", 36);
  try {
    const decoder = new AudioContext();
    try {
      const decoded = await decoder.decodeAudioData(await file.arrayBuffer());
      if (!decoded || !decoded.length) throw Error("No audio samples were decoded.");
      // Rendering into a one-channel 16 kHz context mixes the channels and resamples.
      const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start();
      return (await offline.startRendering()).getChannelData(0);
    } finally {
      await decoder.close();
    }
  } catch (nativeError) {
    // Some formats cannot be decoded by the browser. FFmpeg can read almost anything.
    console.warn("Native audio decoding failed; using FFmpeg fallback.", nativeError);
    status("Preparing the audio with FFmpeg...", 36);
    const encoder = await loadFFmpeg();
    ffmpegJob = null;
    const inputName = "timing-source" + (file.name.match(/\.[a-z0-9]+$/i)?.[0] || ".mp4");
    await encoder.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
    await encoder.exec(["-y", "-i", inputName, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "timing-audio.pcm"]);
    const data = await encoder.readFile("timing-audio.pcm");
    if (typeof data === "string" || !data.length) throw Error("The selected file has no audio track that can be read.");
    return new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + Math.floor(data.byteLength / 4) * 4));
  }
}

// Turns the time of the first and last letter of each line into a subtitle line.
function linesFromSpans(lines, ranges, spans, secondsPerFrame) {
  const sung = lines.map((text, i) => ranges[i]
    ? { text, start: spans[ranges[i][0]].start * secondsPerFrame, end: spans[ranges[i][1]].end * secondsPerFrame }
    : { text, start: null, end: null });
  // A line without letters (only numbers or symbols) goes right after the previous line.
  sung.forEach((b, i) => {
    if (b.start === null) { b.start = i ? sung[i - 1].end : 0; b.end = b.start + 1; }
  });
  const result = [];
  sung.forEach((b, i) => {
    const previousEnd = result.length ? result.at(-1).end : 0;
    const nextShown = i + 1 < sung.length ? sung[i + 1].start - LEAD : duration();
    const start = Math.max(previousEnd, b.start - LEAD);
    let end = Math.min(nextShown, b.end + TAIL);
    if (nextShown - end < GAP_CLOSE) end = nextShown;
    result.push({ text: b.text, start, end: Math.max(end, start + 0.3), x: 50, y: 86 });
  });
  return result;
}

$("generate").onclick = async () => {
  if (!mediaFile) return status("Choose a video or audio file first.");
  const lines = lyricLines();
  if (!lines.length) return status("Paste the lyrics first.");
  const { tokens, ranges } = tokenizeLines(lines);
  if (!tokens.length) return status("The lyrics have no letters that can be timed.");
  if (!confirmReplace()) return;
  setTimingButtonsDisabled(true);

  try {
    await loadAligner();
    if (video.src && video.readyState < 1) {
      await new Promise(resolve => video.addEventListener("loadedmetadata", resolve, { once: true }));
    }
    const pcm = await extractMono16k(vocalsFile || mediaFile);
    const { logProbs, frames, vocabSize, secondsPerFrame } = await letterProbabilities(pcm);

    status("Finding when each line is sung...", 92);
    await new Promise(resolve => setTimeout(resolve, 30)); // let the status message appear
    const spans = ctcAlign(logProbs, frames, vocabSize, tokens);
    const newBlocks = linesFromSpans(lines, ranges, spans, secondsPerFrame);
    const doubtful = lines.map((_, i) => i)
      .filter(i => ranges[i] && lineConfidence(logProbs, vocabSize, tokens, spans, ranges[i]) < DOUBTFUL_CONFIDENCE)
      .map(i => i + 1);

    doubtful.forEach(n => { newBlocks[n - 1].unsure = true; });
    pushUndo();
    blocks = newBlocks;
    normalizeBlocks();
    selected = blocks.length ? 0 : -1;
    renderAll();
    revealPreview();
    const list = doubtful.slice(0, 8).join(", ") + (doubtful.length > 8 ? " and more" : "");
    status(`Timed ${blocks.length} lines. ` + (doubtful.length
      ? `The AI was not sure about line${doubtful.length > 1 ? "s" : ""} ${list}, so check ${doubtful.length > 1 ? "those" : "it"} first. ${doubtful.length > 1 ? "They are" : "It is"} orange on the timeline.`
      : "Play the video to check them, and drag any line that is off."), 100);
  } catch (err) {
    console.error(err);
    status(`Error: ${err.message}`, 0);
  } finally {
    setTimingButtonsDisabled(false);
  }
};

// ---------------------------------------------------------------------------
// Editing panels
// ---------------------------------------------------------------------------

function renderInspector() {
  const box = $("inspector"), b = blocks[selected];
  if (!b) { box.innerHTML = '<div class="hint">Select a line on the timeline or in the list to edit it.</div>'; return; }
  const unsureNote = b.unsure
    ? '<div class="unsure-note">The AI was not sure about this line. Play it, and fix the times if they are off.<br><button type="button" class="ghost" id="markRight">The times are right</button></div>'
    : "";
  box.innerHTML = `${unsureNote}<div class="field"><label for="editText">Text</label><textarea id="editText" class="lyrics" style="height:70px">${escapeHtml(b.text)}</textarea></div><div class="editor-row"><label>Text size<input id="editSize" type="number" min="12" max="160" value="${b.size ?? style.size}"></label><label>Line width (%)<input id="editWidth" type="number" min="20" max="100" value="${b.width ?? 80}"></label></div><div class="editor-row" style="margin-top:8px"><label>Start (s)<input id="editStart" type="number" step=".01" value="${b.start.toFixed(2)}"></label><label>End (s)<input id="editEnd" type="number" step=".01" value="${b.end.toFixed(2)}"></label></div><div class="row" style="margin-top:8px"><button type="button" class="ghost" id="setStart">Start here</button><button type="button" class="ghost" id="setEnd">End here</button></div><div class="hint" style="margin-top:5px">"Here" means the current video position.</div><div class="field" style="margin-top:14px"><label>Position <span class="hint">X ${Math.round(b.x)}% · Y ${Math.round(b.y)}%</span></label><input id="posX" class="range" type="range" min="5" max="95" value="${b.x}" aria-label="Horizontal position"><input id="posY" class="range" type="range" min="5" max="95" value="${b.y}" aria-label="Vertical position"></div><button type="button" class="danger" id="deleteSelected" style="width:100%">Delete line</button>`;
  $("editText").oninput = e => { b.text = e.target.value; renderPreview(); renderBlocks(); renderTimeline(); };
  $("editSize").oninput = e => { b.size = Math.max(12, Math.min(160, Number(e.target.value) || style.size)); renderPreview(); };
  $("editWidth").oninput = e => { b.width = Math.max(20, Math.min(100, Number(e.target.value) || 80)); renderPreview(); };
  $("editStart").oninput = e => { b.start = +e.target.value; delete b.unsure; clampBlock(b); renderTimeline(); };
  $("editEnd").oninput = e => { b.end = +e.target.value; delete b.unsure; clampBlock(b); renderTimeline(); };
  $("setStart").onclick = () => { pushUndo(); b.start = video.currentTime; delete b.unsure; clampBlock(b); renderInspector(); renderTimeline(); };
  $("setEnd").onclick = () => { pushUndo(); b.end = video.currentTime; delete b.unsure; clampBlock(b); renderInspector(); renderTimeline(); };
  if (b.unsure) $("markRight").onclick = () => { pushUndo(); delete b.unsure; renderAll(); };
  $("posX").oninput = e => { b.x = +e.target.value; renderPreview(); };
  $("posY").oninput = e => { b.y = +e.target.value; renderPreview(); };
  $("deleteSelected").onclick = () => deleteBlock(selected);
}

function deleteBlock(index) {
  const b = blocks[index];
  if (!b) return;
  pushUndo();
  blocks.splice(index, 1);
  selected = -1;
  renderAll();
  status(`Deleted "${shorten(b.text)}". Press Undo to bring it back.`);
}

// Splits the text of a line in two: by lines if it has several, otherwise by words.
function splitText(text) {
  const parts = text.split("\n");
  if (parts.length > 1) {
    const half = Math.ceil(parts.length / 2);
    return [parts.slice(0, half).join("\n"), parts.slice(half).join("\n")];
  }
  const words = text.trim().split(/\s+/);
  if (words.length < 2) return [text, text];
  const half = Math.ceil(words.length / 2);
  return [words.slice(0, half).join(" "), words.slice(half).join(" ")];
}

// Cuts a line in the middle of its time and gives each half part of the text.
function splitBlock(index) {
  const b = blocks[index];
  if (!b) return;
  pushUndo();
  const middle = (b.start + b.end) / 2;
  const [firstText, secondText] = splitText(b.text);
  blocks.splice(index, 1, { ...b, text: firstText, end: middle }, { ...b, text: secondText, start: middle });
  selected = index;
  renderAll();
  status("Split the line in two. Drag the edges on the timeline to adjust.");
}

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
  revealOnTimeline(blocks[i].start, blocks[i].end);
}

function sortedBlockIndices() {
  return blocks.map((block, index) => ({ block, index }))
    .sort((a, b) => a.block.start - b.block.start || a.index - b.index)
    .map(entry => entry.index);
}

// Selects the previous (-1) or next (+1) line in time order.
function stepBlock(direction) {
  const order = sortedBlockIndices();
  if (!order.length) return;
  const position = order.indexOf(selected);
  const next = position < 0 ? (direction > 0 ? 0 : order.length - 1) : position + direction;
  if (next >= 0 && next < order.length) selectBlock(order[next], true);
}

function renderBlocks() {
  const box = $("blockList");
  box.innerHTML = blocks.length ? "" : '<div class="hint" style="padding:13px">No lines yet.</div>';
  sortedBlockIndices().forEach((i, displayIndex) => {
    const b = blocks[i];
    const el = document.createElement("div");
    el.className = "block" + (i === selected ? " selected" : "") + (b.unsure ? " unsure" : "");
    el.innerHTML = `<div class="block-top"><span>#${displayIndex + 1}</span><span>${fmt(b.start)} → ${fmt(b.end)}</span></div><div class="block-text">${escapeHtml(b.text)}</div><div class="block-actions"><button type="button" class="ghost" data-play>Play line</button><button type="button" class="ghost" data-split>Split</button></div>`;
    el.onclick = e => { if (e.target.tagName === "BUTTON") return; selectBlock(i, true); };
    el.querySelector("[data-play]").onclick = () => { selectBlock(i, true); playVideo(); };
    el.querySelector("[data-split]").onclick = () => splitBlock(i);
    box.appendChild(el);
  });
}

function renderEditBlocks() {
  const box = $("editBlockList");
  box.innerHTML = blocks.length
    ? '<div class="hint list-hint">To change the order, drag a line by its number or use ▲ ▼. The times stay in place; the lines move.</div><div class="list-head"><span>#</span><span>Text</span><span>Start (s)</span><span>End (s)</span></div>'
    : '<div class="hint">No lines yet.</div>';
  const order = sortedBlockIndices();
  order.forEach((i, displayIndex) => {
    const b = blocks[i], row = document.createElement("div"), n = displayIndex + 1;
    row.className = "edit-block-row" + (i === selected ? " selected" : "");
    row.innerHTML = `<div class="move-cell"><button type="button" class="move-btn" data-move="-1" title="Move up" aria-label="Move line ${n} up"${displayIndex === 0 ? " disabled" : ""}>▲</button><strong class="move-grip" title="Drag to move this line">${n}</strong><button type="button" class="move-btn" data-move="1" title="Move down" aria-label="Move line ${n} down"${displayIndex === order.length - 1 ? " disabled" : ""}>▼</button></div><textarea aria-label="Text of line ${n}">${escapeHtml(b.text)}</textarea><input type="text" inputmode="decimal" autocomplete="off" aria-label="Start time of line ${n}" value="${b.start.toFixed(2)}"><input type="text" inputmode="decimal" autocomplete="off" aria-label="End time of line ${n}" value="${b.end.toFixed(2)}">`;
    const [textInput, startInput, endInput] = row.querySelectorAll("textarea, input");
    row.onclick = e => {
      if (e.target.closest("textarea, input, button") || performance.now() < suppressRowClickUntil) return;
      selectBlock(i, true);
    };
    row.querySelectorAll(".move-btn").forEach(btn => {
      btn.onclick = () => moveLine(displayIndex, displayIndex + Number(btn.dataset.move), btn.dataset.move);
    });
    row.querySelector(".move-grip").onpointerdown = e => startReorder(e, displayIndex);
    textInput.oninput = e => { b.text = e.target.value; renderPreview(); renderBlocks(); renderTimeline(); };
    startInput.oninput = e => { b.start = Number(e.target.value); delete b.unsure; clampBlock(b); renderPreview(); renderBlocks(); renderTimeline(); };
    endInput.oninput = e => { b.end = Number(e.target.value); delete b.unsure; clampBlock(b); renderPreview(); renderBlocks(); renderTimeline(); };
    startInput.onchange = () => renderEditBlocks();
    endInput.onchange = () => renderEditBlocks();
    box.appendChild(row);
  });
}

// Changing the order of the lines. The lines are always listed in time order, so a moved line
// cannot keep its own times. Instead the times stay in their places and the lines move: the moved
// line takes the times of its new place, and the lines in between shift by one place.
function moveLine(from, to, focusButton = null) {
  const order = sortedBlockIndices();
  if (from === to || to < 0 || to >= order.length) return;
  pushUndo();
  const places = order.map(i => [blocks[i].start, blocks[i].end]);
  const oldTexts = order.map(i => blocks[i].text);
  const lines = order.map(i => blocks[i]);
  const [moving] = lines.splice(from, 1);
  lines.splice(to, 0, moving);
  lines.forEach((b, k) => { [b.start, b.end] = places[k]; });
  blocks = lines;
  const lyricsUpdated = reorderLyricsBox(oldTexts, lines.map(b => b.text));
  selectBlock(to, true);
  const row = $("editBlockList").querySelectorAll(".edit-block-row")[to];
  row?.scrollIntoView({ block: "nearest" });
  // After a click on an arrow, keep the focus on the same arrow, so it can be pressed again.
  if (focusButton) row?.querySelector(`.move-btn[data-move="${focusButton}"]:not(:disabled)`)?.focus();
  status(`Moved "${shorten(moving.text)}" to place ${to + 1}. The times stayed in their places.${lyricsUpdated ? " The Lyrics box has the new order too." : ""}`);
}

// If the Lyrics box held exactly these lines, it gets the new order too, so it stays the same as the
// timeline (Tap along compares the two). Section tags and empty lines stay where they are.
function reorderLyricsBox(oldTexts, newTexts) {
  const current = lyricLines();
  if (current.length !== oldTexts.length || current.some((text, k) => text !== oldTexts[k])) return false;
  if (newTexts.some(text => text.includes("\n"))) return false;
  let k = 0;
  lyrics.value = lyrics.value.split(/\r?\n/).map(raw => {
    const text = raw.trim();
    return text && !/^\[[^\]]*\]$/.test(text) ? newTexts[k++] : raw;
  }).join("\n");
  return true;
}

// Dragging a line by its number. The row follows the pointer, the other rows slide apart to show
// where it will go, and near the top or bottom edge the list (or, on a phone, the page) scrolls.
let reorder = null, suppressRowClickUntil = 0;

function reorderScroller() {
  const list = $("editBlockList");
  return list.scrollHeight > list.clientHeight + 1 ? list : null; // null: the page scrolls
}

function startReorder(e, from) {
  if (e.button > 0 || reorder) return;
  e.preventDefault(); // no text selection, and no scrolling on a touch screen (see the CSS)
  const grip = e.currentTarget, list = $("editBlockList"), rows = [...list.querySelectorAll(".edit-block-row")];
  try { grip.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
  const scroller = reorderScroller();
  // Heights are measured from the top of the scrolling content, so they stay right while it scrolls.
  const base = () => scroller ? scroller.scrollTop - scroller.getBoundingClientRect().top : window.scrollY;
  const startBase = base();
  const middles = rows.map(row => { const box = row.getBoundingClientRect(); return box.top + box.height / 2 + startBase; });
  const shift = rows[from].offsetHeight + (parseFloat(getComputedStyle(list).rowGap) || 0);
  reorder = { from, to: from, rows, list, scroller, base, startBase, middles, shift, startY: e.clientY, y: e.clientY, moved: false, frame: 0 };
  grip.onpointermove = ev => { if (reorder) reorder.y = ev.clientY; };
  grip.onpointerup = () => endReorder(true);
  grip.onpointercancel = () => endReorder(false);
  reorder.frame = requestAnimationFrame(reorderFrame);
}

function reorderFrame() {
  const r = reorder;
  if (!r) return;
  r.frame = requestAnimationFrame(reorderFrame);
  if (!r.moved) {
    if (Math.abs(r.y - r.startY) < 5) return; // a small wobble is still a click
    r.moved = true;
    r.rows[r.from].classList.add("moving");
    r.list.classList.add("reordering");
  }
  // Scroll by itself near the edges: the closer to the edge, the faster.
  const edge = r.scroller ? r.scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const zone = 48, speed = 14;
  const step = r.y < edge.top + zone ? -speed * Math.min(1, (edge.top + zone - r.y) / zone)
    : r.y > edge.bottom - zone ? speed * Math.min(1, (r.y - edge.bottom + zone) / zone) : 0;
  if (step) { if (r.scroller) r.scroller.scrollTop += step; else window.scrollBy(0, step); }
  // The dragged row follows the pointer.
  const pointer = r.y + r.base();
  r.rows[r.from].style.transform = `translateY(${pointer - r.startY - r.startBase}px)`;
  // The new place: the first earlier row whose middle is below the pointer, or the last later row
  // whose middle is above it. The rows in between slide over by one row to make room.
  let to = r.from;
  r.middles.forEach((middle, k) => {
    if (k < r.from && pointer < middle && k < to) to = k;
    if (k > r.from && pointer > middle) to = Math.max(to, k);
  });
  r.to = to;
  r.rows.forEach((row, k) => {
    if (k === r.from) return;
    const offset = to < r.from && k >= to && k < r.from ? r.shift : to > r.from && k > r.from && k <= to ? -r.shift : 0;
    row.style.transform = offset ? `translateY(${offset}px)` : "";
  });
}

function endReorder(drop) {
  if (!reorder) return;
  const { from, to, rows, list, moved, frame } = reorder;
  reorder = null;
  cancelAnimationFrame(frame);
  list.classList.remove("reordering");
  rows.forEach(row => { row.classList.remove("moving"); row.style.transform = ""; });
  if (!moved) return; // a click on the number selects the line, through the row's click
  suppressRowClickUntil = performance.now() + 300;
  if (drop && to !== from) moveLine(from, to);
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

// Where things are on the timeline. An x position is counted in pixels from the left edge of the
// scrollable content, so it can be compared with timelineBox.scrollLeft.
function timelineGeometry() {
  const box = timelineBox.getBoundingClientRect(), area = tracks.getBoundingClientRect();
  const d = Math.max(duration(), 0.01);
  return { offset: area.left - box.left + timelineBox.scrollLeft, width: area.width, d };
}
const timeToX = (t, g) => g.offset + t / g.d * g.width;
const xToTime = (x, g) => (x - g.offset) / g.width * g.d;

// Scrolls the timeline sideways so the time from start to end is in view, unless it already is.
function revealOnTimeline(start, end = start) {
  const g = timelineGeometry(), view = timelineBox.clientWidth, margin = 30;
  const left = timeToX(start, g), right = timeToX(end, g), now = timelineBox.scrollLeft;
  if (left >= now + margin && right <= now + view - margin) return;
  const target = right - left > view - 2 * margin ? left - margin : (left + right - view) / 2;
  timelineBox.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
}

// While playing, the timeline scrolls along so the playhead stays visible, except for a few
// seconds after the user scrolls it themselves.
let userScrolledTimelineAt = 0;
["wheel", "touchstart", "pointerdown"].forEach(type =>
  timelineBox.addEventListener(type, () => { userScrolledTimelineAt = performance.now(); }, { passive: true }));

function followPlayhead() {
  if (video.paused || drag || performance.now() - userScrolledTimelineAt < 3000) return;
  const box = timelineBox.getBoundingClientRect(), head = $("playhead").getBoundingClientRect();
  if (head.left < box.left + 30 || head.right > box.right - 30) {
    timelineBox.scrollLeft += head.left - box.left - box.width * 0.25;
  }
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
  followPlayhead();
}

// The time scale has a labelled mark every few seconds and small marks between them. The spacing
// follows the zoom, so the labels never crowd together and are never far apart.
const RULER_STEPS = [[1, 0.25], [2, 0.5], [5, 1], [10, 2], [15, 5], [30, 10], [60, 15], [120, 30]];
const clockLabel = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
let rulerKey = "";

function renderRuler(d, width) {
  const [major, minor] = RULER_STEPS.find(([step]) => step * width / d >= 70) || RULER_STEPS.at(-1);
  const key = `${d}|${major}`;
  if (key === rulerKey) return; // the marks are placed in %, so they only change with the spacing
  rulerKey = key;
  const perMajor = Math.round(major / minor);
  let marks = "", lines = "";
  for (let k = 0; k * minor <= d + 1e-6; k++) {
    const t = k * minor, left = `left:${(t / d * 100).toFixed(4)}%`, isMajor = k % perMajor === 0;
    marks += isMajor ? `<span class="tick major" style="${left}">${clockLabel(t)}</span>` : `<span class="tick" style="${left}"></span>`;
    lines += `<i class="grid-line${isMajor ? " major" : ""}" style="${left}"></i>`;
  }
  $("ruler").innerHTML = marks;
  $("grid").innerHTML = lines;
}

function updateZoomReadout(d, width) {
  const seconds = Math.min(d, timelineBox.clientWidth * d / width);
  $("zoomValue").textContent = `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s visible`;
}

function renderTimeline() {
  const inner = $("timelineInner");
  tracks.querySelectorAll(".track-row").forEach(x => x.remove());
  // A short song fills the visible width; a longer one gets timelineScale pixels per second.
  const padding = parseFloat(getComputedStyle(timelineBox).paddingLeft) || 0;
  const d = Math.max(duration(), 0.01), width = Math.max(timelineBox.clientWidth - 2 * padding, 300, d * timelineScale);
  inner.style.width = width + "px";
  renderRuler(d, width);

  // Lines that touch or overlap go to different rows so both stay easy to grab.
  const minPixelBufferInSeconds = (14 / width) * d;
  const laneEnds = [], laneMap = new Map();
  for (const block of [...blocks].sort((a, b) => a.start - b.start)) {
    let lane = 0;
    while (lane < laneEnds.length && (laneEnds[lane] + minPixelBufferInSeconds) > block.start) {
      lane++;
    }
    laneEnds[lane] = block.end;
    laneMap.set(block, lane);
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
  // Each line shows its number, the same as in All lines and in the AI's messages.
  const number = new Map(sortedBlockIndices().map((index, k) => [index, k + 1]));
  blocks.forEach((b, i) => {
    const lane = laneMap.get(b) || 0, row = rows[Math.min(lane, rows.length - 1)] || rows[0], el = document.createElement("div");
    el.className = "clip" + (i === selected ? " selected" : "") + (b.unsure ? " unsure" : "");
    el.dataset.index = i;
    el.dataset.n = number.get(i);
    el.title = `${number.get(i)}. ${b.text}\n${fmt(b.start)} → ${fmt(b.end)}`;
    el.style.left = (b.start / d * 100) + "%";
    el.style.width = Math.max((b.end - b.start) / d * 100, 0.2) + "%";
    el.append(b.text);
    el.onpointerdown = e => startClipDrag(e, i, "move");
    ["left", "right"].forEach(side => {
      const h = document.createElement("i");
      h.className = "handle " + side;
      h.onpointerdown = e => startClipDrag(e, i, side);
      el.appendChild(h);
    });
    row.appendChild(el);
  });
  updateZoomReadout(d, width);
  updatePlayhead();
}

// While the video plays, the selected line changes often; mark it without drawing everything again.
function markSelectedClip() {
  tracks.querySelectorAll(".clip").forEach(el => el.classList.toggle("selected", Number(el.dataset.index) === selected));
}

function renderAll() { renderBlocks(); renderEditBlocks(); renderInspector(); renderTimeline(); renderPreview(); }

// Zoom. The time at anchorX (pixels from the left edge of the visible timeline) stays in the same
// place on screen: by default the playhead if it is in view, otherwise the middle.
const ZOOM_MIN = Number($("timelineZoom").min), ZOOM_MAX = Number($("timelineZoom").max);

function setZoom(scale, anchorX = null) {
  scale = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale)));
  if (scale === timelineScale) return;
  const g = timelineGeometry(), view = timelineBox.clientWidth;
  if (anchorX === null) {
    const head = timeToX(video.currentTime || 0, g) - timelineBox.scrollLeft;
    anchorX = head >= 0 && head <= view ? head : view / 2;
  }
  const anchorTime = xToTime(timelineBox.scrollLeft + anchorX, g);
  timelineScale = scale;
  $("timelineZoom").value = scale;
  renderTimeline();
  timelineBox.scrollLeft = timeToX(anchorTime, timelineGeometry()) - anchorX;
}

$("timelineZoom").oninput = e => setZoom(Number(e.target.value));

// The mouse wheel scrolls the timeline sideways; at either end it scrolls the page again.
// Ctrl + wheel, or pinching on a touchpad, zooms in and out around the pointer.
timelineBox.addEventListener("wheel", e => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    setZoom(timelineScale * Math.exp(-e.deltaY * 0.002), e.clientX - timelineBox.getBoundingClientRect().left);
    return;
  }
  if (e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return; // already sideways
  const step = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? timelineBox.clientWidth : 1);
  const max = timelineBox.scrollWidth - timelineBox.clientWidth;
  if (max <= 0 || (step < 0 && timelineBox.scrollLeft <= 0) || (step > 0 && timelineBox.scrollLeft >= max - 1)) return;
  e.preventDefault();
  timelineBox.scrollLeft += step;
}, { passive: false });

// A short song fills the timeline, so its width depends on the window.
new ResizeObserver(() => renderTimeline()).observe(timelineBox);

// A tap on a line selects it and jumps to its start. Dragging the line moves it; dragging an edge
// changes its start or end. On touch screens only the selected line can be dragged (see the CSS),
// so swiping over other lines still scrolls the timeline.
let suppressClickUntil = 0;

function startClipDrag(e, index, type) {
  if (e.button > 0) return; // only the main mouse button, a finger or a pen
  e.stopPropagation();
  const b = blocks[index];
  // A finger on a line that is not selected may be starting to scroll the timeline,
  // so it can only select the line with a tap, not move it.
  if (e.pointerType === "touch" && type === "move" && index !== selected) type = "tap";
  drag = { type, index, startX: e.clientX, start: b.start, end: b.end, duration: duration(), moved: false, undo: snapshot() };
  // Capture on the track area, which is not re-created during the drag, so every move reaches
  // tracks.onpointermove, even when the pointer leaves the line.
  try { tracks.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
}

// While a line or an edge is dragged, it snaps to the playhead and to the edges of the other lines
// when it comes within a few pixels of them. So lines can meet exactly, and an edge can be put
// exactly where the video is paused. Holding Alt turns snapping off.
const SNAP_PIXELS = 8;

function snapPoints() {
  const points = blocks.flatMap((other, j) => j === drag.index ? [] : [other.start, other.end]);
  // When a whole line is moved, its old start (where a tap left the playhead) is not a target.
  if (video.src && !(drag.type === "move" && Math.abs(video.currentTime - drag.start) < 0.01)) points.push(video.currentTime);
  return points;
}

function nearestSnap(t, points, tolerance) {
  let best = null, bestDistance = tolerance;
  for (const p of points) {
    const distance = Math.abs(p - t);
    if (distance <= bestDistance) { best = p; bestDistance = distance; }
  }
  return best;
}

tracks.onpointermove = e => {
  if (!drag || drag.type === "position" || drag.type === "tap") return;
  const b = blocks[drag.index];
  if (!b) return;
  if (!drag.moved) {
    if (Math.abs(e.clientX - drag.startX) < 4) return; // a small wobble is still a tap
    drag.moved = true;
    pushUndo(drag.undo);
    selected = drag.index;
    delete b.unsure; // the user is fixing this line
  }
  const d = drag.duration, r = tracks.getBoundingClientRect(), secondsPerPixel = d / r.width;
  const points = e.altKey ? [] : snapPoints(), tolerance = SNAP_PIXELS * secondsPerPixel;
  if (drag.type === "move") {
    const length = drag.end - drag.start;
    let start = drag.start + (e.clientX - drag.startX) * secondsPerPixel;
    const toStart = nearestSnap(start, points, tolerance), toEnd = nearestSnap(start + length, points, tolerance);
    if (toStart !== null && (toEnd === null || Math.abs(toStart - start) <= Math.abs(toEnd - start - length))) start = toStart;
    else if (toEnd !== null) start = toEnd - length;
    b.start = Math.max(0, Math.min(d - length, start));
    b.end = b.start + length;
  } else {
    let t = Math.max(0, Math.min(d, (e.clientX - r.left) * secondsPerPixel));
    t = nearestSnap(t, points, tolerance) ?? t;
    if (drag.type === "left") b.start = Math.min(t, b.end - .05);
    else if (drag.type === "right") b.end = Math.max(t, b.start + .05);
  }
  renderInspector(); renderTimeline(); renderPreview();
};

tracks.onpointerup = () => {
  if (!drag || drag.type === "position") return;
  const { index, moved } = drag;
  drag = null;
  suppressClickUntil = performance.now() + 400; // the click that follows belongs to this drag
  if (moved) renderAll(); else selectBlock(index, true);
};

// The browser took over the gesture, for example to scroll the timeline.
tracks.onpointercancel = () => {
  if (!drag || drag.type === "position") return;
  const moved = drag.moved;
  drag = null;
  if (moved) renderAll();
};

function seekTimeline(e, element) {
  if (!video.src) return;
  const r = element.getBoundingClientRect();
  video.currentTime = Math.max(0, Math.min(duration(), (e.clientX - r.left) / r.width * duration()));
  updatePlayhead();
}

// Clicking an empty part of the timeline moves the playhead there.
tracks.onclick = e => {
  if (performance.now() < suppressClickUntil) return;
  if (e.target === tracks || e.target.classList.contains("track-row")) seekTimeline(e, tracks);
};

// Clicking or dragging along the time scale moves the playhead, with a mouse or a finger.
let scrubbing = false;
const ruler = $("ruler");
ruler.onpointerdown = e => {
  if (e.button > 0 || !video.src) return;
  scrubbing = true;
  try { ruler.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
  seekTimeline(e, ruler);
};
ruler.onpointermove = e => { if (scrubbing) seekTimeline(e, ruler); };
ruler.onpointerup = ruler.onpointercancel = () => { scrubbing = false; };

// After a jump while paused, for example with the video's own controls or Shift + arrow, the
// timeline scrolls to the playhead. (Selecting a line scrolls to the whole line; see selectBlock.)
video.addEventListener("seeked", () => {
  if (video.paused && !scrubbing && !drag && selectionOverride < 0) revealOnTimeline(video.currentTime);
});

$("timelineStart").onclick = () => { if (!video.src) return; video.currentTime = 0; updatePlayhead(); };
$("timelinePlay").onclick = togglePlay;
$("timelinePrev").onclick = () => stepBlock(-1);
$("timelineNext").onclick = () => stepBlock(1);
$("prevBlock").onclick = () => stepBlock(-1);
$("nextBlock").onclick = () => stepBlock(1);

$("addBlock").onclick = () => {
  pushUndo();
  const t = video.currentTime || 0;
  const block = { text: "New lyric line", start: t, end: Math.min(duration(), t + 2), x: 50, y: 86 };
  clampBlock(block);
  blocks.push(block);
  selected = blocks.length - 1;
  setActiveTab("selected");
  renderAll();
  // Select the placeholder text so typing replaces it.
  const editor = $("editText");
  if (editor) { editor.focus(); editor.select(); }
};

$("loadText").onclick = () => $("textFile").click();
$("textFile").onchange = async e => {
  const f = e.target.files?.[0];
  e.target.value = ""; // lets the same file be chosen again later
  if (f) lyrics.value = await f.text();
};

function setActiveTab(tabName) {
  document.querySelectorAll(".tab-button").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tabName));
  document.querySelectorAll(".tab-content").forEach(panel => panel.classList.toggle("active", panel.dataset.panel === tabName));
}
document.querySelectorAll(".tab-button").forEach(btn => btn.onclick = () => setActiveTab(btn.dataset.tab));

// ---------------------------------------------------------------------------
// Global style
// ---------------------------------------------------------------------------

$("styleSize").oninput = e => { style.size = +e.target.value; renderPreview(); };
$("styleColor").oninput = e => { style.color = e.target.value; renderPreview(); };
$("styleOutline").oninput = e => { style.outline = e.target.value; renderPreview(); };
$("styleOutlineWidth").oninput = e => { style.outlineWidth = +e.target.value; renderPreview(); };
$("styleBox").onchange = e => { style.box = e.target.checked; renderPreview(); };
$("styleBoxColor").oninput = e => { style.boxColor = e.target.value; renderPreview(); };
$("styleBoxOpacity").oninput = e => { style.boxOpacity = +e.target.value; renderPreview(); };

function syncStyleInputs() {
  $("styleSize").value = style.size;
  $("styleColor").value = style.color;
  $("styleOutline").value = style.outline;
  $("styleOutlineWidth").value = style.outlineWidth;
  $("styleBox").checked = style.box;
  $("styleBoxColor").value = style.boxColor;
  $("styleBoxOpacity").value = style.boxOpacity;
}

// Copies known style settings with the right type from a project file or the autosave.
function applyStyle(source) {
  if (!source || typeof source !== "object") return;
  for (const key of Object.keys(style)) {
    if (typeof source[key] === typeof style[key]) style[key] = source[key];
  }
  syncStyleInputs();
}

// ---------------------------------------------------------------------------
// Video export
// ---------------------------------------------------------------------------

function downloadFile(content, filename, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let ffmpeg = null, ffmpegLoaded = false;
// Receives FFmpeg's progress (0 to 1) during a conversion, or null when no message is wanted.
let ffmpegJob = null;

async function loadFFmpeg() {
  if (ffmpegLoaded) return ffmpeg;
  status("Loading the FFmpeg video converter into the browser...");
  const { FFmpeg } = await import("https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js");
  ffmpeg = new FFmpeg();
  ffmpeg.on("progress", ({ progress }) => {
    if (ffmpegJob && Number.isFinite(progress)) ffmpegJob(Math.max(0, Math.min(1, progress)));
  });
  const { toBlobURL } = await import("https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js");
  const baseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
  // The FFmpeg worker imports its helper files with relative paths, which do not work when the
  // worker runs from a blob URL. Download the worker and point those imports at the CDN.
  const workerBase = "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm";
  const workerSource = await (await fetch(`${workerBase}/worker.js`)).text();
  const workerModule = workerSource
    .replaceAll('"./const.js"', `"${workerBase}/const.js"`)
    .replaceAll('"./errors.js"', `"${workerBase}/errors.js"`);
  const classWorkerURL = URL.createObjectURL(new Blob([workerModule], { type: "text/javascript" }));
  try {
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
      classWorkerURL
    });
  } finally {
    URL.revokeObjectURL(classWorkerURL);
  }
  ffmpegLoaded = true;
  return ffmpeg;
}

// Draws one subtitle line onto the export canvas. Sizes are scaled from the preview to the full
// video resolution, so the export looks like the preview.
function drawSubtitleToCanvas(ctx, b, vw, vh, previewHeight) {
  if (!b) return;
  const scale = Number.isFinite(previewHeight) && previewHeight > 0 ? vh / previewHeight : vh / 1080;
  const fontSize = Math.max(12, Math.round((b.size ?? style.size) * scale));
  ctx.font = `800 ${fontSize}px Inter,system-ui,sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const posX = b.x / 100 * vw, posY = b.y / 100 * vh, maxWidth = vw * ((b.width ?? 80) / 100);
  // Wrap long lines by words, the same way the preview does.
  const lines = [];
  String(b.text).split("\n").forEach(text => {
    const words = text.split(/\s+/), parts = [];
    let line = "";
    words.forEach(word => {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        parts.push(line);
        line = word;
      } else {
        line = candidate;
      }
    });
    parts.push(line);
    lines.push(...parts);
  });
  const lineHeight = fontSize * 1.2, totalHeight = lines.length * lineHeight;
  let maxW = 0;
  for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);
  if (style.box) {
    const padX = 12 * scale, padY = 6 * scale;
    ctx.fillStyle = `rgba(${hexToRgb(style.boxColor)},${style.boxOpacity})`;
    ctx.fillRect(posX - maxW / 2 - padX, posY - totalHeight / 2 - padY, maxW + padX * 2, totalHeight + padY * 2);
  }
  lines.forEach((line, i) => {
    const lineY = posY - totalHeight / 2 + (i + .5) * lineHeight;
    if (style.outlineWidth > 0) {
      ctx.strokeStyle = style.outline;
      ctx.lineWidth = Math.max(1, style.outlineWidth * scale * 2);
      ctx.lineJoin = "round";
      ctx.strokeText(line, posX, lineY);
    }
    ctx.fillStyle = style.color;
    ctx.fillText(line, posX, lineY);
  });
}

// Plays the media from the start and records every frame (video picture or black, plus the
// subtitle) from a canvas. This takes as long as the song. Returns the recording and its type.
async function recordCanvasVideo(canvas, ctx, vw, vh) {
  status("Preparing the recording...", 5);
  const canvasStream = canvas.captureStream(30);
  const previewHeight = getMediaBounds().height;
  // H.264 in MP4 (Chrome, Edge, Safari) can go into the final file as it is, which makes the
  // conversion afterwards take seconds. Firefox records only WebM, which has to be converted.
  const mimeType = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
    .find(m => MediaRecorder.isTypeSupported(m));
  if (!mimeType) throw Error("This browser cannot record video. Try Chrome or Edge on a computer.");
  // About 0.2 bits per pixel at 30 frames per second: sharp, but small enough to send in a chat app.
  const videoBitsPerSecond = Math.round(Math.min(16e6, Math.max(4e6, vw * vh * 30 * 0.2)));
  const recorder = new MediaRecorder(canvasStream, { mimeType, videoBitsPerSecond }), chunks = [];
  recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.onerror = e => reject(e.error || Error("Recording the video failed."));
  });

  const originalTime = video.currentTime;
  video.pause();
  if (originalTime > 0.01) {
    video.currentTime = 0;
    await new Promise((resolve, reject) => {
      video.addEventListener("seeked", resolve, { once: true });
      video.addEventListener("error", () => reject(Error("Video seek failed during export.")), { once: true });
    });
  }
  if (video.readyState < 2) {
    await new Promise((resolve, reject) => {
      video.addEventListener("loadeddata", resolve, { once: true });
      video.addEventListener("error", () => reject(Error("Video could not be decoded.")), { once: true });
    });
  }

  const drawFrame = () => {
    if (video.videoWidth) {
      ctx.drawImage(video, 0, 0, vw, vh);
    } else {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, vw, vh);
    }
    drawSubtitleToCanvas(ctx, blocks.find(x => video.currentTime >= x.start && video.currentTime < x.end), vw, vh, previewHeight);
  };
  let raf = 0;
  const draw = () => {
    drawFrame();
    if (video.duration) status(`Recording the video... ${Math.round(video.currentTime / video.duration * 100)}%. Keep this tab open and visible.`, video.currentTime / video.duration * 70);
    if (!video.ended) raf = requestAnimationFrame(draw);
  };
  // Browsers pause drawing in hidden tabs, which would freeze the recording.
  const onVisibility = () => {
    if (document.hidden) status("This tab is hidden, so the recording is paused or frozen. Come back to this tab and keep it open.");
  };
  document.addEventListener("visibilitychange", onVisibility);
  const finished = new Promise((resolve, reject) => {
    const cleanup = () => { video.removeEventListener("ended", onEnded); video.removeEventListener("error", onError); };
    const onEnded = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(Error("Video playback failed during export.")); };
    video.addEventListener("ended", onEnded, { once: true });
    video.addEventListener("error", onError, { once: true });
  });

  try {
    status("Starting playback...", 8);
    const playPromise = video.play();
    if (playPromise?.catch) playPromise.catch(err => console.warn("Video playback promise rejected:", err));
    await new Promise(resolve => setTimeout(resolve, 250));
    if (video.paused) throw Error("Video playback could not start. Tap the video once, then try export again.");
    recorder.start();
    draw();
    await finished;
    cancelAnimationFrame(raf);
    drawFrame();
    recorder.stop();
    const recordedBlob = await stopped;
    return { blob: recordedBlob, mimeType };
  } finally {
    document.removeEventListener("visibilitychange", onVisibility);
    canvasStream.getTracks().forEach(t => t.stop());
    video.pause();
    video.currentTime = originalTime;
  }
}

$("exportVideo").onclick = async event => {
  event.preventDefault();
  event.stopPropagation();
  if (!mediaFile || !video.src) return status("Choose a video or song first.", 0);
  if (!blocks.length) return status("There are no timed lines to put on the video yet.", 0);
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return status("This browser cannot export video. Try Chrome or Edge on a computer.", 0);
  const exportBtn = $("exportVideo");
  exportBtn.disabled = true;
  const wasMuted = video.muted;
  try {
    if (video.readyState < 1) await new Promise(resolve => video.addEventListener("loadedmetadata", resolve, { once: true }));
    // A song without video becomes a 1920×1080 video with the lyrics on black.
    const vw = video.videoWidth || AUDIO_EXPORT_WIDTH, vh = video.videoHeight || AUDIO_EXPORT_HEIGHT;
    status(`Preparing a ${vw}×${vh} video. This takes as long as the song, plus a few minutes. Keep this tab open.`, 0);
    const canvas = document.createElement("canvas");
    canvas.width = vw;
    canvas.height = vh;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw Error("Could not create the export canvas.");

    // The sound is copied from the original file afterwards, so the recording can play silently.
    video.muted = true;
    const { blob, mimeType } = await recordCanvasVideo(canvas, ctx, vw, vh);
    video.muted = wasMuted;

    status("Loading the MP4 converter...", 72);
    const enc = await loadFFmpeg();
    const recordedMp4 = mimeType.startsWith("video/mp4");
    const inputName = recordedMp4 ? "lyrics-render.mp4" : "lyrics-render.webm";
    const sourceName = "original-media", outputName = "subtitled-video.mp4";
    await enc.writeFile(inputName, new Uint8Array(await blob.arrayBuffer()));
    await enc.writeFile(sourceName, new Uint8Array(await mediaFile.arrayBuffer()));
    // Picture from the recording, sound from the original file.
    const inputs = ["-y", "-i", inputName, "-i", sourceName, "-map", "0:v:0", "-map", "1:a:0?"]; // -y: overwrite leftovers
    const output = ["-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", outputName];
    ffmpegJob = progress => status(`Converting to MP4... ${Math.round(progress * 100)}%`, 70 + progress * 30);
    try {
      // An H.264 recording is copied as it is; only the sound is encoded, which is fast.
      let exitCode = recordedMp4 ? await enc.exec([...inputs, "-c:v", "copy", ...output]) : 1;
      if (exitCode !== 0) {
        // WebM, or an MP4 that could not be copied: encode the picture again (slow).
        status("Converting the video to MP4. For long or large videos this can take a while...", 72);
        exitCode = await enc.exec([...inputs, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p", ...output]);
      }
      if (exitCode !== 0) throw Error("FFmpeg could not create the MP4 file.");
    } finally {
      ffmpegJob = null;
    }
    const data = await enc.readFile(outputName);
    const fileName = `${baseName(mediaFile.name)} - lyrics.mp4`;
    downloadFile(new Blob([data], { type: "video/mp4" }), fileName, "video/mp4");
    await enc.deleteFile(inputName);
    await enc.deleteFile(sourceName);
    await enc.deleteFile(outputName);
    status(`Done! "${fileName}" (${vw}×${vh}) was saved to your downloads.`, 100);
    video.currentTime = 0;
  } catch (err) {
    console.error(err);
    status(`Export error: ${err?.message || err}`, 0);
    alert(`Export failed: ${err?.message || err}`);
  } finally {
    video.muted = wasMuted;
    exportBtn.disabled = false;
  }
};

// ---------------------------------------------------------------------------
// Saving: project files and the automatic save in this browser
// ---------------------------------------------------------------------------

function sessionData() {
  return { lyrics: lyrics.value, blocks, style, mediaName: mediaFile?.name || savedMediaName };
}

$("saveProject").onclick = () => {
  if (!blocks.length && !lyrics.value.trim()) return status("There is nothing to save yet.");
  const projectData = JSON.stringify({ app: "Lyrics Studio", version: 1, ...sessionData() }, null, 2);
  downloadFile(projectData, `${baseName(mediaFile?.name || savedMediaName)} - lyrics project.json`, "application/json");
  status("Project saved to your downloads. Open it later with Open project.", 100);
};

$("loadProject").onclick = () => $("projectFile").click();
$("projectFile").onchange = async e => {
  const f = e.target.files?.[0];
  e.target.value = ""; // lets the same file be chosen again later
  if (!f) return;
  try {
    const json = JSON.parse(await f.text());
    if (!json || !Array.isArray(json.blocks)) throw Error("it is not a Lyrics Studio project");
    pushUndo();
    blocks = sanitizeBlocks(json.blocks);
    applyStyle(json.style);
    if (typeof json.lyrics === "string" && json.lyrics.trim()) lyrics.value = json.lyrics;
    if (!mediaFile && typeof json.mediaName === "string") savedMediaName = json.mediaName;
    if (Number.isFinite(video.duration) && video.duration > 0) blocks.forEach(clampBlock);
    selected = blocks.length ? 0 : -1;
    renderAll();
    status(`Opened a project with ${blocks.length} lines.${mediaFile ? "" : " Choose its video or song to preview it."}`, 100);
  } catch (err) {
    status(`This file could not be opened as a project: ${err.message}.`, 0);
  }
};

// Everything except the media file is saved in this browser every few seconds and when the page
// is hidden or closed, so a reload or a closed tab does not lose work. The media file itself is
// too large to store, so the user chooses it again.
let lastAutosave = "";
function autosave() {
  const json = JSON.stringify(sessionData());
  if (json !== lastAutosave && storageSet(STORAGE_KEY, json)) lastAutosave = json;
}

function restoreSession() {
  let saved = null;
  try { saved = JSON.parse(storageGet(STORAGE_KEY) || "null"); } catch { saved = null; }
  if (!saved || typeof saved !== "object") return;
  if (typeof saved.lyrics === "string") lyrics.value = saved.lyrics;
  applyStyle(saved.style);
  blocks = sanitizeBlocks(saved.blocks);
  savedMediaName = typeof saved.mediaName === "string" ? saved.mediaName : "";
  selected = blocks.length ? 0 : -1;
  lastAutosave = JSON.stringify(sessionData());
  if (blocks.length) {
    status(`Welcome back! Your ${blocks.length} timed lines were restored. Choose ${savedMediaName ? `"${savedMediaName}"` : "your video"} again to keep working.`);
  } else if (lyrics.value.trim()) {
    status("Welcome back! Your lyrics were restored.");
  }
}

setInterval(autosave, 2000);
document.addEventListener("visibilitychange", () => { if (document.hidden) autosave(); });
window.addEventListener("pagehide", autosave);

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

// Space: play or pause. Delete or Backspace: delete the selected line.
// Left and Right: previous and next line (with Shift: move 1 second). Ctrl+Z / Ctrl+Y: undo and redo.
window.addEventListener("keydown", e => {
  // During Tap along, Space or Enter is the tap button and Esc stops.
  if (tap) {
    if (e.code === "Space" || e.code === "Enter" || e.code === "NumpadEnter") {
      e.preventDefault();
      if (!e.repeat) tapDown();
    } else if (e.code === "Escape") {
      e.preventDefault();
      finishTapAlong(false);
    }
    return;
  }
  const el = document.activeElement;
  const typing = el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable);
  const key = (e.key || "").toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (key === "z" || key === "y")) {
    if (typing) return; // text fields keep their own undo
    e.preventDefault();
    if (key === "y" || e.shiftKey) redo(); else undo();
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (el?.tagName === "VIDEO") return; // the video's own controls handle keys while it has focus
  if (e.code === "Space") {
    e.preventDefault();
    // Without this, Space would also press the button that has focus.
    if (el?.tagName === "BUTTON") el.blur();
    togglePlay();
  } else if (e.code === "Delete" || e.code === "Backspace") {
    if (selected >= 0) {
      e.preventDefault();
      deleteBlock(selected);
    }
  } else if (e.code === "ArrowLeft") {
    e.preventDefault();
    if (e.shiftKey) seekBy(-1); else stepBlock(-1);
  } else if (e.code === "ArrowRight") {
    e.preventDefault();
    if (e.shiftKey) seekBy(1); else stepBlock(1);
  }
});

window.addEventListener("keyup", e => {
  if (tap && (e.code === "Space" || e.code === "Enter" || e.code === "NumpadEnter")) {
    e.preventDefault();
    tapUp();
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if (storageGet(STEPS_HIDDEN_KEY) === "1") $("steps").classList.add("hidden");
$("closeSteps").onclick = () => {
  $("steps").classList.add("hidden");
  storageSet(STEPS_HIDDEN_KEY, "1");
};

// Phones start zoomed out, so a whole line, including both edges, fits on the screen.
if (matchMedia("(max-width: 680px)").matches) {
  timelineScale = 30;
  $("timelineZoom").value = timelineScale;
}

setActiveTab("selected");
restoreSession();
renderAll();
updateUndoButtons();
