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
} from "@discordjs/voice";
import winston from "winston";
import path from "path";
import { Readable, pipeline } from "stream";
import type {
  WOPRPlugin,
  WOPRPluginContextWithVoice,
  ConfigSchema,
  StreamMessage,
  VoiceChannelState,
  AudioBufferState,
} from "./types.js";
import { OpusToPCMConverter, PCMToOpusConverter, VADDetector } from "./audio-converter.js";

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
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
      level: "warn",
    }),
  ],
});

let client: Client | null = null;
let ctx: WOPRPluginContextWithVoice | null = null;

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

    // Convert Opus -> PCM 16kHz mono
    const converter = new OpusToPCMConverter();

    // VAD for speech detection
    const config = ctx?.getConfig<any>() || {};
    const vad = new VADDetector({
      silenceThreshold: config.vadThreshold ?? 500,
      silenceDurationMs: config.vadSilenceMs ?? 1500,
      sampleRate: 16000,
    });

    // Buffer audio chunks
    const bufferKey = `${guildId}-${userId}`;
    audioBuffers.set(bufferKey, {
      chunks: [],
      startTime: Date.now(),
      lastChunkTime: Date.now(),
      silenceCount: 0,
    });

    // Collect PCM chunks
    vad.on("data", (chunk: Buffer) => {
      const buffer = audioBuffers.get(bufferKey);
      if (buffer) {
        buffer.chunks.push(chunk);
        buffer.lastChunkTime = Date.now();
      }
    });

    // When speech ends, transcribe
    vad.on("speech-end", async () => {
      logger.info({ msg: "Speech ended", guildId, userId });
      await transcribeUserSpeech(guildId, userId);
    });

    // Pipeline: Opus stream -> Opus decoder + resample -> VAD
    pipeline(audioStream, converter, vad, (err) => {
      if (err) {
        logger.error({ msg: "Audio pipeline error", error: String(err) });
      }
    });
  });
}

/**
 * Transcribe user speech using STT
 */
async function transcribeUserSpeech(guildId: string, userId: string): Promise<void> {
  if (!ctx) return;

  const bufferKey = `${guildId}-${userId}`;
  const buffer = audioBuffers.get(bufferKey);
  if (!buffer || buffer.chunks.length === 0) {
    logger.debug({ msg: "No audio to transcribe", guildId, userId });
    return;
  }

  // Combine all chunks
  const audioPCM = Buffer.concat(buffer.chunks);
  audioBuffers.delete(bufferKey);

  logger.info({ msg: "Transcribing audio", guildId, userId, size: audioPCM.length });

  // Get STT provider
  const stt = ctx.getSTT();
  if (!stt) {
    logger.warn({ msg: "No STT provider available", guildId });
    return;
  }

  try {
    // Transcribe audio
    const transcript = await stt.transcribe(audioPCM, {
      format: "pcm_s16le",
      sampleRate: 16000,
      language: "en",
    });

    if (!transcript || transcript.trim().length === 0) {
      logger.debug({ msg: "Empty transcript", guildId, userId });
      return;
    }

    logger.info({ msg: "Transcript received", guildId, userId, transcript });

    // Get user info
    const guild = client?.guilds.cache.get(guildId);
    const member = guild?.members.cache.get(userId);
    const username = member?.displayName || member?.user.username || userId;

    // Send to WOPR for response
    const sessionKey = `discord-voice-${guildId}`;
    const response = await ctx.inject(sessionKey, transcript, {
      from: username,
      channel: { type: "discord-voice", id: guildId, name: "voice" },
    });

    // Play TTS response
    await playTTSResponse(guildId, response);
  } catch (error) {
    logger.error({ msg: "Transcription failed", error: String(error) });
  }
}

/**
 * Play TTS response to voice channel
 */
async function playTTSResponse(guildId: string, text: string): Promise<void> {
  if (!ctx) return;

  const player = audioPlayers.get(guildId);
  if (!player) {
    logger.warn({ msg: "No audio player for guild", guildId });
    return;
  }

  // Get TTS provider
  const tts = ctx.getTTS();
  if (!tts) {
    logger.warn({ msg: "No TTS provider available", guildId });
    return;
  }

  try {
    logger.info({ msg: "Synthesizing TTS", guildId, text });

    // Synthesize speech
    const result = await tts.synthesize(text, {
      format: "pcm_s16le",
      sampleRate: 16000,
    });

    // Convert PCM 16kHz mono -> Opus 48kHz stereo
    const converter = new PCMToOpusConverter();
    const opusStream = Readable.from(result.audio).pipe(converter);

    // Create audio resource
    const resource = createAudioResource(opusStream, {
      inputType: "opus" as any,
    });

    // Play audio
    player.play(resource);

    logger.info({ msg: "Playing TTS audio", guildId });
  } catch (error) {
    logger.error({ msg: "TTS playback failed", error: String(error) });
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

      try {
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({ content: "❌ Guild not found", ephemeral: true });
          return;
        }

        await joinChannel(guildId, voiceChannel.id, guild.voiceAdapterCreator);
        await interaction.reply({ content: `🎤 Joined ${voiceChannel.name}!`, ephemeral: false });

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
        await interaction.reply({ content: "❌ Failed to join voice channel", ephemeral: true });
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
 * Register slash commands
 */
async function registerSlashCommands(token: string, clientId: string, guildId?: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);

  try {
    logger.info("Registering voice slash commands...");

    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commands.map((cmd) => cmd.toJSON()),
      });
      logger.info(`Registered ${commands.length} voice commands to guild ${guildId}`);
    } else {
      await rest.put(Routes.applicationCommands(clientId), {
        body: commands.map((cmd) => cmd.toJSON()),
      });
      logger.info(`Registered ${commands.length} global voice commands`);
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

  async init(context: WOPRPluginContextWithVoice) {
    ctx = context;
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
    if (!config?.token) {
      const legacy = ctx.getMainConfig("discord") as { token?: string };
      if (legacy?.token) config = { token: legacy.token, clientId: "" };
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
      logger.info({ tag: client?.user?.tag });

      // Register slash commands
      await registerSlashCommands(config.token, config.clientId!, config.guildId);
    });

    // Login to Discord
    try {
      await client.login(config.token);
      logger.info("Discord voice bot started");
    } catch (e) {
      logger.error(e);
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
