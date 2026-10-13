import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

import type { DesktopConfig, Logger } from "../src/config.js";
import type { DeviceRegistry, DeviceSession } from "../src/device/registry.js";
import type { RobotController } from "../src/robot/controller.js";
import { QwenVoiceChatService } from "../src/voice/chat.js";
import { encodeStackChanBinaryPcmFrame, parseStackChanBinaryFrame } from "../src/ws/binary-frame.js";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

describe("binary PCM frames", () => {
  it("round trips speaker PCM and rejects malformed payloads", () => {
    const header = { streamId: "reply-1", seq: 3, sampleRate: 24000 as const, channels: 1 as const, byteLength: 1920 };
    const frame = encodeStackChanBinaryPcmFrame("speakerPcm", header, Buffer.alloc(1920));
    const parsed = parseStackChanBinaryFrame(frame);
    expect(parsed?.kind).toBe("speakerPcm");
    if (parsed?.kind === "speakerPcm") expect(parsed.header).toEqual(header);
    expect(() => parseStackChanBinaryFrame(frame.subarray(0, -2))).toThrow(/payload/);
    expect(() => encodeStackChanBinaryPcmFrame("speakerPcm", { ...header, byteLength: 2 }, Buffer.alloc(1920))).toThrow(/payload/);
  });
});

describe("QwenVoiceChatService", () => {
  let server: WebSocketServer | undefined;
  let service: QwenVoiceChatService | undefined;
  let settingsDir: string | undefined;

  afterEach(async () => {
    await service?.stop();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    if (settingsDir) {
      if (existsSync(path.join(settingsDir, "settings.json"))) unlinkSync(path.join(settingsDir, "settings.json"));
      rmdirSync(settingsDir);
      settingsDir = undefined;
    }
  });

  it("streams the robot microphone to Qwen and plays Qwen PCM before listening again", async () => {
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    const port = (server.address() as { port: number }).port;
    let peer: WebSocket | undefined;
    const qwenMessages: Record<string, unknown>[] = [];
    server.on("connection", (socket) => {
      peer = socket;
      socket.send(JSON.stringify({ type: "session.created" }));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        qwenMessages.push(message);
        if (message.type === "session.update") socket.send(JSON.stringify({ type: "session.updated" }));
      });
    });

    let registryListener: ((message: unknown) => void) | undefined;
    const sentFrames: Buffer[] = [];
    const device = {
      deviceId: "stackchan-001", sessionId: "session-1", capabilities: ["voiceChatPcm"],
      ws: { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (data: Buffer) => sentFrames.push(data) }
    } as unknown as DeviceSession;
    const registry = {
      getActiveSession: () => device,
      onEvent: (listener: (message: unknown) => void) => { registryListener = listener; return () => undefined; }
    } as unknown as DeviceRegistry;
    const setMicStream = vi.fn().mockResolvedValue({ sent: true, ack: { status: "accepted" } });
    const pcmPlaybackStart = vi.fn().mockResolvedValue({ sent: true, ack: { status: "accepted" } });
    const pcmPlaybackEnd = vi.fn().mockImplementation(async (requestId: string) => {
      setTimeout(() => registryListener?.({ deviceId: device.deviceId, event: { kind: "playback", requestId, state: "finished" } }), 10);
      return { sent: true, ack: { status: "accepted" } };
    });
    const controller = { setMicStream, pcmPlaybackStart, pcmPlaybackEnd, pcmPlaybackAbort: vi.fn() } as unknown as RobotController;
    const resumeCamera = vi.fn();
    service = new QwenVoiceChatService(
      { qwenApiKey: "test-key", qwenWorkspaceId: "test-workspace", qwenRegion: "cn-beijing", qwenModel: "qwen3.8-omni-flash-realtime", qwenVoice: "longanlingxin" } as DesktopConfig,
      registry, controller, { pauseCamera: vi.fn().mockResolvedValue(resumeCamera) }, logger,
      () => new WebSocket(`ws://127.0.0.1:${port}`)
    );

    await service.start();
    await vi.waitFor(() => expect(service?.snapshot().state, JSON.stringify(service?.snapshot())).toBe("listening"));
    const micStreamId = setMicStream.mock.calls[0]![1] as string;
    service.onMicrophoneFrame(device, { deviceId: device.deviceId, streamId: micStreamId, seq: 0, sampleRate: 16000, channels: 1, byteLength: 1280 }, Buffer.alloc(1280));
    await vi.waitFor(() => expect(qwenMessages.some((message) => message.type === "input_audio_buffer.append")).toBe(true));
    expect((qwenMessages[0]?.session as { turn_detection: { type: string } }).turn_detection.type).toBe("semantic_vad");

    peer!.send(JSON.stringify({ type: "input_audio_buffer.committed" }));
    peer!.send(JSON.stringify({ type: "response.audio_transcript.delta", delta: "你好！" }));
    peer!.send(JSON.stringify({ type: "response.audio.delta", delta: Buffer.alloc(3840).toString("base64") }));
    peer!.send(JSON.stringify({ type: "response.audio.done" }));
    peer!.send(JSON.stringify({ type: "response.done" }));
    await vi.waitFor(() => expect(pcmPlaybackEnd).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(service?.snapshot().state, JSON.stringify(service?.snapshot())).toBe("listening"));
    expect(service.snapshot().lastReply).toBe("你好！");
    expect(setMicStream.mock.calls.map(([enabled]) => enabled)).toEqual([true, false, true]);
    expect(sentFrames).toHaveLength(2);
    expect(sentFrames.every((frame) => parseStackChanBinaryFrame(frame)?.kind === "speakerPcm")).toBe(true);
    expect(resumeCamera).not.toHaveBeenCalled();

    const resumeAnnouncement = await service.pauseForAnnouncement();
    expect(service.snapshot().state).toBe("announcement");
    expect(setMicStream.mock.calls.map(([enabled]) => enabled)).toEqual([true, false, true, false]);
    service.onMicrophoneFrame(device, { deviceId: device.deviceId, streamId: micStreamId, seq: 1, sampleRate: 16000, channels: 1, byteLength: 1280 }, Buffer.alloc(1280));
    expect(qwenMessages.filter((message) => message.type === "input_audio_buffer.append")).toHaveLength(1);
    await resumeAnnouncement();
    await vi.waitFor(() => expect(service?.snapshot().state).toBe("listening"));

    peer!.close();
    await vi.waitFor(() => expect(service?.snapshot().state).toBe("reconnecting"));
    await vi.waitFor(() => expect(service?.snapshot().sessionNumber).toBe(2), { timeout: 4000 });
    await vi.waitFor(() => expect(service?.snapshot().state).toBe("listening"));
    peer!.send(JSON.stringify({ type: "response.audio.delta", delta: Buffer.alloc(2_880_002).toString("base64") }));
    await vi.waitFor(() => expect(service?.snapshot().state).toBe("reconnecting"));
    expect(pcmPlaybackStart).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(service?.snapshot().sessionNumber).toBe(3), { timeout: 4000 });
    expect(resumeCamera).not.toHaveBeenCalled();
  });

  it("saves model/search choices and reconnects with a model-specific session", async () => {
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const urls: string[] = [];
    const sessions: Record<string, unknown>[] = [];
    let peer: WebSocket | undefined;
    server.on("connection", (socket) => {
      peer = socket;
      socket.send(JSON.stringify({ type: "session.created" }));
      socket.on("message", (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string; session?: Record<string, unknown> };
        if (event.type === "session.update" && event.session) {
          sessions.push(event.session);
          socket.send(JSON.stringify({ type: "session.updated" }));
        }
      });
    });
    settingsDir = mkdtempSync(path.join(tmpdir(), "stackchan-qwen-settings-"));
    const settingsFile = path.join(settingsDir, "settings.json");
    const config = {
      qwenApiKey: "test-key", qwenWorkspaceId: "test-workspace", qwenRegion: "cn-beijing",
      qwenModel: "qwen3.8-omni-flash-realtime", qwenVoice: "longanlingxin", qwenSettingsFile: settingsFile
    } as DesktopConfig;
    const device = {
      deviceId: "stackchan-001", sessionId: "session-1", capabilities: ["voiceChatPcm"],
      ws: { readyState: WebSocket.OPEN, bufferedAmount: 0, send() {} }
    } as unknown as DeviceSession;
    const registry = {
      getActiveSession: () => device,
      onEvent: () => () => undefined
    } as unknown as DeviceRegistry;
    const setMicStream = vi.fn().mockResolvedValue({ sent: true, ack: { status: "accepted" } });
    const pcmPlaybackAbort = vi.fn().mockResolvedValue({ sent: true, ack: { status: "accepted" } });
    const controller = {
      setMicStream,
      pcmPlaybackStart: vi.fn().mockResolvedValue({ sent: true, ack: { status: "accepted" } }),
      pcmPlaybackEnd: vi.fn().mockResolvedValue({ sent: true, ack: { status: "accepted" } }),
      pcmPlaybackAbort
    } as unknown as RobotController;
    const resumeCamera = vi.fn();
    service = new QwenVoiceChatService(config, registry, controller,
      { pauseCamera: vi.fn().mockResolvedValue(resumeCamera) }, logger,
      (url) => { urls.push(url); return new WebSocket(`ws://127.0.0.1:${port}`); });

    await expect(service.updateSettings({ model: "qwen-plus" })).rejects.toThrow(/不支持/);
    await service.start();
    await vi.waitFor(() => expect(service?.snapshot().state, JSON.stringify(service?.snapshot())).toBe("listening"));
    expect(sessions[0]?.enable_search).toBe(false);
    expect(urls[0]).toContain("model=qwen3.8-omni-flash-realtime");

    await service.updateSettings({ model: "qwen3.5-omni-plus-realtime", searchEnabled: true });
    await vi.waitFor(() => expect(service?.snapshot().state).toBe("listening"));
    expect(service.snapshot().sessionNumber).toBe(2);
    expect(urls[1]).toContain("model=qwen3.5-omni-plus-realtime");
    expect(sessions[1]?.enable_search).toBe(true);
    expect(sessions[1]?.search_options).toEqual({ enable_source: true });
    expect(sessions[1]?.voice).toBe("Ethan");
    expect((sessions[1]?.audio as { output: Record<string, unknown> }).output.voice).toBeUndefined();
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual({ model: "qwen3.5-omni-plus-realtime", searchEnabled: true });
    const reloaded = new QwenVoiceChatService(config, registry, controller,
      { pauseCamera: vi.fn().mockResolvedValue(resumeCamera) }, logger);
    expect(reloaded.snapshot().model).toBe("qwen3.5-omni-plus-realtime");
    expect(reloaded.snapshot().searchEnabled).toBe(true);

    // A long answer may arrive much faster than the robot can play it.
    peer!.send(JSON.stringify({ type: "response.audio.delta", delta: Buffer.alloc(600_000).toString("base64") }));
    await vi.waitFor(() => expect(service?.snapshot().state).toBe("speaking"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(service.snapshot().state).toBe("speaking");
    expect(pcmPlaybackAbort).not.toHaveBeenCalled();
  });
});
