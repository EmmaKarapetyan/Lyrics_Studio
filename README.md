# Lyrics Studio

Make a lyric video in your browser: paste the lyrics, let AI time them to the song, fix the timing on a timeline, and export an MP4.

**Open it: [emmakarapetyan.github.io/Lyrics_Studio](https://emmakarapetyan.github.io/Lyrics_Studio/)**

![Lyrics Studio editor with a song loaded and lyrics on the timeline](screenshot.png)

It is free and needs no account. Your video or song never leaves your device: the AI timing and the video export run inside the browser.

## How to use

### 1. Load the song and the lyrics

1. Under **Video or audio**, choose your video or song (MP4, MP3, WAV or M4A). A song without video becomes a video with the lyrics on a black background.
2. Paste the lyrics into the **Lyrics** box, or click **Load .txt**. Each line of text becomes one subtitle. Empty lines and section tags such as `[Chorus]` are skipped.
3. Write the lyrics exactly as they are sung. If the chorus is sung three times, write it three times.

### 2. Time the lines: choose one of three ways

| | Time with AI | Tap along | Split evenly |
|---|---|---|---|
| What you do | wait | listen once and hold a button during each line | set every time yourself |
| How exact | good with clear vocals; check the orange lines | as exact as your timing | not at all until you edit |
| Best for | a computer | a phone or a computer | a short song, or a rough start |
| How long | several minutes, more on a slow computer | as long as the song | a moment, then your own work |

#### Time with AI

1. Click **Time with AI**.
2. The first time, the browser downloads the timing model (about 300 MB) and shows the progress. After that it is kept, and later runs start right away.
3. The AI listens to the whole song. The status line shows how far it is and about how many minutes are left. You can keep using the page, but leave the tab open.
4. When it is done, all lines are on the timeline. If the status line says *"The AI was not sure about lines 12, 47…"*, those lines are orange on the timeline. Check them first.
5. Play the video and fix any line that is off (step 3 below). An orange line turns back to normal when you change its times, or when you click **The times are right** in **Selected line**.

For better results with AI-made songs: if your song tool (for example Suno) gives you the vocals as a separate file, open **Have the vocals as a separate file?** and choose it. The AI then listens to the voice only, and the video still uses the full song.

#### Tap along

1. Click **Tap along**. The song starts from the beginning, and a bar appears at the bottom of the screen. The bar shows the next line.
2. When the singer starts that line, **press and hold** the big button. On a computer you can also hold Space or Enter.
3. **Let go** when the line ends. The bar moves on to the next line.
4. Do the same for every line. After the last line, tapping ends by itself: the song stops, and all lines are on the timeline with the times you tapped.

Good to know:

- People press a little after they hear a line begin, so the app moves every press and every release 0.15 seconds earlier.
- For a fast song, choose **Speed 0.75×** or **0.5×** in the bar. The times are still right for the song at normal speed.
- During an instrumental break, just do not press. A line disappears when you let go, so the screen stays empty during the break.
- **Stop** (or Esc) ends tapping early. The lines you tapped keep their new times; the remaining lines are placed after them.
- **To redo only part of a song,** select the first line you want to redo (in **All lines** or on the timeline) and click **Tap along** again. The app asks whether to start from that line. If you choose OK, playback starts 3 seconds before that line and the lines before it stay as they are. Choose Cancel to start from the beginning.
- If the Lyrics box and the lines on the timeline are different, Tap along starts over from the Lyrics box. It asks first.

#### Split evenly

1. Click **Split evenly**. A list appears under the buttons with every line and its start and end time. All lines get the same length.
2. Correct the text or the times in that list if you like. A quick way: click a row, type its real end time, then click **Re-split the lines after the selected one**. The lines after it share the rest of the song evenly.
3. Click **Next: put the lines on the timeline**.
4. Set the real times while the video plays: select a line and click **Start here** and **End here** at the right moments, or drag the line on the timeline.

### 3. Check and fix

Play the video and watch the subtitles.

To find your way on the timeline:

- Each line shows its number, the same number as in **All lines** and in the AI's messages.
- When you select a line, or click **Previous** / **Next**, the timeline scrolls to it.
- Click or drag along the time scale at the top of the timeline to move through the song.
- The mouse wheel scrolls the timeline sideways. To zoom in and out, use **Zoom**, Ctrl + wheel (Cmd + wheel on a Mac) or pinch on a touchpad.
- To hear one line again, click **Play line** in **All lines**.

To fix a line:

- **Move it in time:** drag it on the timeline, or drag its left or right edge to change when it starts or ends. An edge snaps to the playhead and to the edges of the other lines when it comes close. So the easiest way to set an end: pause the video where the line should end, then drag the right edge to the playhead. Hold Alt to drag without snapping.
- **Exact times:** in **Selected line**, type the start and end, or click **Start here** / **End here** at the current video position.
- **Many lines at once:** **Edit lines** shows every line with its text, start and end, so you can type them in one list.
- **Change the order:** in **Edit lines**, drag a line by its number, or click ▲ / ▼ next to it. The times stay in their places and the lines move: the moved line takes the times of its new place, and the lines it passes shift by one place. If the **Lyrics** box has the same lines, it gets the new order too, so Tap along still works.
- **Position on the screen:** drag the subtitle in the preview.
- **Text, size and width:** in **Selected line**. Colors, outline and a background box for all lines: in **Global style**.
- **Split** (in **All lines**) cuts a line in two, **Delete line** (in **Selected line**) removes it, and **+ Add line** adds a new one at the playhead. **Undo** takes back any change.

### 4. Export the video

Click **Export High Quality Video**. The browser plays the whole song once while it records, then writes the MP4 and downloads it. Keep the tab open and visible until the download starts. The file keeps the size of your video, or becomes 1920×1080 for a song without video.

### Your work is saved

Everything except the video file is saved in the browser automatically. If you close the tab, open the page again and choose the same video to continue. To move your work to another device, use **Save project** and **Open project**.

### On a phone

- **Tap along** is the easiest way on a phone. The big button is made for a thumb.
- The timeline is right under the video. To edit on it, first tap a line to select it, then drag it or its edges. Swiping over lines that are not selected scrolls the timeline. Drag along the time scale at its top to move through the song.
- **Time with AI** also works, but it downloads 300 MB and is slow on a phone.
- Exporting a long video on a phone can be slow or run out of memory. If that happens, save the project, open it on a computer, and export there.

### Keyboard shortcuts

| Key | Action |
|---|---|
| Space | Play or pause |
| ← / → | Previous or next line |
| Shift + ← / → | Move 1 second back or forward |
| Delete or Backspace | Delete the selected line |
| Space or Enter (hold) | During Tap along: the line is being sung |
| Esc | During Tap along: stop |
| Ctrl+Z / Ctrl+Y | Undo or redo |
| Ctrl + mouse wheel | Zoom the timeline (with the pointer over it) |
| Alt (hold while dragging) | Drag a line or edge without snapping |

## How it works

- **AI timing is forced alignment, not transcription.** The lyrics are already known, so the app only has to find *when* each letter is sung. [Meta's MMS aligner](https://huggingface.co/onnx-community/mms-300m-1130-forced-aligner-ONNX) (wav2vec2, trained on more than 1000 languages) runs in the browser with [transformers.js](https://github.com/huggingface/transformers.js) and gives, for every 20 ms of audio, the probability of each Latin letter. The lyrics are written in Latin letters (Armenian and Cyrillic letters by how they sound), and a CTC Viterbi alignment finds the most likely timing of exactly those letters (`align.js`).
- **Why not Whisper:** the first version transcribed the song with Whisper and then matched the words to the lyrics. On Armenian songs Whisper recognised too little for any line to match, so every line fell back to an even split.
- **Export:** each frame of the video and its subtitle is drawn on a canvas and recorded with MediaRecorder as H.264. [FFmpeg compiled to WebAssembly](https://github.com/ffmpegwasm/ffmpeg.wasm) then adds the sound from the original file and writes the MP4, which takes seconds. Browsers that can only record WebM (Firefox) need a full conversion, which is much slower.
- **Code:** `index.html` (layout), `styles.css`, `app.js` (the editor), `align.js` (romanization and CTC alignment) and `aligner-worker.js` (runs the AI model in a background thread). There is no build step and no server code.

## Run it locally

Browsers block the app's modules when `index.html` is opened directly as a file, so start a small local server in this folder:

```text
python -m http.server 8765
```

Then open `http://localhost:8765`.

To try it on a phone on the same Wi-Fi network, start the server with `--bind 0.0.0.0` and open `http://<your computer's IP address>:8765` on the phone. If the phone cannot connect, allow Python through the Windows Firewall.

Every push to `main` publishes the site with GitHub Pages (see `.github/workflows/pages.yml`).

## License

MIT. See [LICENSE](LICENSE).
