let mic, fft;
let matrix = [];
let colorData = [];
const matrixWidth = 40;
const matrixHeight = 40;
const cellSize = 10;
let isMicActive = false;

function preload() {
  loadTable('https://hebbkx1anhila5yf.public.blob.vercel-storage.com/la%20matrice%20plus-kIWdKtxESmRNHxPTFbvx6NsPzpBa5O.csv', 'csv', 'header', (table) => {
    for (let row of table.rows) {
      colorData.push({
        color: row.get('color'),
        r: parseInt(row.get('r')) || 0,
        g: parseInt(row.get('g')) || 0,
        b: parseInt(row.get('b')) || 0,
        digit: row.get('digit'),
        sound: row.get('sound')
      });
    }
  });
}

function setup() {
  createCanvas(matrixWidth * cellSize, matrixHeight * cellSize);
  mic = new p5.AudioIn();
  fft = new p5.FFT();
  fft.setInput(mic);

  select('#startButton').mousePressed(startCapture);
  select('#stopButton').mousePressed(stopCapture);
}

function draw() {
  background(0);
  
  if (isMicActive) {
    let spectrum = fft.analyze();
    let colorMatrixRow = generateColorMatrix(spectrum);
    matrix.push(colorMatrixRow);
    
    if (matrix.length > matrixHeight) matrix.shift(); // Maintain a scrolling view
  }
  
  renderMatrix();
}

function generateColorMatrix(spectrum) {
  return spectrum.slice(0, matrixWidth).map((freq, index) => {
    let colorIndex = floor(map(freq, 0, 255, 0, colorData.length - 1));
    let data = colorData[colorIndex];
    let cellColor = color(data.r, data.g, data.b);
    return { cellColor, digit: data.digit };
  });
}

function renderMatrix() {
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix[y].length; x++) {
      fill(matrix[y][x].cellColor);
      rect(x * cellSize, y * cellSize, cellSize, cellSize);
      fill(255); // White text for better visibility
      textAlign(CENTER, CENTER);
      textSize(8);
      text(matrix[y][x].digit, x * cellSize + cellSize / 2, y * cellSize + cellSize / 2);
    }
  }
}

function startCapture() {
  mic.start();
  isMicActive = true;
}

function stopCapture() {
  mic.stop();
  isMicActive = false;
}