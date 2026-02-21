import { vi } from "vitest";

// Mock prism-media before importing audio-converter
// The real prism.opus.Decoder/Encoder require native opus bindings
// Use require() inside the factory to avoid the hoisting TDZ issue
vi.mock("prism-media", async () => {
  const { Transform } = await import("stream");

  class MockDecoder extends Transform {
    constructor(_opts?: unknown) {
      super();
    }
    _transform(chunk: Buffer, _encoding: string, callback: () => void) {
      // Simulate decoding: Opus frame -> 48kHz stereo PCM
      // Real decoder outputs 960 frames * 2 channels * 2 bytes = 3840 bytes per 20ms frame
      const stereoSamples = 960; // 20ms at 48kHz
      const output = Buffer.alloc(stereoSamples * 4); // 2 channels * 2 bytes
      for (let i = 0; i < stereoSamples; i++) {
        const sample = Math.round(5000 * Math.sin((2 * Math.PI * 440 * i) / 48000));
        output.writeInt16LE(sample, i * 4); // left
        output.writeInt16LE(sample, i * 4 + 2); // right
      }
      this.push(output);
      callback();
    }
  }

  class MockEncoder extends Transform {
    constructor(_opts?: unknown) {
      super();
    }
    _transform(_chunk: Buffer, _encoding: string, callback: () => void) {
      // Simulate encoding: 48kHz stereo PCM -> Opus frame
      this.push(Buffer.from([0xfc, 0x00, 0x01, 0x02])); // fake opus header
      callback();
    }
  }

  return {
    default: {
      opus: {
        Decoder: MockDecoder,
        Encoder: MockEncoder,
      },
    },
  };
});

import { describe, it, expect, beforeEach } from "vitest";
import {
  OpusToPCMConverter,
  PCMToOpusConverter,
  VADDetector,
} from "../src/audio-converter.js";

/**
 * Generate a synthetic PCM buffer (s16le, mono) with a sine wave.
 */
function generatePCMSineWave(
  durationMs: number,
  sampleRate: number,
  frequency: number = 440,
  amplitude: number = 10000,
): Buffer {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const buf = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(
      amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate),
    );
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

/**
 * Generate a silent PCM buffer (all zeros).
 */
function generateSilentPCM(durationMs: number, sampleRate: number): Buffer {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  return Buffer.alloc(numSamples * 2);
}

describe("VADDetector", () => {
  const SAMPLE_RATE = 16000;

  describe("speech detection", () => {
    it("should emit speech-start when loud audio arrives", async () => {
      const vad = new VADDetector({
        silenceThreshold: 500,
        silenceDurationMs: 1500,
        sampleRate: SAMPLE_RATE,
      });

      const events: string[] = [];
      vad.on("speech-start", () => events.push("speech-start"));

      const loudChunk = generatePCMSineWave(100, SAMPLE_RATE, 440, 10000);
      vad.write(loudChunk);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(events).toContain("speech-start");
    });

    it("should emit speech-end after sustained silence", async () => {
      const vad = new VADDetector({
        silenceThreshold: 500,
        silenceDurationMs: 500, // 500ms for faster test
        sampleRate: SAMPLE_RATE,
      });

      const events: string[] = [];
      vad.on("speech-start", () => events.push("speech-start"));
      vad.on("speech-end", () => events.push("speech-end"));

      // Send loud audio to trigger speech-start
      const loudChunk = generatePCMSineWave(100, SAMPLE_RATE, 440, 10000);
      vad.write(loudChunk);

      // Send enough silent chunks to exceed silenceDurationMs
      // Each 100ms chunk at 16kHz = 1600 samples * 2 bytes = 3200 bytes
      // silenceDuration = (consecutiveSilence * chunkBytes) / (sampleRate * 2)
      // For 500ms: need consecutiveSilence * 3200 / 32000 >= 0.5
      // consecutiveSilence >= 5
      const silentChunk = generateSilentPCM(100, SAMPLE_RATE);
      for (let i = 0; i < 6; i++) {
        vad.write(silentChunk);
      }

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(events).toContain("speech-start");
      expect(events).toContain("speech-end");
    });

    it("should NOT emit speech-end during brief silence", async () => {
      const vad = new VADDetector({
        silenceThreshold: 500,
        silenceDurationMs: 1500,
        sampleRate: SAMPLE_RATE,
      });

      const events: string[] = [];
      vad.on("speech-end", () => events.push("speech-end"));

      // Start speaking
      vad.write(generatePCMSineWave(100, SAMPLE_RATE, 440, 10000));
      // Brief silence (only 200ms worth)
      vad.write(generateSilentPCM(100, SAMPLE_RATE));
      vad.write(generateSilentPCM(100, SAMPLE_RATE));
      // Resume speaking
      vad.write(generatePCMSineWave(100, SAMPLE_RATE, 440, 10000));

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(events).not.toContain("speech-end");
    });

    it("should pass through chunks unchanged", async () => {
      const vad = new VADDetector({ sampleRate: SAMPLE_RATE });

      const inputChunk = generatePCMSineWave(50, SAMPLE_RATE);
      const outputChunks: Buffer[] = [];
      vad.on("data", (chunk: Buffer) => outputChunks.push(chunk));

      vad.write(inputChunk);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(outputChunks.length).toBe(1);
      expect(outputChunks[0]).toEqual(inputChunk);
    });

    it("should reset state via reset()", async () => {
      const vad = new VADDetector({ sampleRate: SAMPLE_RATE });

      // Start speaking
      vad.write(generatePCMSineWave(100, SAMPLE_RATE));
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Reset state
      vad.reset();

      // After reset, isSpeaking should be false — silence should not trigger speech-end
      const events: string[] = [];
      vad.on("speech-end", () => events.push("speech-end"));

      const silentChunk = generateSilentPCM(100, SAMPLE_RATE);
      for (let i = 0; i < 20; i++) {
        vad.write(silentChunk);
      }

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(events).not.toContain("speech-end");
    });
  });
});

describe("OpusToPCMConverter", () => {
  it("should convert opus input to 16kHz mono PCM output", async () => {
    const converter = new OpusToPCMConverter();
    const outputChunks: Buffer[] = [];
    converter.on("data", (chunk: Buffer) => outputChunks.push(chunk));

    // Feed a fake Opus packet (the mock decoder will convert it)
    const fakeOpusPacket = Buffer.from([0xfc, 0x00, 0x01, 0x02, 0x03]);
    converter.write(fakeOpusPacket);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(outputChunks.length).toBeGreaterThan(0);

    // Mock decoder outputs 960 * 4 = 3840 bytes (48kHz stereo)
    // downsampleAndMono: 960 samples/ch / 3 = 320 output samples * 2 bytes = 640 bytes
    const totalOutput = Buffer.concat(outputChunks);
    expect(totalOutput.length).toBe(640);
  });

  it("should propagate errors from decoder", () => {
    const converter = new OpusToPCMConverter();
    const errors: Error[] = [];
    converter.on("error", (err) => errors.push(err));

    // Emit an error on the internal decoder to exercise the forwarding path
    const testError = new Error("decoder failure");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (converter as any).decoder.emit("error", testError);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(testError);
  });

  it("should handle flush correctly", async () => {
    const converter = new OpusToPCMConverter();
    const outputChunks: Buffer[] = [];
    converter.on("data", (chunk: Buffer) => outputChunks.push(chunk));

    converter.write(Buffer.from([0xfc, 0x00]));

    await new Promise<void>((resolve) => {
      converter.end(() => resolve());
    });

    // After end(), flush should have been called with no crash
    expect(true).toBe(true);
  });
});

describe("OpusToPCMConverter cleanup", () => {
  it("should clean up decoder when destroyed without flush", async () => {
    const converter = new OpusToPCMConverter();

    converter.write(Buffer.from([0xfc, 0x00]));

    converter.destroy();

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(converter.destroyed).toBe(true);
  });
});

describe("PCMToOpusConverter", () => {
  it("should convert 16kHz mono PCM to opus output", async () => {
    const converter = new PCMToOpusConverter(16000);
    const outputChunks: Buffer[] = [];
    converter.on("data", (chunk: Buffer) => outputChunks.push(chunk));

    // Feed mono 16kHz PCM
    const pcm = generatePCMSineWave(20, 16000, 440, 5000);
    converter.write(pcm);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(outputChunks.length).toBeGreaterThan(0);
    // Output should be Opus packets (from mock encoder)
    expect(outputChunks[0][0]).toBe(0xfc); // our mock header byte
  });

  it("should handle different input sample rates", async () => {
    const converter22k = new PCMToOpusConverter(22050);
    const output: Buffer[] = [];
    converter22k.on("data", (chunk: Buffer) => output.push(chunk));

    const pcm = generatePCMSineWave(20, 22050, 440, 5000);
    converter22k.write(pcm);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(output.length).toBeGreaterThan(0);
  });
});

describe("PCMToOpusConverter cleanup", () => {
  it("should clean up encoder when destroyed without flush", async () => {
    const converter = new PCMToOpusConverter(16000);

    converter.write(generatePCMSineWave(20, 16000));

    converter.destroy();

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(converter.destroyed).toBe(true);
  });
});
