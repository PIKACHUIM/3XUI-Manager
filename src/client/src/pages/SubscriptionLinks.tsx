import { useState } from "react";
import { say, type Locale } from "../lib/i18n";
import type { SubscriptionFormat } from "../lib/client-downloads";
import "./help.css";

export type SubscriptionLinksData = Record<SubscriptionFormat, string>;
export function SubscriptionLinks({ locale, links, onReset }: { locale: Locale; links?: SubscriptionLinksData; onReset: (reset?: boolean) => Promise<void> }) {
  const [format, setFormat] = useState<SubscriptionFormat>("clash");
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const text = (zh: string, en: string) => say(locale, zh, en);
  const url = links?.[format];
  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setFailed(false);
      setMessage(text("订阅链接已复制。", "Subscription link copied."));
    } catch {
      setFailed(true);
      setMessage(text("无法访问剪贴板，请手动选中并复制链接。", "Clipboard access failed. Select and copy the link manually."));
    }
  }
  async function reset(rotate = true) {
    setBusy(true);
    setMessage("");
    try {
      await onReset(rotate);
      setFailed(false);
      setConfirmReset(false);
      setMessage(rotate ? text("链接已重置，请在所有设备重新导入新链接。", "Links reset. Import the new link on every device.") : text("订阅链接已加载。", "Subscription links loaded."));
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : text("重置失败，请重试。", "Reset failed. Please retry."));
    } finally {
      setBusy(false);
    }
  }
  return <div className="subscription-controls">
    <label className="subscription-format">{text("订阅格式", "Subscription format")}<select value={format} onChange={(event) => { setFormat(event.target.value as SubscriptionFormat); setMessage(""); }}><option value="clash">Clash / Mihomo</option><option value="v2ray">v2ray (Base64)</option><option value="shadowsocks">Shadowsocks (SIP008)</option></select></label>
    <div className="link-copy-row"><code>{url ?? text("订阅链接暂不可用。", "Subscription link unavailable.")}</code><button className="outline-button small" disabled={!url || busy} onClick={() => void copy()}>{text("复制", "Copy")}</button></div>
    <p className="help-note">{text("链接包含访问凭证，请勿分享。不同格式只包含兼容节点；Shadowsocks 需要客户端支持 SIP008，且仅导出具有已验证密码的节点。普通自动同步的节点可能不具备此凭据；没有兼容节点时订阅返回不可用。", "Links contain access credentials; do not share them. Each format includes compatible nodes only. Shadowsocks requires SIP008 support and exports only nodes with verified passwords. Automatically synced nodes may lack these credentials; a subscription without compatible nodes is unavailable.")}</p>
    {!links && <button className="outline-button" disabled={busy} onClick={() => void reset(false)}>{busy ? text("正在加载…", "Loading…") : text("重新获取订阅链接", "Retry loading subscription links")}</button>}
    {confirmReset ? <div><p className="help-note">{text("重置会立即使所有旧链接失效，需要在每台设备重新导入。确认继续？", "Resetting immediately invalidates all old links. Every device must import a new link. Continue?")}</p><div className="subscription-reset"><button className="outline-button" disabled={busy} onClick={() => setConfirmReset(false)}>{text("取消", "Cancel")}</button><button className="primary-button" disabled={busy} onClick={() => void reset()}>{busy ? text("正在重置…", "Resetting…") : text("确认重置", "Confirm reset")}</button></div></div> : <button className="outline-button" disabled={!links || busy} onClick={() => { setConfirmReset(true); setMessage(""); }}>{text("重置订阅链接", "Reset subscription links")}</button>}
    {message && <p className={`auth-message ${failed ? "error" : ""}`} role={failed ? "alert" : "status"}>{message}</p>}
  </div>;
}
