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
let ambientRepeatTicks = 0;
const AMBIENT_FORCE_EVERY = 10;   // append same phrase every N ticks (N * rate ms)

let PHRASE_TO_COLORS = new Map();
let COLOR_KEY_TO_RGB = new Map();
let COLOR_TO_WORDS = new Map(); 

// ===== Ambient Story/NLG =====
let storyTimer = null;
let storyContext = null;   // persistent characters/setting/mood
const STORY_FORCE_EVERY = 6; // even if emotion stable, write every N ticks

// smoothing of the emotion stream (moving average over last K ticks)
const EMO_SMOOTH = 5;
let emoWindow = []; // [{val,aro,dom,label}]



// ----------------------- CIELAB EMOTION ENGINE -----------------------
// cite: Lightness ↑ → Valence ↑; Chroma ↑ (+ red/a*) → Arousal & Dominance ↑,
// low L* + high chroma(+red) → threat/rage; low L* + low chroma → negative-powerless;
// happy = high L* & high chroma; surprised = high L* & yellowish; anger = high a* & low L*;
// disgust = high chroma (red+yellow) & low L*; fear/sad = low all.  (Frontiers Psych 2025)

let emoTimer = null, emoPrev = "", emoRepeatTicks = 0;
const EMO_FORCE_EVERY = 8; // write same phrase every N ticks if unchanged

// ---------- RGB -> Lab ----------
function rgbToXyz(r,g,b){
  r/=255; g/=255; b/=255;
  const lin = (u)=> (u<=0.04045? u/12.92 : Math.pow((u+0.055)/1.055,2.4));
  r=lin(r); g=lin(g); b=lin(b);
  // sRGB D65
  const x = r*0.4124564 + g*0.3575761 + b*0.1804375;
  const y = r*0.2126729 + g*0.7151522 + b*0.0721750;
  const z = r*0.0193339 + g*0.1191920 + b*0.9503041;
  return {x,y,z};
}
function xyzToLab(x,y,z){
  // D65 reference white
  const Xr=0.95047, Yr=1.00000, Zr=1.08883;
  const f=(t)=> (t>0.008856? Math.cbrt(t) : (7.787*t + 16/116));
  const fx=f(x/Xr), fy=f(y/Yr), fz=f(z/Zr);
  const L= (116*fy - 16);
  const a= 500*(fx - fy);
  const b= 200*(fy - fz);
  return {L,a,b};
}
function rgbToLab(r,g,b){ const xyz=rgbToXyz(r,g,b); return xyzToLab(xyz.x,xyz.y,xyz.z); }

// ---------- Lab -> VAD ----------
function labToVAD(L,a,b){
  // Per paper: Valence ~ ↑L* (+ some chroma), Arousal ~ ↑chroma & ↑red (a*) and ↓L*,
  // Dominance ~ ↑chroma & ↑red and ↓L*. Interactions are approximated with weights. :contentReference[oaicite:1]{index=1}
  const C = Math.sqrt(a*a + b*b);            // chroma
  const Ln = constrain(L/100, 0, 1);
  const Cn = constrain(C/100, 0, 1);         // normalize chroma roughly to [0,1]
  const an = constrain((a+100)/200, 0, 1);   // redness [0,1] (centered around 0)

  // weights chosen to reflect effects in the paper
  let val = 0.65*Ln + 0.25*Cn - 0.05*(1-an);         // brighter & more colorful => more positive
  let aro = 0.55*Cn + 0.30*an - 0.25*Ln;             // colorful/red raises arousal, darkness raises too
  let dom = 0.45*Cn + 0.35*an - 0.20*Ln;             // colorful/red dominant, darkness dominant

  // interaction: if (an high AND Cn high) boost arousal & dominance (“rage/joy effect”)
  const boost = Math.max(0, (an-0.55)) * Math.max(0, (Cn-0.55));
  aro += 0.15*boost; dom += 0.15*boost;

  // clip
  val = constrain(val,0,1); aro = constrain(aro,0,1); dom = constrain(dom,0,1);
  return {val, aro, dom, C};
}

// ---------- Lab -> discrete emotion ----------
function labToEmotion(L,a,b){
  const {val, aro, dom, C} = labToVAD(L,a,b);
  const light = L/100, red = (a>0)? a/80 : 0, yell = (b>0)? b/80 : 0, chrom = C/100;

  // rule set distilled from paper results/tables (cf. Figs 2–7 & Tables) :contentReference[oaicite:2]{index=2}
  if (light>0.70 && chrom>0.45 && red<0.35) return "happy";
  if (light>0.65 && yell>0.35) return "surprised";
  if (red>0.55 && light<0.55 && chrom>0.40) return "anger";
  if (light<0.55 && chrom>0.45 && (red>0.35 || yell>0.35)) return "disgust";
  if (light<0.45 && chrom<0.35) return (val<0.45 ? "sad" : "fear");        // both low; fear slightly lighter/darker split
  // fallback by VAD quadrants
  if (val>0.65 && aro<0.45) return "calm";
  if (val>0.65 && aro>=0.45) return "elation";
  if (val<0.40 && aro>=0.55) return "threat";
  return (val<0.45? "boredom" : "content");
}

// ---------- scan recent rows -> top emotions ----------
function ambientEmotionsFromMatrixLab(nRows=4){
  const n = Math.min(nRows, matrix.length);
  if (n===0) return [];
  const tally = new Map();
  for (let r = matrix.length - n; r < matrix.length; r++){
    const row = matrix[r];
    for (let c = 0; c < row.length; c++){
      const cell = row[c];
      const LAb = rgbToLab(cell.r, cell.g, cell.b);
      const emo = labToEmotion(LAb.L, LAb.a, LAb.b);
      tally.set(emo, (tally.get(emo)||0)+1);
    }
  }
  const K = Math.max(1, Math.floor(map(ambSensSlider.value()/100, 0,1, 1,4)));
  return Array.from(tally.entries()).sort((a,b)=>b[1]-a[1]).slice(0,K).map(x=>x[0]);
}

// ---------- controller ----------
function startEmotionsVAD(){
  if (!isMicActive){ msg("❗ Click 🎧 Start Audio first."); return; }
  stopEmotionsVAD();
  const rate = ambRateSlider.value();
  emoPrev = ""; emoRepeatTicks = 0; tokenCount = 0;
  emoTimer = setInterval(()=>{
    const words = ambientEmotionsFromMatrixLab(4);
    if (!words.length) return;
    const phrase = words.join(" ");
    setLive("<b>Listening:</b> " + phrase);

    if (phrase !== emoPrev){
      emoPrev = phrase; emoRepeatTicks = 0;
      appendFinal(phrase + " ");
      return;
    }
    emoRepeatTicks++;
    if (emoRepeatTicks >= EMO_FORCE_EVERY){
      emoRepeatTicks = 0;
      appendFinal(phrase + " ");
    }
  }, rate);
  msg(`🧭 Emotions (CIELAB) … ${rate}ms/sample.`);
}
function stopEmotionsVAD(){
  if (emoTimer){ clearInterval(emoTimer); emoTimer = null; }
  msg("⛔ Emotions stopped.");
}


// -------------------- LOCAL DATASET LOADER --------------------
const DATASET_FILE = "semantic_rgb_mapping_with_sentiment.csv"; 
let datasetTable = null;

function preload() {
  // Synchronous in p5: when preload() returns, the table is ready.
  datasetTable = loadTable(DATASET_FILE, "csv", "header");
}

function setup() {
  createCanvas(matrixWidth * cellSize, matrixHeight * cellSize);
  mic = new p5.AudioIn();
  fft = new p5.FFT(0.8, 1024);
  buildDatasetFromTable(datasetTable);   // <<< make data usable everywhere
  createUI();
  textFont("system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial");
  textSize(12);
}

// Map discrete emotion -> sentiment scores (valence [-1..1], arousal [0..1], dominance [0..1])
const EMO_PROFILE = {
  calm:   {v: 0.6, a:0.2, d:0.4},
  content:{v: 0.7, a:0.3, d:0.5},
  joy:    {v: 0.9, a:0.6, d:0.6},
  elation:{v: 1.0, a:0.8, d:0.7},
  trust:  {v: 0.7, a:0.4, d:0.6},
  anticipation:{v:0.6,a:0.6,d:0.5},
  surprise:{v:0.5,a:0.8,d:0.4},
  anger:  {v:-0.7,a:0.8,d:0.7},
  disgust:{v:-0.8,a:0.7,d:0.6},
  fear:   {v:-0.8,a:0.8,d:0.3},
  sadness:{v:-0.9,a:0.3,d:0.2},
  boredom:{v:-0.3,a:0.1,d:0.3},
  threat: {v:-0.6,a:0.7,d:0.5},
  happy:  {v:0.9,a:0.6,d:0.6}
};

// Templates per emotion (short, ambient-friendly)
const TEMPLATES = {
  calm: [
    "the room loosens its shoulders",
    "air settles into a soft rhythm",
    "quiet turns warm around the edges"
  ],
  content: [
    "things feel gently right where they are",
    "small comforts gather like folded light",
    "the present tucks itself in neatly"
  ],
  joy: [
    "color lifts and the heart says yes",
    "a sudden brightness finds a grin",
    "steps feel lighter without asking"
  ],
  elation: [
    "everything wants to laugh at once",
    "bright rushes bloom under the skin",
    "the day sparks, leaping from tile to tile"
  ],
  trust: [
    "hands rest open on the table",
    "the floor holds; the walls keep their word",
    "breath arrives on time"
  ],
  anticipation: [
    "a hinge of possibility creaks wider",
    "something almost-started hums",
    "edges ring with a waiting note"
  ],
  surprise: [
    "a bright bead pops in the quiet",
    "the surface ripples—then smooths",
    "a quick blink of lightning under glass"
  ],
  anger: [
    "heat climbs the rails of the room",
    "edges sharpen; vowels bite",
    "a red pulse taps the ribs"
  ],
  disgust: [
    "color curdles at the rim",
    "the tongue pulls back from the cup",
    "something sour fogs the air"
  ],
  fear: [
    "shadows practice being doors",
    "the throat rehearses silence",
    "footsteps measure the dark"
  ],
  sadness: [
    "blue gathers its long coat",
    "the hour sits heavy and kind",
    "a low rain thinks in circles"
  ],
  boredom: [
    "time flattens into paper",
    "a thin hum holds the room together",
    "the seconds forget their names"
  ],
  threat: [
    "distance leans in a fraction",
    "the corners keep a watch",
    "metal in the air, not seen"
  ],
  happy: [
    "even the dust chooses to dance",
    "windows smile without glass",
    "every ordinary thing answers back"
  ]
};

// Lightweight connectors based on trajectories
const CONNECTORS = {
  rise:  ["and then", "so", "next", "building,", "after that"],
  fall:  ["until", "and slowly", "at last", "finally", "then"],
  turn:  ["but", "however", "yet", "still", "meanwhile"],
  flat:  [",", "—", "…", "and", " "]
};

function startStory(){
  if (!isMicActive){ msg("❗ Click 🎧 Start Audio first."); return; }
  stopStory();

  // seed context once per run
  storyContext = {
    who: choice(["we","the room","the city","the hallway","the street","the window"]),
    place: choice(["kitchen","river edge","studio","stairs","waiting room","train"]),
    lastVal: 0, lastAro: 0, lastEmo: ""
  };
  emoWindow = [];
  tokenCount = 0;

  const rate = ambRateSlider.value();
  storyTimer = setInterval(()=> {
    const tick = emotionTick(); // {label, val, aro, dom}
    if (!tick) return;

    // smooth window
    emoWindow.push(tick);
    if (emoWindow.length > EMO_SMOOTH) emoWindow.shift();
    const avg = averageEmo(emoWindow);

    const sentence = sentimentToSentence(avg, storyContext);
    if (sentence) appendFinal(sentence + " ");

    // update context
    storyContext.lastVal = avg.val;
    storyContext.lastAro = avg.aro;
    storyContext.lastEmo = avg.label;
    setLive("<b>Listening:</b> " + avg.label);
  }, rate);

  msg(`📖 Story mode… ${rate}ms/sample.`);
}

function stopStory(){
  if (storyTimer){ clearInterval(storyTimer); storyTimer = null; }
  msg("⛔ Story mode stopped.");
}

function emotionTick(){
  const n = Math.min(4, matrix.length); // look at last 4 rows
  if (n === 0) return null;

  const count = new Map();
  let sumV=0,sumA=0,sumD=0, N=0;

  for (let r = matrix.length - n; r < matrix.length; r++){
    const row = matrix[r];
    for (let c = 0; c < row.length; c++){
      const cell = row[c];
      const {L,a,b} = rgbToLab(cell.r, cell.g, cell.b);
      const label = labToEmotion(L,a,b);   // you already added this
      const vad = labToVAD(L,a,b);         // you already added this

      count.set(label, (count.get(label)||0)+1);
      sumV += vad.val; sumA += vad.aro; sumD += vad.dom; N++;
    }
  }

  const label = Array.from(count.entries()).sort((a,b)=>b[1]-a[1])[0][0];
  return { label, val: clamp01(sumV/N), aro: clamp01(sumA/N), dom: clamp01(sumD/N) };
}

function averageEmo(arr){
  const n = arr.length || 1;
  let v=0,a=0,d=0; const freq=new Map();
  for (const e of arr){ v+=e.val; a+=e.aro; d+=e.dom; freq.set(e.label,(freq.get(e.label)||0)+1); }
  const label = Array.from(freq.entries()).sort((x,y)=>y[1]-x[1])[0][0];
  return { label, val: v/n, aro: a/n, dom: d/n };
}
function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function sentimentToSentence(s, ctx){
  const emo = s.label in TEMPLATES ? s.label : fallbackByVAD(s);
  const pool = TEMPLATES[emo] || ["something moves and means it"];
  let line = choice(pool);

  // add soft context + connectors based on trajectory
  const dv = s.val - ctx.lastVal;
  const da = s.aro - ctx.lastAro;
  const mag = Math.sqrt(dv*dv + da*da);

  let conn;
  if (mag < 0.05) conn = choice(CONNECTORS.flat);
  else if (dv > 0 && da >= 0) conn = choice(CONNECTORS.rise);
  else if (dv < 0 && da <= 0) conn = choice(CONNECTORS.fall);
  else conn = choice(CONNECTORS.turn);

  // sprinkle a subject/location sometimes for cohesion
  if (Math.random() < 0.25) {
    line = `${ctx.who} in the ${ctx.place} ${conn} ${line}`;
  } else {
    line = `${conn} ${line}`;
  }

  // intensity adornments
  if (s.aro > 0.75 && Math.random()<0.3) line += ", quick as a match";
  if (s.val > 0.8 && Math.random()<0.3) line += ", bright and kind";
  if (s.val < 0.35 && Math.random()<0.3) line += ", low and honest";

  // punctuation/pacing
  line = tidySentence(line);
  return line;
}

function fallbackByVAD(s){
  if (s.val>0.7 && s.aro<0.4) return "calm";
  if (s.val>0.7 && s.aro>=0.4) return "joy";
  if (s.val<0.4 && s.aro>=0.6) return "fear";
  if (s.val<0.45 && s.aro<0.4) return "sadness";
  return "content";
}

function tidySentence(t){
  // clean connector leading commas
  t = t.replace(/^[,–—\s]+/,"").trim();
  // capitalize first letter, ensure period
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (!/[.!?]$/.test(t)) t += ".";
  return t;
}


// Rebuild global data structures from a p5.Table
function buildDatasetFromTable(table) {
  colorData = [];
  PHRASE_TO_COLORS = new Map();
  COLOR_KEY_TO_RGB = new Map();
  COLOR_TO_WORDS = new Map();

  if (!table || !table.getRowCount()) {
    console.warn("Dataset missing or empty:", DATASET_FILE);
    return;
  }

  const getCol = (row, names) => {
    for (const name of names) {
      const v = row.get(name);
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
    }
    return "";
  };

  for (const row of table.rows) {
    const r = parseInt(getCol(row, ["r","R","red"])) || 0;
    const g = parseInt(getCol(row, ["g","G","green"])) || 0;
    const b = parseInt(getCol(row, ["b","B","blue"])) || 0;

    const sound = getCol(row, ["sound","phrase","label","term","semantic","meaning","word","descriptor"]).toLowerCase().trim();
    const colorName = getCol(row, ["Closest Color"]).trim();
    const digit = getCol(row, ["digit","number"]).trim();

    // --- NEW: Original Words list ---
    const origRaw = getCol(row, ["Original Words","tokens"]);
    const origWords = splitWords(origRaw); // -> ["word1","word2",...]

    const entry = { r, g, b, color: colorName, digit, sound };
    colorData.push(entry);

    const rgbKey = `${r},${g},${b}`;
    COLOR_KEY_TO_RGB.set(rgbKey, [r, g, b]);

    // Build phrase -> colors (kept for analyzer)
    if (sound) {
      if (!PHRASE_TO_COLORS.has(sound)) PHRASE_TO_COLORS.set(sound, []);
      PHRASE_TO_COLORS.get(sound).push({ r, g, b, colorName: colorName || sound });
    }

    // Build color -> words (primary mapping we’ll use)
    const colorKey = colorName ? colorName.toLowerCase() : rgbKey;
    if (!COLOR_TO_WORDS.has(colorKey)) COLOR_TO_WORDS.set(colorKey, []);
    if (origWords.length) {
      // merge while avoiding dupes
      const arr = COLOR_TO_WORDS.get(colorKey);
      for (const w of origWords) if (w && !arr.includes(w)) arr.push(w);
    }
  }

  console.log("✅ dataset loaded:", colorData.length, "rows with color→words keys:", COLOR_TO_WORDS.size);
}

// split a cell like "word1, word2; word3 | word4" into clean tokens
function splitWords(s) {
  if (!s) return [];
  return s
    .split(/[,;|\/]+/g)
    .map(t => t.toLowerCase().replace(/[_\-]+/g," ").replace(/\s+/g," ").trim())
    .filter(Boolean);
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
  btn("Start Emotions (Lab)", startEmotionsVAD, c);
  btn("Stop Emotions", stopEmotionsVAD, c);
  btn("Start Story", startStory, c);
  btn("Stop Story", stopStory, c);


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
  if (!isMicActive) { msg("❗ Click 🎧 Start Audio first."); return; }
  if (colorData.length === 0) { msg("❗ Dataset not loaded."); return; }

  stopAmbient();
  const rate = ambRateSlider.value();
  ambientPrev = "";
  ambientRepeatTicks = 0;
  tokenCount = 0;

  ambientTimer = setInterval(() => {
    // build words from the most recent rows
    const words = ambientWordsFromMatrix(4); // last 4 rows
    if (!words.length) return;

    const phrase = words.join(" ");
    setLive("<b>Listening:</b> " + phrase);

    // Always append if phrase changed
    if (phrase !== ambientPrev) {
      ambientPrev = phrase;
      ambientRepeatTicks = 0;
      appendFinal(phrase + " ");
      return;
    }

    // If phrase hasn't changed, append it every N ticks so you get a baseline stream
    ambientRepeatTicks++;
    if (ambientRepeatTicks >= AMBIENT_FORCE_EVERY) {
      ambientRepeatTicks = 0;
      appendFinal(phrase + " ");
    }
  }, rate);

  msg(`🌈 Ambient encoding… ${rate}ms/sample. (force every ${AMBIENT_FORCE_EVERY} ticks)`);
}

function stopAmbient() {
  if (ambientTimer) { clearInterval(ambientTimer); ambientTimer = null; }
  msg("⛔ Ambient encoding stopped.");
}



// Look at the last N rows, find the top colors, emit their mapped words
function ambientWordsFromMatrix(nRows=4) {
  const n = min(nRows, matrix.length);
  if (n === 0) return [];

  // Build a dominance histogram keyed by colorName or RGB
  const hist = new Map();
  const sens = ambSensSlider.value()/100;

  for (let r = matrix.length - n; r < matrix.length; r++) {
    const row = matrix[r];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      const key = (cell.colorName && cell.colorName.trim())
        ? cell.colorName.toLowerCase()
        : `${cell.r},${cell.g},${cell.b}`;

      if (!hist.has(key)) {
        hist.set(key, {
          count: 0,
          colorKey: key,
          colorName: cell.colorName,
          r: cell.r, g: cell.g, b: cell.b,
          sound: cell.sound,
          digit: cell.digit
        });
      }
      hist.get(key).count += 1;
    }
  }

  const items = Array.from(hist.values()).sort((a,b)=> b.count - a.count);

  // Choose how many colors to speak per tick based on sensitivity (1..4)
  const K = max(1, floor(map(sens, 0, 1, 1, 4)));
  const chosen = items.slice(0, K);

  // For each chosen color, pick a random word from "Original Words"
  const words = chosen.map(entry => pickWordForColor(entry)).filter(Boolean);

  // Tiny shuffle on ties to avoid stutter patterns
  if (words.length > 1 && items.length > 1 && items[0].count === items[1].count) words.reverse();

  return words;
}


function pickWordForColor(entry) {
  const colorKey = (entry.colorName && entry.colorName.trim())
    ? entry.colorName.toLowerCase()
    : `${entry.r},${entry.g},${entry.b}`;

  // try by color name (preferred)
  let list = COLOR_TO_WORDS.get(colorKey);

  // if name didn’t hit, try exact RGB
  if ((!list || list.length === 0) && entry.colorName) {
    list = COLOR_TO_WORDS.get(`${entry.r},${entry.g},${entry.b}`);
  }

  if (list && list.length) {
    return choice(list);
  }

  // graceful fallbacks if that color had no words in the dataset
  if (entry.sound && entry.sound.trim()) return tidy(entry.sound);
  const d = parseInt(entry.digit);
  if (!isNaN(d) && d >= 0 && d <= 9) return DIGIT_WORD[d];
  if (entry.colorName && entry.colorName.trim()) return tidy(entry.colorName);

  // last resort: speak the RGB (you’ll still see activity)
  return `${entry.r},${entry.g},${entry.b}`;
}

// utils
function choice(arr){ return arr[Math.floor(Math.random() * arr.length)]; }
function tidy(s){ return s.toLowerCase().replace(/[_\-]+/g," ").replace(/\s+/g," ").trim(); }


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
