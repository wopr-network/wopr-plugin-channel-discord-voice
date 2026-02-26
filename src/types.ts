/**
 * Type definitions for WOPR Discord Voice Plugin
 *
 * Shared types are imported from @wopr-network/plugin-types.
 * Only plugin-specific types are defined here.
 */

// Re-export shared types used by this plugin
export type {
	AgentIdentity,
	ChannelRef,
	ConfigField,
	ConfigSchema,
	PluginInjectOptions,
	PluginLogger,
	StreamMessage,
	UserProfile,
	WOPRPlugin,
	WOPRPluginContext,
} from "@wopr-network/plugin-types";

/** Minimal STT provider interface for capability provider cast */
export interface STTExtension {
	transcribe(
		audio: Buffer,
		options: { format: string; sampleRate: number; language: string },
	): Promise<string>;
}

/** Minimal TTS extension interface for capability provider cast */
export interface TTSExtension {
	synthesize(
		text: string,
		options: { format: string },
	): Promise<{ audio: Buffer; sampleRate?: number; format?: string }>;
}

/** Typed config for this plugin */
export interface VoicePluginConfig {
	token?: string;
	guildId?: string;
	clientId?: string;
	daveEnabled?: boolean;
	vadSilenceMs?: number;
	vadThreshold?: number;
}

// Plugin-specific types

/** Voice channel connection state */
export interface VoiceChannelState {
	guildId: string;
	channelId: string;
	sessionKey: string;
	userId: string;
	username: string;
	isListening: boolean;
	isSpeaking: boolean;
}

/** Audio buffer accumulation state for STT */
export interface AudioBufferState {
	chunks: Buffer[];
	startTime: number;
	lastChunkTime: number;
	silenceCount: number;
}
