/**
 * Audio Format Conversion Utilities
 *
 * Handles conversion between:
 * - Discord Opus (48kHz stereo) -> PCM 16kHz mono (for STT)
 * - PCM 16kHz mono (from TTS) -> Discord Opus (48kHz stereo)
 */

import prism from "prism-media";
import { Transform } from "stream";

/**
 * Convert Discord Opus (48kHz stereo) to PCM 16kHz mono for STT
 */
export class OpusToPCMConverter extends Transform {
  private decoder: prism.opus.Decoder;
  private resampler: Transform | null = null;

  constructor() {
    super();

    // Decode Opus to PCM (48kHz stereo)
    this.decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    // Resample 48kHz stereo to 16kHz mono
    // For simplicity, we'll do naive downsampling (take every 3rd sample, average channels)
    this.decoder.on("data", (pcm48k: Buffer) => {
      const pcm16k = this.downsampleAndMono(pcm48k);
      this.push(pcm16k);
    });

    this.decoder.on("error", (err) => {
      this.emit("error", err);
    });
  }

  _transform(chunk: Buffer, encoding: string, callback: Function) {
    this.decoder.write(chunk);
    callback();
  }

  _flush(callback: Function) {
    this.decoder.end();
    callback();
  }

  /**
   * Downsample 48kHz stereo PCM to 16kHz mono
   * Input: 48kHz, 2 channels, s16le
   * Output: 16kHz, 1 channel, s16le
   */
  private downsampleAndMono(buffer: Buffer): Buffer {
    const samplesPerChannel = buffer.length / 4; // 2 bytes per sample * 2 channels
    const outputSamples = Math.floor(samplesPerChannel / 3); // 48kHz -> 16kHz = 1/3
    const output = Buffer.alloc(outputSamples * 2); // 1 channel * 2 bytes

    for (let i = 0; i < outputSamples; i++) {
      const sourceIndex = i * 3; // Every 3rd sample
      const sourceOffset = sourceIndex * 4; // 2 channels * 2 bytes

      // Read stereo samples (s16le)
      const left = buffer.readInt16LE(sourceOffset);
      const right = buffer.readInt16LE(sourceOffset + 2);

      // Average to mono
      const mono = Math.floor((left + right) / 2);

      // Write mono sample
      output.writeInt16LE(mono, i * 2);
    }

    return output;
  }
}

/**
 * Convert PCM 16kHz mono (from TTS) to Discord Opus (48kHz stereo)
 */
export class PCMToOpusConverter extends Transform {
  private encoder: prism.opus.Encoder;

  constructor() {
    super();

    // Encode PCM (48kHz stereo) to Opus
    this.encoder = new prism.opus.Encoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    this.encoder.on("data", (opus: Buffer) => {
      this.push(opus);
    });

    this.encoder.on("error", (err) => {
      this.emit("error", err);
    });
  }

  _transform(chunk: Buffer, encoding: string, callback: Function) {
    // Upsample 16kHz mono to 48kHz stereo
    const upsampled = this.upsampleAndStereo(chunk);
    this.encoder.write(upsampled);
    callback();
  }

  _flush(callback: Function) {
    this.encoder.end();
    callback();
  }

  /**
   * Upsample 16kHz mono PCM to 48kHz stereo
   * Input: 16kHz, 1 channel, s16le
   * Output: 48kHz, 2 channels, s16le
   */
  private upsampleAndStereo(buffer: Buffer): Buffer {
    const inputSamples = buffer.length / 2; // 2 bytes per sample
    const outputSamples = inputSamples * 3; // 16kHz -> 48kHz = 3x
    const output = Buffer.alloc(outputSamples * 4); // 2 channels * 2 bytes

    for (let i = 0; i < inputSamples; i++) {
      const sample = buffer.readInt16LE(i * 2);

      // Repeat each sample 3 times (simple upsampling)
      for (let j = 0; j < 3; j++) {
        const outputIndex = i * 3 + j;
        const outputOffset = outputIndex * 4;

        // Write to both channels (stereo)
        output.writeInt16LE(sample, outputOffset); // Left
        output.writeInt16LE(sample, outputOffset + 2); // Right
      }
    }

    return output;
  }
}

/**
 * Accumulate PCM chunks and detect silence for VAD (Voice Activity Detection)
 */
export class VADDetector extends Transform {
  private silenceThreshold: number;
  private silenceDurationMs: number;
  private sampleRate: number;
  private consecutiveSilence: number = 0;
  private isSpeaking: boolean = false;

  constructor(options: {
    silenceThreshold?: number;
    silenceDurationMs?: number;
    sampleRate?: number;
  } = {}) {
    super();

    this.silenceThreshold = options.silenceThreshold ?? 500; // Amplitude threshold
    this.silenceDurationMs = options.silenceDurationMs ?? 1500; // 1.5s of silence
    this.sampleRate = options.sampleRate ?? 16000;
  }

  _transform(chunk: Buffer, encoding: string, callback: Function) {
    const isSilent = this.detectSilence(chunk);

    if (isSilent) {
      this.consecutiveSilence++;
      const silenceDuration = (this.consecutiveSilence * chunk.length) / (this.sampleRate * 2); // s16le = 2 bytes

      if (silenceDuration * 1000 >= this.silenceDurationMs && this.isSpeaking) {
        this.isSpeaking = false;
        this.emit("speech-end");
      }
    } else {
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.emit("speech-start");
      }
      this.consecutiveSilence = 0;
    }

    // Pass through the chunk
    this.push(chunk);
    callback();
  }

  /**
   * Detect if a PCM chunk is silent
   */
  private detectSilence(buffer: Buffer): boolean {
    let sum = 0;
    const samples = buffer.length / 2;

    for (let i = 0; i < samples; i++) {
      const sample = Math.abs(buffer.readInt16LE(i * 2));
      sum += sample;
    }

    const avgAmplitude = sum / samples;
    return avgAmplitude < this.silenceThreshold;
  }

  reset() {
    this.consecutiveSilence = 0;
    this.isSpeaking = false;
  }
}
