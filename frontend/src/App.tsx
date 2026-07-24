import { useState, useEffect, useRef, useCallback } from "react";
import {
  Shield, Mic, MicOff, Send, MessageSquare, Package,
  Receipt, AlertTriangle, CheckCircle2, LogOut, TrendingUp,
  CircleDollarSign, Users, Sparkles,
  ArrowRight, Loader2, Clock, BarChart3, Sun, Moon,
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
  /* Theme: light default */
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
    transaction_id: number;
    parsed_data: ParsedData;
    warnings: string[];
  } | null>(null);

  const [queryInput, setQueryInput] = useState("");
  const [queryLoading, setQueryLoading] = useState(false);
  const [chatHistory, setChatHistory] = useState<{ q: string; a: string }[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);

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
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

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
      const data = await res.json();
      setInventory(data);
    } catch (err) {
      console.error("Failed to fetch inventory", err);
    }
  };

  const fetchTransactions = async () => {
    try {
      const res = await apiFetch("/transactions");
      const data = await res.json();
      setTransactions(data);
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
    setChatHistory([]);
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

  const sendQuery = useCallback(async () => {
    const q = queryInput.trim();
    if (!q || queryLoading) return;
    setQueryLoading(true);
    setChatHistory((prev) => [...prev, { q, a: "Thinking..." }]);
    setQueryInput("");
    try {
      const res = await apiFetch("/query", {
        method: "POST",
        body: JSON.stringify({ question: q }),
      });
      if (!res.ok) throw new Error("Query failed");
      const data = await res.json();
      setChatHistory((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { q, a: data.answer };
        return updated;
      });
    } catch (err: unknown) {
      setChatHistory((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { q, a: `Sorry, I couldn't answer that. ${err instanceof Error ? err.message : ""}` };
        return updated;
      });
    } finally {
      setQueryLoading(false);
    }
  }, [queryInput, queryLoading]);

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

  /* ─── Landing Page ─── */
  if (!token) {
    return (
      <div className="landing-page">
        {/* Nav */}
        <nav className="landing-nav">
          <div className="landing-logo">
            <div className="logo-mark">
              <Shield size={18} color="white" />
            </div>
            <span>MarketGuard</span>
          </div>
          <div className="landing-nav-actions">
            <ThemeToggle />
            <button className="btn btn-ghost btn-sm" onClick={() => setAuthMode("login")}>
              Sign In
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => setAuthMode("register")}>
              Get Started
            </button>
          </div>
        </nav>

        {/* Hero */}
        <section className="landing-hero">
          <div className="hero-content">
            <div className="hero-badge">
              <span className="badge-dot" />
              Powered by Gemma 4
            </div>
            <h1>
              Your business speaks.<br />
              <span className="gradient-text">AI remembers.</span>
            </h1>
            <p className="hero-desc">
              The voice-powered business assistant for Nigeria's informal economy.
              No typing. No complicated forms. Just talk naturally in English,
              Pidgin, or Yoruba.
            </p>
            <div className="hero-actions">
              <button className="btn btn-primary" onClick={() => setAuthMode("register")}>
                Start Free <ArrowRight size={16} />
              </button>
              <button className="btn btn-secondary" onClick={() => setAuthMode("login")}>
                Sign In
              </button>
            </div>
          </div>
          <div className="hero-visual">
            <div className="phone-mockup">
              <div className="phone-notch">
                <div className="phone-notch-bar" />
              </div>
              <div className="phone-header">
                <Mic size={16} />
                Voice Transaction
              </div>
              <div className="phone-body">
                <div className="phone-msg phone-msg-user">
                  "I sell two bags of rice to Mama Ngozi for 96,000"
                </div>
                <div className="phone-msg phone-msg-ai success">
                  ✅ Recorded: SALE — 2 Rice, ₦96,000. Stock updated.
                </div>
                <div className="phone-msg phone-msg-user">
                  "How much did I sell today?"
                </div>
                <div className="phone-msg phone-msg-ai">
                  You sold ₦152,000 today across 3 transactions.
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="landing-features">
          <div className="section-header">
            <h2>How it works</h2>
            <p>Speak naturally. MarketGuard handles the rest.</p>
          </div>
          <div className="features-grid">
            <div className="feature-card">
              <div className="feature-icon"><Mic size={20} /></div>
              <h3>Speak Naturally</h3>
              <p>Talk in English, Nigerian Pidgin, or Yoruba. MarketGuard understands you.</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon"><Sparkles size={20} /></div>
              <h3>AI Processes</h3>
              <p>Gemma 4 extracts sales, debts, restocks — no forms to fill.</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon"><BarChart3 size={20} /></div>
              <h3>Instant Records</h3>
              <p>Transactions saved, inventory updated, debts tracked — automatically.</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon"><AlertTriangle size={20} /></div>
              <h3>Smart Alerts</h3>
              <p>Get warned when you sell below cost or when customers owe you money.</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon"><MessageSquare size={20} /></div>
              <h3>Ask Questions</h3>
              <p>"How much did I sell today?" "Who owes me?" — get instant answers.</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon"><Shield size={20} /></div>
              <h3>Privacy First</h3>
              <p>Your data is yours. Each trader has their own private workspace.</p>
            </div>
          </div>
        </section>

        {/* Demo Accounts */}
        <section className="landing-demo">
          <div className="section-header">
            <h2>Try it now</h2>
            <p>Click a demo account to auto-fill credentials.</p>
          </div>
          <div className="demo-cards">
            <button
              type="button"
              className="demo-card"
              onClick={() => {
                setAuthMode("login");
                setAuthUsername("trader_a");
                setAuthPassword("pass1234");
                window.scrollTo({ top: document.getElementById("auth-section")?.offsetTop ?? 0, behavior: "smooth" });
              }}
            >
              <span className="demo-user">trader_a</span>
              <span className="demo-pass">pass1234</span>
            </button>
            <button
              type="button"
              className="demo-card"
              onClick={() => {
                setAuthMode("login");
                setAuthUsername("trader_b");
                setAuthPassword("pass1234");
                window.scrollTo({ top: document.getElementById("auth-section")?.offsetTop ?? 0, behavior: "smooth" });
              }}
            >
              <span className="demo-user">trader_b</span>
              <span className="demo-pass">pass1234</span>
            </button>
            <button
              type="button"
              className="demo-card"
              onClick={() => {
                setAuthMode("login");
                setAuthUsername("trader_c");
                setAuthPassword("pass1234");
                window.scrollTo({ top: document.getElementById("auth-section")?.offsetTop ?? 0, behavior: "smooth" });
              }}
            >
              <span className="demo-user">trader_c</span>
              <span className="demo-pass">pass1234</span>
            </button>
          </div>
        </section>

        {/* Auth */}
        <section className="landing-auth" id="auth-section">
          <div className="card auth-card">
            <h2>{authMode === "login" ? "Welcome back" : "Create your account"}</h2>
            <p className="auth-subtitle">
              {authMode === "login" ? "Sign in to your workspace" : "No email needed. Just a username and password."}
            </p>
            {authError && <div className="error-banner"><AlertTriangle size={14} /> {authError}</div>}
            <div className="auth-fields">
              <div className="text-field">
                <label>Username</label>
                <input
                  placeholder="Enter your username"
                  value={authUsername}
                  onChange={(e) => setAuthUsername(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") doAuth(); }}
                  autoFocus
                />
              </div>
              <div className="text-field">
                <label>Password</label>
                <input
                  type="password"
                  placeholder="4+ characters"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") doAuth(); }}
                />
              </div>
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

        {/* Footer */}
        <footer className="landing-footer">
          <p><span className="footer-brand">MarketGuard</span> — Built for Nigeria's 40 million micro-merchants</p>
          <p>Powered by Gemma 4. Hackathon MVP.</p>
        </footer>
      </div>
    );
  }

  /* ─── Dashboard ─── */
  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="logo-section">
          <div className="logo-mark">
            <Shield size={20} color="white" />
          </div>
          <div>
            <h1>MarketGuard</h1>
            <span className="header-subtitle">Voice Auditor for the Informal Economy</span>
          </div>
        </div>
        <div className="header-right">
          <ThemeToggle />
          <div className="mode-badge">
            <span className="pulse-dot" />
            {mode === "cloud" ? "Cloud" : "Local"}
          </div>
          {user && (
            <div className="user-chip">
              <div className="avatar">{(user.display_name || user.username)[0].toUpperCase()}</div>
              {user.display_name || user.username}
            </div>
          )}
          <button className="btn-ghost" onClick={logout}>
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      </header>

      {/* Stats Row */}
      <div className="stats-row" style={{ marginBottom: "var(--sp-6)" }}>
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

      {/* Main Grid */}
      <div className="dashboard-grid">
        {/* Voice Recording */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title"><Mic size={18} /> Record Transaction</div>
              <div className="card-subtitle">Speak in Yoruba, Pidgin, or English</div>
            </div>
          </div>

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
            <div className="audio-player">
              <audio src={audioUrl} controls />
            </div>
          )}

          {error && (
            <div className="error-banner">
              <AlertTriangle size={14} /> {error}
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
            <button
              className="btn btn-primary btn-full"
              onClick={processTextIntent}
              disabled={isLoading || !transcription.trim()}
            >
              {isLoading ? (
                <><Loader2 size={16} className="spin" /> Processing with Gemma...</>
              ) : (
                <><CheckCircle2 size={16} /> Confirm & Parse Transaction</>
              )}
            </button>
          </div>
        </div>

        {/* Parsed Output / Alerts */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title"><Sparkles size={18} /> Intelligence & Alerts</div>
              <div className="card-subtitle">AI-decoded transaction details</div>
            </div>
          </div>

          {parsedResult ? (
            <div className="parsed-output">
              <div className="parsed-header">
                <h3>Transaction Decoded</h3>
                <span className={`badge badge-${parsedResult.parsed_data.type}`}>
                  {parsedResult.parsed_data.type}
                </span>
              </div>

              <div className="detail-grid">
                <div className="detail-item">
                  <span className="detail-label">Customer</span>
                  <span className="detail-value">{parsedResult.parsed_data.customer_name || "General / Cash"}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Total Value</span>
                  <span className="detail-value highlight">₦{parsedResult.parsed_data.total_amount.toLocaleString()}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Amount Paid</span>
                  <span className="detail-value">₦{parsedResult.parsed_data.amount_paid.toLocaleString()}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Amount Owed</span>
                  <span className={`detail-value ${parsedResult.parsed_data.amount_owed > 0 ? "danger" : ""}`}>
                    ₦{parsedResult.parsed_data.amount_owed.toLocaleString()}
                  </span>
                </div>
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
                  <ul>
                    {parsedResult.warnings.map((w, idx) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="clean-audit">
                  <CheckCircle2 size={16} /> Audit clean — prices match restock rates
                </div>
              )}
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon"><BarChart3 size={24} /></div>
              <div className="empty-title">No transaction parsed yet</div>
              <div className="empty-desc">Record or type a transaction to see AI-powered analysis here.</div>
            </div>
          )}
        </div>

        {/* Transaction History */}
        <div className="card span-full">
          <div className="card-header">
            <div>
              <div className="card-title"><Clock size={18} /> Transaction History</div>
              <div className="card-subtitle">All recorded transactions</div>
            </div>
          </div>
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
                  <tr>
                    <td colSpan={7} className="table-empty">No transactions recorded yet.</td>
                  </tr>
                ) : (
                  transactions.map((tx) => (
                    <tr key={tx.id}>
                      <td><Clock size={12} style={{ marginRight: 6, opacity: 0.4 }} />{new Date(tx.timestamp).toLocaleTimeString()}</td>
                      <td><span className={`badge badge-${tx.type}`}>{tx.type}</span></td>
                      <td className="text-primary">{tx.customer_name || "General"}</td>
                      <td>{tx.items?.map((it) => `${it.name} (${it.quantity})`).join(", ") || "—"}</td>
                      <td className="text-right text-primary">₦{tx.total_amount.toLocaleString()}</td>
                      <td className="text-right">₦{tx.amount_paid.toLocaleString()}</td>
                      <td className={`text-right ${tx.amount_owed > 0 ? "text-danger" : ""}`}>
                        ₦{tx.amount_owed.toLocaleString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Inventory */}
        <div className="card span-full">
          <div className="card-header">
            <div>
              <div className="card-title"><Package size={18} /> Product Inventory</div>
              <div className="card-subtitle">Stock levels and cost baselines</div>
            </div>
          </div>
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
                  <tr>
                    <td colSpan={5} className="table-empty">No products in inventory yet.</td>
                  </tr>
                ) : (
                  inventory.map((prod) => (
                    <tr key={prod.id}>
                      <td className="text-primary">{prod.name}</td>
                      <td className="text-right">{prod.stock_quantity}</td>
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

        {/* Q&A Chat */}
        <div className="card span-full">
          <div className="card-header">
            <div>
              <div className="card-title"><MessageSquare size={18} /> Ask Your Business</div>
              <div className="card-subtitle">Ask anything — "Who owes me?" "How much did I sell today?"</div>
            </div>
          </div>

          <div className="chat-container">
            {chatHistory.length === 0 ? (
              <div className="chat-empty">
                <div className="empty-icon"><MessageSquare size={24} /></div>
                <div className="empty-title">Ask a question</div>
                <div className="empty-desc">Get instant answers about your sales, debts, and inventory.</div>
              </div>
            ) : (
              <div className="chat-messages">
                {chatHistory.map((msg, idx) => (
                  <div className="chat-msg-group" key={idx}>
                    <div className="chat-bubble chat-bubble-user">
                      <Users size={12} style={{ marginRight: 6, opacity: 0.7 }} />
                      {msg.q}
                    </div>
                    <div className="chat-bubble chat-bubble-ai">
                      <Sparkles size={12} style={{ marginRight: 6, opacity: 0.5 }} />
                      {msg.a}
                    </div>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
            )}
            <div className="chat-input-row">
              <input
                className="chat-input"
                value={queryInput}
                onChange={(e) => setQueryInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") sendQuery(); }}
                placeholder="Ask a question about your business..."
                disabled={queryLoading}
              />
              <button
                className="btn btn-primary"
                onClick={sendQuery}
                disabled={queryLoading || !queryInput.trim()}
              >
                {queryLoading ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Spin animation */}
      <style>{`
        .spin {
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
