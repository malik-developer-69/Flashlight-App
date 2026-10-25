import { AudioContext, decodeAudioData } from 'react-native-audio-api';
import { makeDemoSamples } from './beat';

// Plays one decoded song and reports where it is, so the light can follow it.
export class Player {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.buffer = null;
    this.src = null;
    this.startedAt = 0;
    this.pausedAt = 0;
    this.playing = false;
    this.volume = 0.8;
    this.onEnd = null;
  }

  _ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** Decode a file picked on the phone (file:// or content:// uri). Returns the decoded channels. */
  async loadUri(uri) {
    this._ensure();
    this.stop();
    const buf = await decodeAudioData(uri);
    return this._adopt(buf);
  }

  loadDemo() {
    const ctx = this._ensure();
    this.stop();
    const sr = 44100;
    const samples = makeDemoSamples(sr, 24, 124);
    const buf = ctx.createBuffer(1, samples.length, sr);
    buf.copyToChannel(samples, 0);
    return this._adopt(buf);
  }

  _adopt(buf) {
    this.buffer = buf;
    this.pausedAt = 0;
    const channels = [];
    for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
    return { channels, sampleRate: buf.sampleRate, duration: buf.duration };
  }

  get duration() { return this.buffer ? this.buffer.duration : 0; }

  position() {
    if (!this.buffer) return 0;
    const p = this.playing ? this.ctx.currentTime - this.startedAt : this.pausedAt;
    return Math.max(0, Math.min(this.buffer.duration, p));
  }

  async play() {
    if (!this.buffer) return;
    const ctx = this._ensure();
    try { await ctx.resume(); } catch (e) {}
    const from = this.pausedAt >= this.buffer.duration - 0.05 ? 0 : this.pausedAt;
    this._kill();
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    src.onEnded = () => {
      if (this.src === src && this.playing) {
        this.playing = false;
        this.pausedAt = 0;
        this.src = null;
        if (this.onEnd) this.onEnd();
      }
    };
    src.start(0, from);
    this.src = src;
    this.startedAt = ctx.currentTime - from;
    this.playing = true;
  }

  pause() {
    if (this.playing) this.pausedAt = this.position();
    this.playing = false;
    this._kill();
  }

  stop() {
    this.playing = false;
    this.pausedAt = 0;
    this._kill();
  }

  async seek(seconds) {
    if (!this.buffer) return;
    const was = this.playing;
    this.pausedAt = Math.max(0, Math.min(this.buffer.duration, seconds));
    if (was) { this.playing = false; await this.play(); }
  }

  setVolume(v) {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
  }

  _kill() {
    if (this.src) {
      try { this.src.onEnded = null; this.src.stop(); } catch (e) {}
      this.src = null;
    }
  }
}
