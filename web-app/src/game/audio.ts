const IMA_STEP_TABLE = new Int32Array([
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
]);

const IMA_INDEX_TABLE = new Int32Array([-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]);

interface WavInfo {
  format: number;
  channels: number;
  sampleRate: number;
  blockAlign: number;
  bitsPerSample: number;
  samplesPerBlock: number;
  factSamples: number;
  data: Uint8Array;
}

function parseWav(buf: ArrayBuffer): WavInfo {
  const view = new DataView(buf);
  if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
    throw new Error("not a RIFF/WAVE file");
  }
  let off = 12;
  let format = 0;
  let channels = 1;
  let sampleRate = 44100;
  let blockAlign = 0;
  let bitsPerSample = 16;
  let samplesPerBlock = 0;
  let factSamples = 0;
  let data: Uint8Array | null = null;
  while (off + 8 <= buf.byteLength) {
    const id = view.getUint32(off, false);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 0x666d7420) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      blockAlign = view.getUint16(body + 12, true);
      bitsPerSample = view.getUint16(body + 14, true);
      if (size >= 20) {
        const cb = view.getUint16(body + 16, true);
        if (cb >= 2 && size >= 20) samplesPerBlock = view.getUint16(body + 18, true);
      }
    } else if (id === 0x66616374) {
      if (size >= 4) factSamples = view.getUint32(body, true);
    } else if (id === 0x64617461) {
      data = new Uint8Array(buf, body, Math.min(size, buf.byteLength - body));
    }
    off = body + size + (size & 1);
  }
  if (!data) throw new Error("WAV has no data chunk");
  return { format, channels, sampleRate, blockAlign, bitsPerSample, samplesPerBlock, factSamples, data };
}

function decodeImaAdpcm(info: WavInfo): Float32Array[] {
  const { channels, blockAlign, data, samplesPerBlock } = info;
  if (channels < 1 || channels > 2) throw new Error(`unsupported channel count ${channels}`);
  if (blockAlign <= 4 * channels) throw new Error("bad IMA block align");
  const headerBytes = 4 * channels;
  const blocks = Math.ceil(data.length / blockAlign);
  const spb = samplesPerBlock || Math.floor(((blockAlign - headerBytes) * 2) / channels) + 1;
  const totalFrames = blocks * spb;
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(totalFrames));

  let write = 0;
  for (let b = 0; b < blocks; b++) {
    const start = b * blockAlign;
    const end = Math.min(start + blockAlign, data.length);
    if (end - start <= headerBytes) break;
    const predictors = new Int32Array(channels);
    const indices = new Int32Array(channels);
    for (let c = 0; c < channels; c++) {
      const h = start + c * 4;
      predictors[c] = (data[h] | (data[h + 1] << 8)) << 16 >> 16;
      indices[c] = data[h + 2];
    }
    for (let c = 0; c < channels; c++) out[c][write] = predictors[c] / 32768;
    const frame = new Int32Array(channels);
    frame.fill(write + 1);
    const dataBytes = end - start - headerBytes;
    for (let j = 0; j < dataBytes; j++) {
      const c = channels === 1 ? 0 : Math.floor(j / 4) % channels;
      if (frame[c] >= write + spb) continue;
      const byte = data[start + headerBytes + j];
      for (let nib = 0; nib < 2; nib++) {
        if (frame[c] >= write + spb) break;
        const n = nib === 0 ? byte & 0x0f : (byte >> 4) & 0x0f;
        const step = IMA_STEP_TABLE[indices[c]];
        let diff = step >> 3;
        if (n & 1) diff += step >> 2;
        if (n & 2) diff += step >> 1;
        if (n & 4) diff += step;
        if (n & 8) diff = -diff;
        let pred = predictors[c] + diff;
        if (pred > 32767) pred = 32767;
        else if (pred < -32768) pred = -32768;
        predictors[c] = pred;
        indices[c] += IMA_INDEX_TABLE[n];
        if (indices[c] < 0) indices[c] = 0;
        else if (indices[c] > 88) indices[c] = 88;
        out[c][frame[c]] = pred / 32768;
        frame[c]++;
      }
    }
    write += spb;
  }
  const frames = info.factSamples > 0 ? Math.min(write, info.factSamples) : write;
  return out.map((a) => a.subarray(0, frames));
}

function decodePcm(info: WavInfo): Float32Array[] {
  const { channels, bitsPerSample, data } = info;
  const bytes = bitsPerSample / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const off = (i * channels + c) * bytes;
      let v = 0;
      if (bitsPerSample === 8) v = (view.getUint8(off) - 128) / 128;
      else if (bitsPerSample === 16) v = view.getInt16(off, true) / 32768;
      else if (bitsPerSample === 24) {
        const x = view.getUint8(off) | (view.getUint8(off + 1) << 8) | (view.getInt8(off + 2) << 16);
        v = x / 8388608;
      } else if (bitsPerSample === 32) v = view.getInt32(off, true) / 2147483648;
      out[c][i] = v;
    }
  }
  return out;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bgmGain: GainNode | null = null;
  private seGain: GainNode | null = null;
  private voiceGain: GainNode | null = null;
  private bgmSource: AudioBufferSourceNode | null = null;
  private bgmName: string | null = null;
  private channels = new Map<number, AudioBufferSourceNode>();
  private cache = new Map<string, AudioBuffer>();
  private cacheBytes = 0;
  private readonly cacheLimit = 160 * 1024 * 1024;
  private bgmVolume = 100;
  private seVolume = 100;
  private voiceVolume = 100;
  private muted = false;

  ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
      this.bgmGain = this.ctx.createGain();
      this.seGain = this.ctx.createGain();
      this.voiceGain = this.ctx.createGain();
      this.bgmGain.connect(this.master);
      this.seGain.connect(this.master);
      this.voiceGain.connect(this.master);
      this.applyVolumes();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  async resume() {
    this.ensure();
  }

  setBgmVolume(v: number) {
    this.bgmVolume = clamp(v, 0, 100);
    this.applyVolumes();
  }

  setSeVolume(v: number) {
    this.seVolume = clamp(v, 0, 100);
    this.applyVolumes();
  }

  setVoiceVolume(v: number) {
    this.voiceVolume = clamp(v, 0, 100);
    this.applyVolumes();
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 1;
  }

  private applyVolumes() {
    if (!this.ctx) return;
    if (this.bgmGain) this.bgmGain.gain.value = this.bgmVolume / 100;
    if (this.seGain) this.seGain.gain.value = this.seVolume / 100;
    if (this.voiceGain) this.voiceGain.gain.value = this.voiceVolume / 100;
  }

  get currentBgm(): string | null {
    return this.bgmName;
  }

  getVolumes(): { bgm: number; se: number; voice: number } {
    return { bgm: this.bgmVolume, se: this.seVolume, voice: this.voiceVolume };
  }

  async playBgm(file: string, loop = true) {
    const ctx = this.ensure();
    const buf = await this.load(file);
    this.stopBgm(0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    src.connect(this.bgmGain!);
    src.start();
    this.bgmSource = src;
    this.bgmName = file;
    src.onended = () => {
      if (this.bgmSource === src) {
        this.bgmSource = null;
        this.bgmName = null;
      }
    };
  }

  stopBgm(fadeMs = 0) {
    const src = this.bgmSource;
    this.bgmSource = null;
    this.bgmName = null;
    if (!src || !this.ctx || !this.bgmGain) return;
    if (fadeMs > 0) {
      const now = this.ctx.currentTime;
      const g = this.bgmGain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + fadeMs / 1000);
      setTimeout(() => {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
        if (this.bgmGain) this.bgmGain.gain.value = this.bgmVolume / 100;
      }, fadeMs + 30);
    } else {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
  }

  async playWave(channel: number, file: string) {
    const ctx = this.ensure();
    const buf = await this.load(file);
    this.stopWave(channel);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = channel === 0 ? this.voiceGain! : this.seGain!;
    src.connect(gain);
    src.start();
    this.channels.set(channel, src);
    src.onended = () => {
      if (this.channels.get(channel) === src) this.channels.delete(channel);
    };
  }

  stopWave(channel: number) {
    const src = this.channels.get(channel);
    if (!src) return;
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
    this.channels.delete(channel);
  }

  stopAll() {
    this.stopBgm(0);
    for (const ch of [...this.channels.keys()]) this.stopWave(ch);
  }

  private async load(file: string): Promise<AudioBuffer> {
    const name = file.toLowerCase().replace(/\\/g, "/");
    const cached = this.cache.get(name);
    if (cached) return cached;
    const url = `/media/audio/${encodeURI(name)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`audio not found: ${url}`);
    const raw = await res.arrayBuffer();
    let buffer: AudioBuffer;
    try {
      const info = parseWav(raw);
      if (info.format === 0x11) {
        const channels = decodeImaAdpcm(info);
        buffer = this.ctx!.createBuffer(channels.length, channels[0].length, info.sampleRate);
        for (let c = 0; c < channels.length; c++) buffer.copyToChannel(channels[c] as Float32Array<ArrayBuffer>, c);
      } else if (info.format === 1 || info.format === 3) {
        const channels = decodePcm(info);
        buffer = this.ctx!.createBuffer(channels.length, channels[0].length, info.sampleRate);
        for (let c = 0; c < channels.length; c++) buffer.copyToChannel(channels[c] as Float32Array<ArrayBuffer>, c);
      } else {
        buffer = await this.ctx!.decodeAudioData(raw.slice(0));
      }
    } catch {
      buffer = await this.ctx!.decodeAudioData(raw.slice(0));
    }
    this.store(name, buffer);
    return buffer;
  }

  private store(name: string, buffer: AudioBuffer) {
    const bytes = buffer.length * buffer.numberOfChannels * 4;
    if (bytes > this.cacheLimit) return;
    while (this.cacheBytes + bytes > this.cacheLimit && this.cache.size > 0) {
      const [k, v] = this.cache.entries().next().value as [string, AudioBuffer];
      this.cacheBytes -= v.length * v.numberOfChannels * 4;
      this.cache.delete(k);
    }
    this.cache.set(name, buffer);
    this.cacheBytes += bytes;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
