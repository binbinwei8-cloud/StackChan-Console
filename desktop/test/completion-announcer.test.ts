import { describe, expect, it, vi } from "vitest";

import type { DesktopConfig, Logger } from "../src/config.js";
import type { DeviceRegistry } from "../src/device/registry.js";
import type { RobotController } from "../src/robot/controller.js";
import { CodexCompletionAnnouncer } from "../src/tts/completion-announcer.js";
import type { TtsClient } from "../src/tts/volcengine.js";
import type { VisionTrackingService } from "../src/vision/tracking.js";

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

const config = {
  volcengineTtsEnabled: true,
  volcengineTtsApiKey: "token",
  volcengineTtsCompletionText: "Codex done.",
  volcengineTtsCompletionVolume: 80,
  volcengineTtsDebounceMs: 0
} as DesktopConfig;

describe("CodexCompletionAnnouncer", () => {
  it("reads every queued reply in order and splits long replies for the speaker", async () => {
    let playbackListener: ((message: unknown) => void) | undefined;
    let speechNumber = 0;
    const synthesize = vi.fn<TtsClient["synthesize"]>().mockImplementation(async (text) => ({
      requestId: `reply-${++speechNumber}`,
      format: "ogg_opus",
      mimeType: "audio/ogg",
      sampleRate: 16000,
      dataBase64: Buffer.from("ogg").toString("base64"),
      text
    }));
    const playAudio = vi.fn().mockImplementation(async (options: { requestId: string }) => {
      setTimeout(() => playbackListener?.({
        event: { kind: "playback", requestId: options.requestId, state: "finished" }
      }), 0);
      return { sent: true, deviceId: "stackchan-001", ack: { status: "accepted" } };
    });
    const resumeCamera = vi.fn();
    const announcer = new CodexCompletionAnnouncer(
      { playAudio, setMode: vi.fn(), react: vi.fn() } as unknown as RobotController,
      { synthesize }, logger, config,
      { onEvent: (listener: (message: unknown) => void) => { playbackListener = listener; } } as unknown as Pick<DeviceRegistry, "onEvent">,
      { pauseCamera: vi.fn().mockResolvedValue(resumeCamera) } as unknown as Pick<VisionTrackingService, "pauseCamera">
    );
    announcer.setLightEnabled(false);
    announcer.announceReply({ id: "reply-1", text: "甲".repeat(145) });
    announcer.announceReply({ id: "reply-2", text: "乙。" });

    await vi.waitFor(() => expect(playAudio).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(resumeCamera).toHaveBeenCalledTimes(2));
    expect(synthesize.mock.calls.map(([text]) => text).join("")).toBe(`${"甲".repeat(145)}乙。`);
  });

  it("waits for the camera to stop before synthesizing and resumes after a dispatch failure", async () => {
    let confirmStopped: ((resume: () => void) => void) | undefined;
    const resume = vi.fn();
    const pauseCamera = vi.fn(() => new Promise<() => void>((resolve) => {
      confirmStopped = resolve;
    }));
    const synthesize = vi.fn<TtsClient["synthesize"]>().mockResolvedValue({
      requestId: "speech-camera",
      format: "ogg_opus",
      mimeType: "audio/ogg",
      sampleRate: 16000,
      dataBase64: Buffer.from("ogg").toString("base64"),
      text: "Codex done."
    });
    const controller = {
      playAudio: vi.fn().mockRejectedValue(new Error("device disconnected")),
      setMode: vi.fn(),
      react: vi.fn(),
      say: vi.fn()
    } as unknown as RobotController;
    const announcer = new CodexCompletionAnnouncer(
      controller, { synthesize }, logger, config, undefined,
      { pauseCamera } as unknown as Pick<VisionTrackingService, "pauseCamera">
    );
    announcer.setLightEnabled(false);
    announcer.announce({ id: "camera-pause", reason: "test" });

    await vi.waitFor(() => expect(pauseCamera).toHaveBeenCalledOnce());
    expect(synthesize).not.toHaveBeenCalled();
    confirmStopped?.(resume);
    await vi.waitFor(() => expect(controller.playAudio).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
  });

  it("announces a stable completion id only once", async () => {
    const speechText = "Codex done：update completion speech。";
    const synthesize = vi.fn<TtsClient["synthesize"]>().mockResolvedValue({
      requestId: "speech-1",
      format: "ogg_opus",
      mimeType: "audio/ogg",
      sampleRate: 16000,
      dataBase64: Buffer.from("ogg").toString("base64"),
      text: speechText
    });
    const playAudio = vi.fn().mockReturnValue({ sent: true, deviceId: "stackchan-001" });
    const controller = {
      playAudio,
      setMode: vi.fn(),
      react: vi.fn().mockResolvedValue({ sent: true, deviceId: "stackchan-001" }),
      say: vi.fn()
    } as unknown as RobotController;

    const announcer = new CodexCompletionAnnouncer(controller, { synthesize }, logger, config);
    announcer.setLightEnabled(false);
    announcer.announce({
      id: "session.jsonl:10",
      reason: "codex task complete",
      taskSummary: "update completion speech"
    });
    announcer.announce({
      id: "session.jsonl:10",
      reason: "codex task complete",
      taskSummary: "update completion speech"
    });

    await vi.waitFor(() => expect(playAudio).toHaveBeenCalledTimes(1));
    expect(synthesize).toHaveBeenCalledWith(speechText);
    expect(playAudio).toHaveBeenCalledWith(expect.objectContaining({
      volume: 80
    }));
    expect(playAudio.mock.calls[0]?.[0]).not.toHaveProperty("text");
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("allows completion volume to be tuned at runtime", () => {
    const controller = {
      playAudio: vi.fn(),
      setMode: vi.fn(),
      react: vi.fn().mockResolvedValue({ sent: true, deviceId: "stackchan-001" }),
      say: vi.fn()
    } as unknown as RobotController;
    const announcer = new CodexCompletionAnnouncer(controller, { synthesize: vi.fn() }, logger, {
      ...config,
      volcengineTtsCompletionVolume: 80
    });

    expect(announcer.getVolume()).toBe(80);
    expect(announcer.setVolume(87.4)).toBe(87);
    expect(announcer.getVolume()).toBe(87);
    expect(announcer.setVolume(130)).toBe(100);
  });

  it("can disable Codex completion announcements at runtime", async () => {
    const synthesize = vi.fn<TtsClient["synthesize"]>();
    const playAudio = vi.fn();
    const say = vi.fn();
    const controller = {
      playAudio,
      setMode: vi.fn(),
      react: vi.fn().mockResolvedValue({ sent: true, deviceId: "stackchan-001" }),
      say
    } as unknown as RobotController;
    const announcer = new CodexCompletionAnnouncer(controller, { synthesize }, logger, config);

    announcer.setLightEnabled(false);
    expect(announcer.isEnabled()).toBe(true);
    expect(announcer.setEnabled(false)).toBe(false);
    announcer.announce({
      id: "session.jsonl:disabled",
      reason: "codex task complete",
      taskSummary: "should stay quiet"
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(synthesize).not.toHaveBeenCalled();
    expect(playAudio).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it("flashes device lights for a completed Codex task even when TTS is off", async () => {
    const react = vi.fn().mockResolvedValue({ sent: true, deviceId: "stackchan-001" });
    const controller = {
      playAudio: vi.fn(),
      setMode: vi.fn(),
      react,
      say: vi.fn()
    } as unknown as RobotController;
    const announcer = new CodexCompletionAnnouncer(controller, { synthesize: vi.fn() }, logger, config);

    announcer.setEnabled(false);
    announcer.announce({
      id: "session.jsonl:light",
      reason: "codex task complete",
      taskSummary: "light only"
    });

    await vi.waitFor(() => expect(react).toHaveBeenCalled());
    expect(react).toHaveBeenCalledWith(
      expect.objectContaining({
        emotion: "neutral",
        rgbJson: expect.objectContaining({
          leftRgbColor: "#43D5B0",
          rightRgbColor: "#43D5B0"
        })
      }),
      expect.objectContaining({ waitForAck: false })
    );
  });

  it("can disable completion light flashes at runtime", async () => {
    const react = vi.fn();
    const controller = {
      playAudio: vi.fn(),
      setMode: vi.fn(),
      react,
      say: vi.fn()
    } as unknown as RobotController;
    const announcer = new CodexCompletionAnnouncer(controller, { synthesize: vi.fn() }, logger, config);

    expect(announcer.isLightEnabled()).toBe(true);
    expect(announcer.setLightEnabled(false)).toBe(false);
    announcer.setEnabled(false);
    announcer.announce({
      id: "session.jsonl:no-light",
      reason: "codex task complete",
      taskSummary: "muted"
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(react).not.toHaveBeenCalled();
  });

  it("does not fall back to local say when cloud synthesis fails", async () => {
    const synthesize = vi.fn<TtsClient["synthesize"]>().mockRejectedValue(new Error("network down"));
    const playAudio = vi.fn();
    const say = vi.fn().mockReturnValue({ sent: true, deviceId: "stackchan-001" });
    const controller = {
      playAudio,
      setMode: vi.fn(),
      react: vi.fn().mockResolvedValue({ sent: true, deviceId: "stackchan-001" }),
      say
    } as unknown as RobotController;

    const announcer = new CodexCompletionAnnouncer(controller, { synthesize }, logger, config);
    announcer.setLightEnabled(false);
    announcer.announce({
      id: "session.jsonl:11",
      reason: "codex task complete",
      taskSummary: "build firmware"
    });

    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledWith("Codex done：build firmware。"));
    expect(playAudio).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it("skips audio when cloud tts is disabled", async () => {
    const synthesize = vi.fn<TtsClient["synthesize"]>();
    const playAudio = vi.fn().mockReturnValue({ sent: true, deviceId: "stackchan-001" });
    const say = vi.fn();
    const controller = {
      playAudio,
      setMode: vi.fn(),
      react: vi.fn().mockResolvedValue({ sent: true, deviceId: "stackchan-001" }),
      say
    } as unknown as RobotController;

    const announcer = new CodexCompletionAnnouncer(controller, { synthesize }, logger, {
      ...config,
      volcengineTtsEnabled: false
    });
    announcer.setLightEnabled(false);
    announcer.announce({
      id: "session.jsonl:cloud-disabled",
      reason: "codex task complete",
      taskSummary: "cloud disabled"
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(synthesize).not.toHaveBeenCalled();
    expect(playAudio).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
    expect(announcer.getRouteSnapshot()).toMatchObject({
      provider: "unconfigured",
      activeVoice: "-",
      reason: "cloud tts disabled"
    });
  });
});
