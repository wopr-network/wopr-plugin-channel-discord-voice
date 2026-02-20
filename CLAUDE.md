# wopr-plugin-channel-discord-voice

Discord voice channel integration for WOPR — enables voice conversations in Discord voice channels.

## Commands

```bash
npm run build     # tsc
npm run check     # biome check + tsc --noEmit (run before committing)
npm run format    # biome format --write src/
npm test          # vitest run
```

## Architecture

```
src/
  index.ts         # Plugin entry — Discord voice connection lifecycle
  audio-converter.ts  # PCM/Opus audio format conversion
  types.ts         # Plugin-local types
```

## Key Details

- **Requires `wopr-plugin-discord`** to be installed — this extends the Discord channel with voice
- Uses `@discordjs/voice` for voice channel connections
- Audio pipeline: Discord PCM → STT → LLM → TTS → Opus → Discord
- `audio-converter.ts` handles PCM ↔ Opus transcoding (Discord uses Opus over RTP)
- **Gotcha**: Discord voice requires `sodium` or `libsodium-wrappers` for encryption — must be installed
- **Gotcha**: Voice connections are per-guild, not per-channel. One active voice connection per server.

## Plugin Contract

Imports only from `@wopr-network/plugin-types`. Never import from `@wopr-network/wopr` core.

## Issue Tracking

All issues in **Linear** (team: WOPR). Issue descriptions start with `**Repo:** wopr-network/wopr-plugin-channel-discord-voice`.

## Session Memory

At the start of every WOPR session, **read `~/.wopr-memory.md` if it exists.** It contains recent session context: which repos were active, what branches are in flight, and how many uncommitted changes exist. Use it to orient quickly without re-investigating.

The `Stop` hook writes to this file automatically at session end. Only non-main branches are recorded — if everything is on `main`, nothing is written for that repo.