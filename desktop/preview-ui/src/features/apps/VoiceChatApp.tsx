import { setVoiceChat, setVoiceChatSettings } from "../../api/client";
import { Button } from "../../components/Button";
import { CommandPanel } from "../../components/CommandPanel";
import { CommandStatus } from "../../components/CommandStatus";
import { MetricGrid } from "../../components/MetricGrid";
import { useCommand } from "../../hooks/useCommand";
import type { PreviewSnapshot } from "../../../../src/preview/public-types";

const stateLabels: Record<string, string> = {
  off: "已关闭",
  connecting: "连接千问中",
  listening: "正在聆听",
  thinking: "千问思考中",
  speaking: "机器人播报中",
  announcement: "Codex 播报中",
  reconnecting: "重新连接中",
  error: "出错"
};

export function VoiceChatApp({ snapshot, setSnapshot }: {
  snapshot: PreviewSnapshot | null;
  setSnapshot?: (snapshot: PreviewSnapshot) => void;
}): JSX.Element {
  const chat = snapshot?.voiceChat;
  const command = useCommand();

  async function toggle() {
    const result = await setVoiceChat(!chat?.enabled);
    if (snapshot) setSnapshot?.({ ...snapshot, voiceChat: result });
    return result;
  }

  async function updateSettings(model: string, searchEnabled: boolean) {
    const result = await setVoiceChatSettings({ model, searchEnabled });
    if (result.ok && snapshot) setSnapshot?.({ ...snapshot, voiceChat: result });
    return result;
  }

  return (
    <div className="content-stack">
      <header className="module-header">
        <div>
          <div className="module-kicker">Application</div>
          <h2>千问语音聊天</h2>
          <p>开启后对着 StackChan 说话。机器人播报时暂停收音，结束后继续聆听。</p>
        </div>
      </header>
      <section className="panel-block">
        <h3>状态</h3>
        <MetricGrid metrics={[
          { label: "语音聊天", value: chat?.enabled ? "已开启" : "已关闭", tone: chat?.enabled ? "ok" : "warn" },
          { label: "当前状态", value: stateLabels[chat?.state ?? "off"] ?? "未知" },
          { label: "千问凭据", value: chat?.configured ? "已配置" : "未配置", tone: chat?.configured ? "ok" : "warn" },
          { label: "机器人", value: chat?.deviceId ?? "未连接" },
          { label: "会话次数", value: String(chat?.sessionNumber ?? 0) },
          { label: "当前模型", value: chat?.model ?? "-" },
          { label: "联网搜索", value: chat?.searchEnabled ? "已开启" : "已关闭", tone: chat?.searchEnabled ? "ok" : "muted" },
          { label: "上轮搜索次数", value: String(chat?.lastSearchCount ?? 0) }
        ]} />
        {chat?.reason && <p role="status">{chat.reason}</p>}
      </section>
      <CommandPanel title="语音对话">
        <div className="button-row">
          <Button variant={chat?.enabled ? "danger" : "primary"} disabled={command.pending}
            onClick={() => void command.run(toggle)}>
            {chat?.enabled ? "关闭语音聊天" : "开启语音聊天"}
          </Button>
        </div>
        <CommandStatus status={command.status} />
      </CommandPanel>
      <CommandPanel title="千问设置">
        <div className="form-grid">
          <label className="field">语音模型
            <select value={chat?.model ?? "qwen3.8-omni-flash-realtime"} disabled={!chat || command.pending}
              onChange={(event) => void command.run(() => updateSettings(event.target.value, chat?.searchEnabled ?? false))}>
              {(chat?.availableModels ?? []).map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
          </label>
        </div>
        <div className="button-row">
          <Button disabled={!chat || command.pending}
            onClick={() => void command.run(() => updateSettings(chat?.model ?? "qwen3.8-omni-flash-realtime", !chat?.searchEnabled))}>
            {chat?.searchEnabled ? "关闭联网搜索" : "开启联网搜索"}
          </Button>
        </div>
        <p>保存设置后，正在进行的语音聊天会开启一个新会话。</p>
        <CommandStatus status={command.status} />
      </CommandPanel>
      <section className="panel-block">
        <h3>最近的回答</h3>
        <p aria-live="polite">{chat?.lastReply || "等待千问回答…"}</p>
      </section>
    </div>
  );
}
