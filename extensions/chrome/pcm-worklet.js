class UzjamPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = [];
    this.frameCount = 0;
    this.targetFrames = 512;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !input[0]) return true;
    const left = input[0];
    const right = input[1] || left;
    const block = new Float32Array(left.length * 2);
    for (let frame = 0; frame < left.length; frame += 1) {
      block[frame * 2] = left[frame] || 0;
      block[frame * 2 + 1] = right[frame] || 0;
    }
    this.frames.push(block);
    this.frameCount += left.length;
    if (this.frameCount >= this.targetFrames) {
      const interleaved = new Float32Array(this.frameCount * 2);
      let offset = 0;
      for (const queued of this.frames) {
        interleaved.set(queued, offset);
        offset += queued.length;
      }
      this.frames = [];
      this.frameCount = 0;
      this.port.postMessage(interleaved.buffer, [interleaved.buffer]);
    }
    if (output && output.length) {
      for (const channel of output) channel.fill(0);
    }
    return true;
  }
}

registerProcessor("uzjam-pcm-capture", UzjamPcmCapture);
