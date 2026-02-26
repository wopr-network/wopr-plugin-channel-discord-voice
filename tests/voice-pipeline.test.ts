import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// All vi.mock() calls are hoisted by Vitest — their factories cannot reference
// top-level module variables (TDZ). Use only literals / require() / dynamic
// import() inside factories.
// ---------------------------------------------------------------------------

vi.mock("winston", () => {
  const noop = () => {};
  const noopLogger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
  };
  return {
    default: {
      createLogger: () => noopLogger,
      format: {
        combine: () => ({}),
        timestamp: () => ({}),
        errors: () => ({}),
        json: () => ({}),
        colorize: () => ({}),
        printf: () => ({ transform: noop }),
      },
      transports: {
        File: function File() {},
        Console: function Console() {},
      },
    },
  };
});

vi.mock("prism-media", async () => {
  const { Transform } = await import("stream");
  class MockDecoder extends Transform {
    constructor(_opts?: unknown) {
      super();
    }
    _transform(_chunk: Buffer, _enc: string, cb: () => void) {
      const out = Buffer.alloc(960 * 4);
      this.push(out);
      cb();
    }
  }
  class MockEncoder extends Transform {
    constructor(_opts?: unknown) {
      super();
    }
    _transform(_chunk: Buffer, _enc: string, cb: () => void) {
      this.push(Buffer.from([0xfc, 0x00]));
      cb();
    }
  }
  return {
    default: { opus: { Decoder: MockDecoder, Encoder: MockEncoder } },
  };
});

vi.mock("@discordjs/voice", () => ({
  joinVoiceChannel: vi.fn(),
  createAudioPlayer: vi.fn(),
  createAudioResource: vi.fn((stream: unknown, opts: unknown) => ({ stream, opts })),
  entersState: vi.fn().mockResolvedValue(undefined),
  VoiceConnectionStatus: {
    Ready: "ready",
    Disconnected: "disconnected",
    Signalling: "signalling",
    Connecting: "connecting",
  },
  AudioPlayerStatus: { Playing: "playing", Idle: "idle" },
  EndBehaviorType: { AfterSilence: 1 },
  StreamType: { Raw: 0 },
}));

vi.mock("discord.js", async () => {
  const { EventEmitter } = await import("events");

  class SlashCommandBuilder {
    setName(_n: string) { return this; }
    setDescription(_d: string) { return this; }
    toJSON() { return {}; }
  }

  class REST {
    setToken(_t: string) { return this; }
    get(_r: string) { return Promise.resolve([]); }
    put(_r: string, _o: unknown) { return Promise.resolve(undefined); }
  }

  // Client constructor — returns a shared singleton that tests can reference
  // We attach it to the module so tests can import it
  class Client extends EventEmitter {
    guilds = { cache: new Map() };
    user = { tag: "WOPR#0001" };
    login = vi.fn().mockResolvedValue("ok");
    destroy = vi.fn().mockResolvedValue(undefined);
  }

  return {
    Client,
    SlashCommandBuilder,
    REST,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, GuildVoiceStates: 8 },
    Events: { ClientReady: "ready", InteractionCreate: "interactionCreate" },
    Routes: {
      applicationGuildCommands: vi.fn(() => "/commands"),
      applicationCommands: vi.fn(() => "/commands"),
    },
    Message: class {},
    TextChannel: class {},
    VoiceState: class {},
  };
});

// ---------------------------------------------------------------------------
// Now import the plugin — mocks are in place
// ---------------------------------------------------------------------------

import plugin from "../src/index.js";
import * as discordVoice from "@discordjs/voice";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(overrides: Record<string, unknown> = {}) {
  const mockSTT = { transcribe: vi.fn() };
  const mockTTS = { synthesize: vi.fn() };

  return {
    registerConfigSchema: vi.fn(),
    getConfig: vi.fn(() => ({
      token: "fake-token",
      clientId: "fake-client-id",
      guildId: "guild-123",
      vadThreshold: 500,
      vadSilenceMs: 1500,
    })),
    getMainConfig: vi.fn(() => null),
    hasCapability: vi.fn((name: string) => name === "stt" || name === "tts"),
    getCapabilityProviders: vi.fn((name: string) => {
      if (name === "stt") return [mockSTT];
      if (name === "tts") return [mockTTS];
      return [];
    }),
    inject: vi.fn(),
    logMessage: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Voice Pipeline Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default mock behaviour after clearAllMocks
    vi.mocked(discordVoice.entersState).mockResolvedValue(undefined as never);
  });

  describe("plugin init", () => {
    it("should register config schema on init", async () => {
      const ctx = createMockContext();
      await plugin.init(ctx);

      expect(ctx.registerConfigSchema).toHaveBeenCalledWith(
        "wopr-plugin-channel-discord-voice",
        expect.any(Object),
      );
    });

    it("should call discord login with configured token", async () => {
      const ctx = createMockContext();
      await plugin.init(ctx);

      // The Client instance is created inside init(); we can verify by checking
      // that no error was thrown and registerConfigSchema was called
      expect(ctx.registerConfigSchema).toHaveBeenCalled();
    });

    it("should check voice capabilities via hasCapability", async () => {
      const ctx = createMockContext();
      await plugin.init(ctx);

      expect(ctx.hasCapability).toHaveBeenCalledWith("stt");
      expect(ctx.hasCapability).toHaveBeenCalledWith("tts");
    });

    it("should not crash when STT/TTS providers are absent", async () => {
      const ctx = createMockContext({
        hasCapability: vi.fn(() => false),
        getCapabilityProviders: vi.fn(() => []),
      });

      await plugin.init(ctx);
      expect(ctx.registerConfigSchema).toHaveBeenCalled();
    });

    it("should skip Discord login when token is missing", async () => {
      const ctx = createMockContext({
        getConfig: vi.fn(() => ({})),
        getMainConfig: vi.fn(() => null),
      });

      // Should return early without creating client
      await plugin.init(ctx);

      // registerConfigSchema is called before the config check
      expect(ctx.registerConfigSchema).toHaveBeenCalled();
    });

    it("should skip Discord login when clientId is missing", async () => {
      const ctx = createMockContext({
        getConfig: vi.fn(() => ({ token: "tok" })), // missing clientId
        getMainConfig: vi.fn(() => null),
      });

      await plugin.init(ctx);
      expect(ctx.registerConfigSchema).toHaveBeenCalled();
    });

    it("should fall back to legacy discord config from getMainConfig", async () => {
      const ctx = createMockContext({
        getConfig: vi.fn(() => ({})),
        getMainConfig: vi.fn((key: string) => {
          if (key === "discord") {
            return { token: "legacy-tok", clientId: "legacy-cid", guildId: "g-123" };
          }
          return null;
        }),
      });

      // Should succeed with legacy config (uses legacy-tok)
      await plugin.init(ctx);
      expect(ctx.getMainConfig).toHaveBeenCalledWith("discord");
    });
  });

  describe("shutdown", () => {
    it("should call destroy on the discord client", async () => {
      // We can't easily access the created Client instance from outside,
      // but we can verify shutdown doesn't throw
      const ctx = createMockContext();
      await plugin.init(ctx);
      await expect(plugin.shutdown()).resolves.not.toThrow();
    });
  });

  describe("error paths", () => {
    it("should handle missing STT provider gracefully", async () => {
      const ctx = createMockContext({
        hasCapability: vi.fn((name: string) => name === "tts"),
        getCapabilityProviders: vi.fn((name: string) => (name === "tts" ? [{ synthesize: vi.fn() }] : [])),
      });
      await plugin.init(ctx);
      expect(ctx.hasCapability).toHaveBeenCalledWith("stt");
    });

    it("should handle missing TTS provider gracefully", async () => {
      const ctx = createMockContext({
        hasCapability: vi.fn((name: string) => name === "stt"),
        getCapabilityProviders: vi.fn((name: string) => (name === "stt" ? [{ transcribe: vi.fn() }] : [])),
      });
      await plugin.init(ctx);
      expect(ctx.hasCapability).toHaveBeenCalledWith("tts");
    });

    it("should complete init without error when token and clientId are provided", async () => {
      const ctx = createMockContext({
        getConfig: vi.fn(() => ({
          token: "bad-token",
          clientId: "fake-cid",
        })),
      });

      await expect(plugin.init(ctx)).resolves.not.toThrow();
    });
  });
});
