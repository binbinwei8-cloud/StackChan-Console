import type { DesktopConfig, Logger } from "../config.js";
import type { DeviceRegistry } from "../device/registry.js";
import type { RobotController } from "../robot/controller.js";
import type { TtsClient } from "./volcengine.js";
import type { VisionTrackingService } from "../vision/tracking.js";

export interface CodexCompletionAnnouncement {
  id: string;
  reason: string;
  taskSummary?: string;
}

export interface CodexReplyAnnouncement {
  id: string;
  text: string;
}

interface PendingPlayback {
  text: string;
  timer: NodeJS.Timeout;
  resumeCamera?: () => void;
}

interface ReplyPlaybackWaiter {
  timer: NodeJS.Timeout;
  resolve: (finished: boolean) => void;
}

export interface CompletionTtsRouteSnapshot {
  provider: "volcengine" | "disabled" | "unconfigured";
  configuredVoice: string;
  activeVoice: string;
  cloudEnabled: boolean;
  cloudConfigured: boolean;
  reason?: string;
}

export class CodexCompletionAnnouncer {
  private enabled = true;
  private lightEnabled = true;
  private lightFlashRun = 0;
  private inFlight = false;
  private lastStartedAt = 0;
  private readonly announcedIds: string[] = [];
  private readonly announcedIdSet = new Set<string>();
  private readonly pendingPlayback = new Map<string, PendingPlayback>();
  private readonly replyPlaybackWaiters = new Map<string, ReplyPlaybackWaiter>();
  private readonly replyQueue: CodexReplyAnnouncement[] = [];
  private replyWorkerRunning = false;

  constructor(
    private readonly controller: RobotController,
    private readonly tts: TtsClient,
    private readonly logger: Logger,
    private readonly config: DesktopConfig,
    eventSource?: Pick<DeviceRegistry, "onEvent">,
    private readonly visionTracking?: Pick<VisionTrackingService, "pauseCamera">,
    private readonly voiceChat?: { pauseForAnnouncement(): Promise<() => Promise<void>> }
  ) {
    eventSource?.onEvent((message) => {
      if (message.event.kind !== "playback") {
        return;
      }
      void this.handlePlaybackEvent(message.event.requestId, message.event.state, message.event.message);
    });
  }

  announce(completion: CodexCompletionAnnouncement): void {
    if (this.hasAnnounced(completion.id)) {
      this.logger.debug("codex completion notification skipped by event id", {
        type: "system",
        reason: completion.reason,
        completionId: completion.id
      });
      return;
    }
    this.rememberCompletion(completion.id);

    if (this.lightEnabled) {
      void this.flashCompletionLights(completion);
    }

    if (!this.enabled) {
      this.logger.info("codex completion tts skipped because announcements are disabled", {
        type: "system",
        reason: completion.reason,
        completionId: completion.id,
        lightEnabled: this.lightEnabled
      });
      return;
    }

    if (!this.config.volcengineTtsEnabled) {
      this.logger.info("codex completion tts skipped because cloud tts is disabled", {
        type: "system",
        reason: completion.reason,
        completionId: completion.id,
        configuredVoice: this.config.volcengineTtsVoiceId
      });
      return;
    }
    if (!this.config.volcengineTtsApiKey) {
      this.logger.warn("codex completion tts skipped because api key is missing", {
        type: "system",
        reason: completion.reason,
        completionId: completion.id,
        configuredVoice: this.config.volcengineTtsVoiceId
      });
      return;
    }

    const now = Date.now();
    if (this.inFlight || now - this.lastStartedAt < this.config.volcengineTtsDebounceMs) {
      this.logger.debug("codex completion tts skipped by debounce", { type: "system", reason: completion.reason });
      return;
    }

    this.inFlight = true;
    this.lastStartedAt = now;
    void this.run(completion);
  }

  announceReply(reply: CodexReplyAnnouncement): void {
    if (this.hasAnnounced(reply.id)) {
      return;
    }
    this.rememberCompletion(reply.id);
    if (this.lightEnabled) {
      void this.flashCompletionLights({ id: reply.id, reason: "codex reply" });
    }
    if (!this.enabled || !this.config.volcengineTtsEnabled || !this.config.volcengineTtsApiKey) {
      this.logger.info("codex reply tts skipped because announcements are unavailable", { type: "system" });
      return;
    }
    const text = normalizeReplyText(reply.text);
    if (!text) {
      return;
    }
    this.replyQueue.push({ id: reply.id, text });
    void this.processReplyQueue();
  }

  getVolume(): number {
    return this.config.volcengineTtsCompletionVolume;
  }

  getRouteSnapshot(): CompletionTtsRouteSnapshot {
    const cloudConfigured = Boolean(this.config.volcengineTtsApiKey);
    if (!this.enabled) {
      return {
        provider: "disabled",
        configuredVoice: this.config.volcengineTtsVoiceId,
        activeVoice: "-",
        cloudEnabled: this.config.volcengineTtsEnabled,
        cloudConfigured,
        reason: "codex completion tts disabled"
      };
    }
    if (this.config.volcengineTtsEnabled && cloudConfigured) {
      return {
        provider: "volcengine",
        configuredVoice: this.config.volcengineTtsVoiceId,
        activeVoice: this.config.volcengineTtsVoiceId,
        cloudEnabled: true,
        cloudConfigured: true
      };
    }
    return {
      provider: "unconfigured",
      configuredVoice: this.config.volcengineTtsVoiceId,
      activeVoice: "-",
      cloudEnabled: this.config.volcengineTtsEnabled,
      cloudConfigured,
      reason: this.config.volcengineTtsEnabled ? "cloud tts api key missing" : "cloud tts disabled"
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isLightEnabled(): boolean {
    return this.lightEnabled;
  }

  setEnabled(enabled: boolean): boolean {
    this.enabled = enabled;
    this.logger.info("codex completion tts announcements updated", {
      type: "system",
      enabled
    });
    return this.enabled;
  }

  setLightEnabled(enabled: boolean): boolean {
    this.lightEnabled = enabled;
    if (!enabled) {
      this.lightFlashRun += 1;
    }
    this.logger.info("codex completion light notification updated", {
      type: "system",
      enabled
    });
    return this.lightEnabled;
  }

  setVolume(volume: number): number {
    const nextVolume = clampVolume(volume);
    this.config.volcengineTtsCompletionVolume = nextVolume;
    this.logger.info("codex completion tts volume updated", {
      type: "system",
      volume: nextVolume
    });
    return nextVolume;
  }

  private async flashCompletionLights(completion: CodexCompletionAnnouncement): Promise<void> {
    const runId = ++this.lightFlashRun;
    const steps: Array<{ color: string; holdMs: number }> = [
      { color: "#43D5B0", holdMs: 130 },
      { color: "#000000", holdMs: 90 },
      { color: "#6CB6FF", holdMs: 130 },
      { color: "#000000", holdMs: 90 },
      { color: "#E3B341", holdMs: 150 },
      { color: "#000000", holdMs: 0 }
    ];

    for (const [index, step] of steps.entries()) {
      if (!this.lightEnabled || runId !== this.lightFlashRun) {
        return;
      }
      try {
        const result = await this.controller.react(
          {
            emotion: "neutral",
            durationMs: 160,
            rgbJson: {
              leftRgbDuration: 0.04,
              leftRgbColor: step.color,
              rightRgbDuration: 0.04,
              rightRgbColor: step.color
            }
          },
          { waitForAck: false, bypassMotionGate: true }
        );
        if (index === 0) {
          this.logger.info("codex completion light dispatched", {
            type: "command",
            sent: result.sent,
            deviceId: result.deviceId,
            dispatchReason: result.reason,
            reason: completion.reason,
            completionId: completion.id
          });
        }
      } catch (error) {
        this.logger.warn("codex completion light failed", {
          type: "system",
          reason: completion.reason,
          completionId: completion.id,
          error: error instanceof Error ? error.message : String(error)
        });
        return;
      }
      if (step.holdMs > 0) {
        await delay(step.holdMs);
      }
    }
  }

  private async run(completion: CodexCompletionAnnouncement): Promise<void> {
    const text = buildCompletionText(this.config.volcengineTtsCompletionText, completion.taskSummary);
    let resumeCamera: (() => void) | undefined;
    let resumeVoiceChat: (() => Promise<void>) | undefined;
    let playback: ReturnType<CodexCompletionAnnouncer["trackReplyPlayback"]> | undefined;
    try {
      resumeVoiceChat = await this.voiceChat?.pauseForAnnouncement();
      resumeCamera = await this.visionTracking?.pauseCamera();
      const speech = await this.tts.synthesize(text);
      playback = this.trackReplyPlayback(speech.requestId, text);
      const result = await this.controller.playAudio({
        requestId: speech.requestId,
        format: speech.format,
        mimeType: speech.mimeType,
        sampleRate: speech.sampleRate,
        dataBase64: speech.dataBase64,
        interrupt: true,
        volume: this.config.volcengineTtsCompletionVolume
      });
      this.logger.info("codex completion tts dispatched", {
        type: "command",
        sent: result.sent,
        deviceId: result.deviceId,
        dispatchReason: result.reason,
        reason: completion.reason,
        taskSummaryLength: completion.taskSummary?.length,
        volume: this.config.volcengineTtsCompletionVolume,
        requestId: speech.requestId,
        provider: "volcengine",
        voice: this.config.volcengineTtsVoiceId
      });
      if (result.sent && (!result.ack || result.ack.status === "accepted")) {
        if (!(await playback.done)) {
          throw new Error("codex completion playback did not finish");
        }
      } else {
        playback.cancel();
        this.logger.warn("codex completion tts audio command was not accepted", {
          type: "command",
          sent: result.sent,
          deviceId: result.deviceId,
          dispatchReason: result.reason,
          ack: result.ack,
          reason: completion.reason,
          requestId: speech.requestId,
          provider: "volcengine"
        });
      }
    } catch (error) {
      playback?.cancel();
      this.logger.warn("codex completion tts failed", {
        type: "system",
        reason: completion.reason,
        taskSummaryLength: completion.taskSummary?.length,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      resumeCamera?.();
      await resumeVoiceChat?.();
      this.inFlight = false;
    }
  }

  private async processReplyQueue(): Promise<void> {
    if (this.replyWorkerRunning) {
      return;
    }
    this.replyWorkerRunning = true;
    try {
      while (this.replyQueue.length > 0) {
        const reply = this.replyQueue.shift();
        if (reply && this.enabled) {
          await this.speakReply(reply);
        }
      }
    } finally {
      this.replyWorkerRunning = false;
    }
  }

  private async speakReply(reply: CodexReplyAnnouncement): Promise<void> {
    let resumeCamera: (() => void) | undefined;
    let resumeVoiceChat: (() => Promise<void>) | undefined;
    try {
      while (this.inFlight || this.pendingPlayback.size > 0) {
        await delay(100);
      }
      resumeVoiceChat = await this.voiceChat?.pauseForAnnouncement();
      resumeCamera = await this.visionTracking?.pauseCamera();
      const segments = splitReplyText(reply.text);
      for (const [index, segment] of segments.entries()) {
        if (!this.enabled) {
          break;
        }
        const speech = await this.tts.synthesize(segment);
        const playback = this.trackReplyPlayback(speech.requestId, segment);
        let result;
        try {
          result = await this.controller.playAudio({
            requestId: speech.requestId,
            format: speech.format,
            mimeType: speech.mimeType,
            sampleRate: speech.sampleRate,
            dataBase64: speech.dataBase64,
            interrupt: true,
            volume: this.config.volcengineTtsCompletionVolume
          });
        } catch (error) {
          playback.cancel();
          throw error;
        }
        if (!result.sent || (result.ack && result.ack.status !== "accepted")) {
          playback.cancel();
          throw new Error(result.reason ?? result.ack?.message ?? "audio command was not accepted");
        }
        this.logger.info("codex reply tts dispatched", {
          type: "command",
          deviceId: result.deviceId,
          segment: index + 1,
          segmentCount: segments.length,
          requestId: speech.requestId
        });
        if (!(await playback.done)) {
          throw new Error(`audio playback did not finish for segment ${index + 1}`);
        }
      }
    } catch (error) {
      this.logger.warn("codex reply tts failed", {
        type: "system",
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      resumeCamera?.();
      await resumeVoiceChat?.();
    }
  }

  private trackReplyPlayback(requestId: string, text: string): { done: Promise<boolean>; cancel: () => void } {
    let resolveDone!: (finished: boolean) => void;
    const done = new Promise<boolean>((resolve) => {
      resolveDone = resolve;
    });
    const timeoutMs = Math.max(15_000, Math.min(90_000, text.length * 500 + 10_000));
    const timer = setTimeout(() => {
      this.replyPlaybackWaiters.delete(requestId);
      resolveDone(false);
    }, timeoutMs);
    timer.unref?.();
    this.replyPlaybackWaiters.set(requestId, { timer, resolve: resolveDone });
    return {
      done,
      cancel: () => {
        const waiter = this.replyPlaybackWaiters.get(requestId);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.replyPlaybackWaiters.delete(requestId);
          waiter.resolve(false);
        }
      }
    };
  }

  private waitForPlayback(requestId: string, text: string, resumeCamera?: () => void): void {
    const timeoutMs = estimateSpeechDurationMs(text) + 5000;
    const timer = setTimeout(() => {
      const pending = this.pendingPlayback.get(requestId);
      if (!pending) {
        return;
      }
      this.pendingPlayback.delete(requestId);
      pending.resumeCamera?.();
      this.logger.warn("playback finished event timed out", {
        type: "device",
        requestId,
        timeoutMs
      });
      void this.controller.setMode("idle", "codex completion tts timeout");
    }, timeoutMs);
    timer.unref?.();
    this.pendingPlayback.set(requestId, { text, timer, resumeCamera });
  }

  private async handlePlaybackEvent(requestId: string, state: "started" | "finished" | "failed", message?: string): Promise<void> {
    const replyWaiter = this.replyPlaybackWaiters.get(requestId);
    if (replyWaiter && state !== "started") {
      clearTimeout(replyWaiter.timer);
      this.replyPlaybackWaiters.delete(requestId);
      replyWaiter.resolve(state === "finished");
      return;
    }
    const pending = this.pendingPlayback.get(requestId);
    if (!pending) {
      return;
    }

    if (state === "started") {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingPlayback.delete(requestId);
    pending.resumeCamera?.();
    if (state === "finished") {
      await this.controller.setMode("idle", "codex completion tts done");
      return;
    }

    this.logger.warn("device playback failed", {
      type: "device",
      requestId,
      message
    });
    await this.controller.setMode("idle", "codex completion playback failed");
  }

  private hasAnnounced(id: string): boolean {
    return this.announcedIdSet.has(id);
  }

  private rememberCompletion(id: string): void {
    this.announcedIds.push(id);
    this.announcedIdSet.add(id);
    while (this.announcedIds.length > 200) {
      const removed = this.announcedIds.shift();
      if (removed) {
        this.announcedIdSet.delete(removed);
      }
    }
  }
}

function estimateSpeechDurationMs(text: string): number {
  return Math.max(1800, Math.min(12000, text.length * 260 + 700));
}

function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) {
    return 80;
  }
  return Math.min(100, Math.max(0, Math.round(volume)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeReplyText(text: string): string {
  return text
    .replace(/```[^\n]*\n?/g, "\n")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "链接")
    .replace(/[`*_>#|]/g, " ")
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function splitReplyText(text: string): string[] {
  const chars = Array.from(text);
  const segments: string[] = [];
  const maxChars = 60;
  while (chars.length > 0) {
    let end = Math.min(maxChars, chars.length);
    if (end < chars.length) {
      for (let index = end - 1; index >= Math.floor(maxChars / 2); index -= 1) {
        if (/[。！？!?；;，,、.\n\s]/u.test(chars[index] ?? "")) {
          end = index + 1;
          break;
        }
      }
    }
    const segment = chars.splice(0, end).join("").trim();
    if (segment) {
      segments.push(segment);
    }
  }
  return segments;
}

function buildCompletionText(baseText: string, taskSummary: string | undefined): string {
  const summary = normalizeSpeechSummary(taskSummary);
  if (!summary) {
    return baseText;
  }

  const prefix = baseText.replace(/[。.!！\s]+$/u, "");
  return `${prefix}：${summary}。`;
}

function normalizeSpeechSummary(taskSummary: string | undefined): string {
  if (!taskSummary) {
    return "";
  }

  const normalized = taskSummary
    .replace(/[`*_>#\[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= 56) {
    return normalized;
  }
  return `${normalized.slice(0, 56)}...`;
}
