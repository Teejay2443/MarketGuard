import { useState, useEffect, useRef } from "react";
import "./App.css";

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

function getToken(): string | null {
  return localStorage.getItem("ojaguard_token");
}

function setToken(t: string) {
  localStorage.setItem("ojaguard_token", t);
}

function clearToken() {
  localStorage.removeItem("ojaguard_token");
}

async function apiFetch(path: string, options: RequestInit = {}) {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
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

export default function App() {
  // Auth states
  const [token, setTokenState] = useState<string | null>(getToken());
  const [user, setUser] = useState<{ id: number; username: string; display_name: string } | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");

  const [isRecording, setIsRecording] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [transcription, setTranscription] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // App states
  const [mode, setMode] = useState("local");
  const [inventory, setInventory] = useState<Product[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [parsedResult, setParsedResult] = useState<{
    transaction_id: number;
    parsed_data: ParsedData;
    warnings: string[];
  } | null>(null);

  // Q&A states
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

  const fetchMode = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/health`);
      const data = await res.json();
      if (data.mode) setMode(data.mode);
    } catch {
      // ignore
    }
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

  // --- Auth ---
  const fetchMe = async () => {
    try {
      const res = await apiFetch("/auth/me");
      if (res.ok) setUser(await res.json());
    } catch { /* ignore */ }
  };

  const doAuth = async () => {
    setAuthError("");
    if (authPassword.length < 4) { setAuthError("Password must be at least 4 characters"); return; }
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
      setToken(data.token);
      setTokenState(data.token);
      setUser(data.user);
    } catch {
      setAuthError("Connection failed. Is the backend running?");
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

  const sendQuery = async () => {
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
    } catch (err: any) {
      setChatHistory((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { q, a: `Sorry, I couldn't answer that. ${err.message}` };
        return updated;
      });
    } finally {
      setQueryLoading(false);
    }
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  const startRecording = async () => {
    setError(null);
    audioChunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/wav" });
        const url = URL.createObjectURL(audioBlob);
        setAudioUrl(url);
        uploadAudio(audioBlob);
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      setError("Microphone access denied or not supported.");
      console.error(err);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      // Stop all audio tracks to release microphone
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      setIsRecording(false);
    }
  };

  const uploadAudio = async (blob: Blob) => {
    setIsLoading(true);
    setError(null);
    const formData = new FormData();
    formData.append("file", blob, "recording.wav");

    try {
      const res = await apiFetch("/transcribe", { method: "POST", body: formData });
      if (!res.ok) throw new Error("STT server error");
      const data = await res.json();
      setTranscription(data.transcription);
    } catch (err) {
      setError("Failed to transcribe audio. Ensure backend is running.");
      console.error(err);
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
    } catch (err: any) {
      setError(err.message || "Failed to process transaction with Gemma.");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="app-container">

      {!token ? (
        <div className="auth-card">
          <div className="auth-box">
            <div className="auth-logo">
              <span className="shield-icon">🛡️</span>
              <h1>OjaGuard AI</h1>
              <p className="subtitle">Voice Auditor for the Informal Economy</p>
            </div>
            <h2>{authMode === "login" ? "Sign In" : "Create Account"}</h2>
            <p className="section-desc">No email needed. Just pick a username and password.</p>
            {authError && <div className="error-message">⚠️ {authError}</div>}
            <input className="auth-input" placeholder="Username" value={authUsername} onChange={(e) => setAuthUsername(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doAuth(); }} />
            <input className="auth-input" type="password" placeholder="Password (4+ characters)" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doAuth(); }} />
            <button className="btn btn-primary auth-btn" onClick={doAuth}>
              {authMode === "login" ? "Sign In" : "Create Account"}
            </button>
            <p className="auth-toggle">
              {authMode === "login" ? (
                <>Don't have an account? <a href="#" onClick={(e) => { e.preventDefault(); setAuthMode("register"); setAuthError(""); }}>Create one</a></>
              ) : (
                <>Already have an account? <a href="#" onClick={(e) => { e.preventDefault(); setAuthMode("login"); setAuthError(""); }}>Sign in</a></>
              )}
            </p>
          </div>
        </div>
      ) : (
        <>
      <header className="app-header">
        <div className="logo-section">
          <div className="shield-icon">🛡️</div>
          <div>
            <h1>OjaGuard AI</h1>
            <p className="subtitle">Voice Auditor for the Informal Economy</p>
          </div>
        </div>
        <div className="header-right">
          {user && <span className="user-name">{user.display_name || user.username}</span>}
          <div className="offline-badge">
            <span className="dot"></span> {mode === "cloud" ? "Cloud Mode" : "Local Mode"}
          </div>
          <button className="btn btn-logout" onClick={logout}>Logout</button>
        </div>
      </header>

      <main className="app-grid">
        {/* Left Column: Voice Recording and Intent Extraction */}
        <section className="card voice-section">
          <h2>Record Transaction</h2>
          <p className="section-desc">Speak in Yoruba, Pidgin, or English to log sales or restocks.</p>
          
          <div className="voice-controller">
            <button 
              className={`mic-button ${isRecording ? "recording" : ""}`}
              onClick={isRecording ? stopRecording : startRecording}
              disabled={isLoading}
            >
              <span className="mic-icon">🎤</span>
            </button>
            <p className="mic-status">
              {isRecording ? "Listening... Click to Stop" : "Click to Speak"}
            </p>
          </div>

          {audioUrl && (
            <div className="audio-playback">
              <audio src={audioUrl} controls />
            </div>
          )}

          {error && <div className="error-message">⚠️ {error}</div>}

          <div className="transcription-box">
            <label htmlFor="transcription-input">Transcription (Edit if needed):</label>
            <textarea
              id="transcription-input"
              value={transcription}
              onChange={(e) => setTranscription(e.target.value)}
              placeholder="Your spoken transaction will appear here..."
              disabled={isLoading}
            />
            <button 
              className="btn btn-primary"
              onClick={processTextIntent}
              disabled={isLoading || !transcription.trim()}
            >
              {isLoading ? "Processing with Gemma..." : "Confirm & Parse Transaction"}
            </button>
          </div>
        </section>

        {/* Right Column: Gemma Output & Business Intelligence Alerts */}
        <section className="card results-section">
          <h2>Merchant Intelligence & Alerts</h2>
          
          {parsedResult ? (
            <div className="parsed-output animate-fade-in">
              <div className="audit-header">
                <h3>Transaction Decoded</h3>
                <span className={`badge badge-${parsedResult.parsed_data.type}`}>
                  {parsedResult.parsed_data.type}
                </span>
              </div>
              
              <div className="details-list">
                <p><strong>Customer:</strong> {parsedResult.parsed_data.customer_name || "General/Cash"}</p>
                <p><strong>Total Value:</strong> ₦{parsedResult.parsed_data.total_amount.toLocaleString()}</p>
                <p><strong>Amount Paid:</strong> ₦{parsedResult.parsed_data.amount_paid.toLocaleString()}</p>
                <p><strong>Amount Owed:</strong> ₦{parsedResult.parsed_data.amount_owed.toLocaleString()}</p>
              </div>

              <h4>Items:</h4>
              <ul className="items-list">
                {parsedResult.parsed_data.items.map((item, idx) => (
                  <li key={idx}>
                    <span>{item.name} x {item.quantity}</span>
                    <span>₦{(item.quantity * item.unit_price).toLocaleString()}</span>
                  </li>
                ))}
              </ul>

              {parsedResult.warnings && parsedResult.warnings.length > 0 ? (
                <div className="warnings-container">
                  <h4>⚠️ Audit Alerts (Revenue Leakage Detected)</h4>
                  <ul>
                    {parsedResult.warnings.map((w, idx) => (
                      <li key={idx} className="warning-item">{w}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="clean-audit">
                  ✅ Audit clean. Prices match restock rates!
                </div>
              )}
            </div>
          ) : (
            <div className="empty-state">
              <span className="empty-icon">📊</span>
              <p>No transaction parsed yet. Record or type a transaction to audit it.</p>
            </div>
          )}
        </section>

        {/* Full Width Bottom Column: Inventory & History */}
        <section className="card table-card full-width">
          <div className="tabs-header">
            <h2>Local Ledger (Transaction History)</h2>
          </div>
          
          <div className="table-responsive">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Customer</th>
                  <th>Items</th>
                  <th>Total</th>
                  <th>Paid</th>
                  <th>Owed</th>
                </tr>
              </thead>
              <tbody>
                {transactions.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center">No transactions recorded yet.</td>
                  </tr>
                ) : (
                  transactions.map((tx) => (
                    <tr key={tx.id}>
                      <td>{new Date(tx.timestamp).toLocaleTimeString()}</td>
                      <td>
                        <span className={`badge badge-${tx.type}`}>{tx.type}</span>
                      </td>
                      <td>{tx.customer_name || "General"}</td>
                      <td>
                        {tx.items?.map((it) => `${it.name} (${it.quantity})`).join(", ") || "-"}
                      </td>
                      <td>₦{tx.total_amount.toLocaleString()}</td>
                      <td>₦{tx.amount_paid.toLocaleString()}</td>
                      <td className={tx.amount_owed > 0 ? "text-danger" : ""}>
                        ₦{tx.amount_owed.toLocaleString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card table-card full-width">
          <h2>Product Inventory & Cost Baseline</h2>
          
          <div className="table-responsive">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Product Name</th>
                  <th>Current Stock</th>
                  <th>Unit</th>
                  <th>Restock Cost Price</th>
                  <th>Selling Price Limit</th>
                </tr>
              </thead>
              <tbody>
                {inventory.map((prod) => (
                  <tr key={prod.id}>
                    <td>{prod.name}</td>
                    <td>{prod.stock_quantity}</td>
                    <td>{prod.unit}</td>
                    <td>₦{prod.cost_price.toLocaleString()}</td>
                    <td>₦{prod.selling_price.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Q&A Section */}
        <section className="card full-width">
          <h2>Ask Your Business</h2>
          <p className="section-desc">Ask questions like "Who owes me?" or "How much did I sell today?"</p>
          <div className="chat-box">
            {chatHistory.length === 0 ? (
              <div className="chat-empty">
                <span className="empty-icon">💬</span>
                <p>Ask a question about your business to get started.</p>
              </div>
            ) : (
              <div className="chat-messages">
                {chatHistory.map((msg, idx) => (
                  <div key={idx} className="chat-message">
                    <div className="chat-msg chat-msg-user">{msg.q}</div>
                    <div className="chat-msg chat-msg-ai">{msg.a}</div>
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
                placeholder="Ask a question..."
                disabled={queryLoading}
              />
              <button className="btn btn-primary" onClick={sendQuery} disabled={queryLoading || !queryInput.trim()}>
                {queryLoading ? "..." : "Ask"}
              </button>
            </div>
          </div>
        </section>
      </main>
      </>
      )}
    </div>
  );
}
