import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowRight, ArrowUpRight, Bell, Check, ChevronDown,
  ChevronLeft, ChevronRight, CircleHelp, Command, CreditCard, Globe2, Gauge,
  LayoutDashboard, LifeBuoy, LogOut, Menu, Moon, MoreHorizontal, Network, Palette, Pencil, Power,
  Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Sun, Users,
  Wallet, Wifi, X, Zap, type LucideIcon
} from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis
} from "recharts";
import { detectLocale, EN_MESSAGES, LOCALE_META, LOCALES, localeDirection, messages, phrase, pick, saveLocale, say, type Locale, type MessageKey } from "../lib/i18n";
import { buildInboundConfig, buildInboundMeta, certificateUsages, domainStrategies, inboundFieldValues, inboundNetworks, inboundProtocols, inboundSniffTargets, kcpHeaderTypes, tlsVersions, trafficResetUnits, xhttpModes } from "../lib/inbound-config";

type PageKey = "overview" | "subscription" | "nodes" | "plans" | "account" | "checkin" | "users" | "inbounds" | "orders" | "system";
type MenuItem = { key: PageKey; icon: LucideIcon; label: MessageKey };

const userMenu: MenuItem[] = [
  { key: "overview", icon: LayoutDashboard, label: "overview" },
  { key: "subscription", icon: CreditCard, label: "subscription" },
  { key: "nodes", icon: Network, label: "nodes" },
  { key: "plans", icon: Sparkles, label: "plans" },
  { key: "account", icon: Wallet, label: "account" },
  { key: "checkin", icon: Zap, label: "checkin" },
];
const adminMenu: MenuItem[] = [
  { key: "overview", icon: LayoutDashboard, label: "overview" },
  { key: "users", icon: Users, label: "users" },
  { key: "nodes", icon: Network, label: "nodes" },
  { key: "inbounds", icon: Globe2, label: "inbounds" },
  { key: "plans", icon: Sparkles, label: "plans" },
  { key: "orders", icon: CreditCard, label: "orders" },
  { key: "system", icon: Settings2, label: "system" },
];

function useText(locale: Locale) {
  return (key: MessageKey) => messages[locale][key] ?? EN_MESSAGES[key];
}

function HeaderIcon({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick?: () => void }) {
  return <button className="icon-button" type="button" aria-label={label} title={label} onClick={onClick}><Icon size={18} strokeWidth={1.8} /></button>;
}

type AdminCreateKind = "node" | "inbound" | "plan" | "user";
type AdminEditor = { kind: AdminCreateKind; id?: string };
type AuthenticatedUser = { id: string; email: string; role: "admin" | "user"; createdAt: string };
type PublicConfig = { turnstileSiteKey: string | null; registrationTurnstileEnabled: boolean; checkinTurnstileEnabled: boolean };
type ApiPlan = { id: string; name: string; description: string; group: string; level: number; trafficBytes: number; validityDays: number; priceMinor: number; currency: string; resetUnit: string; resetInterval: number; resetAtHour: number; resetWeekday: number; resetMonthDay: number; enabled: boolean; isDefault: boolean; allowPaidUpgrade: boolean };
type AdminDashboardData = { users: number; activeUsers: number; activeSubscriptions: number; revenueMinor: number; currency: string; nodesOnline: number; nodesTotal: number; plans: number; pendingOrders: number };
type AdminUserRecord = { id: string; email: string; role: "admin" | "user"; enabled: boolean; balanceMinor: number; planId: string; planExpiresAt: string | null; planTrafficBytes: number; billedBytes: number; createdAt: string };
type AdminNodeRecord = { id: string; name: string; region: string; panelUrl: string; publicAddress: string; username: string; basePath: string; status: string; inboundCount: number; enabled: boolean; lastCheckedAt: string | null; syncStatus: string };
type AdminInboundRecord = { id: string; name: string; protocol: string; network: string; port: number; minimumLevel: number; multiplier: number; enabled: boolean; planEnabled?: boolean; listen?: string; total?: number; expiryTime?: number; trafficReset?: string; trafficResetDay?: number; tag?: string; shareAddrStrategy?: string; shareAddr?: string; subSortIndex?: number; excludeFromSub?: boolean; disableFlow?: boolean; defaultFlow?: string; config: Record<string, unknown> };
type AdminInboundBinding = { id: string; inboundId: string; nodeId: string; panelInboundId: number };
type AdminInboundStats = { inboundId: string; nodes: number; clients: number };
type AdminOrderRecord = UserOrderData & { userId: string; paidAt: string | null };
type AdminUserRow = { id: string; name: string; email: string; initials: string; color: string; role: string; plan: string; usage: string; date: string; state: string; enabled: boolean };
type DisplayOrderRow = { id: string; customer: string; email: string; plan: string; amount: string; method: string; date: string; state: string };
type DisplayPlanRow = { id: string; name: string; detail: string; level: string; traffic: string; price: string; cycle: string; users: string; tone: string; enabled: boolean };
type DisplayInboundRow = { id: string; name: string; address: string; node: string; level: string; multiplier: string; clients: string; state: string; enabled: boolean; planEnabled: boolean };
type UserOverviewData = {
  user: AuthenticatedUser & { balanceMinor: number; planLevel: number; planExpiresAt: string | null; createdAt: string; checkinStreak: number; lastCheckinAt: string | null };
  plan: ApiPlan | null;
  subscriptionActive: boolean;
  usage: { usedBytes: number; limitBytes: number; remainingBytes: number; days: Array<{ usageDay: string; billedBytes: number; rawBytes: number }> };
  nodes: Array<{ id: string; name: string; region: string; publicAddress: string; status: string; inboundCount: number }>;
  balanceMinor: number;
  capabilities: { trafficMetering: boolean; quotaEnforcement: boolean; atomicPaymentSettlement: boolean };
  attendance: { streak: number; lastCheckinAt: string | null; checkedInToday: boolean; rewardBytes: number; minRewardBytes?: number; maxRewardBytes?: number };
};
type UserNodeData = { node: UserOverviewData["nodes"][number]; inbound: { id: string; name: string; multiplier: number; protocol: string; port: number }; client: { email: string; clientId: string; enabled: boolean; syncStatus: string } | null };
type DisplayNode = { id?: string; name: string; region: string; address?: string; flag: string; multiplier: string; latency: string; load: number | null; color: string; state: string; enabled?: boolean; inbounds?: number; checkedAt?: string };
type UserOrderData = { id: string; planId: string | null; type: string; amountMinor: number; currency: string; provider: string; status: string; createdAt: string; metadata?: Record<string, unknown> };
type NotificationData = { id: string; type: string; title: string; body: string; createdAt: string; readAt: string | null };
type UserSubscriptionData = { plan: ApiPlan | null; active: boolean; startedAt: string; expiresAt: string | null; traffic: { usedBytes: number; limitBytes: number; remainingBytes: number }; clients: Array<{ inboundName: string; protocol: string; port: number; enabled: boolean; syncStatus: string }>; capabilities: UserOverviewData["capabilities"] };

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: "include", ...init });
  const payload = await response.json().catch(() => null) as { error?: string; message?: string } | null;
  if (!response.ok) throw new Error(payload?.error ?? payload?.message ?? `Request failed (${response.status}).`);
  return payload as T;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 GB";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${(bytes / 1_000_000).toFixed(0)} MB`;
}

function formatMoney(amountMinor: number, currency: string, locale: Locale): string {
  try {
    const exponent = new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amountMinor / 10 ** exponent);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

function moneyFractionDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

function parseMoneyInput(value: string, currency: string): number | null {
  const text = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const digits = moneyFractionDigits(currency);
  const [whole = "", fraction = ""] = text.split(".");
  if (fraction.length > digits) return null;
  const amount = Number(whole) * 10 ** digits + Number((fraction + "0".repeat(digits)).slice(0, digits) || "0");
  return Number.isSafeInteger(amount) ? amount : null;
}

function formatDate(value: string, locale: Locale): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

function LanguageMenu({ locale, onChange, label }: { locale: Locale; onChange: (locale: Locale) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) { setAnchor(null); return; }
    const closeOnOutside = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(340, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
      setAnchor({ top: rect.bottom + 9, left });
    };
    place();
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  return (
    <div className="lang-menu" ref={wrapRef}>
      <button ref={triggerRef} type="button" className={`lang-trigger ${open ? "open" : ""}`} aria-haspopup="listbox" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((value) => !value)}>
        <Globe2 size={15} />
        <span className="lang-current">{LOCALE_META[locale].native}</span>
        <ChevronDown size={13} className="lang-caret" />
      </button>
      {open && anchor && <div className="lang-popover" role="listbox" aria-label={label} style={{ top: anchor.top, left: anchor.left }}>
        <div className="lang-popover-head"><span>{label}</span><small>{LOCALE_META[locale].english}</small></div>
        <div className="lang-options">
          {LOCALES.map((code) => <button key={code} type="button" role="option" aria-selected={code === locale} className={`lang-option ${code === locale ? "active" : ""}`} onClick={() => { onChange(code); setOpen(false); }}>
            <span className="lang-native" dir={LOCALE_META[code].dir}>{LOCALE_META[code].native}</span>
            <small>{LOCALE_META[code].english}</small>
            {code === locale && <Check size={14} className="lang-check" />}
          </button>)}
        </div>
      </div>}
    </div>
  );
}

function heroTitle(locale: Locale, kind: "user" | "admin"): { lead: string; accent: string } {
  return pick(locale, kind === "user" ? {
    zh: { lead: "连接世界，", accent: "轻松自在。" },
    en: { lead: "The whole world, ", accent: "within reach." },
    "zh-TW": { lead: "連接世界，", accent: "輕鬆自在。" },
    ja: { lead: "世界を、", accent: "もっと身近に。" },
    ko: { lead: "전 세계를 ", accent: "손안에." },
    de: { lead: "Die ganze Welt, ", accent: "ganz nah." },
    es: { lead: "Todo el mundo, ", accent: "a tu alcance." },
    pt: { lead: "O mundo inteiro, ", accent: "ao seu alcance." },
    it: { lead: "Tutto il mondo, ", accent: "a portata di mano." },
    ar: { lead: "العالم كله ", accent: "في متناولك." },
    ru: { lead: "Весь мир ", accent: "под рукой." },
    fr: { lead: "Le monde entier, ", accent: "à portée de main." },
  } : {
    zh: { lead: "一切尽在掌握，", accent: "从容管理。" },
    en: { lead: "Everything in sync. ", accent: "Keep things moving." },
    "zh-TW": { lead: "一切盡在掌握，", accent: "從容管理。" },
    ja: { lead: "すべてを把握し、", accent: "余裕の運用を。" },
    ko: { lead: "모든 것을 파악하고 ", accent: "여유롭게 관리하세요." },
    de: { lead: "Alles im Blick, ", accent: "gelassen verwalten." },
    es: { lead: "Todo bajo control, ", accent: "gestiona con calma." },
    pt: { lead: "Tudo sob controlo, ", accent: "gerir com calma." },
    it: { lead: "Tutto sotto controllo, ", accent: "gestisci con calma." },
    ar: { lead: "كل شيء تحت السيطرة، ", accent: "أدر بسهولة." },
    ru: { lead: "Всё под контролем — ", accent: "управляйте спокойно." },
    fr: { lead: "Tout est maîtrisé, ", accent: "gardez le rythme." },
  });
}

type TurnstileApi = {
  render: (container: HTMLElement, options: { sitekey: string; action: string; callback: (token: string) => void; "expired-callback": () => void; "error-callback": () => void }) => string;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window { turnstile?: TurnstileApi }
}

let turnstileLoader: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!turnstileLoader) {
    turnstileLoader = new Promise<TurnstileApi>((resolve, reject) => {
      const src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      const script = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`) ?? document.createElement("script");
      const onLoad = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not initialize."));
      const onError = () => reject(new Error("Turnstile could not be loaded."));
      script.addEventListener("load", onLoad, { once: true });
      script.addEventListener("error", onError, { once: true });
      if (!script.src) {
        script.src = src;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
    }).catch((error: unknown) => {
      turnstileLoader = null;
      throw error;
    });
  }
  return turnstileLoader!;
}

function TurnstileWidget({ siteKey, action, resetKey, onToken, locale }: { siteKey: string; action: string; resetKey: number; onToken: (token: string) => void; locale: Locale }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tokenHandler = useRef(onToken);
  const [error, setError] = useState("");
  tokenHandler.current = onToken;
  useEffect(() => {
    let cancelled = false;
    let widgetId: string | null = null;
    setError("");
    void loadTurnstile().then((turnstile) => {
      if (cancelled || !containerRef.current) return;
      widgetId = turnstile.render(containerRef.current, {
        sitekey: siteKey,
        action,
        callback: (token) => tokenHandler.current(token),
        "expired-callback": () => tokenHandler.current(""),
        "error-callback": () => { tokenHandler.current(""); setError(say(locale, "人机验证加载失败，请重试。", "Verification failed to load. Please try again.")); },
      });
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : say(locale, "人机验证加载失败，请重试。", "Verification failed to load. Please try again."));
    });
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [action, locale, resetKey, siteKey]);
  return <div className="turnstile-field"><div ref={containerRef} />{error && <div className="auth-message error" role="alert">{error}</div>}</div>;
}

function AuthScreen({ onAuthenticated, initialError, turnstileSiteKey, turnstileRequired, securityConfigLoaded, securityConfigError }: { onAuthenticated: (user: AuthenticatedUser) => void; initialError: string; turnstileSiteKey: string | null; turnstileRequired: boolean; securityConfigLoaded: boolean; securityConfigError: string }) {
  const locale = detectLocale();
  const authTheme = detectTheme();
  const [mode, setMode] = useState<"login" | "register" | "bootstrap">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [error, setError] = useState(initialError);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);

  useEffect(() => {
    if (window.location.pathname !== "/verify-email") return;
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) { setError("Verification token is missing."); return; }
    setBusy(true);
    void apiRequest<{ user?: AuthenticatedUser }>("/api/auth/verify-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })
      .then((result) => { window.history.replaceState({}, "", "/"); if (result.user) onAuthenticated(result.user); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Email verification failed."))
      .finally(() => setBusy(false));
  }, [onAuthenticated]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setMessage("");
    if (mode === "register" && !securityConfigLoaded) { setError(say(locale, "安全配置仍在加载，请重试。", "Security configuration is still loading. Please retry.")); return; }
    if (mode === "register" && securityConfigError) { setError(say(locale, "无法加载安全配置，为安全起见注册已暂停。", "Security configuration could not be loaded. Registration is paused for safety.")); return; }
    if (mode === "register" && turnstileRequired && !turnstileSiteKey) { setError(say(locale, "需要人机验证，但尚未配置 Site Key。", "Turnstile is required but no site key is configured.")); return; }
    if (mode === "register" && turnstileRequired && !turnstileToken) { setError(say(locale, "请先完成人机验证再注册。", "Complete the human verification challenge before registering.")); return; }
    setBusy(true);
    const endpoint = mode === "bootstrap" ? "/api/auth/bootstrap" : mode === "register" ? "/api/auth/register" : "/api/auth/login";
    const headers = new Headers({ "Content-Type": "application/json" });
    if (mode === "bootstrap") headers.set("X-Admin-Bootstrap-Token", bootstrapToken);
    try {
      const result = await apiRequest<{ user?: AuthenticatedUser; message?: string }>(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ email, password, ...(mode === "register" ? { inviteCode, ...(turnstileRequired ? { turnstileToken } : {}) } : {}) }),
      });
      if (result.user) onAuthenticated(result.user);
      else setMessage(result.message ?? say(locale, "请查看邮件以进行下一步。", "Check your email for the next step."));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : say(locale, "身份验证失败。", "Authentication failed."));
    } finally {
      if (mode === "register" && turnstileRequired) {
        setTurnstileToken("");
        setTurnstileResetKey((value) => value + 1);
      }
      setBusy(false);
    }
  };

  const title = mode === "bootstrap" ? say(locale, "创建管理员", "Create administrator") : mode === "register" ? say(locale, "创建你的账号", "Create your account") : say(locale, "欢迎回来", "Welcome back");
  return <main className={`auth-shell ${authTheme}`}><section className="auth-card"><div className="brand-mark"><span /><span /><span /></div><div className="auth-brand"><strong>3xui<span>.</span></strong><small>MANAGER</small></div><span className="section-kicker">{say(locale, "安全接入", "SECURE ACCESS")}</span><h1>{title}</h1><p className="auth-intro">{say(locale, "在一个地方管理订阅、流量与已连接节点。", "Manage your subscriptions, traffic and connected nodes from one place.")}</p>
    <form className="auth-form" onSubmit={submit}><label>{mode === "login" ? say(locale, "邮箱或用户名", "Email or username") : say(locale, "邮箱地址", "Email address")}<input type={mode === "login" ? "text" : "email"} autoComplete={mode === "login" ? "username" : "email"} value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} /></label><label>{say(locale, "密码", "Password")}<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={mode === "login" ? 1 : 12} maxLength={256} /></label>{mode === "register" && <label>{say(locale, "邀请码", "Invitation code")} <span className="auth-optional">{say(locale, "选填", "optional")}</span><input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} maxLength={100} /></label>}{mode === "bootstrap" && <label>{say(locale, "管理员初始化令牌", "Administrator bootstrap token")}<input type="password" value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} required autoComplete="off" /></label>}{mode === "register" && turnstileRequired && turnstileSiteKey && <TurnstileWidget siteKey={turnstileSiteKey} action="signup" resetKey={turnstileResetKey} onToken={setTurnstileToken} locale={locale} />}{mode === "register" && turnstileRequired && !turnstileSiteKey && securityConfigLoaded && <div className="auth-message error" role="alert">{say(locale, "需要人机验证，但尚未配置 Site Key。", "Turnstile is required but no site key is configured.")}</div>}{error && <div className="auth-message error" role="alert">{error}</div>}{message && <div className="auth-message" role="status">{message}</div>}<button className="primary-button auth-submit" disabled={busy}>{busy ? say(locale, "请稍候…", "Please wait…") : mode === "bootstrap" ? say(locale, "创建管理员", "Create administrator") : mode === "register" ? say(locale, "创建账号", "Create account") : say(locale, "登录", "Sign in")}</button></form>
    <div className="auth-switches">{mode !== "login" && <button type="button" onClick={() => { setMode("login"); setError(""); setMessage(""); }}>{say(locale, "登录", "Sign in")}</button>}{mode !== "register" && <button type="button" onClick={() => { setMode("register"); setError(""); setMessage(""); }}>{say(locale, "创建账号", "Create account")}</button>}{mode !== "bootstrap" && <button type="button" onClick={() => { setMode("bootstrap"); setError(""); setMessage(""); }}>{say(locale, "首次管理员初始化", "First-time admin setup")}</button>}</div>
  </section><span className="auth-foot">{say(locale, "凭据由 HttpOnly 会话 Cookie 保护。", "Credentials are protected by an HttpOnly session cookie.")}</span></main>;
}

function App() {
  const [sessionUser, setSessionUser] = useState<AuthenticatedUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [publicConfig, setPublicConfig] = useState<PublicConfig | null>(null);
  const [securityConfigLoaded, setSecurityConfigLoaded] = useState(false);
  const [securityConfigError, setSecurityConfigError] = useState("");
  useEffect(() => {
    void apiRequest<{ user: AuthenticatedUser | null }>("/api/auth/me")
      .then((result) => setSessionUser(result.user))
      .catch((error: unknown) => setAuthError(error instanceof Error ? error.message : "Unable to reach the service."))
      .finally(() => setLoading(false));
    void apiRequest<PublicConfig>("/api/auth/config")
      .then(setPublicConfig)
      .catch((error: unknown) => setSecurityConfigError(error instanceof Error ? error.message : "Unable to load security settings."))
      .finally(() => setSecurityConfigLoaded(true));
  }, []);
  const refreshPublicConfig = async () => {
    try {
      setPublicConfig(await apiRequest<PublicConfig>("/api/auth/config"));
      setSecurityConfigError("");
    } catch (cause) {
      setPublicConfig(null);
      setSecurityConfigError(cause instanceof Error ? cause.message : "Unable to load security settings.");
      throw cause;
    }
  };
  const onAuthenticated = (user: AuthenticatedUser) => { setAuthError(""); setSessionUser(user); };
  const logout = async () => {
    try { await apiRequest("/api/auth/logout", { method: "POST" }); } catch { /* Session state is cleared locally even if the API is unreachable. */ }
    setSessionUser(null);
  };
  if (loading) return <main className={`auth-shell ${detectTheme()}`}><section className="auth-card"><div className="brand-mark"><span /><span /><span /></div><h1>3XUI Manager</h1><p className="auth-intro">Checking your session…</p></section></main>;
  if (!sessionUser) return <AuthScreen onAuthenticated={onAuthenticated} initialError={authError} turnstileSiteKey={publicConfig?.turnstileSiteKey ?? null} turnstileRequired={publicConfig?.registrationTurnstileEnabled ?? false} securityConfigLoaded={securityConfigLoaded} securityConfigError={securityConfigError} />;
  return <DashboardApp sessionUser={sessionUser} publicConfig={publicConfig} onSettingsSaved={refreshPublicConfig} onLogout={() => { void logout(); }} />;
}

type Theme = "dark" | "light";
const THEME_STORAGE_KEY = "3xui-theme";

function systemTheme(): Theme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function detectTheme(): Theme {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch { /* Theme preference is optional. */ }
  return systemTheme();
}

function rememberTheme(theme: Theme) {
  try { window.localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* Theme preference is optional. */ }
}

function DashboardApp({ sessionUser, publicConfig, onSettingsSaved, onLogout }: { sessionUser: AuthenticatedUser; publicConfig: PublicConfig | null; onSettingsSaved: () => Promise<void>; onLogout: () => void }) {
  const [locale, setLocale] = useState<Locale>(() => detectLocale());
  const [page, setPage] = useState<PageKey>("overview");
  const [admin, setAdmin] = useState(sessionUser.role === "admin");
  const [theme, setTheme] = useState<Theme>(() => detectTheme());
  const [accent, setAccent] = useState("cyan");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [notifications, setNotifications] = useState<NotificationData[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notificationError, setNotificationError] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return window.localStorage.getItem("3xui-sidebar-collapsed") === "1"; } catch { return false; }
  });
  const [showTheme, setShowTheme] = useState(false);
  const [editor, setEditor] = useState<AdminEditor | null>(null);
  const [adjustUser, setAdjustUser] = useState<AdminUserRecord | null>(null);
  const [overview, setOverview] = useState<UserOverviewData | null>(null);
  const [userPlans, setUserPlans] = useState<ApiPlan[]>([]);
  const [userNodeRecords, setUserNodeRecords] = useState<UserNodeData[]>([]);
  const [userOrders, setUserOrders] = useState<UserOrderData[]>([]);
  const [subscription, setSubscription] = useState<UserSubscriptionData | null>(null);
  const [adminDashboard, setAdminDashboard] = useState<AdminDashboardData | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUserRecord[]>([]);
  const [adminPlans, setAdminPlans] = useState<ApiPlan[]>([]);
  const [adminNodes, setAdminNodes] = useState<AdminNodeRecord[]>([]);
  const [adminInbounds, setAdminInbounds] = useState<AdminInboundRecord[]>([]);
  const [adminBindings, setAdminBindings] = useState<AdminInboundBinding[]>([]);
  const [adminInboundStats, setAdminInboundStats] = useState<AdminInboundStats[]>([]);
  const [adminOrders, setAdminOrders] = useState<AdminOrderRecord[]>([]);
  const [apiLoading, setApiLoading] = useState(false);
  const [apiError, setApiError] = useState("");
  const [checkinBusy, setCheckinBusy] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [syncDialog, setSyncDialog] = useState<{ nodeId?: string } | null>(null);
  const t = useText(locale);
  const canAdmin = sessionUser.role === "admin";
  const chooseTheme = (next: Theme) => {
    setTheme(next);
    rememberTheme(next);
  };
  const changeLocale = (next: Locale) => {
    setLocale(next);
    saveLocale(next);
  };
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemTheme = (event: MediaQueryListEvent) => {
      let saved: string | null = null;
      try { saved = window.localStorage.getItem(THEME_STORAGE_KEY); } catch { /* Theme preference is optional. */ }
      if (saved === "dark" || saved === "light") return;
      setTheme(event.matches ? "dark" : "light");
    };
    query.addEventListener("change", handleSystemTheme);
    return () => query.removeEventListener("change", handleSystemTheme);
  }, []);
  const toggleSidebar = () => {
    if (window.matchMedia("(max-width: 900px)").matches) { setMobileOpen(false); return; }
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      try { window.localStorage.setItem("3xui-sidebar-collapsed", next ? "1" : "0"); } catch { /* Sidebar preference is optional. */ }
      return next;
    });
  };

  useEffect(() => {
    const controller = new AbortController();
    setApiLoading(true);
    setApiError("");
    const load = admin
      ? Promise.all([
        apiRequest<AdminDashboardData>("/api/admin/dashboard", { signal: controller.signal }),
        apiRequest<{ items: AdminUserRecord[] }>("/api/admin/users", { signal: controller.signal }),
        apiRequest<{ items: ApiPlan[] }>("/api/admin/plans", { signal: controller.signal }),
        apiRequest<{ items: AdminNodeRecord[] }>("/api/admin/nodes", { signal: controller.signal }),
        apiRequest<{ items: AdminInboundRecord[]; bindings: AdminInboundBinding[]; sync: AdminInboundStats[] }>("/api/admin/inbounds", { signal: controller.signal }),
        apiRequest<{ items: AdminOrderRecord[] }>("/api/admin/orders", { signal: controller.signal }),
      ]).then(([dashboardResult, usersResult, plansResult, nodesResult, inboundsResult, ordersResult]) => {
        setAdminDashboard(dashboardResult);
        setAdminUsers(usersResult.items);
        setAdminPlans(plansResult.items);
        setAdminNodes(nodesResult.items);
        setAdminInbounds(inboundsResult.items);
        setAdminBindings(inboundsResult.bindings);
        setAdminInboundStats(inboundsResult.sync);
        setAdminOrders(ordersResult.items);
      })
      : Promise.all([
        apiRequest<UserOverviewData>("/api/user/overview", { signal: controller.signal }),
        apiRequest<{ items: ApiPlan[] }>("/api/user/plans", { signal: controller.signal }),
        apiRequest<{ items: UserNodeData[] }>("/api/user/nodes", { signal: controller.signal }),
        apiRequest<{ items: UserOrderData[] }>("/api/user/orders", { signal: controller.signal }),
        apiRequest<UserSubscriptionData>("/api/user/subscription", { signal: controller.signal }),
      ]).then(([nextOverview, planResult, nodeResult, orderResult, nextSubscription]) => {
        setOverview(nextOverview);
        setUserPlans(planResult.items);
        setUserNodeRecords(nodeResult.items);
        setUserOrders(orderResult.items);
        setSubscription(nextSubscription);
      });
    void load.catch((error: unknown) => {
      if (!controller.signal.aborted) setApiError(error instanceof Error ? error.message : "Unable to load account data.");
    }).finally(() => {
      if (!controller.signal.aborted) setApiLoading(false);
    });
    return () => controller.abort();
  }, [admin, refreshToken, sessionUser.id]);
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<{ items: NotificationData[] }>("/api/user/notifications", { signal: controller.signal })
      .then((result) => { setNotifications(result.items); setNotificationError(""); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setNotificationError(error instanceof Error ? error.message : "Notifications could not be loaded."); });
    return () => controller.abort();
  }, [refreshToken, sessionUser.id]);
  const menu = admin ? adminMenu : userMenu;
  const title = t(menu.find((item) => item.key === page)?.label ?? "overview");
  const createKind: AdminCreateKind | null = page === "nodes" ? "node" : page === "inbounds" ? "inbound" : page === "plans" ? "plan" : page === "users" ? "user" : null;
  const createLabel = createKind === "node" ? (say(locale, "添加节点", "Add node")) : createKind === "inbound" ? (say(locale, "添加入站", "Add inbound")) : createKind === "plan" ? (say(locale, "添加套餐", "Add plan")) : createKind === "user" ? (say(locale, "添加用户", "Add user")) : "";
  const initials = sessionUser.email.slice(0, 2).toUpperCase();

  const filteredUsers = useMemo<AdminUserRow[]>(() => {
    const plansById = new Map(adminPlans.map((plan) => [plan.id, plan]));
    return adminUsers
      .filter((user) => `${user.email} ${plansById.get(user.planId)?.name ?? ""}`.toLowerCase().includes(search.toLowerCase()))
      .map((user, index) => {
        const name = user.email.split("@")[0] || user.email;
        const expired = user.planExpiresAt !== null && Date.parse(user.planExpiresAt) <= Date.now();
        return {
          id: user.id,
          name,
          email: user.email,
          initials: name.split(/[._-]/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase(),
          color: ["lavender", "mint", "blue", "peach"][index % 4]!,
          role: user.role,
          plan: plansById.get(user.planId)?.name ?? "—",
          usage: `${formatBytes(user.billedBytes)} / ${formatBytes(user.planTrafficBytes)}`,
          date: formatDate(user.createdAt, locale),
          state: !user.enabled ? "disabled" : expired ? "expired" : "active",
          enabled: user.enabled,
        };
      });
  }, [adminUsers, adminPlans, locale, search]);
  const filteredNodes = useMemo<DisplayNode[]>(() => adminNodes
    .filter((node) => `${node.name} ${node.region} ${node.publicAddress}`.toLowerCase().includes(search.toLowerCase()))
    .map((node) => ({
      id: node.id,
      name: node.name,
      region: node.region || node.publicAddress,
      address: node.publicAddress,
      flag: "•",
      multiplier: "—",
      latency: node.lastCheckedAt ? formatDate(node.lastCheckedAt, locale) : "—",
      load: null,
      color: node.status === "online" ? "mint" : "rose",
      state: node.status,
      enabled: node.enabled,
      inbounds: node.inboundCount,
      checkedAt: node.lastCheckedAt ? formatDate(node.lastCheckedAt, locale) : "—",
    })), [adminNodes, locale, search]);
  const userDisplayNodes = useMemo<DisplayNode[]>(() => {
    const unique = new Map<string, UserNodeData>();
    for (const item of userNodeRecords) if (!unique.has(item.node.id)) unique.set(item.node.id, item);
    return [...unique.values()].map(({ node, inbound }) => ({
      id: node.id,
      name: node.name,
      region: node.region || node.publicAddress,
      address: node.publicAddress,
      flag: "•",
      multiplier: `${inbound.multiplier}×`,
      latency: "—",
      load: null,
      color: node.status === "online" ? "mint" : "rose",
      state: node.status,
    }));
  }, [userNodeRecords]);
  const visibleNodes: DisplayNode[] = admin ? filteredNodes : userDisplayNodes.filter((node) => `${node.name} ${node.region}`.toLowerCase().includes(search.toLowerCase()));
  const planRows = useMemo<DisplayPlanRow[]>(() => adminPlans.map((plan, index) => ({
    id: plan.id,
    name: plan.name,
    detail: plan.description,
    level: phrase(locale, "等级 {n}", "Level {n}", { n: plan.level }),
    traffic: formatBytes(plan.trafficBytes),
    price: formatMoney(plan.priceMinor, plan.currency, locale),
    cycle: plan.validityDays > 0 ? phrase(locale, "{n} 天", "{n} days", { n: plan.validityDays }) : say(locale, "不限期", "No expiry"),
    users: String(adminUsers.filter((user) => user.planId === plan.id).length),
    tone: ["violet", "mint", "amber"][index % 3]!,
    enabled: plan.enabled,
  })), [adminPlans, adminUsers, locale]);
  const inboundRows = useMemo<DisplayInboundRow[]>(() => {
    const nodesById = new Map(adminNodes.map((node) => [node.id, node]));
    return adminInbounds.map((inbound) => {
      const bindings = adminBindings.filter((binding) => binding.inboundId === inbound.id);
      const stats = adminInboundStats.find((item) => item.inboundId === inbound.id);
      return {
        id: inbound.id,
        name: `${inbound.protocol.toUpperCase()} · ${inbound.name}`,
        address: `:${inbound.port}/${inbound.network}`,
        node: bindings.map((binding) => nodesById.get(binding.nodeId)?.name ?? binding.nodeId).join(", ") || "—",
        level: phrase(locale, "等级 {n}+", "Level {n}+", { n: inbound.minimumLevel }),
        multiplier: `${inbound.multiplier}×`,
        clients: String(stats?.clients ?? 0),
        state: inbound.enabled ? "active" : "disabled",
        enabled: inbound.enabled,
        planEnabled: inbound.planEnabled !== false,
      };
    });
  }, [adminInbounds, adminBindings, adminInboundStats, adminNodes]);
  const orderDisplayRows: DisplayOrderRow[] = admin
    ? adminOrders.map((order) => {
      const user = adminUsers.find((item) => item.id === order.userId);
      return {
        id: order.id,
        customer: user?.email.split("@")[0] ?? order.userId,
        email: user?.email ?? order.userId,
        plan: order.provider === "manual" ? say(locale, "余额调整", "Balance adjustment") : adminPlans.find((plan) => plan.id === order.planId)?.name ?? order.type,
        amount: formatMoney(order.amountMinor, order.currency, locale),
        method: order.provider.toUpperCase(),
        date: formatDate(order.createdAt, locale),
        state: order.status,
      };
    })
    : userOrders.map((order) => ({
      id: order.id,
      customer: sessionUser.email,
      email: sessionUser.email,
      plan: order.provider === "manual" ? say(locale, "余额调整", "Balance adjustment") : userPlans.find((plan) => plan.id === order.planId)?.name ?? order.type,
      amount: formatMoney(order.amountMinor, order.currency, locale),
      method: order.provider.toUpperCase(),
      date: formatDate(order.createdAt, locale),
      state: order.status,
    }));

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2400);
  };
  const unreadNotifications = notifications.filter((item) => item.readAt === null).length;
  const refreshNotifications = async () => {
    try {
      const result = await apiRequest<{ items: NotificationData[] }>("/api/user/notifications");
      setNotifications(result.items);
      setNotificationError("");
    } catch (error) {
      setNotificationError(error instanceof Error ? error.message : "Notifications could not be loaded.");
    }
  };
  const markNotificationRead = async (id: string) => {
    try {
      await apiRequest(`/api/user/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
      setNotifications((current) => current.map((item) => item.id === id ? { ...item, readAt: new Date().toISOString() } : item));
    } catch (error) {
      setNotificationError(error instanceof Error ? error.message : "Notification could not be updated.");
    }
  };
  const copyLink = async () => {
    flash(say(locale, "订阅链接尚未由服务端配置", "A subscription URL has not been configured by the server."));
  };
  const startPlanCheckout = async (plan: ApiPlan) => {
    setApiError("");
    try {
      const type = overview && plan.level > overview.user.planLevel && plan.allowPaidUpgrade ? "upgrade" : "subscription";
      const result = await apiRequest<{ checkoutUrl: string | null; appliedWithoutPayment: boolean; balanceAppliedMinor?: number }>("/api/payments/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, provider: "waffo", planId: plan.id }),
      });
      if (result.checkoutUrl) window.location.assign(result.checkoutUrl);
      else if (result.appliedWithoutPayment) {
        setRefreshToken((value) => value + 1);
        if (result.balanceAppliedMinor && result.balanceAppliedMinor > 0) {
          flash(phrase(locale, "已用余额抵扣 {amount}。", "{amount} was deducted from your balance.", { amount: formatMoney(result.balanceAppliedMinor, plan.currency, locale) }));
        }
      }
      else flash(say(locale, "支付订单未生成", "No payment order was created."));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Checkout could not be created.";
      setApiError(message);
      flash(message);
    }
  };
  const submitCheckin = async (turnstileToken?: string) => {
    if (!overview?.capabilities.trafficMetering || !publicConfig || checkinBusy || (publicConfig.checkinTurnstileEnabled && !turnstileToken)) return;
    setApiError("");
    setCheckinBusy(true);
    try {
      const result = await apiRequest<{ rewardBytes: number; syncStatus: "synced" | "partial" | "failed" }>("/api/user/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(publicConfig.checkinTurnstileEnabled ? { turnstileToken } : {}),
      });
      const syncFailed = result.syncStatus === "partial" ? 1 : 0;
      const syncNotice = result.syncStatus === "synced" ? "" : pick(locale, {
        zh: `；节点同步${syncFailed ? "部分失败" : "失败"}`,
        en: `; node sync ${result.syncStatus}`,
        "zh-TW": `；節點同步${syncFailed ? "部分失敗" : "失敗"}`,
        ja: `、ノード同期${syncFailed ? "一部失敗" : "失敗"}`,
        ko: `, 노드 동기화 ${syncFailed ? "일부 실패" : "실패"}`,
        de: `; Knoten-Sync ${syncFailed ? "teilweise fehlgeschlagen" : "fehlgeschlagen"}`,
        es: `; sincronización de nodos ${syncFailed ? "parcial" : "fallida"}`,
        pt: `; sincronização de nós ${syncFailed ? "parcial" : "falhada"}`,
        it: `; sincronizzazione nodi ${syncFailed ? "parziale" : "non riuscita"}`,
        ar: `؛ مزامنة العقد ${syncFailed ? "فشل جزئي" : "فشلت"}`,
        ru: `; синхронизация узлов ${syncFailed ? "частично не удалась" : "не удалась"}`,
        fr: ` ; synchro des nœuds ${syncFailed ? "partielle" : "échouée"}`,
      });
      flash(pick(locale, {
        zh: `签到成功，获得 ${formatBytes(result.rewardBytes)}${syncNotice}`,
        en: `Check-in complete: ${formatBytes(result.rewardBytes)} added${syncNotice}.`,
        "zh-TW": `簽到成功，獲得 ${formatBytes(result.rewardBytes)}${syncNotice}`,
        ja: `チェックイン完了：${formatBytes(result.rewardBytes)} を獲得しました${syncNotice}。`,
        ko: `체크인 완료: ${formatBytes(result.rewardBytes)} 획득${syncNotice}.`,
        de: `Check-in abgeschlossen: ${formatBytes(result.rewardBytes)} gutgeschrieben${syncNotice}.`,
        es: `Registro completado: ${formatBytes(result.rewardBytes)} añadidos${syncNotice}.`,
        pt: `Check-in concluído: ${formatBytes(result.rewardBytes)} adicionados${syncNotice}.`,
        it: `Check-in completato: ${formatBytes(result.rewardBytes)} aggiunti${syncNotice}.`,
        ar: `تم تسجيل الحضور: أضيف ${formatBytes(result.rewardBytes)}${syncNotice}.`,
        ru: `Отметка выполнена: добавлено ${formatBytes(result.rewardBytes)}${syncNotice}.`,
        fr: `Pointage effectué : ${formatBytes(result.rewardBytes)} ajoutés${syncNotice}.`,
      }));
      setRefreshToken((value) => value + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : say(locale, "签到失败。", "Check-in failed.");
      setApiError(message);
      flash(message);
    } finally {
      setCheckinBusy(false);
    }
  };
  const mutateAdmin = async (path: string, method: "PATCH" | "DELETE", body?: Record<string, unknown>) => {
    try {
      await apiRequest(path, {
        method,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      setRefreshToken((value) => value + 1);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "The admin update failed.");
    }
  };
  const testAdminNode = async (nodeId: string) => {
    try {
      const result = await apiRequest<{ probe: { status: string } }>(`/api/admin/nodes/${encodeURIComponent(nodeId)}/test`, { method: "POST" });
      flash(`${t("status")}: ${result.probe.status}`);
      setRefreshToken((value) => value + 1);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "The node test failed.");
    }
  };
  const saveAdminRecord = async (kind: AdminCreateKind, body: Record<string, unknown>, id?: string) => {
    const resource = kind === "node" ? "nodes" : kind === "inbound" ? "inbounds" : kind === "plan" ? "plans" : "users";
    const endpoint = `/api/admin/${resource}${id ? `/${encodeURIComponent(id)}` : ""}`;
    const result = await apiRequest<{ syncStatus?: string }>(endpoint, {
      method: id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setEditor(null);
    setRefreshToken((value) => value + 1);
    if (result.syncStatus && result.syncStatus !== "synced") flash(pick(locale, {
      zh: `已保存，部分节点同步失败（${result.syncStatus}）`,
      en: `Saved; node sync is ${result.syncStatus}.`,
      "zh-TW": `已儲存，部分節點同步失敗（${result.syncStatus}）`,
      ja: `保存しましたが、一部のノード同期に失敗しました（${result.syncStatus}）`,
      ko: `저장했지만 일부 노드 동기화에 실패했습니다(${result.syncStatus}).`,
      de: `Gespeichert; Knoten-Sync ist ${result.syncStatus}.`,
      es: `Guardado; la sincronización de nodos es ${result.syncStatus}.`,
      pt: `Guardado; a sincronização de nós é ${result.syncStatus}.`,
      it: `Salvato; sincronizzazione nodi: ${result.syncStatus}.`,
      ar: `تم الحفظ؛ مزامنة العقد: ${result.syncStatus}.`,
      ru: `Сохранено; синхронизация узлов: ${result.syncStatus}.`,
      fr: `Enregistré ; synchro des nœuds : ${result.syncStatus}.`,
    }));
    else flash(say(locale, id ? "已保存" : "已创建", id ? "Saved successfully." : "Created successfully."));
  };

  return (
    <div className={`app-shell ${theme}`} data-accent={accent} dir={localeDirection(locale)} lang={locale}>
      {mobileOpen && <button className="mobile-scrim" aria-label={say(locale, "关闭导航", "Close navigation")} onClick={() => setMobileOpen(false)} />}
      <aside id="app-sidebar" className={`sidebar ${mobileOpen ? "open" : ""} ${sidebarCollapsed ? "collapsed" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark"><span /><span /><span /></div>
          <div className="brand-copy"><strong>3xui<span>.</span></strong><small>MANAGER</small></div>
          <button className="sidebar-collapse" type="button" aria-label={sidebarCollapsed ? (say(locale, "展开侧边栏", "Expand sidebar")) : (say(locale, "折叠侧边栏", "Collapse sidebar"))} aria-expanded={!sidebarCollapsed} aria-controls="app-sidebar" title={sidebarCollapsed ? (say(locale, "展开侧边栏", "Expand sidebar")) : (say(locale, "折叠侧边栏", "Collapse sidebar"))} onClick={toggleSidebar}><ChevronLeft size={15} /></button>
        </div>
        <button className="workspace-switch" type="button" title={sessionUser.email} onClick={() => { if (canAdmin) setAdmin(!admin); }}>
          <span className="workspace-avatar">{admin ? <ShieldCheck size={17} /> : <Command size={17} />}</span>
          <span className="workspace-copy"><b>{admin ? t("adminPortal") : sessionUser.email}</b><small>{sessionUser.email}</small></span>
          <ChevronDown size={15} className="muted" />
        </button>
        <div className="nav-section-label">{admin ? t("management") : t("workspace")}</div>
        <nav className="side-nav" aria-label={admin ? t("management") : t("workspace")}>
          {menu.map(({ key, icon: Icon, label }) => <button key={key} className={`nav-item ${page === key ? "selected" : ""}`} title={t(label)} aria-current={page === key ? "page" : undefined} onClick={() => { setPage(key); setSearch(""); setEditor(null); setMobileOpen(false); }}><Icon size={18} strokeWidth={1.8} /><span>{t(label)}</span>{key === "orders" && (admin ? adminOrders.length : userOrders.length) > 0 && <span className="nav-pill">{admin ? adminOrders.length : userOrders.length}</span>}</button>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="sync-card">
            <div className="sync-card-top"><span className="sync-icon"><Activity size={15} /></span><span className="sync-live"><i /> {apiError ? "ERROR" : apiLoading ? "LOADING" : "READY"}</span></div>
            <b>{say(locale, "账户 API", "Account API")}</b>
            <small>{apiError || (say(locale, "显示来自服务端的数据", "Account data loaded from the server"))}</small>
            <div className="sync-foot"><span>{say(locale, "数据状态", "Data status")}</span><span>{apiError ? (say(locale, "不可用", "Unavailable")) : apiLoading ? (say(locale, "加载中", "Loading")) : (say(locale, "已加载", "Loaded"))}</span></div>
          </div>
          <button className="nav-item help-item" title={say(locale, "帮助与支持", "Help & support")} onClick={() => flash(t("support"))}><LifeBuoy size={18} /><span>{say(locale, "帮助与支持", "Help & support")}</span></button>
          <div className="profile-row"><div className="avatar avatar-mint">{initials}</div><div className="profile-copy" title={sessionUser.email}><b>{sessionUser.email}</b><small>{admin ? t("adminPortal") : t("userPortal")}</small></div><button className="profile-more" aria-label={t("settings")} onClick={() => setPage("account")}><MoreHorizontal size={19} /></button></div>
        </div>
      </aside>

      <main className={`main-panel ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
        <header className="topbar">
          <div className="topbar-left"><button className="mobile-menu icon-button" aria-label={say(locale, "打开菜单", "Open menu")} onClick={() => setMobileOpen(true)}><Menu size={19} /></button><div className="breadcrumbs"><span>{admin ? t("adminPortal") : t("userPortal")}</span><ChevronRight size={14} /><b>{title}</b></div></div>
          <div className="topbar-actions">
            <label className="global-search"><Search size={16} /><input aria-label={t("search")} placeholder={t("searchPlaceholder")} value={search} onChange={(event) => setSearch(event.target.value)} /><kbd>⌘ K</kbd></label>
            {canAdmin && <div className="role-switch"><button className={!admin ? "on" : ""} onClick={() => { setAdmin(false); setPage("overview"); }}>{t("customer")}</button><button className={admin ? "on" : ""} onClick={() => { setAdmin(true); setPage("overview"); }}>{t("admin")}</button></div>}
            <div className="language-switch"><LanguageMenu locale={locale} onChange={changeLocale} label={t("language")} /></div>
            <div className="header-divider" />
            <HeaderIcon icon={theme === "dark" ? Sun : Moon} label={theme === "dark" ? t("light") : t("dark")} onClick={() => chooseTheme(theme === "dark" ? "light" : "dark")} />
            <div className="theme-wrap"><HeaderIcon icon={Palette} label={t("changeTheme")} onClick={() => setShowTheme(!showTheme)} />{showTheme && <div className="theme-popover"><b>{t("theme")}</b><div className="swatch-row">{[["cyan", "#4de0c4"], ["blue", "#7599ff"], ["violet", "#ac8aff"], ["rose", "#fa8da7"], ["amber", "#f0bf66"]].map(([key, color]) => <button key={key} className={accent === key ? "active" : ""} style={{ "--swatch": color } as React.CSSProperties} aria-label={key} onClick={() => { setAccent(key); setShowTheme(false); }} />)}</div></div>}</div>
            <div className="bell-wrap"><HeaderIcon icon={Bell} label={t("notifications")} onClick={() => { if (!notificationsOpen) void refreshNotifications(); setNotificationsOpen((open) => !open); }} />{unreadNotifications > 0 && <i />}{notificationsOpen && <NotificationPopover items={notifications} locale={locale} error={notificationError} onRead={(id) => { void markNotificationRead(id); }} onClose={() => setNotificationsOpen(false)} />}</div>
            <HeaderIcon icon={LogOut} label={say(locale, "退出登录", "Sign out")} onClick={onLogout} />
            <div className="avatar avatar-small avatar-lavender">{initials}</div>
          </div>
        </header>

        <section className="page-content">
          <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-dot" /> {admin ? t("management") : say(locale, "个人空间", "PERSONAL SPACE")}<span className="eyebrow-line" /></div><h1>{page === "overview" ? <>{t("hello")}, <span>{sessionUser.email.split("@")[0]}.</span></> : title}</h1><p>{page === "overview" ? t("dashboardSub") : <>{t("manageTitle")} <span className="heading-accent">{title.toLowerCase()}</span> {t("manageSuffix")}.</>}</p></div><div className="heading-actions">{admin && createKind && <button className="primary-button small" type="button" onClick={() => setEditor({ kind: createKind })}>{createLabel}</button>}<span className="safe-tag"><ShieldCheck size={14} /> {t("statusGood")}</span></div></div>

          {apiLoading && <div className="auth-message" role="status">{say(locale, "正在加载账户数据…", "Loading account data…")}</div>}
          {apiError && <div className="auth-message error" role="alert">{apiError}</div>}
          {editor && <AdminCreateForm kind={editor.kind} initial={editor.id ? editor.kind === "node" ? adminNodes.find((item) => item.id === editor.id) : editor.kind === "inbound" ? adminInbounds.find((item) => item.id === editor.id) : editor.kind === "plan" ? adminPlans.find((item) => item.id === editor.id) : adminUsers.find((item) => item.id === editor.id) : undefined} nodes={adminNodes.filter((node) => node.enabled)} plans={adminPlans} bindings={adminBindings} locale={locale} onCancel={() => setEditor(null)} onSubmit={(body) => saveAdminRecord(editor.kind, body, editor.id)} />}
          {syncDialog && <InboundSyncDialog t={t} locale={locale} nodes={adminNodes.filter((node) => node.enabled)} initialNodeId={syncDialog.nodeId} onClose={() => setSyncDialog(null)} onImported={(count) => { setRefreshToken((value) => value + 1); flash(phrase(locale, "已导入 {n} 个入站", "Imported {n} inbounds", { n: count })); }} />}
          {adjustUser && <BalanceAdjustDialog t={t} locale={locale} user={adjustUser} currency={adminPlans.find((plan) => plan.id === adjustUser.planId)?.currency ?? "USD"} onClose={() => setAdjustUser(null)} onSaved={(message) => { setAdjustUser(null); setRefreshToken((value) => value + 1); flash(message); }} />}
          {overview && !overview.capabilities.trafficMetering && <div className="auth-message" role="status">{say(locale, "当前存储模式不支持可靠流量计量或配额强制。", "Reliable traffic metering and quota enforcement are unavailable with this storage mode.")}</div>}
          {page === "overview" && (admin ? <AdminDashboard t={t} locale={locale} dashboard={adminDashboard} users={filteredUsers} inboundCount={adminInbounds.length} onNavigate={setPage} /> : overview ? <UserDashboard t={t} locale={locale} overview={overview} nodes={userDisplayNodes} recentOrders={orderDisplayRows} onNavigate={setPage} onCopy={copyLink} /> : null)}
          {page === "nodes" && <NodesPage t={t} locale={locale} rows={visibleNodes} admin={admin} onClearSearch={() => setSearch("")} onEdit={(id) => setEditor({ kind: "node", id })} onToggle={(id, enabled) => { void mutateAdmin(`/api/admin/nodes/${encodeURIComponent(id)}`, "PATCH", { enabled }); }} onTest={(id) => { void testAdminNode(id); }} />}
          {page === "users" && <UsersPage t={t} locale={locale} rows={filteredUsers} onEdit={(id) => setEditor({ kind: "user", id })} onAdjust={(id) => setAdjustUser(adminUsers.find((user) => user.id === id) ?? null)} onToggle={(id, enabled) => { void mutateAdmin(`/api/admin/users/${encodeURIComponent(id)}`, "PATCH", { enabled }); }} />}
          {page === "inbounds" && <InboundsPage t={t} locale={locale} rows={inboundRows} onSync={() => setSyncDialog({})} onEdit={(id) => setEditor({ kind: "inbound", id })} onToggle={(id, enabled) => { void mutateAdmin(`/api/admin/inbounds/${encodeURIComponent(id)}`, "PATCH", { enabled }); }} />}
          {page === "plans" && (admin ? <PlansAdmin t={t} locale={locale} plans={planRows} onEdit={(id) => setEditor({ kind: "plan", id })} onToggle={(id, enabled) => { void mutateAdmin(`/api/admin/plans/${encodeURIComponent(id)}`, "PATCH", { enabled }); }} /> : <PlansPage t={t} locale={locale} plans={userPlans} currentPlan={overview?.plan ?? null} onCheckout={startPlanCheckout} />)}
          {page === "orders" && <OrdersPage t={t} locale={locale} rows={orderDisplayRows} onDelete={(id) => { void mutateAdmin(`/api/admin/orders/${encodeURIComponent(id)}`, "DELETE"); }} onAction={(label) => flash(label)} />}
          {page === "subscription" && <SubscriptionPage t={t} locale={locale} subscription={subscription} onCopy={copyLink} />}
          {page === "account" && <AccountPage t={t} locale={locale} user={sessionUser} overview={overview} rows={orderDisplayRows} onNavigate={setPage} />}
          {page === "checkin" && <CheckinPage t={t} locale={locale} attendance={overview?.attendance ?? null} available={Boolean(overview?.capabilities.trafficMetering)} securityConfigAvailable={publicConfig !== null} turnstileRequired={Boolean(publicConfig?.checkinTurnstileEnabled)} turnstileSiteKey={publicConfig?.turnstileSiteKey ?? null} busy={checkinBusy} onCheckin={(token) => { void submitCheckin(token); }} />}
          {page === "system" && <SystemPage t={t} locale={locale} onSaved={async () => { setRefreshToken((value) => value + 1); await onSettingsSaved(); }} theme={theme} accent={accent} onTheme={chooseTheme} onAccent={setAccent} onLocale={changeLocale} onAction={(label) => flash(label)} />}
          <footer className="page-footer"><span>© 2025 3XUI Manager</span><span><i /> {t("apiStatus")} <b>·</b> {admin ? t("d1Mode") : t("planName")}</span></footer>
        </section>
      </main>
      {notice && <div className="toast"><span className="toast-check"><Check size={14} /></span>{notice}<button aria-label={say(locale, "关闭提示", "Dismiss")} onClick={() => setNotice("")}><X size={14} /></button></div>}
    </div>
  );
}

type TextFn = (key: MessageKey) => string;

/** Defaults for the complete 3X-UI inbound field set rendered by the admin form. */
const inboundDefaults: Record<string, string | boolean> = {  protocol: "vless", network: "tcp", port: "443", listen: "", minimumLevel: "0", multiplier: "1", security: "none",
  totalGb: "", expiryTime: "", trafficReset: "never", trafficResetDay: "0", tag: "", shareAddrStrategy: "node", shareAddr: "", subSortIndex: "1", excludeFromSub: false, disableFlow: false,
  clientFlow: "", vlessDecryption: "none", protocolFallbacks: "", protocolAccounts: "",
  ssMethod: "2022-blake3-aes-128-gcm", ssPassword: "", ssNetwork: "tcp,udp",
  dokodemoAddress: "", dokodemoPort: "0", dokodemoNetwork: "tcp", dokodemoFollowRedirect: false, dokodemoTimeout: "300",
  proxyAuth: "noauth", proxyUdp: false, proxyIp: "", httpAllowTransparent: false, httpUserLevel: "0",
  wireguardSecretKey: "", wireguardAddress: "", wireguardMtu: "1420", wireguardPeers: "", wireguardNoise: "", wireguardNoKernelTun: false,
  wsPath: "/", wsHost: "", wsHeaders: "", wsHeartbeatPeriod: "0", wsMaxEarlyData: "0", wsEarlyDataHeaderName: "", wsAcceptProxyProtocol: false,
  upgradePath: "/", upgradeHost: "", upgradeHeaders: "", upgradeAcceptProxyProtocol: false,
  h2Path: "/", h2Host: "", h2Method: "PUT", h2Headers: "", h2ReadIdleTimeout: "0", h2HealthCheckTimeout: "0",
  grpcService: "", grpcAuthority: "", grpcMultiMode: false, grpcIdleTimeout: "0", grpcHealthCheckTimeout: "0", grpcPermitWithoutStream: false, grpcInitialWindowsSize: "0",
  xhttpPath: "/", xhttpHost: "", xhttpMode: "auto", xhttpHeaders: "", xhttpXPaddingBytes: "", xhttpScMaxBufferedPosts: "0", xhttpScMaxEachPostBytes: "0", xhttpNoGRPCHeader: false,
  xhttpMaxConcurrency: "0", xhttpMaxConnections: "0", xhttpCMaxReuseTimes: "0", xhttpHMaxRequestTimes: "0", xhttpHKeepAlivePeriod: "0", xhttpMaxLifetime: "0",
  kcpMtu: "1350", kcpTti: "20", kcpUplinkCapacity: "5", kcpDownlinkCapacity: "20", kcpCwndMultiplier: "1", kcpMaxSendingWindow: "2097152", kcpCongestion: false, kcpReadBufferSize: "0", kcpWriteBufferSize: "0", kcpHeaderType: "none", kcpSeed: "",
  tcpHeader: "none", tcpAcceptProxyProtocol: false, tcpRequest: "", tcpResponse: "",
  hysteriaVersion: "2", hysteriaAuth: "", hysteriaUdpIdleTimeout: "60", hysteriaMasquerade: "",
  tlsSni: "", tlsAlpn: "h2,http/1.1", tlsCipherSuites: "", tlsMinVersion: "", tlsMaxVersion: "", tlsFingerprint: "", tlsCurves: "", tlsRejectUnknownSni: false, tlsDisableSystemRoot: false, tlsSessionResumption: "", tlsMasterKeyLog: "", tlsEchSockopt: "",
  tlsCertFile: "", tlsKeyFile: "", tlsCertPem: "", tlsKeyPem: "", tlsCertUsage: "", tlsCertOcspStapling: false, tlsCertOneTimeLoading: false, tlsCertBuildChain: false, tlsCertificates: "",
  realityDest: "", realitySni: "", realityPrivateKey: "", realityPublicKey: "", realityShortIds: "", realityFingerprint: "chrome", realitySpiderX: "/", realityShow: false, realityXver: "0",
  realityMinClientVer: "", realityMaxClientVer: "", realityMaxTimediff: "0", realityMldsa65Seed: "", realityMldsa65Verify: "",
  sockTcpFastOpen: false, sockTcpNoDelay: false, sockTcpMptcp: false, sockTcpCongestion: "", sockTcpKeepAliveIdle: "0", sockTcpKeepAliveInterval: "0", sockTcpUserTimeout: "0", sockTcpWindowClamp: "0", sockTcpMaxSeg: "0",
  sockTproxy: "off", sockDomainStrategy: "", sockDialerProxy: "", sockInterface: "", sockMark: "0", sockHappyEyeballsTryDelayMs: "0", sockHappyEyeballsPrioritizeIPv4: false, sockHappyEyeballsInterleave: false, sockHappyEyeballsMaxConcurrentTry: "0",
  sockCustomSockopt: "", tcpMasks: "", udpMasks: "",
  sniffEnabled: true, sniffDest: "http,tls,quic,fakedns", sniffMetadataOnly: false, sniffRouteOnly: false, sniffDomainsExcluded: "", sniffIpsExcluded: "",
  planEnabled: true, baseConfig: "{}",
};

const inboundProtocolLabels: Record<string, string> = { vless: "VLESS", vmess: "VMess", trojan: "Trojan", shadowsocks: "Shadowsocks", "dokodemo-door": "Dokodemo-door", http: "HTTP", socks: "SOCKS", mixed: "Mixed", wireguard: "WireGuard" };
const inboundNetworkLabels: Record<string, string> = { tcp: "TCP", raw: "Raw", ws: "WebSocket", http: "HTTP/2", httpupgrade: "HTTP Upgrade", grpc: "gRPC", xhttp: "XHTTP", kcp: "mKCP", hysteria: "Hysteria" };

function trafficResetLabel(value: string, text: (zh: string, en: string) => string): string {
  if (value === "hourly") return text("每小时", "Hourly");
  if (value === "daily") return text("每日", "Daily");
  if (value === "weekly") return text("每周", "Weekly");
  if (value === "monthly") return text("每月", "Monthly");
  return text("不重置", "Never");
}

/** JSON textareas of the inbound editor and the shape each one accepts. */
const inboundJsonFields: Array<[string, "object" | "array"]> = [
  ["protocolFallbacks", "array"], ["protocolAccounts", "array"], ["wireguardPeers", "array"], ["wireguardNoise", "object"],
  ["settingsExtra", "object"], ["tcpRequest", "object"], ["tcpResponse", "object"], ["wsHeaders", "object"], ["h2Headers", "object"],
  ["upgradeHeaders", "object"], ["xhttpHeaders", "object"], ["tlsEchSockopt", "object"], ["tlsCertificates", "array"],
  ["hysteriaMasquerade", "object"], ["sockCustomSockopt", "array"], ["tcpMasks", "array"], ["udpMasks", "array"], ["baseConfig", "object"],
];


function AdminCreateForm({ kind, initial, nodes, plans, bindings = [], locale, onCancel, onSubmit }: { kind: AdminCreateKind; initial?: ApiPlan | AdminNodeRecord | AdminInboundRecord | AdminUserRecord; nodes: AdminNodeRecord[]; plans: ApiPlan[]; bindings?: AdminInboundBinding[]; locale: Locale; onCancel: () => void; onSubmit: (body: Record<string, unknown>) => Promise<void> }) {
  const [fields, setFields] = useState<Record<string, string | boolean>>(() => {
    const defaults: Record<string, string | boolean> = {
      email: "", userPassword: "", planId: "", name: "", description: "", level: "1", trafficGb: "10",
      validityDays: "30", priceMinor: "1000", currency: "USD", resetUnit: "month", resetInterval: "1",
      resetAtHour: "0", resetWeekday: "1", resetMonthDay: "1", allowPaidUpgrade: false, region: "",
      panelUrl: "", publicAddress: "", username: "", password: "", apiToken: "", basePath: "/",
      ...inboundDefaults, role: "user", enabled: true, planExpiresAt: "",
    };
    if (!initial) return defaults;
    if (kind === "plan") {
      const plan = initial as ApiPlan;
      return { ...defaults, name: plan.name, description: plan.description, level: String(plan.level), trafficGb: String(plan.trafficBytes / 1_000_000_000), validityDays: String(plan.validityDays), priceMinor: String(plan.priceMinor), currency: plan.currency, resetUnit: plan.resetUnit, resetInterval: String(plan.resetInterval), resetAtHour: String(plan.resetAtHour), resetWeekday: String(plan.resetWeekday), resetMonthDay: String(plan.resetMonthDay), allowPaidUpgrade: plan.allowPaidUpgrade, enabled: plan.enabled };
    }
    if (kind === "node") {
      const node = initial as AdminNodeRecord;
      return { ...defaults, name: node.name, region: node.region, panelUrl: node.panelUrl, publicAddress: node.publicAddress, username: node.username, basePath: node.basePath, enabled: node.enabled };
    }
    if (kind === "inbound") return { ...defaults, ...inboundFieldValues(initial as AdminInboundRecord) };
    const user = initial as AdminUserRecord;
    const expiration = user.planExpiresAt ? new Date(user.planExpiresAt) : null;
    const localExpiration = expiration && !Number.isNaN(expiration.getTime()) ? new Date(expiration.getTime() - expiration.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
    return { ...defaults, email: user.email, role: user.role, enabled: user.enabled, planExpiresAt: localExpiration };
  });
  const [nodeIds, setNodeIds] = useState<string[]>(() => initial && kind === "inbound" ? bindings.filter((binding) => binding.inboundId === initial.id).map((binding) => binding.nodeId) : kind === "inbound" && nodes.length ? [nodes[0].id] : []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState("basic");
  const text = (zh: string, en: string) => say(locale, zh, en);
  const inboundTabs: Array<[string, string]> = [
    ["basic", text("基本设置", "Basics")],
    ["protocol", text("协议设置", "Protocol")],
    ["transport", text("传输设置", "Transport")],
    ["security", text("传输安全", "Security")],
    ["sniffing", text("流量嗅探", "Sniffing")],
    ["advanced", text("高级设置", "Advanced")],
  ];
  const planEditingDefault = kind === "plan" && initial ? (initial as ApiPlan).isDefault : false;
  const title = initial ? kind === "node" ? text("编辑节点", "Edit node") : kind === "inbound" ? text("编辑入站", "Edit inbound") : kind === "plan" ? text("编辑套餐", "Edit plan") : text("编辑用户", "Edit user") : kind === "node" ? text("添加 3X-UI 节点", "Add 3X-UI node") : kind === "inbound" ? text("添加入站", "Add inbound") : kind === "plan" ? text("添加套餐", "Add plan") : text("添加用户", "Add user");
  const field = (name: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => <label><span>{label}</span><input {...props} value={String(fields[name] ?? "")} onChange={(event) => setFields((current) => ({ ...current, [name]: event.target.value }))} /></label>;
  const wideField = (name: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => <label className="admin-form-wide"><span>{label}</span><input {...props} value={String(fields[name] ?? "")} onChange={(event) => setFields((current) => ({ ...current, [name]: event.target.value }))} /></label>;
  const checkField = (name: string, label: string) => <label className="admin-form-check"><input type="checkbox" checked={fields[name] === true} onChange={(event) => setFields((current) => ({ ...current, [name]: event.target.checked }))} /><span>{label}</span></label>;
  const selectField = (name: string, label: string, options: Array<[string, string]>) => <label><span>{label}</span><select value={String(fields[name] ?? "")} onChange={(event) => setFields((current) => ({ ...current, [name]: event.target.value }))}>{options.map(([value, optionLabel]) => <option key={value || "-"} value={value}>{optionLabel}</option>)}</select></label>;
  const withDefault = (options: Array<[string, string]>): Array<[string, string]> => [["", text("默认", "Default")], ...options];
  const toggleListField = (name: string, value: string) => (event: React.ChangeEvent<HTMLInputElement>) => setFields((current) => {
    const list = String(current[name] ?? "").split(",").filter(Boolean);
    const next = event.target.checked ? [...new Set([...list, value])] : list.filter((item) => item !== value);
    return { ...current, [name]: next.join(",") };
  });
  const areaField = (name: string, label: string, props: React.TextareaHTMLAttributes<HTMLTextAreaElement> = {}) => <label className="admin-form-wide"><span>{label}</span><textarea rows={3} {...props} value={String(fields[name] ?? "")} onChange={(event) => setFields((current) => ({ ...current, [name]: event.target.value }))} /></label>;
  const checkListField = (name: string, values: readonly string[], label: string) => <fieldset className="admin-node-options"><legend>{label}</legend>{values.map((value) => <label key={value}><input type="checkbox" checked={String(fields[name] ?? "").split(",").includes(value)} onChange={toggleListField(name, value)} /><span>{value.toUpperCase()}</span></label>)}</fieldset>;
  const formSection = (title: string, body: React.ReactNode) => <section className="admin-form-block"><h3>{title}</h3><div className="admin-form-grid two-col">{body}</div></section>;
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      let body: Record<string, unknown>;
      if (kind === "plan") {
        const trafficBytes = Number(fields.trafficGb) * 1_000_000_000;
        if (!Number.isSafeInteger(trafficBytes)) throw new Error(text("流量必须是可表示的安全整数 GB。", "Traffic must resolve to a safe whole-byte value."));
        body = { name: String(fields.name).trim(), description: fields.description, level: Number(fields.level), trafficBytes, validityDays: Number(fields.validityDays), priceMinor: Number(fields.priceMinor), currency: String(fields.currency).toUpperCase(), resetUnit: fields.resetUnit, resetInterval: Number(fields.resetInterval), resetAtHour: Number(fields.resetAtHour), resetWeekday: Number(fields.resetWeekday), resetMonthDay: Number(fields.resetMonthDay), allowPaidUpgrade: fields.allowPaidUpgrade === true, enabled: fields.enabled === true };
      } else if (kind === "node") {
        if (!initial && !String(fields.password) && !String(fields.apiToken)) throw new Error(text("请填写面板密码或 API Token。", "Provide a panel password or API token."));
        body = { name: String(fields.name).trim(), region: fields.region, panelUrl: String(fields.panelUrl).trim(), publicAddress: fields.publicAddress, username: fields.username, basePath: fields.basePath, enabled: fields.enabled === true, ...(fields.password ? { password: fields.password } : {}), ...(fields.apiToken ? { apiToken: fields.apiToken } : {}) };
      } else if (kind === "inbound") {
        const jsonFieldTab = (name: string) => ["settingsExtra", "protocolFallbacks", "protocolAccounts", "wireguardPeers", "wireguardNoise"].includes(name) ? "protocol" : ["tcpRequest", "tcpResponse", "wsHeaders", "h2Headers", "upgradeHeaders", "xhttpHeaders", "hysteriaMasquerade"].includes(name) ? "transport" : ["tlsCertificates", "tlsEchSockopt"].includes(name) ? "security" : "advanced";
        if (!initial && !nodeIds.length) { setActiveTab("basic"); throw new Error(text("至少选择一个已启用节点。", "Select at least one enabled node.")); }
        const port = Number(fields.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) { setActiveTab("basic"); throw new Error(text("端口必须在 1-65535 之间。", "Port must be between 1 and 65535.")); }
        if (fields.security === "reality" && (!String(fields.realityDest).trim() || !String(fields.realityPrivateKey).trim())) {
          setActiveTab("security");
          throw new Error(text("REALITY 需要填写目标地址与私钥。", "REALITY needs a destination and a private key."));
        }
        for (const [name, kind] of inboundJsonFields) {
          const source = String(fields[name] ?? "").trim();
          if (!source) continue;
          try {
            const parsed: unknown = JSON.parse(source);
            if (kind === "array" ? !Array.isArray(parsed) : (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) throw new Error("shape");
          } catch {
            setActiveTab(jsonFieldTab(name));
            throw new Error(`${text("以下字段必须是合法 JSON：", "This field must contain valid JSON: ")}${name}`);
          }
        }
        body = { name: String(fields.name).trim(), protocol: fields.protocol, network: fields.network, port, minimumLevel: Number(fields.minimumLevel), multiplier: Number(fields.multiplier), planEnabled: fields.planEnabled === true, enabled: fields.enabled === true, ...buildInboundMeta(fields), config: buildInboundConfig(fields), ...(!initial ? { nodeIds } : {}) };
      } else if (initial) {
        body = { role: fields.role, enabled: fields.enabled === true, planExpiresAt: fields.planExpiresAt ? new Date(String(fields.planExpiresAt)).toISOString() : null };
      } else {
        const email = String(fields.email).trim();
        const userPassword = String(fields.userPassword);
        if (!email) throw new Error(text("请填写邮箱。", "Enter an email address."));
        if (userPassword.length < 12) throw new Error(text("密码至少需要 12 位。", "Password must contain at least 12 characters."));
        body = { email, password: userPassword, role: fields.role, enabled: fields.enabled === true, ...(fields.planId ? { planId: fields.planId } : {}) };
      }
      await onSubmit(body);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("提交失败。", "Unable to create this item."));
      setBusy(false);
    }
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}><section className={`panel admin-create-panel${kind === "inbound" ? "" : " is-compact"}`} role="dialog" aria-modal="true" aria-labelledby="admin-create-title"><form className="admin-create-form" onSubmit={(event) => { void submit(event); }}><div className="admin-create-heading"><div><div className="section-kicker">{text("管理操作", "ADMIN ACTION")}</div><h2 id="admin-create-title">{title}</h2></div><button className="quiet-icon" type="button" aria-label={text("关闭", "Close")} onClick={onCancel}><X size={17} /></button></div><div className={kind === "inbound" ? "admin-form-grid" : "admin-form-stack"}>
    {kind === "plan" && <>
      {formSection(text("基本信息", "Basics"), <>
        {field("name", text("套餐名称", "Plan name"), { required: true, maxLength: 80 })}
        {field("level", text("等级", "Level"), { type: "number", min: 0, step: 1, required: true, disabled: planEditingDefault })}
        {wideField("description", text("描述", "Description"), { maxLength: 500 })}
      </>)}
      {formSection(text("流量与价格", "Traffic and price"), <>
        {field("trafficGb", text("流量（十进制 GB）", "Traffic (decimal GB)"), { type: "number", min: 0, step: 0.001, required: true })}
        {field("validityDays", text("有效天数（0 表示不限期）", "Validity days (0 = no expiry)"), { type: "number", min: 0, step: 1, required: true })}
        {field("priceMinor", text("价格（最小货币单位）", "Price (minor currency units)"), { type: "number", min: 0, step: 1, required: true, disabled: planEditingDefault })}
        {field("currency", text("币种", "Currency"), { required: true, minLength: 3, maxLength: 3 })}
      </>)}
      {formSection(text("重置与选项", "Reset and options"), <>
        <label><span>{text("重置周期", "Reset cycle")}</span><select value={String(fields.resetUnit)} onChange={(event) => setFields((current) => ({ ...current, resetUnit: event.target.value }))}><option value="none">{say(locale, "不限", "None")}</option><option value="day">{say(locale, "每日", "Daily")}</option><option value="week">{say(locale, "每周", "Weekly")}</option><option value="month">{say(locale, "每月", "Monthly")}</option><option value="year">{say(locale, "每年", "Yearly")}</option></select></label>
        {checkField("allowPaidUpgrade", text("允许付费升级", "Allow paid upgrades"))}
        {checkField("enabled", text("启用套餐", "Plan enabled"))}
      </>)}
      {planEditingDefault && <div className="admin-form-note">{text("默认免费套餐固定等级 0、价格 0，可调整流量与有效期；改动只对之后创建的账户生效，已有账户保留各自额度。", "The default free plan keeps level 0 and price 0. Traffic and validity apply to accounts created afterwards; existing accounts keep their own quota.")}</div>}
    </>}
    {kind === "node" && <>
      {formSection(text("节点信息", "Node details"), <>
        {field("name", text("节点名称", "Node name"), { required: true, maxLength: 80 })}
        {field("region", text("区域", "Region"), { maxLength: 80 })}
        {wideField("publicAddress", text("公开地址", "Public address"), { maxLength: 255 })}
      </>)}
      {formSection(text("面板连接", "Panel connection"), <>
        {wideField("panelUrl", text("3X-UI 面板 HTTPS URL", "3X-UI panel HTTPS URL"), { type: "url", required: true, placeholder: "https://panel.example.com:54321" })}
        {field("basePath", text("面板基础路径", "Panel base path"), { required: true })}
        {field("username", text("面板用户名", "Panel username"))}
      </>)}
      {formSection(text("面板认证", "Panel credentials"), <>
        {field("password", text(initial ? "更换面板密码（留空不变）" : "面板密码", initial ? "Change panel password (blank to keep)" : "Panel password"), { type: "password", autoComplete: "new-password" })}
        {field("apiToken", text(initial ? "更换 API Token（留空不变）" : "API Token", initial ? "Change API token (blank to keep)" : "API token"), { type: "password", autoComplete: "new-password" })}
        <div className="admin-form-wide admin-form-note">{text("面板密码或 API Token 任选其一，两者都填时以 Token 为优先；面板开启两步验证时仅接受 Token。", "Use the panel password or an API token; the token wins when both are set. Panels with two-factor authentication only accept a token.")}</div>
      </>)}
      <div className="admin-form-inline">{checkField("enabled", text("启用节点", "Node enabled"))}</div>
    </>}
        {kind === "inbound" && <>
      <div className="admin-form-tabs" role="tablist" aria-label={text("入站设置", "Inbound settings")}>{inboundTabs.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={activeTab === key} className={activeTab === key ? "active" : ""} onClick={() => setActiveTab(key)}>{label}</button>)}</div>
      <div className="admin-form-tabpanel" role="tabpanel">
      {activeTab === "basic" && <>
        {formSection(text("基础", "Basics"), <>
          {field("name", text("入站名称", "Inbound name"), { required: true, maxLength: 100 })}
          {field("port", text("端口", "Port"), { type: "number", min: 1, max: 65535, step: 1, required: true })}
          {selectField("protocol", text("协议", "Protocol"), inboundProtocols.map((value): [string, string] => [value, inboundProtocolLabels[value] ?? value]))}
          {selectField("network", text("传输方式", "Transport"), inboundNetworks.map((value): [string, string] => [value, inboundNetworkLabels[value] ?? value]))}
          {selectField("security", text("传输安全", "Transport security"), [["none", text("无", "None")], ["tls", "TLS"], ["reality", "REALITY"]])}
          {field("listen", text("监听地址（留空为全部）", "Listen address (blank = all)"))}
        </>)}
        {formSection(text("流量与到期", "Traffic and expiry"), <>
          {field("totalGb", text("总流量（十进制 GB，0 为不限）", "Total traffic (decimal GB, 0 = unlimited)"), { type: "number", min: 0, step: 0.001 })}
          {field("expiryTime", text("到期时间（留空为永不）", "Expiry time (blank = never)"), { type: "datetime-local" })}
          {selectField("trafficReset", text("流量重置周期", "Traffic reset"), trafficResetUnits.map((value): [string, string] => [value, trafficResetLabel(value, text)]))}
          {(fields.trafficReset === "monthly" || fields.trafficReset === "weekly") && field("trafficResetDay", text("重置日（1-31）", "Reset day (1-31)"), { type: "number", min: 0, max: 31, step: 1 })}
        </>)}
        {formSection(text("订阅与分享", "Subscription and sharing"), <>
          {field("tag", text("标签", "Tag"), { maxLength: 64 })}
          {field("subSortIndex", text("订阅排序", "Subscription sort index"), { type: "number", min: 0, max: 9999, step: 1 })}
          {selectField("shareAddrStrategy", text("分享地址策略", "Share address strategy"), [["node", text("使用节点地址", "Use the node address")], ["listen", text("使用监听地址", "Use the listen address")], ["custom", text("自定义地址", "Custom address")]])}
          {fields.shareAddrStrategy === "custom" && field("shareAddr", text("自定义分享地址", "Custom share address"), { maxLength: 255 })}
          {checkField("excludeFromSub", text("从订阅中排除", "Exclude from subscription"))}
          {checkField("disableFlow", text("禁用客户端 Flow", "Disable client flow"))}
        </>)}
        {formSection(text("权限与同步", "Access and sync"), <>
          {field("minimumLevel", text("最低套餐等级", "Minimum plan level"), { type: "number", min: 0, step: 1, required: true })}
          {field("multiplier", text("流量倍率", "Traffic multiplier"), { type: "number", min: 0, max: 100, step: 0.1, required: true })}
          {checkField("planEnabled", text("对套餐启用（为符合条件的用户创建客户端）", "Provision for plans (create clients for eligible users)"))}
          {checkField("enabled", text("启用入站", "Inbound enabled"))}
          {!initial && <fieldset className="admin-node-options"><legend>{text("绑定节点", "Bind nodes")}</legend>{nodes.length ? nodes.map((node) => <label key={node.id}><input type="checkbox" checked={nodeIds.includes(node.id)} onChange={(event) => setNodeIds((current) => event.target.checked ? [...current, node.id] : current.filter((id) => id !== node.id))} /><span>{node.name} · {node.region || node.publicAddress}</span></label>) : <small>{text("请先添加并启用节点。", "Add and enable a node first.")}</small>}</fieldset>}
        </>)}
      </>}

      {activeTab === "protocol" && <>
        {formSection(text("协议参数", "Protocol options"), <>
          {fields.protocol === "vmess" && <div className="admin-form-wide admin-form-note">{text("VMess 客户端由面板与套餐同步管理，这里只调整入站结构。", "VMess clients are managed by the panel and plan sync; this section only shapes the inbound.")}</div>}
          {fields.protocol === "vless" && <>{selectField("clientFlow", text("客户端 Flow 默认值", "Default client flow"), [["", text("无", "None")], ["xtls-rprx-vision", "xtls-rprx-vision"], ["xtls-rprx-vision-udp443", "xtls-rprx-vision-udp443"]])}{field("vlessDecryption", text("VLESS 解密方式", "VLESS decryption"), { placeholder: "none" })}</>}
          {fields.protocol === "shadowsocks" && <>{selectField("ssMethod", text("加密方式", "Cipher"), [["2022-blake3-aes-128-gcm", "2022-blake3-aes-128-gcm"], ["2022-blake3-aes-256-gcm", "2022-blake3-aes-256-gcm"], ["2022-blake3-chacha20-poly1305", "2022-blake3-chacha20-poly1305"], ["aes-128-gcm", "aes-128-gcm"], ["aes-256-gcm", "aes-256-gcm"], ["chacha20-poly1305", "chacha20-poly1305"], ["xchacha20-poly1305", "xchacha20-poly1305"], ["none", text("无", "None")]])}{field("ssPassword", text("入站密码", "Inbound password"))}{field("ssNetwork", text("网络（tcp,udp）", "Network (tcp,udp)"))}</>}
          {fields.protocol === "dokodemo-door" && <>{field("dokodemoAddress", text("目标地址", "Destination address"), { placeholder: "1.1.1.1" })}{field("dokodemoPort", text("目标端口", "Destination port"), { type: "number", min: 0, max: 65535, step: 1 })}{selectField("dokodemoNetwork", text("网络", "Network"), [["tcp", "TCP"], ["udp", "UDP"], ["tcp,udp", "TCP+UDP"]])}{checkField("dokodemoFollowRedirect", text("跟随原始目标地址", "Follow redirect"))}{field("dokodemoTimeout", text("超时（秒）", "Timeout (seconds)"), { type: "number", min: 0, step: 1 })}</>}
          {(fields.protocol === "http" || fields.protocol === "socks" || fields.protocol === "mixed") && <>{selectField("proxyAuth", text("认证方式", "Authentication"), [["noauth", text("无认证", "No auth")], ["password", text("用户名密码", "Username and password")]])}{areaField("protocolAccounts", text("账户（JSON 数组）", "Accounts (JSON array)"), { placeholder: '[{"user":"name","pass":"secret"}]' })}{fields.protocol !== "http" && checkField("proxyUdp", text("允许 UDP", "Allow UDP"))}{fields.protocol === "http" ? <>{checkField("httpAllowTransparent", text("允许透明代理", "Allow transparent proxy"))}{field("httpUserLevel", text("用户等级", "User level"), { type: "number", min: 0, step: 1 })}</> : field("proxyIp", text("本地 IP", "Local IP"), { placeholder: "127.0.0.1" })}</>}
          {fields.protocol === "wireguard" && <>{field("wireguardSecretKey", text("WireGuard 私钥", "WireGuard secret key"))}{field("wireguardAddress", text("WireGuard 地址（CIDR，逗号分隔）", "WireGuard address (CIDR, comma separated)"))}{field("wireguardMtu", "MTU", { type: "number", min: 0, max: 65535, step: 1 })}{checkField("wireguardNoKernelTun", text("禁用内核 TUN", "Disable kernel TUN"))}{areaField("wireguardPeers", text("对端（JSON 数组）", "Peers (JSON array)"), { placeholder: '[{"publicKey":"…","allowedIPs":["0.0.0.0/0"]}]' })}{areaField("wireguardNoise", text("Noise 配置（JSON）", "Noise settings (JSON)"))}</>}
        </>)}
        {formSection(text("回落与额外配置", "Fallbacks and extras"), <>
          {(fields.protocol === "vless" || fields.protocol === "trojan") && areaField("protocolFallbacks", text("回落配置（JSON 数组）", "Fallbacks (JSON array)"), { placeholder: '[{"dest":80}]' })}
          {areaField("settingsExtra", text("额外 settings（JSON，合并覆盖）", "Extra settings (JSON, merged last)"))}
        </>)}
      </>}

      {activeTab === "transport" && <div className="admin-form-block"><h3>{text("传输参数", "Transport options")}</h3><div className="admin-form-grid two-col">
        {(fields.network === "tcp" || fields.network === "raw") && <>{selectField("tcpHeader", text("TCP 伪装类型", "TCP header type"), [["none", text("无", "None")], ["http", "HTTP"]])}{checkField("tcpAcceptProxyProtocol", text("接受 PROXY protocol", "Accept PROXY protocol"))}{fields.tcpHeader === "http" && <>{areaField("tcpRequest", text("HTTP 请求头（JSON）", "HTTP request (JSON)"))}{areaField("tcpResponse", text("HTTP 响应头（JSON）", "HTTP response (JSON)"))}</>}</>}
        {fields.network === "ws" && <>{field("wsPath", text("路径", "Path"))}{field("wsHost", text("Host（可选）", "Host (optional)"))}{field("wsHeartbeatPeriod", "heartbeatPeriod", { type: "number", min: 0, step: 1 })}{field("wsMaxEarlyData", "maxEarlyData", { type: "number", min: 0, step: 1 })}{field("wsEarlyDataHeaderName", "earlyDataHeaderName")}{checkField("wsAcceptProxyProtocol", text("接受 PROXY protocol", "Accept PROXY protocol"))}{areaField("wsHeaders", text("额外请求头（JSON）", "Extra headers (JSON)"))}</>}
        {fields.network === "http" && <>{field("h2Path", text("路径", "Path"))}{field("h2Host", text("Hosts（逗号分隔）", "Hosts (comma separated)"))}{selectField("h2Method", text("HTTP 方法", "HTTP method"), [["PUT", "PUT"], ["GET", "GET"]])}{field("h2ReadIdleTimeout", "readIdleTimeout", { type: "number", min: 0, step: 1 })}{field("h2HealthCheckTimeout", "healthCheckTimeout", { type: "number", min: 0, step: 1 })}{areaField("h2Headers", text("请求头（JSON）", "Headers (JSON)"))}</>}
        {fields.network === "httpupgrade" && <>{field("upgradePath", text("路径", "Path"))}{field("upgradeHost", text("Host（可选）", "Host (optional)"))}{checkField("upgradeAcceptProxyProtocol", text("接受 PROXY protocol", "Accept PROXY protocol"))}{areaField("upgradeHeaders", text("额外请求头（JSON）", "Extra headers (JSON)"))}</>}
        {fields.network === "grpc" && <>{field("grpcService", text("gRPC 服务名", "gRPC service name"))}{field("grpcAuthority", text("gRPC authority", "gRPC authority"))}{field("grpcIdleTimeout", "idle_timeout", { type: "number", min: 0, step: 1 })}{field("grpcHealthCheckTimeout", "health_check_timeout", { type: "number", min: 0, step: 1 })}{field("grpcInitialWindowsSize", "initial_windows_size", { type: "number", min: 0, step: 1 })}{checkField("grpcMultiMode", text("多路复用模式", "Multi mode"))}{checkField("grpcPermitWithoutStream", "permit_without_stream")}</>}
        {fields.network === "xhttp" && <>{field("xhttpPath", text("路径", "Path"))}{field("xhttpHost", text("Host（可选）", "Host (optional)"))}{selectField("xhttpMode", text("XHTTP 模式", "XHTTP mode"), xhttpModes.map((value): [string, string] => [value, value]))}{field("xhttpXPaddingBytes", "xPaddingBytes", { placeholder: "100-1000" })}{field("xhttpScMaxBufferedPosts", "scMaxBufferedPosts", { type: "number", min: 0, step: 1 })}{field("xhttpScMaxEachPostBytes", "scMaxEachPostBytes", { type: "number", min: 0, step: 1 })}{field("xhttpMaxConcurrency", "xmux.maxConcurrency", { type: "number", min: 0, step: 1 })}{field("xhttpMaxConnections", "xmux.maxConnections", { type: "number", min: 0, step: 1 })}{field("xhttpCMaxReuseTimes", "xmux.cMaxReuseTimes", { type: "number", min: 0, step: 1 })}{field("xhttpHMaxRequestTimes", "xmux.hMaxRequestTimes", { type: "number", min: 0, step: 1 })}{field("xhttpHKeepAlivePeriod", "xmux.hKeepAlivePeriod", { type: "number", min: 0, step: 1 })}{field("xhttpMaxLifetime", "xmux.maxLifetime", { type: "number", min: 0, step: 1 })}{checkField("xhttpNoGRPCHeader", "noGRPCHeader")}{areaField("xhttpHeaders", text("请求头（JSON）", "Headers (JSON)"))}</>}
        {fields.network === "kcp" && <>{field("kcpMtu", "mtu", { type: "number", min: 576, max: 1460, step: 1 })}{field("kcpTti", "tti", { type: "number", min: 10, max: 100, step: 1 })}{field("kcpUplinkCapacity", "uplinkCapacity", { type: "number", min: 0, step: 1 })}{field("kcpDownlinkCapacity", "downlinkCapacity", { type: "number", min: 0, step: 1 })}{field("kcpCwndMultiplier", "cwndMultiplier", { type: "number", min: 0, step: 0.1 })}{field("kcpMaxSendingWindow", "maxSendingWindow", { type: "number", min: 0, step: 1 })}{field("kcpReadBufferSize", "readBufferSize", { type: "number", min: 0, step: 1 })}{field("kcpWriteBufferSize", "writeBufferSize", { type: "number", min: 0, step: 1 })}{selectField("kcpHeaderType", text("伪装类型", "Header type"), kcpHeaderTypes.map((value): [string, string] => [value, value]))}{field("kcpSeed", text("种子（可选）", "Seed (optional)"))}{checkField("kcpCongestion", text("启用拥塞控制", "Enable congestion control"))}</>}
        {fields.network === "hysteria" && <>{field("hysteriaVersion", text("Hysteria 版本", "Hysteria version"), { type: "number", min: 1, max: 2, step: 1 })}{field("hysteriaAuth", text("认证字符串", "Auth string"))}{field("hysteriaUdpIdleTimeout", "udpIdleTimeout", { type: "number", min: 0, step: 1 })}{areaField("hysteriaMasquerade", text("伪装站点（JSON）", "Masquerade (JSON)"))}</>}
      </div></div>}

      {activeTab === "security" && <>
        {fields.security === "none" && <div className="admin-form-block"><div className="admin-form-note">{text("当前不启用传输加密，TLS 与 REALITY 参数会被忽略。", "No transport encryption is enabled; TLS and REALITY settings are ignored.")}</div></div>}
        {fields.security === "tls" && <>
          {formSection(text("TLS 基础", "TLS basics"), <>
            {field("tlsSni", text("TLS 服务器名（SNI）", "TLS server name (SNI)"))}
            {field("tlsAlpn", text("ALPN（逗号分隔）", "ALPN (comma separated)"))}
            {field("tlsCipherSuites", text("密码套件（逗号分隔）", "Cipher suites (comma separated)"))}
            {field("tlsCurves", text("曲线（逗号分隔）", "Curves (comma separated)"))}
            {selectField("tlsMinVersion", text("最低 TLS 版本", "Minimum TLS version"), withDefault(tlsVersions.map((value): [string, string] => [value, value])))}
            {selectField("tlsMaxVersion", text("最高 TLS 版本", "Maximum TLS version"), withDefault(tlsVersions.map((value): [string, string] => [value, value])))}
            {field("tlsFingerprint", text("uTLS 指纹", "uTLS fingerprint"), { placeholder: "chrome" })}
            {field("tlsSessionResumption", text("会话恢复密钥", "Session resumption key"))}
            {field("tlsMasterKeyLog", text("主密钥日志路径", "Master key log"))}
            {checkField("tlsRejectUnknownSni", text("拒绝未知 SNI", "Reject unknown SNI"))}
            {checkField("tlsDisableSystemRoot", text("禁用系统根证书", "Disable system root"))}
          </>)}
          {formSection(text("证书", "Certificates"), <>
            {field("tlsCertFile", text("证书文件路径", "Certificate file path"))}
            {field("tlsKeyFile", text("私钥文件路径", "Private key file path"))}
            {selectField("tlsCertUsage", text("证书用途", "Certificate usage"), withDefault(certificateUsages.map((value): [string, string] => [value, value])))}
            {areaField("tlsCertPem", text("证书内容（PEM，可选）", "Certificate PEM (optional)"))}
            {areaField("tlsKeyPem", text("私钥内容（PEM，可选）", "Private key PEM (optional)"))}
            {checkField("tlsCertOcspStapling", text("启用 OCSP 装订", "OCSP stapling"))}
            {checkField("tlsCertOneTimeLoading", text("仅加载一次", "One-time loading"))}
            {checkField("tlsCertBuildChain", text("构建证书链", "Build chain"))}
            {areaField("tlsCertificates", text("多证书（JSON 数组，优先使用）", "Additional certificates (JSON array, takes precedence)"))}
          </>)}
          {formSection(text("高级", "Advanced"), <>
            {areaField("tlsEchSockopt", text("ECH sockopt（JSON）", "ECH sockopt (JSON)"))}
          </>)}
        </>}
        {fields.security === "reality" && formSection("REALITY", <>
          {field("realityDest", text("REALITY 目标地址", "REALITY destination"), { placeholder: "www.example.com:443" })}
          {field("realitySni", text("REALITY 服务器名（逗号分隔）", "REALITY server names (comma separated)"))}
          {field("realityPrivateKey", text("REALITY 私钥", "REALITY private key"))}
          {field("realityPublicKey", text("REALITY 公钥", "REALITY public key"))}
          {field("realityShortIds", text("Short ID（逗号分隔）", "Short IDs (comma separated)"))}
          {selectField("realityFingerprint", text("uTLS 指纹", "uTLS fingerprint"), [["chrome", "Chrome"], ["firefox", "Firefox"], ["safari", "Safari"], ["ios", "iOS"], ["android", "Android"], ["edge", "Edge"], ["random", "Random"]])}
          {field("realitySpiderX", text("SpiderX 路径", "SpiderX path"))}
          {field("realityXver", text("Xver 版本", "Xver"), { type: "number", min: 0, max: 2, step: 1 })}
          {field("realityMinClientVer", text("最低客户端版本", "Minimum client version"))}
          {field("realityMaxClientVer", text("最高客户端版本", "Maximum client version"))}
          {field("realityMaxTimediff", text("最大时间差（毫秒）", "Maximum time difference (ms)"), { type: "number", min: 0, step: 1 })}
          {field("realityMldsa65Seed", text("ML-DSA-65 种子", "ML-DSA-65 seed"))}
          {field("realityMldsa65Verify", text("ML-DSA-65 校验", "ML-DSA-65 verify"))}
          {checkField("realityShow", text("在日志中显示调试信息", "Show debug output"))}
        </>)}
      </>}

      {activeTab === "sniffing" && formSection(text("嗅探参数", "Sniffing options"), <>
        {checkField("sniffEnabled", text("启用流量嗅探", "Enable sniffing"))}
        {checkField("sniffMetadataOnly", text("仅元数据", "Metadata only"))}
        {checkField("sniffRouteOnly", text("仅用于路由", "Route only"))}
        {checkListField("sniffDest", inboundSniffTargets, text("嗅探目标", "Sniffing targets"))}
        {field("sniffDomainsExcluded", text("排除域名（逗号分隔）", "Excluded domains (comma separated)"))}
        {field("sniffIpsExcluded", text("排除 IP（逗号分隔）", "Excluded IPs (comma separated)"))}
      </>)}

      {activeTab === "advanced" && <>
        {formSection(text("Socket 参数", "Socket options"), <>
          {selectField("sockTcpCongestion", "tcpcongestion", [["", text("默认", "Default")], ["bbr", "bbr"], ["cubic", "cubic"], ["reno", "reno"]])}
          {selectField("sockTproxy", text("透明代理模式", "Transparent proxy mode"), [["off", text("关闭", "Off")], ["redirect", "redirect"], ["tproxy", "tproxy"]])}
          {selectField("sockDomainStrategy", text("域名解析策略", "Domain strategy"), withDefault(domainStrategies.map((value): [string, string] => [value, value])))}
          {field("sockDialerProxy", "dialerProxy")}
          {field("sockInterface", text("网卡名称", "Network interface"))}
          {field("sockMark", "mark", { type: "number", min: 0, step: 1 })}
          {field("sockTcpKeepAliveIdle", "tcpKeepAliveIdle", { type: "number", min: 0, step: 1 })}
          {field("sockTcpKeepAliveInterval", "tcpKeepAliveInterval", { type: "number", min: 0, step: 1 })}
          {field("sockTcpUserTimeout", "tcpUserTimeout", { type: "number", min: 0, step: 1 })}
          {field("sockTcpWindowClamp", "tcpWindowClamp", { type: "number", min: 0, step: 1 })}
          {field("sockTcpMaxSeg", "tcpMaxSeg", { type: "number", min: 0, step: 1 })}
          {field("sockHappyEyeballsTryDelayMs", "happyEyeballs.tryDelayMs", { type: "number", min: 0, step: 1 })}
          {field("sockHappyEyeballsMaxConcurrentTry", "happyEyeballs.maxConcurrentTry", { type: "number", min: 0, step: 1 })}
          {checkField("sockTcpFastOpen", "tcpFastOpen")}
          {checkField("sockTcpNoDelay", "tcpNoDelay")}
          {checkField("sockTcpMptcp", "tcpMptcp")}
          {checkField("sockHappyEyeballsPrioritizeIPv4", "happyEyeballs.prioritizeIPv4")}
          {checkField("sockHappyEyeballsInterleave", "happyEyeballs.interleave")}
          {areaField("sockCustomSockopt", text("自定义 sockopt（JSON 数组）", "Custom sockopt (JSON array)"))}
        </>)}
        {formSection(text("最终掩码", "Final masks"), <>
          {areaField("tcpMasks", text("TCP 最终掩码（JSON 数组）", "TCP masks (JSON array)"))}
          {areaField("udpMasks", text("UDP 最终掩码（JSON 数组）", "UDP masks (JSON array)"))}
        </>)}
        {formSection(text("原始配置", "Raw config"), <>
          {areaField("baseConfig", text("原始配置（JSON，未托管键会保留）", "Raw config (JSON, unmanaged keys are kept)"), { rows: 6 })}
        </>)}
      </>}
      </div>
    </>}
    {kind === "user" && (initial ? <>
      {formSection(text("账户信息", "Account"), <>
        <label><span>{text("邮箱", "Email")}</span><input value={String(fields.email)} readOnly /></label>
        <label><span>{text("账户角色", "Account role")}</span><select value={String(fields.role)} onChange={(event) => setFields((current) => ({ ...current, role: event.target.value }))}><option value="user">{say(locale, "用户", "User")}</option><option value="admin">{say(locale, "管理员", "Admin")}</option></select></label>
        {wideField("planExpiresAt", text("套餐到期时间（留空表示不限期）", "Plan expiration (blank = no expiry)"), { type: "datetime-local" })}
      </>)}
      <div className="admin-form-inline">{checkField("enabled", text("启用账户", "Account enabled"))}</div>
    </> : <>
      {formSection(text("账户信息", "Account"), <>
        {field("email", text("邮箱", "Email"), { type: "email", required: true, maxLength: 254, autoComplete: "off" })}
        {field("userPassword", text("初始密码（至少 12 位）", "Initial password (12+ characters)"), { type: "password", required: true, minLength: 12, maxLength: 256, autoComplete: "new-password" })}
      </>)}
      {formSection(text("角色与套餐", "Role and plan"), <>
        <label><span>{text("账户角色", "Account role")}</span><select value={String(fields.role)} onChange={(event) => setFields((current) => ({ ...current, role: event.target.value }))}><option value="user">{say(locale, "用户", "User")}</option><option value="admin">{say(locale, "管理员", "Admin")}</option></select></label>
        <label><span>{text("套餐", "Plan")}</span><select value={String(fields.planId)} onChange={(event) => setFields((current) => ({ ...current, planId: event.target.value }))}><option value="">{text("默认免费套餐", "Default free plan")}</option>{plans.filter((plan) => plan.enabled).map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></label>
      </>)}
      <div className="admin-form-inline">{checkField("enabled", text("启用账户", "Account enabled"))}</div>
      <div className="admin-form-note">{text("管理员创建的账号会直接标记为邮箱已验证，可立即登录。", "Accounts created by an administrator are marked as email-verified and can sign in immediately.")}</div>
    </>)}
  </div>{error && <div className="auth-message error" role="alert">{error}</div>}<div className="admin-form-actions"><button className="outline-button" type="button" onClick={onCancel}>{text("取消", "Cancel")}</button><button className="primary-button" type="submit" disabled={busy}>{busy ? text("正在保存…", "Saving…") : initial ? text("保存", "Save") : text("创建", "Create")}</button></div></form></section></div>;
}

type BalanceAdjustAction = "credit" | "refund";

/** Credits or deducts an account balance by writing a manual order plus an idempotent ledger entry. */
function BalanceAdjustDialog({ t, locale, user, currency, onClose, onSaved }: { t: TextFn; locale: Locale; user: AdminUserRecord; currency: string; onClose: () => void; onSaved: (message: string) => void }) {
  const [action, setAction] = useState<BalanceAdjustAction>("credit");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const text = (zh: string, en: string) => say(locale, zh, en);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    const amountMinor = parseMoneyInput(amount, currency);
    if (amountMinor === null || amountMinor <= 0) { setError(text("请输入有效金额。", "Enter a valid amount.")); return; }
    if (amountMinor > 100_000_000) { setError(text("单次调整金额过大。", "This amount is too large for a single adjustment.")); return; }
    if (action === "refund" && amountMinor > user.balanceMinor) { setError(text("退款金额不能超过当前余额。", "The refund cannot exceed the current balance.")); return; }
    setBusy(true);
    try {
      await apiRequest(`/api/admin/users/${encodeURIComponent(user.id)}/balance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, amountMinor, currency, note }),
      });
      const formatted = formatMoney(amountMinor, currency, locale);
      onSaved(action === "credit"
        ? phrase(locale, "已为账户充值 {amount}。", "Credited {amount} to this account.", { amount: formatted })
        : phrase(locale, "已从账户余额扣回 {amount}。", "Deducted {amount} from this account.", { amount: formatted }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("调整失败。", "The adjustment failed."));
      setBusy(false);
    }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="panel admin-create-panel" role="dialog" aria-modal="true" aria-labelledby="balance-adjust-title"><form className="admin-create-form" onSubmit={(event) => { void submit(event); }}><div className="admin-create-heading"><div><div className="section-kicker">{text("管理操作", "ADMIN ACTION")}</div><h2 id="balance-adjust-title">{text("余额调整", "Balance adjustment")}</h2></div><button className="quiet-icon" type="button" aria-label={text("关闭", "Close")} onClick={onClose}><X size={17} /></button></div><div className="admin-form-grid">
    <label><span>{text("账户", "Account")}</span><input value={user.email} readOnly /></label>
    <label><span>{text("当前余额", "Current balance")}</span><input value={formatMoney(user.balanceMinor, currency, locale)} readOnly /></label>
    <label><span>{text("操作", "Action")}</span><select value={action} onChange={(event) => { setError(""); setAction(event.target.value === "refund" ? "refund" : "credit"); }}><option value="credit">{text("充值", "Credit")}</option><option value="refund">{text("退款", "Refund")}</option></select></label>
    <label><span>{phrase(locale, "金额（{currency}）", "Amount ({currency})", { currency })}</span><input inputMode="decimal" value={amount} placeholder="0.00" onChange={(event) => { setError(""); setAmount(event.target.value); }} autoFocus /></label>
    <label className="admin-form-wide"><span>{text("备注（可选）", "Note (optional)")}</span><input value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} /></label>
    <div className="admin-form-wide admin-form-note">{text("人工调整会生成一笔来源为 manual 的订单：充值记为已支付、退款记为已退款，并写入对应余额流水。", "Manual adjustments create a provider=manual order: credits are marked paid, refunds are marked refunded, and each writes a balance ledger entry.")}</div>
  </div>{error && <div className="auth-message error" role="alert">{error}</div>}<div className="admin-form-actions"><button className="outline-button" type="button" onClick={onClose}>{t("cancel")}</button><button className="primary-button" type="submit" disabled={busy}>{busy ? text("正在保存…", "Saving…") : text("确认调整", "Apply adjustment")}</button></div></form></section></div>;
}

type RemoteInboundRow = { panelInboundId: number; name: string; protocol: string; port: number; network: string; security: string; enabled: boolean; imported: boolean };

/** Imports inbounds that already live on a 3X-UI node; they stay unbound from every plan. */
function InboundSyncDialog({ t, locale, nodes, initialNodeId, onClose, onImported }: { t: TextFn; locale: Locale; nodes: AdminNodeRecord[]; initialNodeId?: string; onClose: () => void; onImported: (count: number) => void }) {
  const [nodeId, setNodeId] = useState(() => initialNodeId ?? nodes[0]?.id ?? "");
  const [items, setItems] = useState<RemoteInboundRow[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const text = (zh: string, en: string) => say(locale, zh, en);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!nodeId) return;
    let cancelled = false;
    setScanning(true);
    setError("");
    apiRequest<{ items: RemoteInboundRow[] }>(`/api/admin/inbounds/remote?nodeId=${encodeURIComponent(nodeId)}`)
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setSelected(result.items.filter((item) => !item.imported).map((item) => item.panelInboundId));
      })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : text("无法读取面板入站。", "Unable to read panel inbounds.")); })
      .finally(() => { if (!cancelled) setScanning(false); });
    return () => { cancelled = true; };
  }, [nodeId]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!nodeId || !selected.length) return;
    setBusy(true);
    setError("");
    try {
      const result = await apiRequest<{ imported: number }>("/api/admin/inbounds/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId, panelInboundIds: selected }),
      });
      onImported(result.imported);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("导入失败。", "Import failed."));
      setBusy(false);
    }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="panel admin-create-panel" role="dialog" aria-modal="true" aria-labelledby="inbound-sync-title"><form className="admin-create-form" onSubmit={(event) => { void submit(event); }}><div className="admin-create-heading"><div><div className="section-kicker">{text("管理操作", "ADMIN ACTION")}</div><h2 id="inbound-sync-title">{text("从节点同步入站", "Sync inbounds from node")}</h2></div><button className="quiet-icon" type="button" aria-label={text("关闭", "Close")} onClick={onClose}><X size={17} /></button></div>{nodes.length ? <><div className="admin-form-grid"><label><span>{text("节点", "Node")}</span><select value={nodeId} onChange={(event) => setNodeId(event.target.value)}>{nodes.map((node) => <option key={node.id} value={node.id}>{node.name} · {node.region || node.publicAddress}</option>)}</select></label></div><div className="inbound-sync-list">{scanning ? <div className="empty-state"><Network size={22} /><b>{text("正在读取面板入站…", "Reading panel inbounds…")}</b></div> : items.length ? items.map((item) => <label className={`inbound-sync-row ${item.imported ? "imported" : ""}`} key={item.panelInboundId}><input type="checkbox" disabled={item.imported} checked={selected.includes(item.panelInboundId)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.panelInboundId] : current.filter((id) => id !== item.panelInboundId))} /><span className="inbound-sync-main"><b>{item.name}</b><small>{item.protocol.toUpperCase()} · {item.network.toUpperCase()} · {item.port}</small></span><span className={`status-chip ${item.enabled ? "" : "pending"}`}><i />{item.enabled ? text("已启用", "Enabled") : text("已停用", "Disabled")}</span>{item.imported && <span className="role-chip">{text("已导入", "Imported")}</span>}</label>) : <div className="empty-state"><Network size={22} /><b>{text("该节点没有可同步的入站。", "This node has no inbounds to sync.")}</b></div>}</div><div className="admin-form-note">{text("导入的入站只会绑定到所选节点，且不会对任何套餐启用；之后可在编辑里手动开启。", "Imported inbounds bind to the selected node only and stay disabled for plans; enable them later from the editor.")}</div></> : <div className="admin-form-note">{text("请先添加并启用节点。", "Add and enable a node first.")}</div>}{error && <div className="auth-message error" role="alert">{error}</div>}<div className="admin-form-actions"><button className="outline-button" type="button" onClick={onClose}>{t("cancel")}</button><button className="primary-button" type="submit" disabled={busy || !selected.length}>{busy ? text("正在导入…", "Importing…") : phrase(locale, "导入 {n} 项", "Import {n}", { n: selected.length })}</button></div></form></section></div>;
}

function UserDashboard({ t, locale, overview, nodes, recentOrders, onNavigate, onCopy }: { t: TextFn; locale: Locale; overview: UserOverviewData | null; nodes: DisplayNode[]; recentOrders: DisplayOrderRow[]; onNavigate: (page: PageKey) => void; onCopy: () => void }) {
  const usageChartData = (overview?.usage.days ?? []).map((day) => ({ day: day.usageDay.slice(5), used: day.billedBytes / 1_000_000_000 }));
  const usagePercent = overview && overview.usage.limitBytes > 0 ? Math.min(100, overview.usage.usedBytes / overview.usage.limitBytes * 100) : 0;
  const attendanceMessage = !overview?.capabilities.trafficMetering
    ? say(locale, "当前存储模式不支持签到。", "Check-in is unavailable with this storage mode.")
    : overview.attendance.checkedInToday
      ? pick(locale, {
        zh: `今日已签到 · 连续 ${overview.attendance.streak} 天`,
        en: `Checked in today · ${overview.attendance.streak} day streak`,
        "zh-TW": `今日已簽到 · 連續 ${overview.attendance.streak} 天`,
        ja: `本日チェックイン済み · 連続${overview.attendance.streak}日`,
        ko: `오늘 체크인 완료 · ${overview.attendance.streak}일 연속`,
        de: `Heute eingecheckt · ${overview.attendance.streak} Tage Serie`,
        es: `Registrado hoy · racha de ${overview.attendance.streak} días`,
        pt: `Check-in feito hoje · sequência de ${overview.attendance.streak} dias`,
        it: `Check-in effettuato oggi · serie di ${overview.attendance.streak} giorni`,
        ar: `تم تسجيل الحضور اليوم · ${overview.attendance.streak} يوم متتابع`,
        ru: `Отмечено сегодня · серия ${overview.attendance.streak} дн.`,
        fr: `Pointé aujourd'hui · série de ${overview.attendance.streak} jours`,
      })
      : pick(locale, {
        zh: `今日待签到 · 奖励 ${attendanceRewardLabel(overview.attendance)}`,
        en: `Check in today · ${attendanceRewardLabel(overview.attendance)} reward`,
        "zh-TW": `今日待簽到 · 獎勵 ${attendanceRewardLabel(overview.attendance)}`,
        ja: `本日は未チェックイン · 特典 ${attendanceRewardLabel(overview.attendance)}`,
        ko: `오늘 체크인 필요 · 보상 ${attendanceRewardLabel(overview.attendance)}`,
        de: `Heute einchecken · Belohnung ${attendanceRewardLabel(overview.attendance)}`,
        es: `Regístrate hoy · recompensa de ${attendanceRewardLabel(overview.attendance)}`,
        pt: `Faça check-in hoje · recompensa de ${attendanceRewardLabel(overview.attendance)}`,
        it: `Fai check-in oggi · premio ${attendanceRewardLabel(overview.attendance)}`,
        ar: `سجل الحضور اليوم · مكافأة ${attendanceRewardLabel(overview.attendance)}`,
        ru: `Отметьтесь сегодня · награда ${attendanceRewardLabel(overview.attendance)}`,
        fr: `Pointez aujourd'hui · récompense ${attendanceRewardLabel(overview.attendance)}`,
      });
  const hero = heroTitle(locale, "user");
  return <>
    <div className="welcome-banner"><div className="banner-glow glow-one" /><div className="banner-glow glow-two" /><div className="banner-copy"><div className="banner-label"><Sparkles size={14} /> {say(locale, "你的网络已就绪", "YOUR NETWORK IS IN ORBIT")}</div><h2>{hero.lead}<em>{hero.accent}</em></h2><p>{say(locale, "安全、快速又稳定的连接，想去哪就去哪。", "A secure, fast and steady connection for wherever you’re headed.")}</p><button className="banner-button" onClick={() => onNavigate("subscription")}>{t("subscription")} <ArrowRight size={15} /></button></div><div className="orbit-art" aria-hidden="true"><div className="orbit orbit-a" /><div className="orbit orbit-b" /><div className="orbit orbit-c" /><div className="planet"><span /><i /><b /></div><div className="orbit-star star-a">✦</div><div className="orbit-star star-b">✧</div><div className="orbit-dot dot-a" /><div className="orbit-dot dot-b" /></div><div className="banner-foot"><span><span className="live-indicator" />{say(locale, "节点状态", "NODE STATUS")}</span><span><b>{nodes.filter((node) => node.state === "online").length} / {nodes.length}</b></span></div></div>

    <div className="stats-grid">
      <StatCard icon={Gauge} label={t("remaining")} value={formatBytes(overview?.usage.remainingBytes ?? 0)} hint={t("available")} tone="mint" meter={100 - usagePercent} moreLabel={t("more")} />
      <StatCard icon={Wallet} label={t("balance")} value={formatMoney(overview?.balanceMinor ?? 0, overview?.plan?.currency ?? "USD", locale)} hint={t("balance")} tone="violet" moreLabel={t("more")} />
      <StatCard icon={CreditCard} label={t("planStatus")} value={overview?.plan?.name ?? t("noData")} hint={overview?.subscriptionActive ? t("active") : t("expired")} tone="blue" badge={overview ? phrase(locale, "等级 {n}", "LEVEL {n}", { n: String(overview.user.planLevel).padStart(2, "0") }) : undefined} moreLabel={t("more")} />
      <StatCard icon={Wifi} label={t("activeNodes")} value={String(overview?.nodes.length ?? 0).padStart(2, "0")} hint={`${nodes.filter((node) => node.state === "online").length} ${t("online")}`} tone="amber" moreLabel={t("more")} />
    </div>

    <div className="content-grid usage-grid">
      <section className="panel usage-panel"><div className="panel-heading"><div><div className="section-kicker">{say(locale, "流量分析", "TRAFFIC ANALYTICS")}</div><h3>{t("usageTitle")}</h3><p>{formatBytes(overview?.usage.usedBytes ?? 0)} {t("traffic")}</p></div><span className="count-chip">{t("last30")}</span></div><div className="chart-summary"><div><strong>{formatBytes(overview?.usage.usedBytes ?? 0)}</strong><small>{say(locale, "当前周期累计", "Current cycle total")}</small></div><div className="chart-legend"><span><i className="legend-primary" /> {t("traffic")}</span></div></div><div className="area-chart">{overview?.capabilities.trafficMetering && usageChartData.length > 0 ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={usageChartData} margin={{ top: 8, right: 0, left: -20, bottom: 0 }}><defs><linearGradient id="usageFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity={0.22} /><stop offset="95%" stopColor="var(--accent)" stopOpacity={0} /></linearGradient></defs><CartesianGrid stroke="var(--chart-grid)" vertical={false} /><XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: "var(--text-faint)", fontSize: 11 }} dy={12} /><YAxis axisLine={false} tickLine={false} tick={{ fill: "var(--text-faint)", fontSize: 11 }} tickFormatter={(value: number) => `${value} GB`} /><Tooltip contentStyle={{ background: "var(--tooltip-bg)", border: "1px solid var(--border)", borderRadius: 12, color: "var(--text-primary)", fontSize: 12 }} /><Area type="monotone" dataKey="used" name={t("traffic")} stroke="var(--accent)" strokeWidth={2.5} fill="url(#usageFill)" activeDot={{ r: 5, strokeWidth: 3, stroke: "var(--surface)" }} /></AreaChart></ResponsiveContainer> : <div className="empty-state"><Activity size={24} /><b>{overview?.capabilities.trafficMetering ? say(locale, "暂无流量样本", "No traffic samples recorded yet.") : say(locale, "流量计量不可用", "Traffic metering is unavailable.")}</b></div>}</div></section>
      <section className="panel plan-panel"><div className="panel-heading"><div><div className="section-kicker">{say(locale, "会员方案", "MEMBERSHIP")}</div><h3>{t("planStatus")}</h3></div><button className="quiet-icon" aria-label={t("more")}><MoreHorizontal size={18} /></button></div><div className="member-card"><div className="member-card-top"><div className="plan-emblem"><Sparkles size={19} /></div><span className="plan-state"><i /> {overview?.subscriptionActive ? t("active") : t("expired")}</span></div><h4>{overview?.plan?.name ?? t("planName")}</h4><p>{overview?.plan?.description ?? t("planDescription")}</p><div className="member-dates"><div><small>{say(locale, "续费日期", "RENEWS ON")}</small><b>{overview?.user.planExpiresAt ? formatDate(overview.user.planExpiresAt, locale) : "—"}</b></div><span className="date-divider" /><div><small>{say(locale, "访问等级", "ACCESS LEVEL")}</small><b>{overview ? phrase(locale, "等级 {n}", "Level {n}", { n: overview.user.planLevel }) : "—"}</b></div></div><div className="plan-progress-label"><span>{t("includedTraffic")}</span><span>{formatBytes(overview?.usage.usedBytes ?? 0)} <i>/</i> {formatBytes(overview?.usage.limitBytes ?? 0)}</span></div><div className="plan-progress"><span style={{ width: `${usagePercent}%` }} /></div><button className="plan-link" onClick={() => { void onCopy(); }}><ArrowRight size={14} />{t("copyLink")}<span>↗</span></button></div><button className="upgrade-row" onClick={() => onNavigate("plans")}><span><Sparkles size={15} /> {t("upgrade")}</span><ArrowRight size={15} /></button></section>
    </div>

    <div className="content-grid lower-grid"><section className="panel nodes-panel"><div className="panel-heading"><div><div className="section-kicker">{say(locale, "网络地图", "NETWORK MAP")}</div><h3>{t("liveNodes")}</h3><p>{pick(locale, {
  zh: `${nodes.length} 个接入点可用`,
  en: `${nodes.length} access points available`,
  "zh-TW": `${nodes.length} 個接入點可用`,
  ja: `${nodes.length} 個の接続ポイントが利用可能`,
  ko: `사용 가능한 접속 지점 ${nodes.length}개`,
  de: `${nodes.length} Zugangspunkte verfügbar`,
  es: `${nodes.length} puntos de acceso disponibles`,
  pt: `${nodes.length} pontos de acesso disponíveis`,
  it: `${nodes.length} punti di accesso disponibili`,
  ar: `${nodes.length} نقاط وصول متاحة`,
  ru: `Доступно точек доступа: ${nodes.length}`,
  fr: `${nodes.length} points d'accès disponibles`,
})}</p></div><button className="text-link" onClick={() => onNavigate("nodes")}>{t("allNodes")} <ArrowRight size={14} /></button></div><div className="node-list">{nodes.slice(0, 3).map((node) => <NodeRow key={node.name} node={node} t={t} locale={locale} />)}</div><div className="node-panel-footer"><span><i /> {nodes.filter((node) => node.state === "online").length} / {nodes.length} {t("online")}</span><button onClick={() => onNavigate("nodes")}>{t("allNodes")} <ArrowRight size={13} /></button></div></section><section className="panel activity-panel"><div className="panel-heading"><div><div className="section-kicker">{say(locale, "你的空间", "YOUR SPACE")}</div><h3>{t("recent")}</h3></div><button className="quiet-icon" aria-label={t("more")}><MoreHorizontal size={18} /></button></div><div className="activity-list">{recentOrders.length ? recentOrders.slice(0, 3).map((order) => <div className="activity-item" key={order.id}><div className="activity-icon blue"><CreditCard size={14} /></div><div className="activity-copy"><b>{order.plan}</b><small>{order.method} · {order.amount}</small></div><time>{orderStatusLabel(order.state, t, locale)}</time></div>) : <div className="empty-state"><CreditCard size={24} /><b>{t("noResults")}</b></div>}</div><div className="activity-bottom"><span>{attendanceMessage}</span><button className="outline-button small" type="button" onClick={() => onNavigate("checkin")}>{t("checkin")}</button></div></section></div>
  </>;
}

function StatCard({ icon: Icon, label, value, unit, hint, tone, meter, badge, trend, moreLabel }: { icon: LucideIcon; label: string; value: string; unit?: string; hint: string; tone: string; meter?: number; badge?: string; trend?: string; moreLabel: string }) {
  return <article className="stat-card"><div className="stat-top"><span className={`stat-icon ${tone}`}><Icon size={17} strokeWidth={1.8} /></span>{badge ? <span className="stat-badge">{badge}</span> : <button className="quiet-icon tiny" aria-label={moreLabel}><MoreHorizontal size={17} /></button>}</div><span className="stat-label">{label}</span><div className="stat-value">{value}{unit && <span>{unit}</span>}</div><div className="stat-foot">{meter !== undefined ? <><div className="mini-meter"><span style={{ width: `${meter}%` }} /></div><span className="stat-hint">{hint}</span></> : <><span className={`hint-dot ${tone}`} />{trend === "up" && <span className="trend-up"><ArrowUpRight size={12} /></span>}<span className="stat-hint">{hint}</span></>}</div></article>;
}

function NodeRow({ node, t, locale }: { node: DisplayNode; t: TextFn; locale: Locale }) {
  return <div className="node-row"><span className={`node-flag ${node.color}`}>{node.flag}</span><div className="node-name"><b>{node.name}</b><small><span className="node-health-dot" /> {node.state === "online" ? t("online") : node.state === "offline" ? t("offline") : "—"} {node.load !== null && <><span className="node-row-sep">·</span> {say(locale, "负载", "Load")} {node.load}%</>}</small></div><span className="node-multiplier"><Zap size={11} /> {node.multiplier}</span><div className="node-latency"><b>{node.latency}</b><small>{t("latency")}</small></div><button className="node-chevron" aria-label={t("details")}><ChevronRight size={16} /></button></div>;
}

function AdminDashboard({ t, locale, dashboard, users, inboundCount, onNavigate }: { t: TextFn; locale: Locale; dashboard: AdminDashboardData | null; users: AdminUserRow[]; inboundCount: number; onNavigate: (page: PageKey) => void }) {
  const hero = heroTitle(locale, "admin");
  return <>
    <div className="admin-banner"><div className="admin-banner-copy"><div className="banner-label"><ShieldCheck size={14} /> {say(locale, "系统总览", "SYSTEM OVERVIEW")}</div><h2>{hero.lead}<em>{hero.accent}</em></h2><p>{say(locale, "平台运行稳定，所有接入点均已同步。", "Your platform is healthy, and every access point is in sync.")}</p></div><div className="admin-orbit"><div /><span><Network size={28} /></span></div><div className="admin-banner-foot"><span><i /> {t("statusGood")}</span><span>{t("trafficSync")}</span></div></div>
    <div className="stats-grid admin-stats"><StatCard icon={Users} label={t("userCount")} value={String(dashboard?.users ?? 0)} hint={`${dashboard?.activeUsers ?? 0} ${t("active")}`} tone="mint" moreLabel={t("more")} /><StatCard icon={CreditCard} label={t("activeSubs")} value={String(dashboard?.activeSubscriptions ?? 0)} hint={`${dashboard?.pendingOrders ?? 0} ${t("pending")}`} tone="blue" moreLabel={t("more")} /><StatCard icon={Wallet} label={t("monthRevenue")} value={formatMoney(dashboard?.revenueMinor ?? 0, dashboard?.currency ?? "USD", locale)} hint={say(locale, "本月已支付订单", "Paid orders this month")} tone="violet" moreLabel={t("more")} /><StatCard icon={Activity} label={t("nodeHealth")} value={`${dashboard?.nodesOnline ?? 0} / ${dashboard?.nodesTotal ?? 0}`} hint={t("online")} tone="amber" moreLabel={t("more")} /></div>
    <div className="content-grid admin-chart-grid"><section className="panel usage-panel"><div className="panel-heading"><div><div className="section-kicker">{say(locale, "平台分析", "PLATFORM ANALYTICS")}</div><h3>{say(locale, "平台增长", "Platform growth")}</h3><p>{say(locale, "过去 30 天的订单与注册表现", "Orders and sign-ups over the past 30 days")}</p></div><div className="segmented"><button>{say(locale, "7 天", "7 days")}</button><button className="active">{t("last30")}</button><button><SlidersHorizontal size={13} /></button></div></div><div className="chart-summary"><div><strong>{formatMoney(dashboard?.revenueMinor ?? 0, dashboard?.currency ?? "USD", locale)}</strong><small>{say(locale, "本月已支付订单", "Paid orders this month")}</small></div><div className="chart-legend"><span><i className="legend-primary" /> {t("monthRevenue")}</span><span><i className="legend-muted" /> {t("userCount")}</span></div></div><div className="area-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={[]} margin={{ top: 8, right: 0, left: -20, bottom: 0 }}><defs><linearGradient id="adminFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity={0.22} /><stop offset="95%" stopColor="var(--accent)" stopOpacity={0} /></linearGradient></defs><CartesianGrid stroke="var(--chart-grid)" vertical={false} /><XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: "var(--text-faint)", fontSize: 11 }} dy={12} /><YAxis axisLine={false} tickLine={false} tick={{ fill: "var(--text-faint)", fontSize: 11 }} /><Tooltip contentStyle={{ background: "var(--tooltip-bg)", border: "1px solid var(--border)", borderRadius: 12, color: "var(--text-primary)", fontSize: 12 }} /><Area type="monotone" dataKey="used" stroke="var(--accent)" strokeWidth={2.5} fill="url(#adminFill)" /></AreaChart></ResponsiveContainer></div></section><section className="panel system-panel"><div className="panel-heading"><div><div className="section-kicker">{say(locale, "基础设施", "INFRASTRUCTURE")}</div><h3>{say(locale, "实时状态", "Live status")}</h3></div><span className="plan-state"><i /> {say(locale, "一切正常", "ALL CLEAR")}</span></div><div className="system-hero"><div className="system-ring"><div><strong>98</strong><small>%</small></div></div><div><b>{t("nodeHealth")}</b><small>{phrase(locale, "{a}/{b} 接入点", "{a} of {b} access points", { a: dashboard?.nodesOnline ?? 0, b: dashboard?.nodesTotal ?? 0 })}</small></div></div><div className="system-metrics"><div><span>{t("storageMode")}</span><b><i className="metric-dot violet-dot" />{say(locale, "D1 · 已连接", "D1 · connected")}</b></div><div><span>{t("realtimeSync")}</span><b><i className="metric-dot mint-dot" />{phrase(locale, "{n} 秒前", "{n} sec ago", { n: 9 })}</b></div><div><span>{t("trafficSync")}</span><b><i className="metric-dot blue-dot" />{say(locale, "按计划执行", "On schedule")}</b></div></div><button className="system-link" onClick={() => onNavigate("system")}>{t("settingsTitle")} <ArrowRight size={14} /></button></section></div>
    <div className="content-grid admin-lower"><section className="panel users-panel"><div className="panel-heading"><div><div className="section-kicker">{say(locale, "成员", "MEMBERS")}</div><h3>{t("users")}</h3></div><button className="text-link" onClick={() => onNavigate("users")}>{t("allNodes")} <ArrowRight size={14} /></button></div><div className="table-wrap"><table><thead><tr><th>{t("customer")}</th><th>{t("plan")}</th><th>{t("usage")}</th><th>{t("status")}</th><th /></tr></thead><tbody>{users.slice(0, 3).map((user) => <tr key={user.id}><td><div className="table-person"><span className={`avatar avatar-${user.color}`}>{user.initials}</span><span><b>{user.name}</b><small>{user.email}</small></span></div></td><td>{user.plan}</td><td><span className="usage-number">{user.usage}</span></td><td><span className={`status-chip ${user.state === "active" ? "" : "pending"}`}><i />{user.state === "active" ? t("active") : user.state === "expired" ? t("expired") : t("disabled")}</span></td><td><button className="quiet-icon tiny"><MoreHorizontal size={17} /></button></td></tr>)}</tbody></table></div></section><section className="panel quick-panel"><div className="panel-heading"><div><div className="section-kicker">{say(locale, "快捷入口", "SHORTCUTS")}</div><h3>{t("quickActions")}</h3></div></div><div className="quick-actions"><button onClick={() => onNavigate("users")}><span className="quick-icon mint"><Users size={17} /></span><span><b>{t("users")}</b><small>{dashboard?.users ?? 0} {say(locale, "个账号", "accounts")}</small></span><ArrowRight size={15} /></button><button onClick={() => onNavigate("inbounds")}><span className="quick-icon blue"><Globe2 size={17} /></span><span><b>{t("inbounds")}</b><small>{inboundCount} {say(locale, "个已配置", "configured")}</small></span><ArrowRight size={15} /></button><button onClick={() => onNavigate("orders")}><span className="quick-icon violet"><CreditCard size={17} /></span><span><b>{t("orders")}</b><small>{dashboard?.pendingOrders ?? 0} {t("pending")}</small></span><ArrowRight size={15} /></button></div></section></div>
  </>;
}

function PageToolbar({ t, count, action }: { t: TextFn; count: string; action?: React.ReactNode }) {
  return <div className="table-toolbar"><div className="toolbar-left"><span className="count-chip">{count}</span></div><div className="toolbar-right">{action}<span className="filter-button"><SlidersHorizontal size={14} />{t("filtering")}</span></div></div>;
}

function NodesPage({ t, locale, rows, admin, onClearSearch, onEdit, onToggle, onTest }: { t: TextFn; locale: Locale; rows: DisplayNode[]; admin: boolean; onClearSearch: () => void; onEdit: (nodeId: string) => void; onToggle: (nodeId: string, enabled: boolean) => void; onTest: (nodeId: string) => void }) {
  const regionLabel = say(locale, "区域", "Region");
  const inboundLabel = say(locale, "入站", "Inbounds");
  const checkedLabel = say(locale, "最后检查", "Last checked");
  const headers = admin
    ? [t("nodes"), regionLabel, inboundLabel, checkedLabel, t("status"), ""]
    : [t("nodes"), regionLabel, t("multiplier"), t("status")];
  return <div className="panel data-panel">
    <PageToolbar t={t} count={phrase(locale, "{n} 个节点", "{n} nodes", { n: rows.length })} />
    <div className="table-wrap full-table node-table">
      <table>
        <thead><tr>{headers.map((header, index) => <th key={`${header}-${index}`}>{header}</th>)}</tr></thead>
        <tbody>
          {rows.length ? rows.map((node) => <tr key={node.name}>
            <td className="cell-title"><div className="table-person"><span className={`node-flag ${node.color}`}>{node.flag}</span><span><b>{node.name}</b><small>{node.address ?? "—"}</small></span></div></td>
            <td data-label={regionLabel}>{node.region || "—"}</td>
            {admin
              ? <><td data-label={inboundLabel}>{node.inbounds ?? "—"}</td><td data-label={checkedLabel}>{node.checkedAt ?? "—"}</td></>
              : <td data-label={t("multiplier")}><span className="multiplier-chip"><Zap size={11} />{node.multiplier}</span></td>}
            <td data-label={t("status")}><span className={`status-chip ${node.state === "offline" ? "pending" : ""}`}><i />{node.state === "online" ? t("online") : node.state === "offline" ? t("offline") : "—"}</span></td>
            {admin && <td className="cell-actions" data-label="">
              <div className="row-actions">{node.id ? <>
                <button className="quiet-icon" title={say(locale, "连通性测试", "Test connection")} aria-label={say(locale, "连通性测试", "Test connection")} onClick={() => onTest(node.id!)}><Activity size={15} /></button>
                <button className="quiet-icon" title={t("edit")} aria-label={t("edit")} onClick={() => onEdit(node.id!)}><Pencil size={14} /></button>
                <button className={`quiet-icon ${node.enabled ? "" : "danger"}`} title={node.enabled ? say(locale, "停用", "Disable") : say(locale, "启用", "Enable")} aria-label={node.enabled ? say(locale, "停用", "Disable") : say(locale, "启用", "Enable")} onClick={() => onToggle(node.id!, !node.enabled)}><Power size={15} /></button>
              </> : null}</div>
            </td>}
          </tr>) : <tr><td colSpan={headers.length}><div className="empty-state"><Network size={24} /><b>{t("noResults")}</b><button className="text-link" onClick={onClearSearch}>{t("clearSearch")}</button></div></td></tr>}
        </tbody>
      </table>
    </div>
    <div className="node-list-foot"><span><i /> {t("statusGood")}</span><span>{t("refreshSoon")}</span></div>
  </div>;
}
function UsersPage({ t, locale, rows, onEdit, onAdjust, onToggle }: { t: TextFn; locale: Locale; rows: AdminUserRow[]; onEdit: (userId: string) => void; onAdjust: (userId: string) => void; onToggle: (userId: string, enabled: boolean) => void }) {
  return <div className="panel data-panel">
    <PageToolbar t={t} count={phrase(locale, "{n} 个用户", "{n} users", { n: rows.length })} />
    <div className="table-wrap full-table">
      <table>
        <thead><tr><th className="bulk-col"><input type="checkbox" aria-label={say(locale, "全选", "Select all")} /></th><th>{t("customer")}</th><th>{t("role")}</th><th>{t("plan")}</th><th>{t("usage")}</th><th>{t("created")}</th><th>{t("status")}</th><th /></tr></thead>
        <tbody>
          {rows.map((user) => <tr key={user.id}>
            <td className="bulk-col" data-label=""><input type="checkbox" aria-label={phrase(locale, "选择 {n}", "Select {n}", { n: user.name })} /></td>
            <td className="cell-title"><div className="table-person"><span className={`avatar avatar-${user.color}`}>{user.initials}</span><span><b>{user.name}</b><small>{user.email}</small></span></div></td>
            <td data-label={t("role")}><span className="role-chip">{user.role}</span></td>
            <td data-label={t("plan")}>{user.plan}</td>
            <td data-label={t("usage")}><span className="usage-number">{user.usage}</span></td>
            <td data-label={t("created")}>{user.date}</td>
            <td data-label={t("status")}><span className={`status-chip ${user.state === "active" ? "" : "pending"}`}><i />{user.state === "active" ? t("active") : user.state === "expired" ? t("expired") : t("disabled")}</span></td>
            <td className="cell-actions" data-label="">
              <div className="row-actions">
                <button className="outline-button small" onClick={() => onEdit(user.id)}>{t("edit")}</button>
                <button className="outline-button small" onClick={() => onAdjust(user.id)}>{say(locale, "充值 / 退款", "Credit / refund")}</button>
                <button className="outline-button small" onClick={() => onToggle(user.id, !user.enabled)}>{user.enabled ? say(locale, "停用", "Disable") : say(locale, "启用", "Enable")}</button>
              </div>
            </td>
          </tr>)}
        </tbody>
      </table>
      {!rows.length && <div className="empty-state"><Search size={24} /><b>{t("noResults")}</b></div>}
    </div>
  </div>;
}
function InboundsPage({ t, locale, rows, onEdit, onToggle, onSync }: { t: TextFn; locale: Locale; rows: DisplayInboundRow[]; onEdit: (inboundId: string) => void; onToggle: (inboundId: string, enabled: boolean) => void; onSync: () => void }) {
  return <div className="panel data-panel">
    <PageToolbar t={t} count={phrase(locale, "{n} 个入站", "{n} inbounds", { n: rows.length })} action={<button className="outline-button small" type="button" onClick={onSync}>{say(locale, "从节点同步", "Sync from node")}</button>} />
    <div className="table-wrap full-table">
      <table>
        <thead><tr><th>{t("inbounds")}</th><th>{t("nodes")}</th><th>{t("level")}</th><th>{t("multiplierLabel")}</th><th>{t("clientCount")}</th><th>{t("status")}</th><th /></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.id}>
            <td className="cell-title"><div className="table-person"><span className="inbound-symbol"><Network size={16} /></span><span><b>{row.name}</b><small>{row.address}</small></span></div></td>
            <td data-label={t("nodes")}>{row.node}</td>
            <td data-label={t("level")}><span className="role-chip">{row.level}</span>{!row.planEnabled && <span className="role-chip">{say(locale, "未对套餐启用", "No plan")}</span>}</td>
            <td data-label={t("multiplierLabel")}><span className="multiplier-chip"><Zap size={12} />{row.multiplier}</span></td>
            <td data-label={t("clientCount")}>{row.clients}</td>
            <td data-label={t("status")}><span className={`status-chip ${row.enabled ? "" : "pending"}`}><i />{row.enabled ? t("enabled") : t("disabled")}</span></td>
            <td className="cell-actions" data-label="">
              <div className="row-actions">
                <button className="outline-button small" onClick={() => onEdit(row.id)}>{t("edit")}</button>
                <button className="outline-button small" onClick={() => onToggle(row.id, !row.enabled)}>{row.enabled ? say(locale, "停用", "Disable") : say(locale, "启用", "Enable")}</button>
              </div>
            </td>
          </tr>)}
        </tbody>
      </table>
      {!rows.length && <div className="empty-state"><Network size={24} /><b>{t("noResults")}</b></div>}
    </div>
  </div>;
}
function PlansAdmin({ t, locale, plans, onEdit, onToggle }: { t: TextFn; locale: Locale; plans: DisplayPlanRow[]; onEdit: (planId: string) => void; onToggle: (planId: string, enabled: boolean) => void }) {
  return <div className="plans-grid">{plans.map((plan) => <article className={`plan-admin-card ${plan.tone}`} key={plan.id}><div className="plan-admin-head"><span className={`plan-emblem ${plan.tone}`}><Sparkles size={17} /></span><span className={`status-chip ${plan.enabled ? "" : "pending"}`}><i />{plan.enabled ? t("enabled") : t("disabled")}</span></div><h3>{plan.name}</h3><p>{plan.detail}</p><div className="plan-price"><b>{plan.price}</b><span>/ {plan.cycle.toLowerCase()}</span></div><div className="plan-admin-rows"><div><span>{t("level")}</span><b>{plan.level}</b></div><div><span>{t("trafficLimit")}</span><b>{plan.traffic}</b></div><div><span>{t("resetCycle")}</span><b>{plan.cycle}</b></div><div><span>{t("users")}</span><b>{plan.users}</b></div></div><button className="outline-button wide" onClick={() => onEdit(plan.id)}>{t("edit")}</button><button className="outline-button wide" onClick={() => onToggle(plan.id, !plan.enabled)}>{plan.enabled ? say(locale, "停用", "Disable") : say(locale, "启用", "Enable")}</button></article>)}</div>;
}

function PlansPage({ t, locale, plans, currentPlan, onCheckout }: { t: TextFn; locale: Locale; plans: ApiPlan[]; currentPlan: ApiPlan | null; onCheckout: (plan: ApiPlan) => void }) {
  const cardPlans = plans.filter((plan) => !plan.isDefault && plan.priceMinor > 0).map((plan, index) => ({
    ...plan,
    tone: ["violet", "mint", "amber"][index % 3],
    detail: plan.description,
    traffic: formatBytes(plan.trafficBytes),
    price: formatMoney(plan.priceMinor, plan.currency, locale),
    cycle: plan.validityDays > 0 ? phrase(locale, "{n} 天", "{n} days", { n: plan.validityDays }) : say(locale, "不限期", "No expiry"),
    levelLabel: phrase(locale, "等级 {n}", "Level {n}", { n: plan.level }),
    isCurrent: plan.id === currentPlan?.id,
    isDowngrade: currentPlan !== null && plan.level < currentPlan.level,
  }));
  return <><div className="plans-intro"><div><span className="section-kicker">{say(locale, "再多一点空间", "A LITTLE MORE ROOM")}</span><h2>{t("manageTitle")} <span>{t("manageSuffix")}</span></h2><p>{t("planDescription")}</p></div><span className="plan-group-badge"><Sparkles size={14} /> {t("payment")} · Waffo</span></div><div className="plans-grid">{cardPlans.map((plan, index) => <article className={`plan-admin-card ${plan.tone} ${index === 1 ? "featured-plan" : ""}`} key={plan.name}><div className="plan-admin-head"><span className={`plan-emblem ${plan.tone}`}><Sparkles size={17} /></span>{index === 1 && <span className="popular-badge">{say(locale, "最受欢迎", "MOST LOVED")}</span>}</div><h3>{plan.name}</h3><p>{plan.detail}</p><div className="plan-price"><b>{plan.price}</b><span>/ {plan.cycle.toLowerCase()}</span></div><div className="plan-admin-rows"><div><span>{t("trafficLimit")}</span><b>{plan.traffic}</b></div><div><span>{t("level")}</span><b>{plan.levelLabel}</b></div><div><span>{t("resetCycle")}</span><b>{plan.cycle}</b></div></div><button className={index === 1 ? "primary-button wide" : "outline-button wide"} disabled={plan.isDowngrade} onClick={() => onCheckout(plan)}>{plan.isDowngrade ? (say(locale, "不可降级", "Downgrade unavailable")) : plan.isCurrent ? t("renew") : t("upgrade")}</button></article>)}</div></>;
}

function orderStatusLabel(status: string, t: TextFn, locale: Locale): string {
  if (status === "refunded") return say(locale, "已退款", "Refunded");
  if (status === "paid" || status === "pending" || status === "failed" || status === "expired") return t(status);
  return status;
}

function OrdersPage({ t, locale, rows, onDelete, onAction }: { t: TextFn; locale: Locale; rows: DisplayOrderRow[]; onDelete: (orderId: string) => void; onAction: (label: string) => void }) {
  return <div className="panel data-panel">
    <PageToolbar t={t} count={phrase(locale, "最近 {n} 笔订单", "{n} recent orders", { n: rows.length })} />
    <div className="table-wrap full-table">
      <table>
        <thead><tr><th>{t("orderNo")}</th><th>{t("customer")}</th><th>{t("plan")}</th><th>{t("payment")}</th><th>{t("amount")}</th><th>{t("date")}</th><th>{t("status")}</th><th /></tr></thead>
        <tbody>
          {rows.map((order) => <tr key={order.id}>
            <td className="cell-title"><b className="mono cell-id" title={order.id}>{order.id}</b></td>
            <td data-label={t("customer")}><div className="table-person"><span className="avatar avatar-blue">{order.customer.split(" ").map((word) => word[0]).join("")}</span><span><b>{order.customer}</b><small>{order.email}</small></span></div></td>
            <td data-label={t("plan")}>{order.plan}</td>
            <td data-label={t("payment")}>{order.method}</td>
            <td data-label={t("amount")}><b>{order.amount}</b></td>
            <td data-label={t("date")}>{order.date}</td>
            <td data-label={t("status")}><span className={`status-chip ${order.state === "pending" ? "pending" : ""}`}><i />{orderStatusLabel(order.state, t, locale)}</span></td>
            <td className="cell-actions" data-label="">
              <div className="row-actions">{order.state === "failed" || order.state === "expired"
                ? <button className="outline-button small" onClick={() => onDelete(order.id)}>{t("delete")}</button>
                : <button className="quiet-icon tiny" onClick={() => onAction(t("details"))}><MoreHorizontal size={17} /></button>}</div>
            </td>
          </tr>)}
        </tbody>
      </table>
      {!rows.length && <div className="empty-state"><CreditCard size={24} /><b>{t("noResults")}</b></div>}
    </div>
  </div>;
}
function SubscriptionPage({ t, locale, subscription, onCopy }: { t: TextFn; locale: Locale; subscription: UserSubscriptionData | null; onCopy: () => void }) {
  return <div className="subscription-layout"><section className="panel subscription-hero"><div className="sub-hero-glow" /><div className="member-card-top"><div className="plan-emblem"><Sparkles size={19} /></div><span className="plan-state"><i /> {subscription?.active ? t("active") : t("expired")}</span></div><span className="section-kicker">{say(locale, "当前套餐", "YOUR CURRENT PLAN")}</span><h2>{subscription?.plan?.name ?? t("planName")}</h2><p>{subscription?.plan?.description ?? t("planDescription")}</p><div className="sub-stat-strip"><div><small>{t("level")}</small><b>{subscription?.plan ? phrase(locale, "等级 {n}", "Level {n}", { n: subscription.plan.level }) : "—"}</b></div><div><small>{t("trafficLimit")}</small><b>{formatBytes(subscription?.traffic.limitBytes ?? 0)}</b></div><div><small>{t("expiry")}</small><b>{subscription?.expiresAt ? formatDate(subscription.expiresAt, locale) : "—"}</b></div><div><small>{t("remaining")}</small><b>{formatBytes(subscription?.traffic.remainingBytes ?? 0)}</b></div></div><div className="sub-actions"><button className="primary-button" onClick={onCopy}><ArrowRight size={15} />{t("copyLink")}</button><span className="sub-hint"><ShieldCheck size={14} /> {t("statusGood")}</span></div></section><section className="panel subscription-settings"><div className="panel-heading"><div><div className="section-kicker">{say(locale, "配置", "CONFIGURATION")}</div><h3>{t("subscriptionLink")}</h3><p>{t("copyLink")}</p></div></div><div className="link-copy-row"><code>{say(locale, "尚未配置订阅链接", "Subscription URL is not configured.")}</code><button className="outline-button small" onClick={onCopy}>{t("copy")}</button></div><div className="client-list">{subscription?.clients.map((client) => <div key={`${client.inboundName}:${client.port}`}><span className="client-logo client-v">{client.protocol.slice(0, 1).toUpperCase()}</span><span><b>{client.inboundName}</b><small>{client.protocol.toUpperCase()} · {client.port} · {client.syncStatus}</small></span><span className={`status-chip ${client.enabled ? "" : "pending"}`}><i />{client.enabled ? t("enabled") : t("offline")}</span></div>)}{!subscription?.clients.length && <div className="empty-state"><Network size={20} /><b>{say(locale, "暂无可用客户端", "No connected clients are available.")}</b></div>}</div></section><section className="panel subscription-note"><span className="quick-icon amber"><CircleHelp size={16} /></span><div><b>{t("support")}</b><p>{t("refreshSoon")}</p></div><ArrowRight size={15} /></section></div>;
}

function AccountPage({ t, locale, user, overview, rows, onNavigate }: { t: TextFn; locale: Locale; user: AuthenticatedUser; overview: UserOverviewData | null; rows: DisplayOrderRow[]; onNavigate: (page: PageKey) => void }) {
  return <div className="account-grid"><section className="panel account-card"><div className="panel-heading"><div><div className="section-kicker">{say(locale, "你的钱包", "YOUR WALLET")}</div><h3>{t("balance")}</h3></div><span className="quick-icon violet"><Wallet size={18} /></span></div><b className="account-balance">{overview ? formatMoney(overview.balanceMinor, overview.plan?.currency ?? "USD", locale) : "—"}</b><p>{overview?.plan?.currency ?? "—"} · {t("balance")}</p><button className="primary-button" type="button" onClick={() => onNavigate("plans")}><Sparkles size={15} />{t("plans")}</button></section><section className="panel account-card"><div className="panel-heading"><div><div className="section-kicker">{say(locale, "账户信息", "ACCOUNT DETAILS")}</div><h3>{t("accountEmail")}</h3></div><span className="quick-icon blue"><Users size={17} /></span></div><div className="account-detail"><span className="avatar avatar-mint">{user.email.slice(0, 2).toUpperCase()}</span><div><b>{user.email}</b><small>{phrase(locale, "注册于 {n}", "Member since {n}", { n: formatDate(user.createdAt, locale) })}</small></div></div><button className="outline-button" type="button" disabled>{say(locale, "暂不支持编辑", "Editing unavailable")}</button></section><section className="panel account-history"><div className="panel-heading"><div><div className="section-kicker">{say(locale, "账户动态", "ACCOUNT ACTIVITY")}</div><h3>{t("orders")}</h3></div><button className="text-link" type="button" onClick={() => onNavigate("orders")}>{t("orders")} <ArrowRight size={14} /></button></div>{rows.length ? rows.slice(0, 2).map((row) => <div className="history-row" key={row.id}><span className="quick-icon mint"><CreditCard size={16} /></span><div><b>{row.plan}</b><small>{row.date} · {row.method}</small></div><strong>{row.amount}</strong><span className={`status-chip ${row.state === "paid" || row.state === "refunded" ? "" : "pending"}`}><i />{orderStatusLabel(row.state, t, locale)}</span></div>) : <div className="empty-state"><CreditCard size={24} /><b>{t("noResults")}</b></div>}</section></div>;
}

function CheckinPage({ t, locale, attendance, available, securityConfigAvailable, turnstileRequired, turnstileSiteKey, busy, onCheckin }: { t: TextFn; locale: Locale; attendance: UserOverviewData["attendance"] | null; available: boolean; securityConfigAvailable: boolean; turnstileRequired: boolean; turnstileSiteKey: string | null; busy: boolean; onCheckin: (token?: string) => void }) {
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const checkedIn = attendance?.checkedInToday ?? false;
  const rewardsEnabled = (attendance?.maxRewardBytes ?? attendance?.rewardBytes ?? 0) > 0;
  const widgetReady = !turnstileRequired || Boolean(turnstileSiteKey && turnstileToken);
  const unavailableMessage = !securityConfigAvailable
    ? say(locale, "安全设置暂不可用，请稍后重试签到。", "Security settings are unavailable; retry check-in later.")
    : !rewardsEnabled
      ? say(locale, "签到奖励暂未开放。", "Check-in rewards are currently disabled.")
    : !available
      ? say(locale, "当前存储模式不支持安全签到；需要启用 D1 原子存储。", "Secure check-in is unavailable with this storage mode; D1 atomic storage is required.")
      : turnstileRequired && !turnstileSiteKey
        ? say(locale, "签到要求人机验证，但未配置 Site Key。", "Check-in requires verification, but no Site Key is configured.")
        : turnstileRequired && !turnstileToken
          ? say(locale, "请先完成人机验证。", "Complete the human verification challenge first.")
          : checkedIn
            ? say(locale, "今日已签到，奖励已计入流量额度。", "You have checked in today; the reward is included in your traffic quota.")
            : say(locale, "完成今日签到后，奖励将计入流量额度。", "Check in today to add the reward to your traffic quota.");
  return <div className="checkin-layout"><section className="panel checkin-hero"><span className="checkin-spark">✦</span><span className="section-kicker">{t("attendance")}</span><h2>{t("checkin")}</h2><p>{pick(locale, {
  zh: `今日奖励 ${attendanceRewardLabel(attendance)}，连续签到 ${attendance?.streak ?? 0} 天。`,
  en: `${attendanceRewardLabel(attendance)} reward today · ${attendance?.streak ?? 0} day streak.`,
  "zh-TW": `今日獎勵 ${attendanceRewardLabel(attendance)}，連續簽到 ${attendance?.streak ?? 0} 天。`,
  ja: `本日の特典 ${attendanceRewardLabel(attendance)} · 連続${attendance?.streak ?? 0}日。`,
  ko: `오늘 보상 ${attendanceRewardLabel(attendance)} · ${attendance?.streak ?? 0}일 연속.`,
  de: `Heute ${attendanceRewardLabel(attendance)} Belohnung · ${attendance?.streak ?? 0} Tage Serie.`,
  es: `Recompensa de hoy: ${attendanceRewardLabel(attendance)} · racha de ${attendance?.streak ?? 0} días.`,
  pt: `Recompensa de hoje: ${attendanceRewardLabel(attendance)} · sequência de ${attendance?.streak ?? 0} dias.`,
  it: `Premio di oggi: ${attendanceRewardLabel(attendance)} · serie di ${attendance?.streak ?? 0} giorni.`,
  ar: `مكافأة اليوم ${attendanceRewardLabel(attendance)} · ${attendance?.streak ?? 0} يوم متتابع.`,
  ru: `Награда сегодня ${attendanceRewardLabel(attendance)} · серия ${attendance?.streak ?? 0} дн.`,
  fr: `Récompense du jour : ${attendanceRewardLabel(attendance)} · série de ${attendance?.streak ?? 0} jours.`,
})}</p><div className="auth-message" role="status">{unavailableMessage}</div>{turnstileRequired && turnstileSiteKey && <TurnstileWidget siteKey={turnstileSiteKey} action="checkin" resetKey={turnstileResetKey} onToken={setTurnstileToken} locale={locale} />}<button className="primary-button" type="button" disabled={!rewardsEnabled || !available || !securityConfigAvailable || !widgetReady || busy || checkedIn} onClick={() => { onCheckin(turnstileRequired ? turnstileToken : undefined); if (turnstileRequired) { setTurnstileToken(""); setTurnstileResetKey((value) => value + 1); } }}><Zap size={15} />{busy ? say(locale, "正在签到…", "Checking in…") : checkedIn ? say(locale, "今日已签到", "Checked in today") : !rewardsEnabled || !available || !securityConfigAvailable ? say(locale, "暂不可用", "Unavailable") : turnstileRequired && !widgetReady ? say(locale, "完成人机验证", "Verify to continue") : say(locale, "立即签到", "Check in now")}</button></section><section className="panel checkin-side"><div className="section-kicker">{t("attendance")}</div><h3>{say(locale, "签到记录", "Attendance")}</h3><p>{pick(locale, {
  zh: `连续签到 ${attendance?.streak ?? 0} 天`,
  en: `${attendance?.streak ?? 0} consecutive days`,
  "zh-TW": `連續簽到 ${attendance?.streak ?? 0} 天`,
  ja: `連続${attendance?.streak ?? 0}日`,
  ko: `${attendance?.streak ?? 0}일 연속`,
  de: `${attendance?.streak ?? 0} Tage in Folge`,
  es: `${attendance?.streak ?? 0} días consecutivos`,
  pt: `${attendance?.streak ?? 0} dias consecutivos`,
  it: `${attendance?.streak ?? 0} giorni consecutivi`,
  ar: `${attendance?.streak ?? 0} يوم متتابع`,
  ru: `${attendance?.streak ?? 0} дней подряд`,
  fr: `${attendance?.streak ?? 0} jours consécutifs`,
})}</p><div className="setting-row"><div><b>{say(locale, "今日状态", "Today's status")}</b><small>{attendance?.lastCheckinAt ? formatDate(attendance.lastCheckinAt, locale) : say(locale, "暂无签到记录", "No check-ins recorded")}</small></div><span className={`status-chip ${checkedIn ? "" : "pending"}`}><i />{checkedIn ? say(locale, "已完成", "Complete") : say(locale, "未签到", "Not checked in")}</span></div><div className="setting-row"><div><b>{say(locale, "本次奖励", "Today's reward")}</b><small>{say(locale, "增加流量额度", "Added to traffic quota")}</small></div><strong>{attendanceRewardLabel(attendance)}</strong></div></section></div>;
}

function attendanceRewardLabel(attendance: UserOverviewData["attendance"] | null): string {
  const min = attendance?.minRewardBytes ?? attendance?.rewardBytes ?? 0;
  const max = attendance?.maxRewardBytes ?? attendance?.rewardBytes ?? 0;
  return min === max ? formatBytes(min) : `${formatBytes(min)} – ${formatBytes(max)}`;
}

type SettingsTabKey = "platform" | "security" | "referrals" | "attendance" | "emails" | "payment" | "display";

const settingsTabs: Array<[SettingsTabKey, MessageKey, LucideIcon]> = [
  ["platform", "settingsTitle", Settings2],
  ["security", "security", ShieldCheck],
  ["referrals", "referrals", Users],
  ["attendance", "attendance", Zap],
  ["emails", "emails", Bell],
  ["payment", "payment", CreditCard],
  ["display", "display", Palette],
];

/** Maps the stored settings document onto the editable form values. */
function settingsDraft(settings: Record<string, unknown>): Record<string, string | boolean> {
  const flag = (key: string, fallback: boolean) => (typeof settings[key] === "boolean" ? settings[key] as boolean : fallback);
  const number = (key: string, fallback: number) => {
    const raw = settings[key];
    return String(typeof raw === "number" && Number.isFinite(raw) ? raw : fallback);
  };
  const balance = typeof settings.defaultBalanceMinor === "number" && Number.isFinite(settings.defaultBalanceMinor) ? settings.defaultBalanceMinor : 0;
  const reward = typeof settings.checkinTrafficBytes === "number" && Number.isFinite(settings.checkinTrafficBytes) ? settings.checkinTrafficBytes : 0;
  return {
    registrationEnabled: flag("registrationEnabled", true),
    inviteRequired: flag("inviteRequired", false),
    emailVerificationRequired: flag("emailVerificationRequired", true),
    defaultBalance: (balance / 100).toFixed(2),
    timezone: typeof settings.timezone === "string" && settings.timezone ? settings.timezone : "UTC",
    turnstileEnabled: flag("turnstileEnabled", false),
    turnstileOnCheckin: flag("turnstileOnCheckin", false),
    userInvitesEnabled: flag("userInvitesEnabled", false),
    userInviteLimit: number("userInviteLimit", 0),
    referralPercent: number("referralPercent", 0),
    referralValidityDays: number("referralValidityDays", 30),
    checkinMinRewardGb: String(Number(number("checkinMinTrafficBytes", reward)) / 1_000_000_000),
    checkinMaxRewardGb: String(Number(number("checkinMaxTrafficBytes", reward)) / 1_000_000_000),
    ...Object.fromEntries(["publicAppUrl", "turnstileSiteKey", "resendFrom", "waffoMerchantId", "waffoPublicKey"].map((key) => [key, typeof settings[key] === "string" ? settings[key] : ""])),
    waffoEnvironment: settings.waffoEnvironment === "production" ? "production" : "sandbox",
    turnstileSecretKey: "", resendApiKey: "", waffoApiKey: "", waffoSigningKey: "",
    notifyTrafficExhausted: flag("notifyTrafficExhausted", true),
    notifySubscriptionExpired: flag("notifySubscriptionExpired", true),
    notifyTrafficReset: flag("notifyTrafficReset", false),
    notifyOrderExpired: flag("notifyOrderExpired", false),
    notifyReferralReward: flag("notifyReferralReward", false),
    notifyAccountCleanup: flag("notifyAccountCleanup", false),
  };
}

/** One-line description of each settings tab. */
function settingsTabHint(tab: SettingsTabKey, locale: Locale): string {
  if (tab === "platform") return say(locale, "注册、初始余额与时区。", "Registration, starting balance and time zone.");
  if (tab === "security") return say(locale, "人机验证与登录安全策略。", "Human verification and login security.");
  if (tab === "referrals") return say(locale, "邀请码与返利比例。", "Invite codes and referral commission.");
  if (tab === "attendance") return say(locale, "每日签到奖励的流量额度。", "Traffic granted by the daily check-in.");
  if (tab === "emails") return say(locale, "Resend 发信配置与邮件通知。", "Resend delivery settings and email notifications.");
  if (tab === "payment") return say(locale, "Waffo 支付配置。", "Waffo payment settings.");
  return say(locale, "主题、强调色与界面语言。", "Theme, accent color and interface language.");
}

function SystemPage({ t, locale, onSaved, theme, accent, onTheme, onAccent, onLocale, onAction }: {
  t: TextFn; locale: Locale; onSaved: () => Promise<void>; theme: Theme; accent: string;
  onTheme: (next: Theme) => void; onAccent: (next: string) => void; onLocale: (next: Locale) => void;
  onAction: (label: string) => void;
}) {
  const [tab, setTab] = useState<SettingsTabKey>("platform");
  const [draft, setDraft] = useState<Record<string, string | boolean> | null>(null);
  const [secretConfigured, setSecretConfigured] = useState<Record<string, boolean>>({});
  const [clearSecrets, setClearSecrets] = useState<Record<string, boolean>>({});
  const [health, setHealth] = useState<{ capabilities?: { trafficMetering?: boolean } } | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void apiRequest<{ settings: Record<string, unknown>; secretConfigured: Record<string, boolean> }>("/api/admin/settings")
      .then((result) => { if (active) { setDraft(settingsDraft(result.settings)); setSecretConfigured(result.secretConfigured ?? {}); } })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Failed to load settings."); });
    void apiRequest<{ capabilities?: { trafficMetering?: boolean } }>("/api/health")
      .then((result) => { if (active) setHealth(result); })
      .catch(() => { if (active) setHealth(null); });
    return () => { active = false; };
  }, []);
  const setValue = (key: string, value: string | boolean) => setDraft((current) => (current ? { ...current, [key]: value } : current));
  const isOn = (key: string) => draft?.[key] === true;
  const wholeNumber = (key: string, min: number, max: number): number => {
    const parsed = Number(String(draft?.[key] ?? "").trim());
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(say(locale, "请填写有效范围内的整数。", "Enter a whole number within the allowed range."));
    return parsed;
  };
  const decimalNumber = (key: string, min: number, max: number): number => {
    const parsed = Number(String(draft?.[key] ?? "").trim());
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(say(locale, "请填写有效范围内的数值。", "Enter a number within the allowed range."));
    return parsed;
  };
  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setError("");
    try {
      const payload: Record<string, unknown> = {};
      const text = (key: string) => { payload[key] = String(draft[key] ?? "").trim(); };
      const secret = (key: string) => {
        if (clearSecrets[key]) payload[key] = null;
        else if (String(draft[key] ?? "").trim()) text(key);
      };
      if (tab === "platform") {
        const balance = parseMoneyInput(String(draft.defaultBalance ?? ""), "USD");
        if (balance === null) throw new Error(say(locale, "初始余额格式不正确。", "The starting balance is not a valid amount."));
        text("publicAppUrl");
        const timezone = String(draft.timezone ?? "").trim();
        if (!timezone) throw new Error(say(locale, "请填写时区名称。", "Enter a time zone name."));
        Object.assign(payload, { registrationEnabled: isOn("registrationEnabled"), inviteRequired: isOn("inviteRequired"), emailVerificationRequired: isOn("emailVerificationRequired"), defaultBalanceMinor: balance, timezone });
      } else if (tab === "security") {
        text("turnstileSiteKey");
        secret("turnstileSecretKey");
        Object.assign(payload, { turnstileEnabled: isOn("turnstileEnabled"), turnstileOnCheckin: isOn("turnstileOnCheckin") });
      } else if (tab === "referrals") {
        Object.assign(payload, {
          userInvitesEnabled: isOn("userInvitesEnabled"), userInviteLimit: wholeNumber("userInviteLimit", 0, 1000),
          referralPercent: decimalNumber("referralPercent", 0, 100), referralValidityDays: wholeNumber("referralValidityDays", 0, 3650),
        });
      } else if (tab === "attendance") {
        const min = decimalNumber("checkinMinRewardGb", 0, 1000);
        const max = decimalNumber("checkinMaxRewardGb", 0, 1000);
        if (min > max) throw new Error(say(locale, "奖励下限不能大于上限。", "The minimum reward cannot exceed the maximum."));
        Object.assign(payload, { checkinMinTrafficBytes: Math.round(min * 1_000_000_000), checkinMaxTrafficBytes: Math.round(max * 1_000_000_000) });
      } else if (tab === "payment") {
        for (const key of ["waffoMerchantId", "waffoPublicKey", "waffoEnvironment"]) text(key);
        secret("waffoApiKey");
        secret("waffoSigningKey");
      } else if (tab === "emails") {
        text("resendFrom");
        secret("resendApiKey");
        for (const key of ["notifyTrafficExhausted", "notifySubscriptionExpired", "notifyTrafficReset", "notifyOrderExpired", "notifyReferralReward", "notifyAccountCleanup"]) payload[key] = isOn(key);
      }
      if (Object.keys(payload).length) {
        await apiRequest("/api/admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      }
      const result = await apiRequest<{ settings: Record<string, unknown>; secretConfigured: Record<string, boolean> }>("/api/admin/settings");
      setDraft(settingsDraft(result.settings));
      setSecretConfigured(result.secretConfigured ?? {});
      setClearSecrets({});
      await onSaved();
      onAction(t("saveSuccess"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : say(locale, "保存失败。", "Saving failed."));
    } finally {
      setSaving(false);
    }
  };
  const row = (key: string, title: string, hint: string, control: React.ReactNode) => (
    <div className="setting-row" key={key}><div><b>{title}</b><small>{hint}</small></div>{control}</div>
  );
  const toggleRow = (key: string, title: string, hint: string) => row(key, title, hint,
    <button type="button" role="switch" aria-checked={isOn(key)} aria-label={title} className={`toggle ${isOn(key) ? "on" : "off"}`} disabled={!draft || saving} onClick={() => setValue(key, !isOn(key))}><i /></button>);
  const inputRow = (key: string, title: string, hint: string, options: { type?: string; min?: number; max?: number; step?: string; suffix?: string } = {}) => row(key, title, hint,
    <label className="settings-input">
      <input type={options.type ?? "text"} inputMode={options.type === "number" ? "decimal" : undefined} value={String(draft?.[key] ?? "")} min={options.min} max={options.max} step={options.step} disabled={!draft || saving} aria-label={title} onChange={(event) => setValue(key, event.target.value)} />
      {options.suffix && <span>{options.suffix}</span>}
    </label>);
  const pemInput = (key: string, title: string, disabled = false) => <textarea className="settings-select" rows={4} style={{ width: "100%", maxWidth: "100%", resize: "vertical" }} aria-label={title} autoComplete="off" spellCheck={false} value={String(draft?.[key] ?? "")} disabled={!draft || saving || disabled} onChange={(event) => setValue(key, event.target.value)} />;
  const secretRow = (key: string, title: string, pem = false) => row(key, title,
    clearSecrets[key] ? say(locale, "保存后清除密钥。", "The key will be cleared on save.") : secretConfigured[key] ? say(locale, "已配置；留空保留原密钥，输入新值替换。", "Configured; leave blank to keep the key, or enter a replacement.") : say(locale, "尚未配置。", "Not configured."),
    <div style={{ display: "grid", gap: 8, width: "min(100%, 360px)" }}>
      {pem ? pemInput(key, title, clearSecrets[key]) : <label className="settings-input"><input type="password" aria-label={title} autoComplete="new-password" value={String(draft?.[key] ?? "")} disabled={!draft || saving || clearSecrets[key]} onChange={(event) => setValue(key, event.target.value)} /></label>}
      <button className="outline-button small" type="button" disabled={!draft || saving || (!secretConfigured[key] && !clearSecrets[key])} onClick={() => { setClearSecrets((current) => ({ ...current, [key]: !current[key] })); setValue(key, ""); }}>{clearSecrets[key] ? say(locale, "取消清除", "Keep existing key") : say(locale, "清除密钥", "Clear key")}</button>
    </div>);
  const tabLabel = t((settingsTabs.find(([key]) => key === tab) ?? settingsTabs[0])[1]);
  return <div className="settings-layout"><aside className="panel settings-menu">{settingsTabs.map(([key, label, Icon]) => <button key={key} type="button" className={tab === key ? "active" : ""} aria-current={tab === key ? "page" : undefined} onClick={() => setTab(key)}><Icon size={16} />{t(label)}<ChevronRight size={14} /></button>)}</aside><section className="panel settings-content">
    <div className="settings-section">
      <div className="section-kicker">{say(locale, "配置", "CONFIGURATION")}</div>
      <h3>{tabLabel}</h3>
      <p>{settingsTabHint(tab, locale)}</p>
      {!draft && !error && <div className="auth-message" role="status">{say(locale, "正在加载设置…", "Loading settings…")}</div>}
      {error && <div className="auth-message error" role="alert">{error}</div>}
      {draft && tab === "platform" && <>
        {inputRow("publicAppUrl", say(locale, "站点公开地址", "Public site URL"), say(locale, "用于验证邮件、支付回调与跳转，例如 https://example.com。", "Used for verification emails, payment callbacks and redirects, e.g. https://example.com."), { type: "url" })}
        {row("storage", t("storageMode"), `${t("d1Mode")} · ${health?.capabilities?.trafficMetering ? t("active") : t("offline")}`, <span className={`status-chip ${health?.capabilities?.trafficMetering ? "" : "pending"}`}><i />{health?.capabilities?.trafficMetering ? t("active") : t("offline")}</span>)}
        {toggleRow("registrationEnabled", say(locale, "开放注册", "Open registration"), say(locale, "关闭后注册接口返回 403。", "When off, sign-up returns 403."))}
        {toggleRow("inviteRequired", say(locale, "注册需要邀请码", "Invite code required"), say(locale, "新用户必须携带有效邀请码才能注册。", "New accounts must present a valid invite code."))}
        {toggleRow("emailVerificationRequired", say(locale, "需要邮箱验证", "Require email verification"), say(locale, "未验证邮箱的账户无法登录。", "Accounts must verify their email before signing in."))}
        {inputRow("defaultBalance", say(locale, "新账户初始余额", "Starting balance"), say(locale, "以 USD 计的金额，创建账户时写入余额。", "USD amount credited when an account is created."), { suffix: "USD" })}
        {inputRow("timezone", say(locale, "签到时区", "Check-in time zone"), say(locale, "IANA 名称，例如 Asia/Shanghai。", "IANA name, e.g. Asia/Shanghai."))}
      </>}
      {draft && tab === "security" && <>
        {inputRow("turnstileSiteKey", "Turnstile Site Key", say(locale, "Cloudflare Turnstile 的公开站点密钥。", "The public site key from Cloudflare Turnstile."))}
        {secretRow("turnstileSecretKey", "Turnstile Secret Key")}
        {toggleRow("turnstileEnabled", say(locale, "注册要求人机验证", "Verify sign-ups"), say(locale, "注册时强制通过 Turnstile 校验。", "Require Turnstile on registration."))}
        {toggleRow("turnstileOnCheckin", say(locale, "签到要求人机验证", "Verify check-ins"), say(locale, "签到请求必须携带有效校验令牌。", "Check-in requests must carry a valid token."))}
        <p className="settings-note">{say(locale, "密钥加密保存，页面不会回显已有密钥。", "Secrets are stored encrypted and existing keys are never displayed.")}</p>
      </>}
      {draft && tab === "referrals" && <>
        {toggleRow("userInvitesEnabled", say(locale, "允许用户生成邀请码", "Users can create invite codes"), say(locale, "关闭后只有管理员可以创建邀请码。", "When off, only admins can create invite codes."))}
        {inputRow("userInviteLimit", say(locale, "每位用户的邀请码上限", "Invite codes per user"), say(locale, "0 表示不限制。", "0 means unlimited."), { type: "number", min: 0, max: 1000, step: "1" })}
        {inputRow("referralPercent", say(locale, "返利比例", "Referral commission"), say(locale, "被邀请人付款时按比例返给邀请人。", "Share of each invitee payment credited to the inviter."), { type: "number", min: 0, max: 100, step: "0.1", suffix: "%" })}
        {inputRow("referralValidityDays", say(locale, "返利有效期", "Referral validity"), say(locale, "超过该天数的订单不再返利。", "Orders placed after this window earn no commission."), { type: "number", min: 0, max: 3650, step: "1", suffix: say(locale, "天", "days") })}
      </>}
      {draft && tab === "attendance" && <>
        {inputRow("checkinMinRewardGb", say(locale, "签到奖励下限", "Minimum check-in reward"), say(locale, "可为 0；每次签到在上下限间随机奖励。", "May be 0; each check-in grants a random reward within the range."), { type: "number", min: 0, max: 1000, step: "0.000000001", suffix: "GB" })}
        {inputRow("checkinMaxRewardGb", say(locale, "签到奖励上限", "Maximum check-in reward"), say(locale, "上限为 0 时关闭签到；上下限相同时奖励固定。", "Set to 0 to disable check-in; equal bounds grant a fixed reward."), { type: "number", min: 0, max: 1000, step: "0.000000001", suffix: "GB" })}
        <p className="settings-note">{say(locale, "使用十进制 GB：1 GB = 1,000,000,000 字节。", "Decimal GB: 1 GB = 1,000,000,000 bytes.")}</p>
      </>}
      {draft && tab === "payment" && <>
        {inputRow("waffoMerchantId", "Waffo Merchant ID", say(locale, "Waffo 商户编号。", "Your Waffo merchant identifier."))}
        {row("waffoEnvironment", say(locale, "支付环境", "Payment environment"), say(locale, "测试使用 Sandbox，正式收款使用 Production。", "Use Sandbox for testing and Production for live payments."), <select className="settings-select" aria-label={say(locale, "支付环境", "Payment environment")} value={String(draft.waffoEnvironment)} disabled={saving} onChange={(event) => setValue("waffoEnvironment", event.target.value)}><option value="sandbox">Sandbox</option><option value="production">Production</option></select>)}
        {secretRow("waffoApiKey", "Waffo API Key")}
        {secretRow("waffoSigningKey", say(locale, "Waffo 签名私钥 (PEM)", "Waffo signing private key (PEM)"), true)}
        {row("waffoPublicKey", say(locale, "Waffo 验签公钥 (PEM)", "Waffo verification public key (PEM)"), say(locale, "用于验证支付回调签名。", "Used to verify payment webhook signatures."), pemInput("waffoPublicKey", "Waffo public key"))}
      </>}
      {draft && tab === "emails" && <>
        {inputRow("resendFrom", say(locale, "Resend 发件人", "Resend sender"), say(locale, "使用已验证域名，例如 Service <mail@example.com>。", "Use a verified domain, e.g. Service <mail@example.com>."))}
        {secretRow("resendApiKey", "Resend API Key")}
        {toggleRow("notifyTrafficExhausted", say(locale, "流量用尽", "Traffic exhausted"), say(locale, "用户流量耗尽时发送提醒。", "Email the user when their traffic runs out."))}
        {toggleRow("notifySubscriptionExpired", say(locale, "订阅到期", "Subscription expired"), say(locale, "套餐到期后发送提醒。", "Email the user after their plan expires."))}
        {toggleRow("notifyTrafficReset", say(locale, "流量重置", "Traffic reset"), say(locale, "周期流量重置时发送提醒。", "Email the user when their traffic resets."))}
        {toggleRow("notifyOrderExpired", say(locale, "订单过期", "Order expired"), say(locale, "未支付的订单超时后发送提醒。", "Email the user when an unpaid order expires."))}
        {toggleRow("notifyReferralReward", say(locale, "返利到账", "Referral reward"), say(locale, "邀请返利入账时通知邀请人。", "Notify the inviter when a commission is credited."))}
        {toggleRow("notifyAccountCleanup", say(locale, "账户清理", "Account cleanup"), say(locale, "长期未活跃账户被清理前提醒。", "Warn before inactive accounts are removed."))}
        <p className="settings-note">{say(locale, "邮件需要配置 Resend API Key 与发件人才能发出。", "Email delivery requires a Resend API key and sender.")}</p>
      </>}
      {tab === "display" && <>
        {row("theme", t("theme"), say(locale, "切换浅色或深色外观。", "Switch between light and dark."), <div className="segmented"><button type="button" className={theme === "light" ? "active" : ""} onClick={() => onTheme("light")}>{t("light")}</button><button type="button" className={theme === "dark" ? "active" : ""} onClick={() => onTheme("dark")}>{t("dark")}</button></div>)}
        {row("accent", say(locale, "强调色", "Accent color"), say(locale, "影响按钮与高亮配色。", "Used by buttons and highlights."), <div className="swatch-row">{[["cyan", "#4de0c4"], ["blue", "#7599ff"], ["violet", "#ac8aff"], ["rose", "#fa8da7"], ["amber", "#f0bf66"]].map(([key, color]) => <button key={key} type="button" className={accent === key ? "active" : ""} style={{ "--swatch": color } as React.CSSProperties} aria-label={key} onClick={() => onAccent(key)} />)}</div>)}
        {row("language", t("language"), say(locale, "选择界面语言。", "Choose the interface language."), <select className="settings-select" value={locale} onChange={(event) => onLocale(event.target.value as Locale)} aria-label={t("language")}>{LOCALES.map((code) => <option key={code} value={code}>{LOCALE_META[code].native}</option>)}</select>)}
        <p className="settings-note">{say(locale, "外观与语言只保存在本机浏览器。", "Appearance and language are stored in this browser only.")}</p>
      </>}
    </div>
    <div className="settings-actions">
      <span>{tab === "display" ? say(locale, "这些偏好即时生效。", "These preferences apply instantly.") : say(locale, "设置保存在服务端，保存后立即生效。", "Settings are stored on the server and apply instantly.")}</span>
      {tab !== "display" && <button className="primary-button" type="button" disabled={!draft || saving} onClick={() => { void save(); }}>{saving ? say(locale, "保存中…", "Saving…") : t("save")}</button>}
    </div>
  </section></div>;
}

function NotificationPopover({ items, locale, error, onRead, onClose }: { items: NotificationData[]; locale: Locale; error: string; onRead: (id: string) => void; onClose: () => void }) {
  return <section className="notification-popover" role="dialog" aria-label={say(locale, "通知中心", "Notification center")}>
    <div className="notification-popover-head"><b>{say(locale, "通知中心", "Notifications")}</b><button type="button" aria-label={say(locale, "关闭通知", "Close notifications")} onClick={onClose}><X size={15} /></button></div>
    {error && <div className="notification-error" role="alert">{error}</div>}
    {items.length ? <div className="notification-list">{items.map((item) => <button type="button" key={item.id} className={`notification-entry ${item.readAt ? "read" : "unread"}`} onClick={() => { if (!item.readAt) onRead(item.id); }}>
      <span className="notification-entry-dot" />
      <span className="notification-entry-content"><b>{item.title}</b><small>{formatDate(item.createdAt, locale)}</small><span>{item.body}</span></span>
    </button>)}</div> : <div className="notification-empty">{say(locale, "暂无通知", "You're all caught up.")}</div>}
  </section>;
}

export default App;
