/**
 * WOPR Discord Voice Channel Plugin
 *
 * Enables voice conversations in Discord voice channels:
 * - Join/leave voice channels
 * - Play TTS responses to voice channel
 * - Listen to users speaking and transcribe via STT
 * - Audio format conversion (Opus 48kHz stereo <-> PCM 16kHz mono)
 */

import {
  Client,
  GatewayIntentBits,
  Events,
  Message,
  TextChannel,
  VoiceState,
  SlashCommandBuilder,
  REST,
  Routes,
  ChatInputCommandInteraction,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  VoiceConnection,
  AudioPlayer,
  EndBehaviorType,
  StreamType,
} from "@discordjs/voice";
import winston from "winston";
import path from "path";
import { Readable, pipeline } from "stream";
import prism from "prism-media";
import type {
  WOPRPlugin,
  WOPRPluginContextWithVoice,
  ConfigSchema,
  StreamMessage,
  VoiceChannelState,
  AudioBufferState,
} from "./types.js";
import { OpusToPCMConverter, PCMToOpusConverter, VADDetector } from "./audio-converter.js";

// Console format that handles { msg: ... } objects properly
const consoleFormat = winston.format.printf((info) => {
  const level = info.level;
  // Winston puts the logged object into info.message when you call logger.warn({...})
  const msgObj = typeof info.message === "object" ? (info.message as Record<string, unknown>) : null;
  const msg = (msgObj?.msg as string) || (info as any).msg || (typeof info.message === "string" ? info.message : "");
  const error = (msgObj?.error as string) || (info as any).error;
  const errorStr = error ? ` - ${error}` : "";
  // If msg is empty but we have data, stringify the message object
  if (!msg && msgObj) {
    return `${level}: ${JSON.stringify(msgObj)}`;
  }
  return `${level}: ${msg}${errorStr}`;
});

const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "wopr-plugin-discord-voice" },
  transports: [
    new winston.transports.File({
      filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-voice-error.log"),
      level: "error",
    }),
    new winston.transports.File({
      filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-voice.log"),
      level: "debug",
    }),
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), consoleFormat),
      level: "warn",
    }),
  ],
});

let client: Client | null = null;
let ctx: WOPRPluginContextWithVoice | null = null;

/**
 * Resample mono PCM to stereo at target sample rate using linear interpolation
 * @param input Input PCM buffer (mono, s16le)
 * @param inputRate Input sample rate (e.g., 22050)
 * @param outputRate Output sample rate (e.g., 48000)
 * @returns Output PCM buffer (stereo, s16le)
 */
function resamplePCM(input: Buffer, inputRate: number, outputRate: number): Buffer {
  const inputSamples = input.length / 2; // 2 bytes per sample (s16le)
  const ratio = outputRate / inputRate;
  const outputSamples = Math.floor(inputSamples * ratio);
  const output = Buffer.alloc(outputSamples * 4); // 2 channels * 2 bytes

  for (let i = 0; i < outputSamples; i++) {
    // Calculate the position in the input buffer
    const inputPos = i / ratio;
    const inputIndex = Math.floor(inputPos);
    const frac = inputPos - inputIndex;

    // Linear interpolation between samples
    let sample: number;
    if (inputIndex + 1 < inputSamples) {
      const s1 = input.readInt16LE(inputIndex * 2);
      const s2 = input.readInt16LE((inputIndex + 1) * 2);
      sample = Math.round(s1 + frac * (s2 - s1));
    } else if (inputIndex < inputSamples) {
      sample = input.readInt16LE(inputIndex * 2);
    } else {
      sample = 0;
    }

    // Clamp to int16 range
    sample = Math.max(-32768, Math.min(32767, sample));

    const outputOffset = i * 4;
    // Write to both channels (stereo)
    output.writeInt16LE(sample, outputOffset); // Left
    output.writeInt16LE(sample, outputOffset + 2); // Right
  }

  return output;
}

// Voice connection management
const connections = new Map<string, VoiceConnection>();
const audioPlayers = new Map<string, AudioPlayer>();
const voiceStates = new Map<string, VoiceChannelState>();
const audioBuffers = new Map<string, AudioBufferState>();

// Configuration schema
const configSchema: ConfigSchema = {
  title: "Discord Voice Channel Integration",
  description: "Configure Discord voice channel integration with STT/TTS",
  fields: [
    {
      name: "token",
      type: "password",
      label: "Discord Bot Token",
      placeholder: "Bot token from Discord Developer Portal",
      required: true,
      description: "Your Discord bot token",
    },
    {
      name: "guildId",
      type: "text",
      label: "Guild ID (optional)",
      placeholder: "Server ID to restrict bot to",
      description: "Restrict bot to a specific Discord server",
    },
    {
      name: "clientId",
      type: "text",
      label: "Application ID",
      placeholder: "From Discord Developer Portal",
      required: true,
      description: "Discord Application ID (for slash commands)",
    },
    {
      name: "vadSilenceMs",
      type: "number",
      label: "VAD Silence Duration (ms)",
      default: 1500,
      description: "Duration of silence to end speech detection",
    },
    {
      name: "vadThreshold",
      type: "number",
      label: "VAD Amplitude Threshold",
      default: 500,
      description: "Minimum amplitude to detect speech",
    },
  ],
};

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName("voice-join")
    .setDescription("Join your current voice channel"),
  new SlashCommandBuilder()
    .setName("voice-leave")
    .setDescription("Leave the voice channel"),
  new SlashCommandBuilder()
    .setName("voice-status")
    .setDescription("Show voice channel status"),
];

/**
 * Join a voice channel
 */
async function joinChannel(
  guildId: string,
  channelId: string,
  voiceAdapterCreator: any
): Promise<VoiceConnection> {
  const existingConnection = connections.get(guildId);
  if (existingConnection) {
    logger.info({ msg: "Already connected to voice channel", guildId });
    return existingConnection;
  }

  logger.info({ msg: "Joining voice channel", guildId, channelId });

  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
    // Disable DAVE E2E encryption - use legacy encryption for receiving audio
    daveEncryption: false,
    debug: true,
  });

  // Wait for connection to be ready
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    logger.info({ msg: "Voice connection ready", guildId });
  } catch (error) {
    logger.error({ msg: "Failed to connect to voice channel", error: String(error) });
    connection.destroy();
    throw error;
  }

  // Create audio player for this guild
  const player = createAudioPlayer();
  connection.subscribe(player);

  // Handle player state changes
  player.on(AudioPlayerStatus.Playing, () => {
    logger.debug({ msg: "Audio player started", guildId });
  });

  player.on(AudioPlayerStatus.Idle, () => {
    logger.debug({ msg: "Audio player idle", guildId });
  });

  player.on("error", (error) => {
    logger.error({ msg: "Audio player error", guildId, error: String(error) });
  });

  // Handle connection state changes
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    logger.warn({ msg: "Voice connection disconnected", guildId });
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
      connections.delete(guildId);
      audioPlayers.delete(guildId);
      logger.info({ msg: "Voice connection destroyed", guildId });
    }
  });

  connections.set(guildId, connection);
  audioPlayers.set(guildId, player);

  // Start listening to users
  startListening(guildId, connection);

  return connection;
}

/**
 * Leave a voice channel
 */
function leaveChannel(guildId: string): void {
  const connection = connections.get(guildId);
  if (connection) {
    connection.destroy();
    connections.delete(guildId);
    audioPlayers.delete(guildId);
    voiceStates.delete(guildId);
    logger.info({ msg: "Left voice channel", guildId });
  }
}

/**
 * Start listening to users in voice channel
 */
function startListening(guildId: string, connection: VoiceConnection): void {
  const receiver = connection.receiver;

  receiver.speaking.on("start", (userId) => {
    logger.info({ msg: "User started speaking", guildId, userId });

    // Create audio stream for this user
    const audioStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 300, // 300ms of silence
      },
    });

    logger.debug({ msg: "Subscribed to audio stream", userId });

    // Debug: Track data flow
    let packetCount = 0;
    audioStream.on("data", (chunk: Buffer) => {
      packetCount++;
      if (packetCount <= 3 || packetCount % 50 === 0) {
        logger.debug({ msg: "Audio packet received", userId, packetCount, size: chunk.length });
      }
    });

    audioStream.on("error", (err) => {
      logger.error({ msg: "Audio stream error", userId, error: String(err) });
    });

    audioStream.on("end", () => {
      logger.debug({ msg: "Audio stream ended", userId, totalPackets: packetCount });
      // When stream ends (Discord's silence detection), transcribe what we have
      logger.info({ msg: "Stream ended - triggering transcription", guildId, userId });
      transcribeUserSpeech(guildId, userId).catch((err) => {
        logger.error({ msg: "Transcription from stream-end failed", error: String(err) });
      });
    });

    // Convert Opus -> PCM 16kHz mono
    const converter = new OpusToPCMConverter();
    converter.on("error", (err) => {
      logger.error({ msg: "Converter error", userId, error: String(err) });
    });

    let converterOutputCount = 0;
    converter.on("data", (chunk: Buffer) => {
      converterOutputCount++;
      if (converterOutputCount <= 3 || converterOutputCount % 50 === 0) {
        logger.debug({ msg: "Converter output", userId, count: converterOutputCount, size: chunk.length });
      }
    });

    // VAD for speech detection
    const config = ctx?.getConfig<any>() || {};
    logger.debug({ msg: "Creating VAD", userId, vadThreshold: config.vadThreshold ?? 500, vadSilenceMs: config.vadSilenceMs ?? 1500 });
    const vad = new VADDetector({
      silenceThreshold: config.vadThreshold ?? 500,
      silenceDurationMs: config.vadSilenceMs ?? 1500,
      sampleRate: 16000,
    });

    vad.on("error", (err) => {
      logger.error({ msg: "VAD error", userId, error: String(err) });
    });

    vad.on("speech-start", () => {
      logger.info({ msg: "VAD: Speech start detected", guildId, userId });
    });

    // Buffer audio chunks
    const bufferKey = `${guildId}-${userId}`;
    logger.debug({ msg: "Creating audio buffer", userId, bufferKey });
    audioBuffers.set(bufferKey, {
      chunks: [],
      startTime: Date.now(),
      lastChunkTime: Date.now(),
      silenceCount: 0,
    });

    let vadOutputCount = 0;
    // Collect PCM chunks
    vad.on("data", (chunk: Buffer) => {
      vadOutputCount++;
      const buffer = audioBuffers.get(bufferKey);
      if (buffer) {
        buffer.chunks.push(chunk);
        buffer.lastChunkTime = Date.now();
        if (vadOutputCount <= 3 || vadOutputCount % 50 === 0) {
          logger.debug({ msg: "VAD output -> buffer", userId, count: vadOutputCount, chunkSize: chunk.length, totalChunks: buffer.chunks.length });
        }
      }
    });

    // When speech ends, transcribe
    vad.on("speech-end", async () => {
      const buffer = audioBuffers.get(bufferKey);
      logger.info({ msg: "VAD: Speech end detected", guildId, userId, totalChunks: buffer?.chunks.length, vadOutputCount });
      await transcribeUserSpeech(guildId, userId);
    });

    // Pipeline: Opus stream -> Opus decoder + resample -> VAD
    logger.debug({ msg: "Starting audio pipeline", userId });
    pipeline(audioStream, converter, vad, (err) => {
      if (err) {
        logger.error({ msg: "Audio pipeline error", error: String(err) });
      } else {
        logger.debug({ msg: "Audio pipeline completed", userId });
      }
    });
  });
}

/**
 * Transcribe user speech using STT
 */
async function transcribeUserSpeech(guildId: string, userId: string): Promise<void> {
  logger.debug({ msg: "transcribeUserSpeech called", guildId, userId, hasCtx: !!ctx });
  if (!ctx) {
    logger.error({ msg: "No context available", guildId, userId });
    return;
  }

  const bufferKey = `${guildId}-${userId}`;
  const buffer = audioBuffers.get(bufferKey);
  logger.debug({ msg: "Audio buffer lookup", bufferKey, hasBuffer: !!buffer, chunks: buffer?.chunks.length });
  if (!buffer || buffer.chunks.length === 0) {
    logger.warn({ msg: "No audio to transcribe - buffer empty", guildId, userId });
    return;
  }

  // Combine all chunks
  const audioPCM = Buffer.concat(buffer.chunks);
  const duration = (audioPCM.length / 2 / 16000).toFixed(2); // seconds
  audioBuffers.delete(bufferKey);

  logger.info({ msg: "Transcribing audio", guildId, userId, size: audioPCM.length, durationSeconds: duration });

  // Get STT provider
  const stt = ctx.getSTT();
  logger.debug({ msg: "STT provider lookup", hasSTT: !!stt });
  if (!stt) {
    logger.warn({ msg: "No STT provider available", guildId });
    return;
  }

  try {
    logger.debug({ msg: "Calling STT transcribe", guildId, audioSize: audioPCM.length });
    // Transcribe audio
    const transcript = await stt.transcribe(audioPCM, {
      format: "pcm_s16le",
      sampleRate: 16000,
      language: "en",
    });

    logger.debug({ msg: "STT transcribe returned", transcript, transcriptLength: transcript?.length });
    if (!transcript || transcript.trim().length === 0) {
      logger.info({ msg: "Empty transcript", guildId, userId });
      return;
    }

    logger.info({ msg: "Transcript received", guildId, userId, transcript });

    // Get user info
    const guild = client?.guilds.cache.get(guildId);
    const member = guild?.members.cache.get(userId);
    const username = member?.displayName || member?.user.username || userId;
    logger.debug({ msg: "User info", username, hasGuild: !!guild, hasMember: !!member });

    // Send to WOPR for response
    const sessionKey = `discord-voice-${guildId}`;
    logger.info({ msg: "Sending to WOPR", sessionKey, transcript, username });
    const response = await ctx.inject(sessionKey, transcript, {
      from: username,
      channel: { type: "discord-voice", id: guildId, name: "voice" },
    });
    logger.info({ msg: "WOPR response received", responseLength: response?.length, responsePreview: response?.slice(0, 100) });

    // Play TTS response
    logger.debug({ msg: "Calling playTTSResponse", guildId });
    await playTTSResponse(guildId, response);
    logger.debug({ msg: "playTTSResponse completed", guildId });
  } catch (error) {
    logger.error({ msg: "Transcription/response failed", error: String(error), stack: (error as any)?.stack });
  }
}

/**
 * Play TTS response to voice channel
 */
async function playTTSResponse(guildId: string, text: string): Promise<void> {
  logger.debug({ msg: "playTTSResponse called", guildId, textLength: text?.length, hasCtx: !!ctx });
  if (!ctx) {
    logger.error({ msg: "No context in playTTSResponse", guildId });
    return;
  }

  const player = audioPlayers.get(guildId);
  logger.debug({ msg: "Audio player lookup", guildId, hasPlayer: !!player });
  if (!player) {
    logger.warn({ msg: "No audio player for guild", guildId });
    return;
  }

  // Get TTS provider
  const tts = ctx.getTTS();
  logger.debug({ msg: "TTS provider lookup", hasTTS: !!tts });
  if (!tts) {
    logger.warn({ msg: "No TTS provider available", guildId });
    return;
  }

  try {
    logger.info({ msg: "Synthesizing TTS", guildId, textLength: text.length, textPreview: text.slice(0, 50) });

    // Synthesize speech
    const result = await tts.synthesize(text, {
      format: "pcm_s16le",
    });
    const sampleRate = result.sampleRate || 22050; // Piper default is 22050Hz
    logger.debug({ msg: "TTS synthesis complete", audioSize: result.audio?.length, format: result.format, sampleRate });

    // Use manual resampling instead of FFmpeg (more reliable)
    logger.debug({ msg: "Resampling PCM", guildId, inputSampleRate: sampleRate });

    // Resample to 48kHz stereo using our helper function
    const convertedAudio = resamplePCM(result.audio, sampleRate, 48000);
    logger.debug({ msg: "Resampling complete", guildId, inputSize: result.audio.length, outputSize: convertedAudio.length });

    // Create a proper readable stream that doesn't end immediately
    const pcmStream = new Readable({
      read() {
        // Push all data at once, then signal end
        this.push(convertedAudio);
        this.push(null);
      }
    });

    // Create audio resource with raw s16le input - Discord.js will encode to Opus
    const resource = createAudioResource(pcmStream, {
      inputType: StreamType.Raw,
      inlineVolume: true,
    });
    logger.debug({ msg: "Audio resource created", guildId, audioLength: convertedAudio.length });

    // Play audio
    player.play(resource);

    logger.info({ msg: "Playing TTS audio", guildId });
  } catch (error) {
    logger.error({ msg: "TTS playback failed", error: String(error), stack: (error as any)?.stack });
  }
}

/**
 * Handle slash commands
 */
async function handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!ctx || !client) return;

  const { commandName } = interaction;
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "This command only works in servers.", ephemeral: true });
    return;
  }

  logger.info({ msg: "Slash command received", command: commandName, guildId });

  switch (commandName) {
    case "voice-join": {
      const member = interaction.member as any;
      const voiceChannel = member?.voice?.channel;

      if (!voiceChannel) {
        await interaction.reply({ content: "❌ You need to be in a voice channel first!", ephemeral: true });
        return;
      }

      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({ content: "❌ Guild not found", ephemeral: true });
        return;
      }

      // Defer reply since joining can take a few seconds
      await interaction.deferReply();

      try {
        await joinChannel(guildId, voiceChannel.id, guild.voiceAdapterCreator);
        await interaction.editReply({ content: `🎤 Joined ${voiceChannel.name}!` });

        // Check voice capabilities
        const hasVoice = ctx.hasVoice();
        if (!hasVoice.stt || !hasVoice.tts) {
          await interaction.followUp({
            content:
              "⚠️ Warning: Voice features limited\n" +
              `STT: ${hasVoice.stt ? "✅" : "❌"}\n` +
              `TTS: ${hasVoice.tts ? "✅" : "❌"}`,
            ephemeral: true,
          });
        }
      } catch (error) {
        logger.error({ msg: "Failed to join voice channel", error: String(error) });
        await interaction.editReply({ content: "❌ Failed to join voice channel" });
      }
      break;
    }

    case "voice-leave": {
      leaveChannel(guildId);
      await interaction.reply({ content: "👋 Left voice channel", ephemeral: false });
      break;
    }

    case "voice-status": {
      const connection = connections.get(guildId);
      const hasVoice = ctx.hasVoice();

      await interaction.reply({
        content:
          `🎤 **Voice Status**\n\n` +
          `**Connected:** ${connection ? "✅" : "❌"}\n` +
          `**STT Available:** ${hasVoice.stt ? "✅" : "❌"}\n` +
          `**TTS Available:** ${hasVoice.tts ? "✅" : "❌"}\n` +
          `**Active Sessions:** ${voiceStates.size}`,
        ephemeral: true,
      });
      break;
    }
  }
}

/**
 * Register slash commands - merges with existing commands instead of replacing
 */
async function registerSlashCommands(token: string, clientId: string, guildId?: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);

  try {
    logger.info("Registering voice slash commands (merge mode)...");

    // Get our command names for filtering
    const voiceCommandNames = new Set(commands.map(cmd => cmd.name));

    if (guildId) {
      // Fetch existing guild commands
      const existingCommands = await rest.get(Routes.applicationGuildCommands(clientId, guildId)) as any[];

      // Filter out our voice commands from existing (in case of re-registration)
      const otherCommands = existingCommands.filter((cmd: any) => !voiceCommandNames.has(cmd.name));

      // Merge: keep other commands + add our voice commands
      const mergedCommands = [...otherCommands, ...commands.map(cmd => cmd.toJSON())];

      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: mergedCommands,
      });
      logger.info(`Registered ${commands.length} voice commands (merged with ${otherCommands.length} existing) to guild ${guildId}`);
    } else {
      // Fetch existing global commands
      const existingCommands = await rest.get(Routes.applicationCommands(clientId)) as any[];

      // Filter out our voice commands from existing
      const otherCommands = existingCommands.filter((cmd: any) => !voiceCommandNames.has(cmd.name));

      // Merge: keep other commands + add our voice commands
      const mergedCommands = [...otherCommands, ...commands.map(cmd => cmd.toJSON())];

      await rest.put(Routes.applicationCommands(clientId), {
        body: mergedCommands,
      });
      logger.info(`Registered ${commands.length} global voice commands (merged with ${otherCommands.length} existing)`);
    }
  } catch (error) {
    logger.error({ msg: "Failed to register voice commands", error: String(error) });
  }
}

/**
 * Plugin implementation
 */
const plugin: WOPRPlugin = {
  name: "wopr-plugin-channel-discord-voice",
  version: "1.0.0",
  description: "Discord voice channel integration with STT/TTS support",

  async init(context) {
    ctx = context as WOPRPluginContextWithVoice;
    ctx.registerConfigSchema("wopr-plugin-channel-discord-voice", configSchema);

    // Check voice capabilities
    const hasVoice = ctx.hasVoice();
    if (!hasVoice.stt || !hasVoice.tts) {
      logger.warn({
        msg: "Voice features limited",
        stt: hasVoice.stt,
        tts: hasVoice.tts,
      });
    }

    // Get configuration
    let config = ctx.getConfig<{ token?: string; guildId?: string; clientId?: string }>();
    if (!config?.token || !config?.clientId) {
      // Fall back to main discord config
      const legacy = ctx.getMainConfig("discord") as { token?: string; clientId?: string; guildId?: string };
      if (legacy?.token) {
        config = {
          token: legacy.token,
          clientId: legacy.clientId || "",
          guildId: legacy.guildId,
        };
      }
    }
    if (!config?.token || !config?.clientId) {
      logger.warn("Not configured - missing token or clientId");
      return;
    }

    // Create Discord client
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
      ],
    });

    // Handle slash commands
    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      await handleSlashCommand(interaction).catch((e) =>
        logger.error({ msg: "Command error", error: String(e) })
      );
    });

    // Handle client ready
    client.on(Events.ClientReady, async () => {
      logger.info({ msg: "Discord voice bot ready", tag: client?.user?.tag });

      // Register slash commands
      await registerSlashCommands(config.token!, config.clientId!, config.guildId);
    });

    // Login to Discord
    try {
      await client.login(config.token);
      logger.info("Discord voice bot started");
    } catch (e) {
      logger.error({ msg: "Discord voice login failed", error: String(e) });
      throw e;
    }
  },

  async shutdown() {
    // Leave all voice channels
    for (const [guildId] of connections) {
      leaveChannel(guildId);
    }

    // Destroy Discord client
    if (client) {
      await client.destroy();
      logger.info("Discord voice bot stopped");
    }
  },
};

export default plugin;
