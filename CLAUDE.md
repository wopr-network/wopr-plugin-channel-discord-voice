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

## PR Automation

This repo runs three automated bots on every PR:

- **Qodo** (`.pr_agent.toml`): `auto_review` and `auto_describe` are enabled; `auto_improve` is disabled to prevent bot commits from re-triggering CI/Claude workflows in a cascade.
- **CodeRabbit**: OSS-tier review on every PR.
- **Claude** (`.github/workflows/claude.yml`): Full code review + auto-fix loop on `pull_request` (opened/synchronize/reopened). Responds to `@claude` comments.

To disable Qodo automation temporarily, set the flags to `false` in `.pr_agent.toml`. To disable CodeRabbit, remove its GitHub App from the repo settings.

## Issue Tracking

All issues in **Linear** (team: WOPR). Issue descriptions start with `**Repo:** wopr-network/wopr-plugin-channel-discord-voice`.

## Session Memory

At the start of every WOPR session, **read `~/.wopr-memory.md` if it exists.** It contains recent session context: which repos were active, what branches are in flight, and how many uncommitted changes exist. Use it to orient quickly without re-investigating.

The `Stop` hook writes to this file automatically at session end. Only non-main branches are recorded — if everything is on `main`, nothing is written for that repo.
## Version Control: Prefer jj

Use `jj` (Jujutsu) for all VCS operations instead of `git`:
- `jj status`, `jj diff`, `jj log` for inspection
- `jj new` to start a change, `jj describe` to set the message
- `jj commit` to commit, `jj push` to push
- `jj squash`, `jj rebase`, `jj edit` for history manipulation

Fall back to `git` only for operations not yet supported by `jj`.

