import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { say, type Locale } from "../lib/i18n";
import type { SubscriptionFormat } from "../lib/client-downloads";
import "./help.css";

export type SubscriptionLinksData = Record<SubscriptionFormat, string>;

const FORMATS: ReadonlyArray<readonly [SubscriptionFormat, string]> = [
  ["clash", "Clash / Mihomo"],
  ["v2ray", "v2ray"],
  ["shadowsocks", "Shadowsocks"],
];

export function SubscriptionLinks({ locale, links, onReset }: { locale: Locale; links?: SubscriptionLinksData; onReset: (reset?: boolean) => Promise<void> }) {
  const [format, setFormat] = useState<SubscriptionFormat>("clash");
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = (zh: string, en: string) => say(locale, zh, en);
  const url = links?.[format];
  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setFailed(false);
      setMessage("");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
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
      setMessage(rotate ? text("链接已重置，请在所有设备重新导入。", "Links reset. Import the new link on every device.") : "");
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : text("重置失败，请重试。", "Reset failed. Please retry."));
    } finally {
      setBusy(false);
    }
  }
  return <div className="subscription-controls">
    <div className="format-tabs" role="tablist" aria-label={text("订阅格式", "Subscription format")}>
      {FORMATS.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={format === key} className={format === key ? "active" : ""} onClick={() => { setFormat(key); setMessage(""); setCopied(false); }}>{label}</button>)}
    </div>
    <div className="link-copy-row">
      <code>{url ?? text("订阅链接暂不可用。", "Subscription link unavailable.")}</code>
      <button type="button" className="primary-button small" disabled={!url || busy} onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? text("已复制", "Copied") : text("复制", "Copy")}</button>
    </div>
    <div className="subscription-actions">
      {!links && <button type="button" className="outline-button" disabled={busy} onClick={() => void reset(false)}>{busy ? text("正在加载…", "Loading…") : text("重新获取订阅链接", "Retry loading subscription links")}</button>}
      {confirmReset
        ? <div className="subscription-reset">
          <span>{text("旧链接将立即失效，确认重置？", "Old links stop working immediately. Reset?")}</span>
          <button type="button" className="outline-button" disabled={busy} onClick={() => setConfirmReset(false)}>{text("取消", "Cancel")}</button>
          <button type="button" className="primary-button danger" disabled={busy} onClick={() => void reset()}>{busy ? text("正在重置…", "Resetting…") : text("确认重置", "Confirm reset")}</button>
        </div>
        : <button type="button" className="outline-button" disabled={!links || busy} onClick={() => { setConfirmReset(true); setMessage(""); }}>{text("重置订阅链接", "Reset subscription links")}</button>}
    </div>
    {message && <p className={`auth-message ${failed ? "error" : ""}`} role={failed ? "alert" : "status"}>{message}</p>}
  </div>;
}
