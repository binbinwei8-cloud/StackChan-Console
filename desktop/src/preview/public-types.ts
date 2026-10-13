import type { DeviceSnapshot } from "../device/registry.js";
import type { VisionPreviewSnapshot } from "../vision/tracking.js";
import type { RobotEmotion } from "@stackchan-local/protocol";
import type { VoiceChatSnapshot } from "../voice/chat.js";

export type { RobotEmotion };

export type AvatarExpressionItem = {
  x: number;
  y: number;
  rotation: number;
  weight: number;
  size: number;
};

export type AvatarExpressionPayload = {
  type: "bleAvatar";
  leftEye: AvatarExpressionItem;
  rightEye: AvatarExpressionItem;
  mouth: AvatarExpressionItem;
};

export type PublicVisionFrame = Omit<NonNullable<VisionPreviewSnapshot["frame"]>, "jpegBuffer">;

export type CompletionTtsSnapshot = {
  enabled: boolean;
  lightEnabled: boolean;
  volume: number;
  provider: "volcengine" | "disabled" | "unconfigured";
  configuredVoice: string;
  activeVoice: string;
  cloudEnabled: boolean;
  cloudConfigured: boolean;
  reason?: string;
};

export type PreviewSnapshot = Omit<VisionPreviewSnapshot, "frame"> & {
  frame?: PublicVisionFrame;
  devices?: DeviceSnapshot[];
  completionTts?: CompletionTtsSnapshot;
  voiceChat?: VoiceChatSnapshot;
};

export type DebugSnapshot = {
  vision: PreviewSnapshot;
  devices: DeviceSnapshot[];
  completionTts: CompletionTtsSnapshot;
  voiceChat?: VoiceChatSnapshot;
  logs: unknown[];
};

export type CommandApiResult = {
  ok: boolean;
  sent?: boolean;
  reason?: string;
  error?: string;
  ack?: unknown;
  completion?: unknown;
  command?: unknown;
  [key: string]: unknown;
};
