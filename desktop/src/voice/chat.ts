import { WebSocket } from "ws";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { DesktopConfig, Logger } from "../config.js";
import type { DeviceRegistry, DeviceSession } from "../device/registry.js";
import type { RobotController } from "../robot/controller.js";
import type { VisionTrackingService } from "../vision/tracking.js";
import { encodeStackChanBinaryPcmFrame, type BinaryPcmFrameHeader } from "../ws/binary-frame.js";
import { DEFAULT_QWEN_REALTIME_MODEL, isQwenRealtimeModel, QWEN_REALTIME_MODELS, type QwenRealtimeModel } from "./models.js";

const INPUT_FRAME_BYTES = 1280; // 40 ms, 16 kHz mono s16le
const OUTPUT_FRAME_BYTES = 1920; // 40 ms, 24 kHz mono s16le
const MAX_OUTPUT_BUFFER_BYTES = 2_880_000; // one minute of 24 kHz mono s16le
const PAUSE_QWEN_AT_BYTES = 480_000; // ten seconds
const RESUME_QWEN_AT_BYTES = 240_000; // five seconds
const MAX_WS_BUFFER_BYTES = 256_000;

export type VoiceChatState = "off" | "connecting" | "listening" | "thinking" | "speaking" | "announcement" | "reconnecting" | "error";

export interface VoiceChatSnapshot {
  enabled: boolean;
  configured: boolean;
  state: VoiceChatState;
  deviceId?: string;
  sessionNumber: number;
  lastReply: string;
  model: QwenRealtimeModel;
  availableModels: typeof QWEN_REALTIME_MODELS;
  searchEnabled: boolean;
  lastSearchCount: number;
  reason?: string;
}

export interface VoiceChatSettingsPatch {
  model?: unknown;
  searchEnabled?: unknown;
}

type QwenEvent = { type?: string; [key: string]: unknown };

export class QwenVoiceChatService {
  private enabled = false;
  private state: VoiceChatState = "off";
  private reason?: string;
  private device?: DeviceSession;
  private qwen?: WebSocket;
  private qwenReadPaused = false;
  private streamId = "";
  private expectedMicSeq = 0;
  private resumeCamera?: () => void;
  private generation = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private speakerTimer?: NodeJS.Timeout;
  private speakerRequestId?: string;
  private speakerSeq = 0;
  private speakerBuffer = Buffer.alloc(0);
  private audioDone = false;
  private responseDone = false;
  private speakerStarting = false;
  private speakerEnding = false;
  private userSpeaking = false;
  private micRunning = false;
  private lastMicAt = 0;
  private micStopPromise?: Promise<void>;
  private lastReply = "";
  private model: QwenRealtimeModel;
  private searchEnabled = false;
  private lastSearchCount = 0;
  private sessionNumber = 0;
  private reconnectAttempts = 0;
  private pendingAnnouncements = 0;
  private announcementTail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly config: DesktopConfig,
    private readonly registry: DeviceRegistry,
    private readonly controller: RobotController,
    private readonly vision: Pick<VisionTrackingService, "pauseCamera">,
    private readonly logger: Logger,
    private readonly createQwenSocket: (url: string, options: { headers: { Authorization: string }; handshakeTimeout: number; perMessageDeflate: false }) => WebSocket =
      (url, options) => new WebSocket(url, options)
  ) {
    this.model = isQwenRealtimeModel(config.qwenModel) ? config.qwenModel : DEFAULT_QWEN_REALTIME_MODEL;
    this.loadSettings();
    registry.onEvent((message) => {
      if (message.event.kind !== "playback" || message.deviceId !== this.device?.deviceId ||
          message.event.requestId !== this.speakerRequestId) {
        return;
      }
      if (message.event.state === "finished") {
        this.speakerRequestId = undefined;
        void this.finishTurn();
      } else if (message.event.state === "failed") {
        void this.recover(`机器人播放失败：${message.event.message ?? "未知错误"}`);
      }
    });
  }

  snapshot(): VoiceChatSnapshot {
    return {
      enabled: this.enabled,
      configured: Boolean(this.config.qwenApiKey && this.config.qwenWorkspaceId),
      state: this.state,
      deviceId: this.device?.deviceId,
      sessionNumber: this.sessionNumber,
      lastReply: this.lastReply,
      model: this.model,
      availableModels: QWEN_REALTIME_MODELS,
      searchEnabled: this.searchEnabled,
      lastSearchCount: this.lastSearchCount,
      reason: this.reason
    };
  }

  async updateSettings(patch: VoiceChatSettingsPatch): Promise<VoiceChatSnapshot> {
    if (patch.model !== undefined && !isQwenRealtimeModel(patch.model)) {
      throw new Error("不支持的千问实时语音模型");
    }
    if (patch.searchEnabled !== undefined && typeof patch.searchEnabled !== "boolean") {
      throw new Error("联网搜索设置必须为布尔值");
    }
    if (patch.model === undefined && patch.searchEnabled === undefined) {
      throw new Error("缺少模型或联网搜索设置");
    }
    const model = isQwenRealtimeModel(patch.model) ? patch.model : this.model;
    const searchEnabled = typeof patch.searchEnabled === "boolean" ? patch.searchEnabled : this.searchEnabled;
    if (model === this.model && searchEnabled === this.searchEnabled) return this.snapshot();
    this.saveSettings(model, searchEnabled);
    const wasEnabled = this.enabled;
    if (wasEnabled) await this.stop();
    this.model = model;
    this.searchEnabled = searchEnabled;
    this.lastSearchCount = 0;
    for (const listener of this.listeners) listener();
    if (wasEnabled) await this.start();
    return this.snapshot();
  }

  private loadSettings(): void {
    if (!this.config.qwenSettingsFile) return;
    try {
      const parsed = JSON.parse(readFileSync(this.config.qwenSettingsFile, "utf8")) as VoiceChatSettingsPatch;
      if (isQwenRealtimeModel(parsed.model)) this.model = parsed.model;
      if (typeof parsed.searchEnabled === "boolean") this.searchEnabled = parsed.searchEnabled;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn("invalid local voice chat settings; using defaults");
      }
    }
  }

  private saveSettings(model: QwenRealtimeModel, searchEnabled: boolean): void {
    const file = this.config.qwenSettingsFile;
    if (!file) return;
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ model, searchEnabled }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(state: VoiceChatState, reason?: string): void {
    this.state = state;
    this.reason = reason;
    for (const listener of this.listeners) listener();
  }

  async start(): Promise<VoiceChatSnapshot> {
    if (this.enabled) return this.snapshot();
    if (!this.config.qwenApiKey || !this.config.qwenWorkspaceId) {
      this.setState("error", "请先在本机 .env 配置百炼 API Key 和业务空间 ID");
      return this.snapshot();
    }
    if (this.config.qwenWorkspaceId && !/^[A-Za-z0-9_-]+$/.test(this.config.qwenWorkspaceId)) {
      this.setState("error", "业务空间 ID 格式无效");
      return this.snapshot();
    }
    const device = this.registry.getActiveSession();
    if (!device || !device.capabilities.includes("voiceChatPcm")) {
      this.setState("error", "未找到支持语音聊天的机器人；请先更新固件并连接机器人");
      return this.snapshot();
    }
    this.enabled = true;
    this.device = device;
    this.generation++;
    this.streamId = crypto.randomUUID();
    this.expectedMicSeq = 0;
    this.reconnectAttempts = 0;
    this.lastReply = "";
    this.lastSearchCount = 0;
    this.setState("connecting");
    try {
      this.resumeCamera = await this.vision.pauseCamera();
      if (!this.enabled) return this.snapshot();
      await this.connectQwen(this.generation);
      this.healthTimer = setInterval(() => {
        if (this.enabled && (this.device?.ws.readyState !== WebSocket.OPEN ||
            this.registry.getActiveSession()?.sessionId !== this.device?.sessionId)) {
          void this.stop("机器人已断开，请重新开启语音聊天");
        } else if (this.enabled && this.state === "listening" && this.micRunning && Date.now() - this.lastMicAt > 4000) {
          void this.recover("机器人麦克风没有持续送来音频");
        }
      }, 1000);
    } catch (error) {
      await this.stop(error instanceof Error ? error.message : String(error));
    }
    return this.snapshot();
  }

  async stop(reason?: string): Promise<VoiceChatSnapshot> {
    this.enabled = false;
    this.generation++;
    this.clearTimers();
    this.resumeQwenRead();
    this.qwen?.close();
    this.qwen = undefined;
    await this.stopMic().catch(() => undefined);
    if (this.speakerRequestId) {
      await this.controller.pcmPlaybackAbort(this.speakerRequestId).catch(() => undefined);
    }
    this.resetTurn();
    this.resumeCamera?.();
    this.resumeCamera = undefined;
    this.device = undefined;
    this.setState(reason ? "error" : "off", reason);
    return this.snapshot();
  }

  onMicrophoneFrame(session: DeviceSession, header: BinaryPcmFrameHeader, payload: Buffer): void {
    if (!this.enabled || this.state !== "listening" || !this.micRunning) return;
    if (
        session.sessionId !== this.device?.sessionId || header.streamId !== this.streamId ||
        header.seq !== this.expectedMicSeq || header.sampleRate !== 16000 || header.channels !== 1 ||
        payload.byteLength !== INPUT_FRAME_BYTES) {
      if (this.enabled && session.sessionId === this.device?.sessionId && this.state === "listening") {
        void this.recover("麦克风音频帧无效或丢失");
      }
      return;
    }
    this.expectedMicSeq++;
    this.lastMicAt = Date.now();
    const socket = this.qwen;
    if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_WS_BUFFER_BYTES) {
      void this.recover("千问上行音频拥塞");
      return;
    }
    socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload.toString("base64") }));
  }

  async pauseForAnnouncement(): Promise<() => Promise<void>> {
    this.pendingAnnouncements++;
    const previous = this.announcementTail;
    let unlock!: () => void;
    this.announcementTail = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    try {
      const deadline = Date.now() + 60_000;
      while (this.enabled && (this.state === "thinking" || this.state === "speaking" || this.userSpeaking) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (this.enabled && (this.state === "thinking" || this.state === "speaking" || this.userSpeaking)) {
        await this.recover("千问回答超时，正在建立新会话");
      }
      if (this.enabled) {
        await this.stopMic();
        this.setState("announcement");
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        this.pendingAnnouncements--;
        unlock();
        if (this.enabled && this.pendingAnnouncements === 0 && this.state === "announcement") {
          await this.startMic().catch((error) => this.recover(String(error)));
        }
      };
    } catch (error) {
      this.pendingAnnouncements--;
      unlock();
      throw error;
    }
  }

  private async connectQwen(generation: number): Promise<void> {
    const workspace = this.config.qwenWorkspaceId!;
    const region = this.config.qwenRegion;
    const url = `wss://${workspace}.${region}.maas.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(this.model)}`;
    const socket = this.createQwenSocket(url, {
      headers: { Authorization: `Bearer ${this.config.qwenApiKey}` },
      handshakeTimeout: 15_000,
      perMessageDeflate: false
    });
    this.qwen = socket;
    this.qwenReadPaused = false;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error); else resolve();
      };
      const timeout = setTimeout(() => { socket.close(); finish(new Error("千问会话初始化超时")); }, 20_000);
      socket.on("message", (raw) => {
        if (generation !== this.generation) return;
        try {
          const event = JSON.parse(raw.toString()) as QwenEvent;
          if (typeof event.code === "string") {
            const requestId = typeof event.request_id === "string" ? `（请求 ID：${event.request_id}）` : "";
            const reason = event.code === "Model.AccessDenied"
              ? `百炼业务空间尚未授权模型 ${this.model}${requestId}`
              : `千问错误 ${event.code}: ${String(event.message ?? "请求失败")}${requestId}`;
            if (!ready) finish(new Error(reason));
            else void this.stop(reason);
            return;
          }
          if (event.type === "session.created") {
            socket.send(JSON.stringify({
              type: "session.update",
              session: {
                modalities: ["text", "audio"],
                instructions: "你是 StackChan 机器人。请用自然、简短的中文语音回答用户。",
                turn_detection: { type: "semantic_vad", threshold: 0.1, prefix_padding_ms: 500, silence_duration_ms: 900 },
                enable_search: this.searchEnabled,
                ...(this.searchEnabled ? { search_options: { enable_source: true } } : {}),
                ...(this.model === "qwen3.8-omni-flash-realtime" ? {} : { voice: this.config.qwenVoice === "longanlingxin" ? "Ethan" : this.config.qwenVoice }),
                audio: {
                  input: { format: this.model === "qwen3.8-omni-flash-realtime"
                    ? { type: "pcm", sample_rate: 16000, sample_format: "s16le", channels: 1, packing: "interleaved", channel_layout: "mono" }
                    : { type: "pcm", sample_rate: 16000 } },
                  output: { ...(this.model === "qwen3.8-omni-flash-realtime" ? { voice: this.config.qwenVoice } : {}), format: { type: "pcm", sample_rate: 24000 } }
                }
              }
            }));
            return;
          }
          if (event.type === "session.updated") {
            ready = true;
            this.handleQwenEvent(event);
            finish();
            return;
          }
          if (event.type === "error" && !ready) {
            finish(new Error(JSON.stringify(event.error ?? "千问会话配置失败")));
            return;
          }
          this.handleQwenEvent(event);
        } catch (error) {
          if (!ready) finish(error instanceof Error ? error : new Error(String(error)));
          else void this.recover(error instanceof Error ? error.message : String(error));
        }
      });
      socket.on("close", () => {
        if (generation !== this.generation || !this.enabled) return;
        if (!ready) finish(new Error("千问连接在初始化时断开"));
        else void this.recover("千问连接已断开");
      });
      socket.on("error", (error) => {
        if (generation !== this.generation || !this.enabled) return;
        this.logger.warn("qwen websocket error", { error: error.message });
        if (!ready) finish(error);
      });
    });
  }

  private handleQwenEvent(event: QwenEvent): void {
    switch (event.type) {
      case "session.updated":
        this.sessionNumber++;
        this.reconnectAttempts = 0;
        if (this.pendingAnnouncements === 0) void this.startMic().catch((error) => this.recover(String(error)));
        else this.setState("announcement");
        break;
      case "input_audio_buffer.speech_started":
        this.userSpeaking = true;
        break;
      case "input_audio_buffer.speech_stopped":
        this.userSpeaking = false;
        break;
      case "input_audio_buffer.committed":
        this.userSpeaking = false;
        this.setState("thinking");
        void this.stopMic();
        break;
      case "response.created":
        this.lastReply = "";
        this.lastSearchCount = 0;
        for (const listener of this.listeners) listener();
        break;
      case "response.audio_transcript.delta":
        if (typeof event.delta === "string") {
          this.lastReply = (this.lastReply + event.delta).slice(-2000);
          for (const listener of this.listeners) listener();
        }
        break;
      case "response.audio_transcript.done":
        if (typeof event.transcript === "string") {
          this.lastReply = event.transcript.slice(-2000);
          for (const listener of this.listeners) listener();
        }
        break;
      case "response.audio.delta":
        if (typeof event.delta === "string") this.appendSpeakerAudio(event.delta);
        break;
      case "response.audio.done":
        this.audioDone = true;
        break;
      case "response.done":
        this.responseDone = true;
        if (event.response && typeof event.response === "object") {
          const response = event.response as { usage?: { plugins?: { search?: { count?: unknown } } } };
          const count = response.usage?.plugins?.search?.count;
          this.lastSearchCount = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
          for (const listener of this.listeners) listener();
        }
        if (!this.speakerRequestId && !this.speakerStarting && this.speakerBuffer.byteLength === 0) void this.finishTurn();
        break;
      case "error": {
        const detail = event.error && typeof event.error === "object" ? JSON.stringify(event.error) : "千问返回错误";
        if (/401|Unauthorized|invalid.api.key|Authentication/i.test(detail)) void this.stop("百炼 API Key 无效或无权使用该模型");
        else void this.recover(detail.slice(0, 300));
        break;
      }
    }
  }

  private appendSpeakerAudio(encoded: string): void {
    const data = Buffer.from(encoded, "base64");
    if (data.byteLength === 0 || data.byteLength % 2 !== 0 || this.speakerBuffer.byteLength + data.byteLength > MAX_OUTPUT_BUFFER_BYTES) {
      void this.recover("千问下行音频无效或积压过多");
      return;
    }
    this.speakerBuffer = Buffer.concat([this.speakerBuffer, data]);
    if (!this.qwenReadPaused && this.speakerBuffer.byteLength >= PAUSE_QWEN_AT_BYTES && this.qwen?.readyState === WebSocket.OPEN) {
      this.qwen.pause();
      this.qwenReadPaused = true;
    }
    if (!this.speakerRequestId && !this.speakerStarting) void this.startSpeaker();
  }

  private resumeQwenRead(): void {
    if (!this.qwenReadPaused) return;
    this.qwenReadPaused = false;
    if (this.qwen?.readyState === WebSocket.OPEN) this.qwen.resume();
  }

  private async startSpeaker(): Promise<void> {
    this.speakerStarting = true;
    const generation = this.generation;
    try {
      await this.stopMic();
      if (generation !== this.generation || !this.enabled) return;
      const requestId = crypto.randomUUID();
      const result = await this.controller.pcmPlaybackStart(requestId);
      if (!result.sent || result.ack?.status !== "accepted") throw new Error(result.reason ?? result.ack?.message ?? "机器人扬声器不可用");
      this.speakerRequestId = requestId;
      this.speakerSeq = 0;
      this.setState("speaking");
      this.speakerTimer = setInterval(() => this.drainSpeaker(), 40);
    } catch (error) {
      void this.recover(error instanceof Error ? error.message : String(error));
    } finally {
      this.speakerStarting = false;
    }
  }

  private drainSpeaker(): void {
    if (!this.speakerRequestId || !this.device || this.speakerEnding) return;
    const frameBytes = this.speakerBuffer.byteLength >= OUTPUT_FRAME_BYTES ? OUTPUT_FRAME_BYTES :
      this.audioDone ? this.speakerBuffer.byteLength : 0;
    if (frameBytes > 0) {
      if (this.device.ws.readyState !== WebSocket.OPEN || this.device.ws.bufferedAmount > MAX_WS_BUFFER_BYTES) {
        void this.recover("机器人下行音频拥塞");
        return;
      }
      const chunk = this.speakerBuffer.subarray(0, frameBytes);
      this.speakerBuffer = this.speakerBuffer.subarray(frameBytes);
      if (this.speakerBuffer.byteLength <= RESUME_QWEN_AT_BYTES) this.resumeQwenRead();
      this.device.ws.send(encodeStackChanBinaryPcmFrame("speakerPcm", {
        streamId: this.speakerRequestId,
        seq: this.speakerSeq++,
        sampleRate: 24000,
        channels: 1,
        byteLength: chunk.byteLength
      }, chunk));
    }
    if (this.audioDone && this.speakerBuffer.byteLength === 0 && !this.speakerEnding) {
      this.speakerEnding = true;
      if (this.speakerTimer) clearInterval(this.speakerTimer);
      this.speakerTimer = undefined;
      void this.controller.pcmPlaybackEnd(this.speakerRequestId).then((result) => {
        if (!result.sent || result.ack?.status !== "accepted") void this.recover("机器人未确认语音播放完成");
      });
    }
  }

  private async finishTurn(): Promise<void> {
    if (!this.enabled || !this.responseDone) return;
    this.resetTurn();
    if (this.pendingAnnouncements > 0) this.setState("announcement");
    else await this.startMic().catch((error) => this.recover(String(error)));
  }

  private resetTurn(): void {
    this.resumeQwenRead();
    if (this.speakerTimer) clearInterval(this.speakerTimer);
    this.speakerTimer = undefined;
    this.speakerRequestId = undefined;
    this.speakerBuffer = Buffer.alloc(0);
    this.audioDone = false;
    this.responseDone = false;
    this.speakerStarting = false;
    this.speakerEnding = false;
    this.userSpeaking = false;
  }

  private async startMic(): Promise<void> {
    if (this.micStopPromise) await this.micStopPromise;
    if (!this.enabled || !this.device || this.micRunning) return;
    this.streamId = crypto.randomUUID();
    this.expectedMicSeq = 0;
    this.lastMicAt = Date.now();
    this.micRunning = true;
    this.setState("listening");
    const result = await this.controller.setMicStream(true, this.streamId);
    if (!result.sent || result.ack?.status !== "accepted") {
      this.micRunning = false;
      throw new Error(result.reason ?? result.ack?.message ?? "机器人麦克风不可用");
    }
  }

  private async stopMic(): Promise<void> {
    if (this.micStopPromise) return this.micStopPromise;
    if (!this.device || !this.micRunning) return;
    this.micRunning = false;
    this.micStopPromise = this.controller.setMicStream(false, this.streamId).then(() => undefined);
    try { await this.micStopPromise; }
    finally { this.micStopPromise = undefined; }
  }

  private async recover(reason: string): Promise<void> {
    if (!this.enabled || this.state === "reconnecting") return;
    this.logger.warn("voice chat reconnecting", { reason });
    this.setState("reconnecting", reason);
    this.generation++;
    this.resumeQwenRead();
    this.qwen?.close();
    this.qwen = undefined;
    await this.stopMic().catch(() => undefined);
    if (this.speakerRequestId) await this.controller.pcmPlaybackAbort(this.speakerRequestId).catch(() => undefined);
    this.resetTurn();
    const generation = this.generation;
    const delay = Math.min(16_000, 1000 * 2 ** Math.min(this.reconnectAttempts++, 4));
    this.reconnectTimer = setTimeout(() => {
      if (this.enabled && generation === this.generation) void this.connectQwen(generation).catch((error) => {
        this.setState("listening");
        void this.recover(error instanceof Error ? error.message : String(error));
      });
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.speakerTimer) clearInterval(this.speakerTimer);
    this.reconnectTimer = undefined;
    this.healthTimer = undefined;
    this.speakerTimer = undefined;
  }
}
