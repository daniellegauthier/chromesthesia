// p5 + Matrix visual + Vosk STT via WebSocket
// Ambient → Text now maps to dataset words (sound/digit/color) and transcript wraps nicely.

// ---------- Matrix / audio visual ----------
let mic, fft;
let matrix = [];
let colorData = [];
const matrixWidth = 40, matrixHeight = 40, cellSize = 10;
let isMicActive = false;

// ---------- UI ----------
let statusDiv, liveDiv, finalDiv;
let startAudioBtn, stopAudioBtn;
let connectBtn, pttBtn, stopSttBtn, clearBtn, contBtn;
let ledSpan, txStats;

// Ambient encoder UI
let ambStartBtn, ambStopBtn, ambSensSlider, ambRateSlider, ambLabel;

// ---------- STT (WebSocket to Vosk) ----------
let ws = null;
let audioCtx, workletNode, stream;
let capturing = false;
let bytesSent = 0, packets = 0;

// Ambient encoder state
let ambientTimer = null;
let ambientPrev = "";
const DIGIT_WORD = ["zero","one","two","three","four","five","six","seven","eight","nine"];
let tokenCount = 0;               // for soft line breaks
const TOKENS_PER_LINE = 14;       // wrap every N tokens visually

function preload() {
  loadTable(
    'https://hebbkx1anhila5yf.public.blob.vercel-storage.com/la%20matrice%20plus-kIWdKtxESmRNHxPTFbvx6NsPzpBa5O.csv',
    'csv','header',
    (table) => {
      for (let row of table.rows) {
        colorData.push({
          color: row.get('color'),               // name string
          r: parseInt(row.get('r')) || 0,
          g: parseInt(row.get('g')) || 0,
          b: parseInt(row.get('b')) || 0,
          digit: row.get('digit'),               // "0".."9"
          sound: row.get('sound') || ""          // word/label (may be empty)
        });
      }
    }
  );
}

function setup() {
  createCanvas(matrixWidth * cellSize, matrixHeight * cellSize);
  mic = new p5.AudioIn();
  fft = new p5.FFT(0.8, 1024);
  createUI();
  textFont("system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial");
  textSize(12);
}

function draw() {
  background(0);
  if (isMicActive) {
    const spec = fft.analyze();
    const row = spec.slice(0, matrixWidth).map((freq) => {
      const idx = floor(map(freq, 0, 255, 0, max(0, colorData.length - 1)));
      const d = colorData[idx] || { r:0,g:0,b:0, digit:"", color:"", sound:"" };
      return {
        cellColor: color(d.r, d.g, d.b),
        digit: d.digit,
        colorName: d.color,
        sound: d.sound
      };
    });
    matrix.push(row);
    if (matrix.length > matrixHeight) matrix.shift();
  }
  // render
  for (let y=0; y<matrix.length; y++) {
    for (let x=0; x<matrix[y].length; x++) {
      fill(matrix[y][x].cellColor);
      rect(x*cellSize, y*cellSize, cellSize, cellSize);
      fill(255);
      textAlign(CENTER, CENTER);
      textSize(8);
      text(matrix[y][x].digit, x*cellSize+cellSize/2, y*cellSize+cellSize/2);
    }
  }
}

// ------------------------- UI -------------------------
function createUI() {
  const c = createDiv().style("width", (matrixWidth*cellSize + 320) + "px").style("margin","10px 0");

  ledSpan = createSpan("🔴").parent(c).style("margin-right","6px");
  txStats = createSpan(" packets: 0 • bytes: 0 ").parent(c);
  createElement("br").parent(c);

  startAudioBtn = btn("🎧 Start Audio", () => {
    mic.start(() => { fft.setInput(mic); isMicActive = true; msg("🎧 Mic active."); }, micErr);
  }, c);
  stopAudioBtn = btn("⏹ Stop Audio", () => {
    try { mic.stop(); } catch(_) {}
    isMicActive = false; msg("🛑 Mic stopped.");
  }, c);

  connectBtn = btn("🔌 Connect STT", connectSTT, c);
  contBtn    = btn("▶️ Start Continuous", startContinuous, c);
  pttBtn     = btn("🎙 Hold to Talk", null, c);
  pttBtn.mousePressed(startPTT);
  pttBtn.mouseReleased(stopPTT);
  stopSttBtn = btn("■ Stop STT", stopSTT, c);
  clearBtn   = btn("Clear", () => { setLive(""); setFinal(""); tokenCount=0; }, c);

  createElement("hr").parent(c);

  // Ambient encoder controls
  ambLabel = createSpan("🌈 Ambient → Dataset Words ").parent(c).style("font-weight","600");
  ambStartBtn = btn("Start Ambient", startAmbient, c);
  ambStopBtn  = btn("Stop Ambient", stopAmbient, c);

  createSpan("&nbsp; Sensitivity ").parent(c);
  ambSensSlider = createSlider(0, 100, 45, 1).parent(c).style("width","160px");

  createSpan("&nbsp; Rate(ms) ").parent(c);
  ambRateSlider = createSlider(60, 400, 160, 10).parent(c).style("width","160px");

  createElement("br").parent(c);

  statusDiv = createDiv("Ready. • For STT: 🎧 Start Audio → 🔌 Connect STT → talk. • For Ambient: 🎧 Start Audio → Start Ambient.")
                .parent(c).style("margin","6px 0");

  // WRAPPED transcript box
  finalDiv  = createDiv("<b>Transcript:</b> <i>(final will appear here)</i>")
                .parent(c)
                .style("padding","10px")
                .style("background","#fff")
                .style("border","1px solid #ddd")
                .style("border-radius","6px")
                .style("margin-bottom","8px")
                .style("max-width", (matrixWidth*cellSize) + "px")
                .style("white-space","pre-wrap")
                .style("overflow-wrap","anywhere")
                .style("word-break","break-word")
                .style("line-height","1.35");

  liveDiv   = createDiv("<b>Listening:</b> <i>(live words…)</i>")
                .parent(c).style("padding","10px")
                .style("background","#fafafa")
                .style("border","1px dashed #ddd")
                .style("border-radius","6px")
                .style("max-width", (matrixWidth*cellSize) + "px");
}

function btn(label, handler, parent) {
  const b = createButton(label).parent(parent);
  b.style("padding","8px 12px").style("border-radius","8px").style("border","1px solid #999")
   .style("background","#f5f5f5").style("cursor","pointer").style("margin","6px 8px 6px 0");
  if (handler) b.mousePressed(handler);
  return b;
}

// ------------------------- STT client (Vosk WS) -------------------------
async function connectSTT() {
  if (ws && ws.readyState === WebSocket.OPEN) { msg("WS already connected."); return; }
  ws = new WebSocket("ws://localhost:3001");
  ws.binaryType = "arraybuffer";

  ws.onopen = async () => {
    msg("📡 STT connected. (server ready)");
    led("🟢");
    bytesSent = 0; packets = 0; showTx();
    await setupAudioWorklet();
  };
  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === "partial") setLive(data.value.partial || "");
      if (data.type === "final") {
        const text = (typeof data.value === "string") ? data.value : (data.value.text || "");
        if (text) appendFinal(text + " ");
      }
      if (data.type === "status") msg("🔊 " + data.value);
    } catch(e) {
      console.warn("Bad WS message:", e);
    }
  };
  ws.onclose = () => { msg("🔌 STT disconnected."); led("🔴"); };
  ws.onerror = (e) => { console.error(e); msg("❗ STT error (WS)."); led("🟠"); };
}

async function setupAudioWorklet() {
  if (audioCtx) return;
  stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  await audioCtx.audioWorklet.addModule("recorder-worklet.js");
  const src = audioCtx.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(audioCtx, "downsample-processor");
  workletNode.port.onmessage = (event) => {
    if (event.data && event.data.__init) { console.log("Worklet init:", event.data.__init); return; }
    if (!capturing || !ws || ws.readyState !== WebSocket.OPEN) return;
    const buf = event.data.buffer; // ArrayBuffer from Int16Array
    ws.send(buf);
    bytesSent += buf.byteLength;
    packets++;
    showTx();
  };
  src.connect(workletNode);
}

async function startPTT() {
  if (!ws || ws.readyState !== WebSocket.OPEN) { msg("Connect STT first."); return; }
  if (!audioCtx) await setupAudioWorklet();
  await audioCtx.resume();
  capturing = true;
  ws.send(JSON.stringify({ type: "start" }));
  msg("🟢 PTT listening… (hold)");
}
function stopPTT() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  capturing = false;
  ws.send(JSON.stringify({ type: "stop" }));
  msg("🛑 PTT stopped.");
}

async function startContinuous() {
  if (!ws || ws.readyState !== WebSocket.OPEN) { msg("Connect STT first."); return; }
  if (!audioCtx) await setupAudioWorklet();
  await audioCtx.resume();
  if (capturing) return;
  capturing = true;
  ws.send(JSON.stringify({ type: "start" }));
  msg("🟢 Continuous listening… click ■ Stop STT to end.");
}

function stopSTT() {
  capturing = false;
  try { ws && ws.close(); } catch(_) {}
  ws = null;
  msg("■ STT stopped."); led("🔴");
}

// ------------------------- Ambient → DATASET WORDS -------------------------
function startAmbient() {
  if (!isMicActive) { msg("❗ Start Audio first so the encoder can read the mic."); return; }
  stopAmbient(); // clear any existing loop
  const rate = ambRateSlider.value(); // ms/token
  ambientPrev = "";
  tokenCount = 0;

  ambientTimer = setInterval(() => {
    const words = ambientWordsFromMatrix(4); // look at last 4 rows
    if (!words.length) return;
    const phrase = words.join(" ");
    if (phrase !== ambientPrev) {
      ambientPrev = phrase;
      appendFinal(phrase + " ");
    }
  }, rate);

  msg(`🌈 Ambient encoding… ${rate}ms/sample.`);
}

function stopAmbient() {
  if (ambientTimer) { clearInterval(ambientTimer); ambientTimer = null; }
  msg("⛔ Ambient encoding stopped.");
}

// Look at the last N rows, find the top colors, emit their mapped words
function ambientWordsFromMatrix(nRows=4) {
  const n = min(nRows, matrix.length);
  if (n === 0) return [];
  const hist = new Map(); // key=colorName -> {count, sound, digit}
  const sens = ambSensSlider.value()/100; // shifts how many top colors we keep

  for (let r = matrix.length - n; r < matrix.length; r++) {
    const row = matrix[r];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      const key = cell.colorName || "";
      if (!key) continue;
      if (!hist.has(key)) hist.set(key, { count: 0, sound: cell.sound, digit: cell.digit, color: cell.colorName });
      hist.get(key).count += 1;
    }
  }

  // Sort colors by dominance
  const items = Array.from(hist.values()).sort((a,b)=> b.count - a.count);

  // Keep top K based on sensitivity (more sensitive → more words)
  const K = max(1, floor(map(sens, 0, 1, 1, 4)));
  const top = items.slice(0, K);

  // Map each top color to a word from dataset
  const words = top.map(mapColorEntryToWord).filter(Boolean);

  // Slight randomization on ties to avoid stutter
  if (words.length > 1 && items.length > 1 && items[0].count === items[1].count) {
    words.reverse();
  }
  return words;
}

function mapColorEntryToWord(entry) {
  // Prefer explicit dataset "sound" field if present
  if (entry.sound && entry.sound.trim()) return tidy(entry.sound);

  // Fallback to digit word
  const d = parseInt(entry.digit);
  if (!isNaN(d) && d >= 0 && d <= 9) return DIGIT_WORD[d];

  // Last resort: color name itself
  if (entry.color && entry.color.trim()) return tidy(entry.color);

  return null;
}
function tidy(s) {
  // Make it pleasant as a token
  return s.toLowerCase().replace(/[_\-]+/g," ").replace(/\s+/g," ").trim();
}

// ------------------------- UI helpers -------------------------
function micErr(e){ console.error(e); msg("❗ Mic permission failed."); }
function msg(t){ statusDiv.html(t); }
function led(icon){ ledSpan.html(icon); }
function showTx(){ txStats.html(` packets: ${packets} • bytes: ${bytesSent}`); }
function setLive(t){ liveDiv.html("<b>Listening:</b> " + (t || "<i>(…)</i>")); }
function setFinal(t){
  finalDiv.html("<b>Transcript:</b> " + (t || "<i>(none yet)</i>"));
}
function appendFinal(text){
  const current = getFinal();
  tokenCount++;
  // Insert a soft newline every N tokens to avoid long single lines
  const spacer = (tokenCount % TOKENS_PER_LINE === 0) ? "\n" : "";
  const next = current ? (current + text + spacer) : (text + spacer);
  setFinal(next);
}
function getFinal(){
  const html = finalDiv.elt.innerHTML;
  const m = html.match(/<\/b>\s*(.*)$/s);
  return (m && m[1] && !m[1].includes("<i>")) ? m[1] : "";
}

// Space = PTT
function keyPressed(){ if (keyCode === 32) startPTT(); }
function keyReleased(){ if (keyCode === 32) stopPTT(); }
