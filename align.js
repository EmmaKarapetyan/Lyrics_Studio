// Forced alignment: finds when each lyric line is sung when the lyrics are already known.
//
// A CTC speech model (Meta's MMS aligner) reads the audio and gives, for every 20 ms frame,
// the probability of each Latin letter or of "no new letter" (the blank). The lyrics are written
// in Latin letters, and the most likely path through these probabilities that spells exactly the
// lyrics (Viterbi algorithm) gives the time of every letter. Unlike transcription, this works even
// when the model would not recognise the words, because it only has to decide *when* they happen.

// Letters known to the model and their output index (from the model's vocab.json).
// Index 0 is the CTC blank.
const VOCAB = { a: 4, i: 5, e: 6, n: 7, o: 8, u: 9, t: 10, s: 11, r: 12, m: 13, k: 14, l: 15, d: 16, g: 17, h: 18, y: 19, b: 20, p: 21, w: 22, c: 23, v: 24, j: 25, z: 26, f: 27, "'": 28, q: 29, x: 30 };
export const BLANK = 0;

// Armenian letters written the way they sound in Eastern Armenian.
const ARMENIAN = {
  "ա": "a", "բ": "b", "գ": "g", "դ": "d", "ե": "e", "զ": "z", "է": "e", "ը": "e", "թ": "t", "ժ": "zh",
  "ի": "i", "լ": "l", "խ": "kh", "ծ": "ts", "կ": "k", "հ": "h", "ձ": "dz", "ղ": "gh", "ճ": "ch", "մ": "m",
  "յ": "y", "ն": "n", "շ": "sh", "ո": "o", "չ": "ch", "պ": "p", "ջ": "j", "ռ": "r", "ս": "s", "վ": "v",
  "տ": "t", "ր": "r", "ց": "ts", "ւ": "v", "փ": "p", "ք": "k", "օ": "o", "ֆ": "f", "և": "ev"
};

// Russian and other Cyrillic letters.
const CYRILLIC = {
  "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo", "ж": "zh", "з": "z", "и": "i",
  "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t",
  "у": "u", "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch", "ъ": "", "ы": "y", "ь": "",
  "э": "e", "ю": "yu", "я": "ya", "і": "i", "ї": "yi", "є": "ye", "ґ": "g", "ў": "u"
};

// Latin letters that do not become plain a-z by removing accents.
const LATIN_EXTRA = { "ß": "ss", "æ": "ae", "œ": "oe", "ø": "o", "ł": "l", "đ": "d", "þ": "th", "ð": "d" };

// Writes one word in the letters the model knows. Letters it cannot write are dropped.
export function romanize(word) {
  let w = String(word).normalize("NFC").toLowerCase();
  // Armenian: "ու" is the sound u, and a word-initial ե or ո is pronounced "ye" or "vo".
  w = w.replace(/ու/g, "u").replace(/^ե/, "յե").replace(/^ո/, "վո");
  let out = "";
  for (const ch of w) {
    if (ARMENIAN[ch] !== undefined) out += ARMENIAN[ch];
    else if (CYRILLIC[ch] !== undefined) out += CYRILLIC[ch];
    else if (LATIN_EXTRA[ch] !== undefined) out += LATIN_EXTRA[ch];
    else out += ch.normalize("NFD").replace(/\p{M}/gu, ""); // é -> e, ü -> u
  }
  return out.replace(/[’ʼ`]/g, "'").replace(/[^a-z']/g, "");
}

// Splits a line into words, ignoring punctuation and Armenian stress and question marks.
export function wordsOf(line) {
  return String(line).normalize("NFC")
    .replace(/[՛-՞]/g, "")
    .split(/[^\p{L}\p{M}\p{N}'’ʼ]+/u)
    .filter(word => romanize(word));
}

// Turns lyric lines into one list of model tokens, and remembers which tokens belong to which line.
// Lines without any letters (for example only digits) get a range of null.
export function tokenizeLines(lines) {
  const tokens = [], ranges = [];
  for (const line of lines) {
    const first = tokens.length;
    for (const word of wordsOf(line)) {
      for (const ch of romanize(word)) tokens.push(VOCAB[ch]);
    }
    ranges.push(tokens.length > first ? [first, tokens.length - 1] : null);
  }
  return { tokens, ranges };
}

// Converts model scores (logits) of one frame to log-probabilities, in place.
export function logSoftmaxRows(data, frames, vocabSize) {
  for (let t = 0; t < frames; t++) {
    const row = t * vocabSize;
    let max = -Infinity;
    for (let v = 0; v < vocabSize; v++) if (data[row + v] > max) max = data[row + v];
    let sum = 0;
    for (let v = 0; v < vocabSize; v++) sum += Math.exp(data[row + v] - max);
    const logSum = max + Math.log(sum);
    for (let v = 0; v < vocabSize; v++) data[row + v] -= logSum;
  }
  return data;
}

// CTC Viterbi alignment. logProbs holds frames × vocabSize log-probabilities. Returns, for each
// token, the first frame and the frame after the last one where the best path is on that token.
//
// The path moves through 2·L + 1 states: a blank before each token, the token itself, and a final
// blank. From one frame to the next it may stay, move one state forward, or skip a blank between
// two different tokens.
export function ctcAlign(logProbs, frames, vocabSize, tokens) {
  const L = tokens.length, S = 2 * L + 1;
  if (!L) return [];
  let needed = L;
  for (let i = 1; i < L; i++) if (tokens[i] === tokens[i - 1]) needed++; // a repeated letter needs a blank between
  if (frames < needed) throw Error("The song is too short for this many lyrics.");

  const back = new Uint8Array(frames * S); // how each state was reached: 0 stay, 1 from s-1, 2 from s-2
  let prev = new Float32Array(S).fill(-Infinity), cur = new Float32Array(S);
  prev[0] = logProbs[BLANK];
  prev[1] = logProbs[tokens[0]];
  for (let t = 1; t < frames; t++) {
    const row = t * vocabSize, brow = t * S;
    // Only states that can still reach the end in the remaining frames matter.
    const lowest = Math.max(0, S - 2 * (frames - t) - 1), highest = Math.min(S - 1, 2 * t + 1);
    cur.fill(-Infinity);
    for (let s = lowest; s <= highest; s++) {
      let best = prev[s], from = 0;
      if (s > 0 && prev[s - 1] > best) { best = prev[s - 1]; from = 1; }
      if ((s & 1) && s > 1 && tokens[(s - 1) >> 1] !== tokens[(s - 3) >> 1] && prev[s - 2] > best) { best = prev[s - 2]; from = 2; }
      if (best === -Infinity) continue;
      cur[s] = best + logProbs[row + ((s & 1) ? tokens[(s - 1) >> 1] : BLANK)];
      back[brow + s] = from;
    }
    [prev, cur] = [cur, prev];
  }

  let s = prev[S - 1] >= prev[S - 2] ? S - 1 : S - 2;
  const spans = new Array(L);
  for (let t = frames - 1; t >= 0; t--) {
    if (s & 1) {
      const k = (s - 1) >> 1;
      if (spans[k]) spans[k].start = t; else spans[k] = { start: t, end: t + 1 };
    }
    if (t > 0) s -= back[t * S + s];
  }
  return spans;
}

// Average probability (0 to 1) of the letters of one line on the best path: a rough confidence.
export function lineConfidence(logProbs, vocabSize, tokens, spans, range) {
  if (!range) return 0;
  let sum = 0, count = 0;
  for (let k = range[0]; k <= range[1]; k++) {
    for (let t = spans[k].start; t < spans[k].end; t++) {
      sum += Math.exp(logProbs[t * vocabSize + tokens[k]]);
      count++;
    }
  }
  return count ? sum / count : 0;
}
