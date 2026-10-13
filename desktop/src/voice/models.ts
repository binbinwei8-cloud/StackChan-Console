export const QWEN_REALTIME_MODELS = [
  { id: "qwen3.8-omni-flash-realtime", label: "Qwen3.8 Omni Flash Realtime" },
  { id: "qwen3.5-omni-plus-realtime", label: "Qwen3.5 Omni Plus Realtime" },
  { id: "qwen3.5-omni-flash-realtime", label: "Qwen3.5 Omni Flash Realtime" }
] as const;

export type QwenRealtimeModel = (typeof QWEN_REALTIME_MODELS)[number]["id"];
export const DEFAULT_QWEN_REALTIME_MODEL: QwenRealtimeModel = "qwen3.8-omni-flash-realtime";

export function isQwenRealtimeModel(value: unknown): value is QwenRealtimeModel {
  return typeof value === "string" && QWEN_REALTIME_MODELS.some((model) => model.id === value);
}
