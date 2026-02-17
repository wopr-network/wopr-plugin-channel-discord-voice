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
