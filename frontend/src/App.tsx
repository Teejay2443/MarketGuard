import { useState, useEffect, useRef, useCallback } from "react";
import {
  Shield, Mic, MicOff, Send, Package,
  Receipt, AlertTriangle, CheckCircle2, LogOut, TrendingUp,
  CircleDollarSign, Users, Sparkles,
  ArrowRight, Loader2, Clock, BarChart3, Sun, Moon,
  LayoutDashboard, Bot, History, ClipboardList,
} from "lucide-react";
import "./App.css";

/* ─── Types ─── */
interface Item {
  name: string;
  quantity: number;
  unit_price: number;
}

interface ParsedData {
  type: string;
  customer_name: string | null;
  total_amount: number;
  amount_paid: number;
  amount_owed: number;
  items: Item[];
}

interface Transaction {
  id: number;
  type: string;
  customer_name: string | null;
  total_amount: number;
  amount_paid: number;
  amount_owed: number;
  timestamp: string;
  items?: Item[];
}

interface Product {
  id: number;
  name: string;
  stock_quantity: number;
  unit: string;
  cost_price: number;
  selling_price: number;
}

type SidebarView = "dashboard" | "voice" | "transactions" | "inventory" | "companion";

const BACKEND_URL = "http://localhost:8000";

/* ─── Auth helpers ─── */
function getToken(): string | null {
  return localStorage.getItem("marketguard_token");
}
function setTokenLocal(t: string) {
  localStorage.setItem("marketguard_token", t);
}
function clearToken() {
  localStorage.removeItem("marketguard_token");
}

async function apiFetch(path: string, options: RequestInit = {}) {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (!(options.body instanceof FormData)) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  const res = await fetch(`${BACKEND_URL}${path}`, { ...options, headers });
  if (res.status === 401) {
    clearToken();
    window.location.reload();
  }
  return res;
}

/* ─── App ─── */
export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    return (localStorage.getItem("marketguard_theme") as "light" | "dark") || "light";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("marketguard_theme", theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));

  const [token, setTokenState] = useState<string | null>(getToken());
  const [user, setUser] = useState<{ id: number; username: string; display_name: string } | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [transcription, setTranscription] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState("local");
  const [inventory, setInventory] = useState<Product[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [parsedResult, setParsedResult] = useState<{
    transaction_id: number | null;
    parsed_data: ParsedData;
    warnings: string[];
    hallucination?: boolean;
  } | null>(null);

  const [activeView, setActiveView] = useState<SidebarView>("dashboard");

  /* Companion chat */
  const [companionInput, setCompanionInput] = useState("");
  const [companionLoading, setCompanionLoading] = useState(false);
  const [companionHistory, setCompanionHistory] = useState<{ q: string; a: string }[]>([]);
  const companionEndRef = useRef<HTMLDivElement>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    fetchMode();
    if (token) {
      fetchMe();
      fetchInventory();
      fetchTransactions();
    }
  }, [token]);

  useEffect(() => {
    companionEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [companionHistory]);

  const fetchMode = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/health`);
      const data = await res.json();
      if (data.mode) setMode(data.mode);
    } catch { /* ignore */ }
  };

  const fetchInventory = async () => {
    try {
      const res = await apiFetch("/inventory");
      setInventory(await res.json());
    } catch (err) {
      console.error("Failed to fetch inventory", err);
    }
  };

  const fetchTransactions = async () => {
    try {
      const res = await apiFetch("/transactions");
      setTransactions(await res.json());
    } catch (err) {
      console.error("Failed to fetch transactions", err);
    }
  };

  const fetchMe = async () => {
    try {
      const res = await apiFetch("/auth/me");
      if (res.ok) setUser(await res.json());
    } catch { /* ignore */ }
  };

  const doAuth = async () => {
    setAuthError("");
    if (authPassword.length < 4) {
      setAuthError("Password must be at least 4 characters");
      return;
    }
    setAuthLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/auth/${authMode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: authUsername, password: authPassword }),
      });
      if (!res.ok) {
        const err = await res.json();
        setAuthError(err.detail || "Authentication failed");
        return;
      }
      const data = await res.json();
      setTokenLocal(data.token);
      setTokenState(data.token);
      setUser(data.user);
    } catch {
      setAuthError("Connection failed. Is the backend running?");
    } finally {
      setAuthLoading(false);
    }
  };

  const logout = () => {
    clearToken();
    setTokenState(null);
    setUser(null);
    setTransactions([]);
    setInventory([]);
    setParsedResult(null);
    setCompanionHistory([]);
  };

  const startRecording = async () => {
    setError(null);
    audioChunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: "audio/wav" });
        setAudioUrl(URL.createObjectURL(blob));
        uploadAudio(blob);
      };
      mediaRecorder.start();
      setIsRecording(true);
    } catch {
      setError("Microphone access denied or not supported.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
      setIsRecording(false);
    }
  };

  const uploadAudio = async (blob: Blob) => {
    setIsLoading(true);
    setError(null);
    const fd = new FormData();
    fd.append("file", blob, "recording.wav");
    try {
      const res = await apiFetch("/transcribe", { method: "POST", body: fd });
      if (!res.ok) throw new Error("STT server error");
      const data = await res.json();
      setTranscription(data.transcription);
    } catch {
      setError("Failed to transcribe audio. Ensure backend is running.");
    } finally {
      setIsLoading(false);
    }
  };

  const processTextIntent = async () => {
    if (!transcription.trim()) return;
    setIsLoading(true);
    setError(null);
    setParsedResult(null);
    try {
      const res = await apiFetch("/process-intent", {
        method: "POST",
        body: JSON.stringify({ text: transcription }),
      });
      if (!res.ok) {
        const detail = await res.json();
        throw new Error(detail.detail || "LLM server error");
      }
      const data = await res.json();
      setParsedResult(data);
      fetchInventory();
      fetchTransactions();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to process transaction.");
    } finally {
      setIsLoading(false);
    }
  };

  const sendCompanion = useCallback(async () => {
    const q = companionInput.trim();
    if (!q || companionLoading) return;
    setCompanionLoading(true);
    setCompanionHistory((prev) => [...prev, { q, a: "Thinking..." }]);
    setCompanionInput("");
    try {
      const res = await apiFetch("/companion", {
        method: "POST",
        body: JSON.stringify({ question: q }),
      });
      if (!res.ok) throw new Error("Companion query failed");
      const data = await res.json();
      setCompanionHistory((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { q, a: data.answer };
        return updated;
      });
    } catch (err: unknown) {
      setCompanionHistory((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { q, a: `Sorry, I couldn't respond. ${err instanceof Error ? err.message : ""}` };
        return updated;
      });
    } finally {
      setCompanionLoading(false);
    }
  }, [companionInput, companionLoading]);

  /* ─── Computed stats ─── */
  const totalSales = transactions
    .filter((t) => t.type === "SALE" || t.type === "CREDIT")
    .reduce((sum, t) => sum + t.total_amount, 0);
  const totalOwed = transactions.reduce((sum, t) => sum + t.amount_owed, 0);
  const transactionCount = transactions.length;

  const ThemeToggle = () => (
    <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle theme">
      {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
    </button>
  );

  const sidebarItems: { id: SidebarView; icon: typeof LayoutDashboard; label: string }[] = [
    { id: "dashboard", icon: LayoutDashboard, label: "Dashboard" },
    { id: "voice", icon: Mic, label: "Record" },
    { id: "transactions", icon: History, label: "Transactions" },
    { id: "inventory", icon: ClipboardList, label: "Inventory" },
    { id: "companion", icon: Bot, label: "AI Companion" },
  ];

  /* ─── Landing Page ─── */
  if (!token) {
    return (
      <div className="landing-page">
        <nav className="landing-nav">
          <div className="landing-logo">
            <div className="logo-mark"><Shield size={18} color="white" /></div>
            <span>MarketGuard</span>
          </div>
          <div className="landing-nav-actions">
            <ThemeToggle />
            <button className="btn btn-ghost btn-sm" onClick={() => setAuthMode("login")}>Sign In</button>
            <button className="btn btn-primary btn-sm" onClick={() => setAuthMode("register")}>Get Started</button>
          </div>
        </nav>

        <section className="landing-hero">
          <div className="hero-content">
            <div className="hero-badge"><span className="badge-dot" />Powered by Gemma 4</div>
            <h1>Your business speaks.<br /><span className="gradient-text">AI remembers.</span></h1>
            <p className="hero-desc">
              The voice-powered business assistant for Nigeria's informal economy.
              No typing. No complicated forms. Just talk naturally in English, Pidgin, or Yoruba.
            </p>
            <div className="hero-actions">
              <button className="btn btn-primary" onClick={() => setAuthMode("register")}>Start Free <ArrowRight size={16} /></button>
              <button className="btn btn-secondary" onClick={() => setAuthMode("login")}>Sign In</button>
            </div>
          </div>
          <div className="hero-visual">
            <div className="phone-mockup">
              <div className="phone-notch"><div className="phone-notch-bar" /></div>
              <div className="phone-header"><Mic size={16} />Voice Transaction</div>
              <div className="phone-body">
                <div className="phone-msg phone-msg-user">"I sell two bags of rice to Mama Ngozi for 96,000"</div>
                <div className="phone-msg phone-msg-ai success">✅ Recorded: SALE — 2 Rice, ₦96,000. Stock updated.</div>
                <div className="phone-msg phone-msg-user">"How much did I sell today?"</div>
                <div className="phone-msg phone-msg-ai">You sold ₦152,000 today across 3 transactions.</div>
              </div>
            </div>
          </div>
        </section>

        <section className="landing-features">
          <div className="section-header"><h2>How it works</h2><p>Speak naturally. MarketGuard handles the rest.</p></div>
          <div className="features-grid">
            <div className="feature-card"><div className="feature-icon"><Mic size={20} /></div><h3>Speak Naturally</h3><p>Talk in English, Nigerian Pidgin, or Yoruba. MarketGuard understands you.</p></div>
            <div className="feature-card"><div className="feature-icon"><Sparkles size={20} /></div><h3>AI Processes</h3><p>Gemma 4 extracts sales, debts, restocks — no forms to fill.</p></div>
            <div className="feature-card"><div className="feature-icon"><BarChart3 size={20} /></div><h3>Instant Records</h3><p>Transactions saved, inventory updated, debts tracked — automatically.</p></div>
            <div className="feature-card"><div className="feature-icon"><AlertTriangle size={20} /></div><h3>Smart Alerts</h3><p>Get warned when you sell below cost or when customers owe you money.</p></div>
            <div className="feature-card"><div className="feature-icon"><Bot size={20} /></div><h3>AI Companion</h3><p>Your personal business advisor — ask anything, get smart guidance.</p></div>
            <div className="feature-card"><div className="feature-icon"><Shield size={20} /></div><h3>Privacy First</h3><p>Your data is yours. Each trader has their own private workspace.</p></div>
          </div>
        </section>

        <section className="landing-demo">
          <div className="section-header"><h2>Try it now</h2><p>Click a demo account to auto-fill credentials.</p></div>
          <div className="demo-cards">
            <button type="button" className="demo-card" onClick={() => { setAuthMode("login"); setAuthUsername("trader_a"); setAuthPassword("pass1234"); window.scrollTo({ top: document.getElementById("auth-section")?.offsetTop ?? 0, behavior: "smooth" }); }}><span className="demo-user">trader_a</span><span className="demo-pass">pass1234</span></button>
            <button type="button" className="demo-card" onClick={() => { setAuthMode("login"); setAuthUsername("trader_b"); setAuthPassword("pass1234"); window.scrollTo({ top: document.getElementById("auth-section")?.offsetTop ?? 0, behavior: "smooth" }); }}><span className="demo-user">trader_b</span><span className="demo-pass">pass1234</span></button>
            <button type="button" className="demo-card" onClick={() => { setAuthMode("login"); setAuthUsername("trader_c"); setAuthPassword("pass1234"); window.scrollTo({ top: document.getElementById("auth-section")?.offsetTop ?? 0, behavior: "smooth" }); }}><span className="demo-user">trader_c</span><span className="demo-pass">pass1234</span></button>
          </div>
        </section>

        <section className="landing-auth" id="auth-section">
          <div className="card auth-card">
            <h2>{authMode === "login" ? "Welcome back" : "Create your account"}</h2>
            <p className="auth-subtitle">{authMode === "login" ? "Sign in to your workspace" : "No email needed. Just a username and password."}</p>
            {authError && <div className="error-banner"><AlertTriangle size={14} /> {authError}</div>}
            <div className="auth-fields">
              <div className="text-field"><label>Username</label><input placeholder="Enter your username" value={authUsername} onChange={(e) => setAuthUsername(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doAuth(); }} autoFocus /></div>
              <div className="text-field"><label>Password</label><input type="password" placeholder="4+ characters" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doAuth(); }} /></div>
            </div>
            <button className="btn btn-primary btn-full" onClick={doAuth} disabled={authLoading} style={{ marginTop: 16 }}>
              {authLoading ? <Loader2 size={16} className="spin" /> : authMode === "login" ? "Sign In" : "Create Account"}
            </button>
            <p className="auth-toggle">
              {authMode === "login" ? (
                <>Don't have an account?{" "}<a onClick={() => { setAuthMode("register"); setAuthError(""); }}>Create one</a></>
              ) : (
                <>Already have an account?{" "}<a onClick={() => { setAuthMode("login"); setAuthError(""); }}>Sign in</a></>
              )}
            </p>
          </div>
        </section>

        <footer className="landing-footer">
          <p><span className="footer-brand">MarketGuard</span> — Built for Nigeria's 40 million micro-merchants</p>
          <p>Powered by Gemma 4. Hackathon MVP.</p>
        </footer>
      </div>
    );
  }

  /* ─── Sidebar + Dashboard ─── */
  return (
    <div className="shell">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-mark"><Shield size={18} color="white" /></div>
          <span className="sidebar-logo-text">MarketGuard</span>
        </div>

        <nav className="sidebar-nav">
          {sidebarItems.map((item) => (
            <button
              key={item.id}
              className={`sidebar-item ${activeView === item.id ? "active" : ""}`}
              onClick={() => setActiveView(item.id)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.id === "companion" && <span className="sidebar-badge">AI</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-divider" />
          {user && (
            <div className="user-chip">
              <div className="avatar">{(user.display_name || user.username)[0].toUpperCase()}</div>
              <span>{user.display_name || user.username}</span>
            </div>
          )}
          <div className="sidebar-footer-row">
            <ThemeToggle />
            <div className="mode-badge">
              <span className="pulse-dot" />
              {mode === "cloud" ? "Cloud" : "Local"}
            </div>
            <button className="btn-ghost" onClick={logout} title="Sign out"><LogOut size={14} /></button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        {/* ─── Dashboard View ─── */}
        {activeView === "dashboard" && (
          <>
            <div className="page-header">
              <h2>Dashboard</h2>
              <p className="page-subtitle">Your business at a glance</p>
            </div>

            <div className="stats-row">
              <div className="stat-card">
                <div className="stat-label"><TrendingUp size={14} /> Total Sales</div>
                <div className="stat-value sale">₦{totalSales.toLocaleString()}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label"><CircleDollarSign size={14} /> Outstanding</div>
                <div className="stat-value danger">₦{totalOwed.toLocaleString()}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label"><Receipt size={14} /> Transactions</div>
                <div className="stat-value">{transactionCount}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label"><Package size={14} /> Products</div>
                <div className="stat-value info">{inventory.length}</div>
              </div>
            </div>

            {/* Quick Actions */}
            <div className="quick-actions">
              <button className="quick-action-card" onClick={() => setActiveView("voice")}>
                <div className="qa-icon"><Mic size={24} /></div>
                <div><strong>Record Transaction</strong><span>Speak to log a sale or restock</span></div>
                <ArrowRight size={16} className="qa-arrow" />
              </button>
              <button className="quick-action-card" onClick={() => setActiveView("companion")}>
                <div className="qa-icon companion"><Bot size={24} /></div>
                <div><strong>Ask AI Companion</strong><span>Get business advice and insights</span></div>
                <ArrowRight size={16} className="qa-arrow" />
              </button>
            </div>

            {/* Recent Transactions */}
            <div className="card">
              <div className="card-header">
                <div className="card-title"><Clock size={18} /> Recent Transactions</div>
                <button className="btn btn-ghost btn-sm" onClick={() => setActiveView("transactions")}>View all</button>
              </div>
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Type</th>
                      <th>Customer</th>
                      <th className="text-right">Total</th>
                      <th className="text-right">Owed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.length === 0 ? (
                      <tr><td colSpan={5} className="table-empty">No transactions yet. Record your first one!</td></tr>
                    ) : (
                      transactions.slice(0, 5).map((tx) => (
                        <tr key={tx.id}>
                          <td><Clock size={12} style={{ marginRight: 6, opacity: 0.4 }} />{new Date(tx.timestamp).toLocaleTimeString()}</td>
                          <td><span className={`badge badge-${tx.type}`}>{tx.type}</span></td>
                          <td className="text-primary">{tx.customer_name || "General"}</td>
                          <td className="text-right text-primary">₦{tx.total_amount.toLocaleString()}</td>
                          <td className={`text-right ${tx.amount_owed > 0 ? "text-danger" : ""}`}>₦{tx.amount_owed.toLocaleString()}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Low Stock Alert */}
            {inventory.filter((p) => p.stock_quantity < 5).length > 0 && (
              <div className="card warning-card">
                <div className="card-title"><AlertTriangle size={18} /> Low Stock Alert</div>
                <div className="low-stock-list">
                  {inventory.filter((p) => p.stock_quantity < 5).map((p) => (
                    <div key={p.id} className="low-stock-item">
                      <span>{p.name}</span>
                      <span className="text-danger">{p.stock_quantity} {p.unit} left</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* ─── Voice Recording View ─── */}
        {activeView === "voice" && (
          <>
            <div className="page-header">
              <h2>Record Transaction</h2>
              <p className="page-subtitle">Speak in Yoruba, Pidgin, or English</p>
            </div>

            <div className="voice-layout">
              <div className="card voice-card">
                <div className="voice-area">
                  <div className="mic-wrapper">
                    <button
                      className={`mic-button ${isRecording ? "recording" : ""}`}
                      onClick={isRecording ? stopRecording : startRecording}
                      disabled={isLoading}
                    >
                      {isRecording ? <MicOff size={32} /> : <Mic size={32} />}
                    </button>
                    <div className="mic-ring" />
                  </div>
                  <p className={`mic-label ${isRecording ? "recording" : ""}`}>
                    {isRecording ? "Listening... Click to stop" : isLoading ? "Processing..." : "Click to speak"}
                  </p>
                </div>

                {audioUrl && (
                  <div className="audio-player"><audio src={audioUrl} controls /></div>
                )}

                {error && <div className="error-banner"><AlertTriangle size={14} /> {error}</div>}

                {parsedResult?.hallucination && (
                  <div className="hallucination-notice">
                    <AlertTriangle size={14} />
                    <span>AI couldn't parse the transaction perfectly. Please rephrase or try again.</span>
                  </div>
                )}

                <div className="input-group">
                  <label className="input-label" htmlFor="transcription-input">Transcription</label>
                  <textarea
                    id="transcription-input"
                    className="textarea-field"
                    value={transcription}
                    onChange={(e) => setTranscription(e.target.value)}
                    placeholder="Your spoken transaction will appear here..."
                    disabled={isLoading}
                  />
                  <button className="btn btn-primary btn-full" onClick={processTextIntent} disabled={isLoading || !transcription.trim()}>
                    {isLoading ? <><Loader2 size={16} className="spin" /> Processing with Gemma...</> : <><CheckCircle2 size={16} /> Confirm & Parse Transaction</>}
                  </button>
                </div>
              </div>

              <div className="card">
                {parsedResult ? (
                  <div className="parsed-output">
                    <div className="parsed-header">
                      <h3>Transaction Decoded</h3>
                      <span className={`badge badge-${parsedResult.parsed_data.type}`}>{parsedResult.parsed_data.type}</span>
                    </div>
                    <div className="detail-grid">
                      <div className="detail-item"><span className="detail-label">Customer</span><span className="detail-value">{parsedResult.parsed_data.customer_name || "General / Cash"}</span></div>
                      <div className="detail-item"><span className="detail-label">Total Value</span><span className="detail-value highlight">₦{parsedResult.parsed_data.total_amount.toLocaleString()}</span></div>
                      <div className="detail-item"><span className="detail-label">Amount Paid</span><span className="detail-value">₦{parsedResult.parsed_data.amount_paid.toLocaleString()}</span></div>
                      <div className="detail-item"><span className="detail-label">Amount Owed</span><span className={`detail-value ${parsedResult.parsed_data.amount_owed > 0 ? "danger" : ""}`}>₦{parsedResult.parsed_data.amount_owed.toLocaleString()}</span></div>
                    </div>
                    <div className="items-section">
                      <h4>Items</h4>
                      {parsedResult.parsed_data.items.map((item, idx) => (
                        <div className="item-row" key={idx}>
                          <span className="item-name">{item.name} × {item.quantity}</span>
                          <span className="item-price">₦{(item.quantity * item.unit_price).toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                    {parsedResult.warnings && parsedResult.warnings.length > 0 ? (
                      <div className="warnings-box">
                        <h4><AlertTriangle size={14} /> Audit Alerts</h4>
                        <ul>{parsedResult.warnings.map((w, idx) => <li key={idx}>{w}</li>)}</ul>
                      </div>
                    ) : (
                      <div className="clean-audit"><CheckCircle2 size={16} /> Audit clean — prices match restock rates</div>
                    )}
                  </div>
                ) : (
                  <div className="empty-state">
                    <div className="empty-icon"><BarChart3 size={24} /></div>
                    <div className="empty-title">No transaction parsed yet</div>
                    <div className="empty-desc">Record a transaction to see AI-powered analysis here.</div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* ─── Transactions View ─── */}
        {activeView === "transactions" && (
          <>
            <div className="page-header">
              <h2>Transaction History</h2>
              <p className="page-subtitle">All recorded transactions</p>
            </div>
            <div className="card">
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Type</th>
                      <th>Customer</th>
                      <th>Items</th>
                      <th className="text-right">Total</th>
                      <th className="text-right">Paid</th>
                      <th className="text-right">Owed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.length === 0 ? (
                      <tr><td colSpan={7} className="table-empty">No transactions recorded yet.</td></tr>
                    ) : (
                      transactions.map((tx) => (
                        <tr key={tx.id}>
                          <td><Clock size={12} style={{ marginRight: 6, opacity: 0.4 }} />{new Date(tx.timestamp).toLocaleString()}</td>
                          <td><span className={`badge badge-${tx.type}`}>{tx.type}</span></td>
                          <td className="text-primary">{tx.customer_name || "General"}</td>
                          <td>{tx.items?.map((it) => `${it.name} (${it.quantity})`).join(", ") || "—"}</td>
                          <td className="text-right text-primary">₦{tx.total_amount.toLocaleString()}</td>
                          <td className="text-right">₦{tx.amount_paid.toLocaleString()}</td>
                          <td className={`text-right ${tx.amount_owed > 0 ? "text-danger" : ""}`}>₦{tx.amount_owed.toLocaleString()}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {/* ─── Inventory View ─── */}
        {activeView === "inventory" && (
          <>
            <div className="page-header">
              <h2>Product Inventory</h2>
              <p className="page-subtitle">Stock levels and cost baselines</p>
            </div>
            <div className="card">
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="text-right">Stock</th>
                      <th>Unit</th>
                      <th className="text-right">Cost Price</th>
                      <th className="text-right">Selling Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inventory.length === 0 ? (
                      <tr><td colSpan={5} className="table-empty">No products in inventory yet.</td></tr>
                    ) : (
                      inventory.map((prod) => (
                        <tr key={prod.id}>
                          <td className="text-primary">{prod.name}</td>
                          <td className={`text-right ${prod.stock_quantity < 5 ? "text-danger" : ""}`}>{prod.stock_quantity}</td>
                          <td>{prod.unit}</td>
                          <td className="text-right">₦{prod.cost_price.toLocaleString()}</td>
                          <td className="text-right">₦{prod.selling_price.toLocaleString()}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {/* ─── AI Companion View ─── */}
        {activeView === "companion" && (
          <>
            <div className="page-header">
              <h2>AI Companion</h2>
              <p className="page-subtitle">Your personal business advisor</p>
            </div>

            <div className="companion-layout">
              <div className="card companion-card">
                {companionHistory.length === 0 ? (
                  <div className="companion-welcome">
                    <div className="companion-avatar-large"><Bot size={40} /></div>
                    <h3>Hi! I'm your MarketGuard AI Companion</h3>
                    <p>Ask me anything about your business — pricing strategy, debt management, inventory tips, or just for encouragement.</p>
                    <div className="companion-suggestions">
                      <button className="suggestion-chip" onClick={() => { setCompanionInput("What should I do about customers who owe me money?"); }}>
                        <CircleDollarSign size={14} /> Debt management tips
                      </button>
                      <button className="suggestion-chip" onClick={() => { setCompanionInput("How can I increase my sales this week?"); }}>
                        <TrendingUp size={14} /> Boost my sales
                      </button>
                      <button className="suggestion-chip" onClick={() => { setCompanionInput("What products should I restock?"); }}>
                        <Package size={14} /> Restock advice
                      </button>
                      <button className="suggestion-chip" onClick={() => { setCompanionInput("Give me a motivation to keep going!"); }}>
                        <Sparkles size={14} /> Motivate me
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="companion-messages">
                    {companionHistory.map((msg, idx) => (
                      <div className="chat-msg-group" key={idx}>
                        <div className="chat-bubble chat-bubble-user"><Users size={12} style={{ marginRight: 6, opacity: 0.7 }} />{msg.q}</div>
                        <div className="chat-bubble chat-bubble-ai"><Bot size={12} style={{ marginRight: 6, opacity: 0.5 }} />{msg.a}</div>
                      </div>
                    ))}
                    <div ref={companionEndRef} />
                  </div>
                )}

                <div className="companion-input-row">
                  <input
                    className="chat-input"
                    value={companionInput}
                    onChange={(e) => setCompanionInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") sendCompanion(); }}
                    placeholder="Ask your AI companion..."
                    disabled={companionLoading}
                  />
                  <button className="btn btn-primary" onClick={sendCompanion} disabled={companionLoading || !companionInput.trim()}>
                    {companionLoading ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      <style>{`
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
