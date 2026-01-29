# WOPR Discord Voice Channel Plugin

Discord voice channel integration for WOPR - Enables AI voice conversations in Discord voice channels.

## Features

- **Join/Leave Voice Channels** - Connect WOPR to Discord voice channels via slash commands
- **Speech-to-Text (STT)** - Listen to users speaking and transcribe audio using WOPR's STT system
- **Text-to-Speech (TTS)** - Play AI responses in voice channels using WOPR's TTS system
- **Audio Format Conversion** - Automatic conversion between Discord Opus (48kHz stereo) and PCM (16kHz mono)
- **Voice Activity Detection (VAD)** - Detect when users start/stop speaking with configurable silence thresholds
- **Multi-User Support** - Handle multiple users speaking in the same channel

## Architecture

```
Discord Voice Channel (Opus 48kHz stereo)
          │
          ▼
    OpusToPCMConverter (48kHz stereo → 16kHz mono)
          │
          ▼
      VADDetector (speech start/end detection)
          │
          ▼
    STT Provider (transcribe audio)
          │
          ▼
    WOPR Core (process message)
          │
          ▼
    TTS Provider (synthesize response)
          │
          ▼
    PCMToOpusConverter (16kHz mono → 48kHz stereo)
          │
          ▼
Discord Voice Channel (play audio)
```

## Installation

```bash
cd ~/wopr-project/plugins/wopr-plugin-channel-discord-voice
npm install
npm run build
```

## Configuration

Add to your WOPR configuration:

```json
{
  "plugins": {
    "wopr-plugin-channel-discord-voice": {
      "token": "YOUR_DISCORD_BOT_TOKEN",
      "clientId": "YOUR_APPLICATION_ID",
      "guildId": "OPTIONAL_SERVER_ID",
      "vadSilenceMs": 1500,
      "vadThreshold": 500
    }
  }
}
```

### Configuration Fields

- `token` (required) - Discord bot token from Developer Portal
- `clientId` (required) - Discord Application ID (for slash commands)
- `guildId` (optional) - Restrict bot to specific server
- `vadSilenceMs` (default: 1500) - Milliseconds of silence to end speech detection
- `vadThreshold` (default: 500) - Minimum amplitude to detect speech

## Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" section and create a bot
4. Copy the bot token
5. Enable these Privileged Gateway Intents:
   - Message Content Intent
6. Go to "OAuth2" > "URL Generator"
7. Select scopes: `bot`, `applications.commands`
8. Select permissions:
   - Read Messages/View Channels
   - Send Messages
   - Connect (voice)
   - Speak (voice)
9. Copy the generated URL and invite the bot to your server

## Commands

### Slash Commands

- `/voice-join` - Join your current voice channel
- `/voice-leave` - Leave the voice channel
- `/voice-status` - Show voice channel status and capabilities

## Usage

1. Join a voice channel in Discord
2. Use `/voice-join` to bring WOPR into the channel
3. Start speaking - WOPR will transcribe and respond
4. WOPR's responses will be played back via TTS
5. Use `/voice-leave` when done

## Voice System Integration

This plugin requires WOPR's voice system to be configured with STT and TTS providers:

### STT Providers
- `wopr-plugin-voice-whisper-local` - Local Whisper STT
- `wopr-plugin-voice-deepgram` - Deepgram Cloud STT
- `wopr-plugin-voice-assemblyai` - AssemblyAI STT

### TTS Providers
- `wopr-plugin-voice-openai-tts` - OpenAI TTS
- `wopr-plugin-voice-elevenlabs` - ElevenLabs TTS
- `wopr-plugin-voice-piper-local` - Local Piper TTS

Example configuration with voice providers:

```json
{
  "plugins": {
    "wopr-plugin-voice-whisper-local": {
      "model": "base.en",
      "device": "cpu"
    },
    "wopr-plugin-voice-openai-tts": {
      "apiKey": "sk-...",
      "voice": "alloy",
      "model": "tts-1"
    },
    "wopr-plugin-channel-discord-voice": {
      "token": "YOUR_BOT_TOKEN",
      "clientId": "YOUR_APP_ID"
    }
  }
}
```

## Audio Format Details

### Discord Audio
- Codec: Opus
- Sample Rate: 48kHz
- Channels: 2 (stereo)
- Frame Size: 960 samples (20ms)

### WOPR STT Input
- Format: PCM s16le
- Sample Rate: 16kHz
- Channels: 1 (mono)

### WOPR TTS Output
- Format: PCM s16le
- Sample Rate: 16kHz (or configurable)
- Channels: 1 (mono)

## Voice Activity Detection (VAD)

The plugin includes a simple VAD implementation:

- **Speech Start** - Triggered when amplitude exceeds threshold
- **Speech End** - Triggered after N milliseconds of silence
- **Configurable Parameters**:
  - `vadThreshold` - Amplitude threshold (0-32767, default: 500)
  - `vadSilenceMs` - Silence duration to end utterance (default: 1500ms)

For production use, consider integrating more advanced VAD algorithms like:
- WebRTC VAD
- Silero VAD
- Picovoice Cobra

## Dependencies

- `discord.js@^14.14.1` - Discord API client
- `@discordjs/voice@^0.16.1` - Discord voice support
- `@discordjs/opus@^0.9.0` - Opus codec binding
- `sodium-native@^4.0.10` - Encryption for voice
- `prism-media@^1.3.5` - Audio format conversion
- `winston@^3.19.0` - Logging

## Troubleshooting

### No audio heard in Discord

1. Check TTS provider is configured: `/voice-status`
2. Verify bot has "Speak" permission in voice channel
3. Check bot is not server-muted
4. Verify audio format conversion (check logs)

### Bot not transcribing speech

1. Check STT provider is configured: `/voice-status`
2. Verify bot has "Connect" permission
3. Adjust VAD threshold if speech not detected
4. Check microphone permissions in Discord
5. Verify users are not muted

### Connection issues

1. Check bot token is valid
2. Verify bot has voice permissions
3. Check network connectivity
4. Review logs: `logs/discord-voice.log`

## Performance Considerations

- **CPU Usage** - Audio conversion and VAD run in real-time
- **Memory** - Audio buffers accumulate during speech
- **Network** - Voice data is bandwidth-intensive
- **Latency** - STT/TTS processing adds delay

For production deployments:
- Use fast STT/TTS providers
- Consider GPU acceleration for local models
- Monitor buffer sizes to prevent memory leaks
- Implement rate limiting for concurrent users

## Security

- Keep bot token secure (use environment variables)
- Restrict bot permissions to necessary guilds/channels
- Implement user authentication if needed
- Consider privacy implications of voice recording

## License

MIT

## Links

- [Discord.js Documentation](https://discord.js.org/)
- [Discord Voice Guide](https://discord.js.org/#/docs/voice/main/general/welcome)
- [WOPR Voice Types](../../core/src/voice/types.ts)
- [Discord Developer Portal](https://discord.com/developers/applications)

## Contributing

Contributions welcome! Please ensure:
- TypeScript code follows project style
- Audio conversion is tested
- VAD parameters are tunable
- Logging is comprehensive
- Error handling is robust
