// Downsample to 16k mono Int16 and emit ~100ms packets.
class DownsampleProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.inRate = sampleRate;             // context rate (e.g., 48000)
    this.ratio = this.inRate / this.targetRate;
    this.acc = [];                         // float32 accumulator
    this.samplesPerPacket = Math.round(this.targetRate * 0.1); // 100ms
    this.port.postMessage({ __init: { inRate: this.inRate, outRate: this.targetRate } });
  }

  static get parameterDescriptors() { return []; }

  // simple (fast) FIR-less downsample (pick sample). Fine for speech.
  _downsample(frame) {
    const outLen = Math.floor(frame.length / this.ratio);
    const out = new Float32Array(outLen);
    for (let i = 0, j = 0; j < outLen; j++, i += this.ratio) out[j] = frame[Math.floor(i)];
    return out;
  }

  _f32ToI16(f32) {
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      let s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return i16;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0]; // mono
    if (!ch) return true;

    const ds = this._downsample(ch);
    // accumulate until we have ~100ms worth at 16k
    this.acc.push(...ds);
    while (this.acc.length >= this.samplesPerPacket) {
      const slice = this.acc.splice(0, this.samplesPerPacket);
      this.port.postMessage(this._f32ToI16(new Float32Array(slice)));
    }
    return true;
  }
}

registerProcessor("downsample-processor", DownsampleProcessor);
