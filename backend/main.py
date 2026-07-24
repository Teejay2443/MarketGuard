import os
import shutil
import tempfile
import json
import hashlib
import secrets
import time
from fastapi import FastAPI, UploadFile, File, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from typing import List, Optional

# Local imports
import database

# --- Auth ---
SECRET_KEY = os.getenv("JWT_SECRET", "marketguard-secret-key-change-in-production")
auth_scheme = HTTPBearer(auto_error=False)

# --- Mode Selection ---
# LLM_MODE = "local"  -> uses Ollama (Gemma 2B locally)
# LLM_MODE = "cloud"  -> uses Gemini API (Gemma hosted)
LLM_MODE = os.getenv("LLM_MODE", "local").lower()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMMA_MODEL = os.getenv("GEMMA_MODEL", "gemma-4-31b-it")

PROMPT_TEMPLATE = """
You are MarketGuard AI, a local business intelligence auditor for Nigerian micro-merchants.
Your task is to parse unstructured text spoken by a trader (which might be in Nigerian Pidgin, Yoruba, or English) and extract a structured transaction JSON.

Transaction Types:
- SALE: Trader sold goods (could be paid full, part-paid, or not paid).
- CREDIT: Customer bought goods on credit (amount_owed > 0).
- RESTOCK: Trader purchased more goods to top up their inventory (increases stock).

You MUST output ONLY valid JSON matching this schema:
{
  "type": "SALE" | "CREDIT" | "RESTOCK",
  "customer_name": "string or null (especially needed for CREDIT)",
  "total_amount": number (total value of goods sold/bought),
  "amount_paid": number (cash received right now),
  "amount_owed": number (remaining balance to be paid later),
  "items": [
    {
      "name": "string (standardized name of product e.g., Rice, Beans, Garri, Palm Oil)",
      "quantity": number,
      "unit_price": number (price per unit)
    }
  ]
}

Guidelines:
1. Standardize item names to start with a Capital letter (e.g. "rice" -> "Rice").
2. Calculate total_amount if not explicitly mentioned by multiplying quantity by unit_price.
3. If the language is Yoruba, translate names of goods to English in the JSON (e.g., "iresi" -> "Rice", "ewa" -> "Beans", "epo pupa" -> "Palm Oil").
4. Output nothing else but the raw JSON object. Do not include markdown code block formatting (no ```json).

Example Pidgin input: "I sell two paint rubber of beans to Iya Basira, she pay 15000, she owe 5000"
Example output JSON:
{
  "type": "CREDIT",
  "customer_name": "Iya Basira",
  "total_amount": 20000,
  "amount_paid": 15000,
  "amount_owed": 5000,
  "items": [
    {
      "name": "Beans",
      "quantity": 2,
      "unit_price": 10000
    }
  ]
}
"""

# Initialize cloud LLM client if in cloud mode
genai_client = None
if LLM_MODE == "cloud":
    if not GEMINI_API_KEY:
        raise RuntimeError("LLM_MODE=cloud but GEMINI_API_KEY is not set")
    import google.generativeai as genai
    genai.configure(api_key=GEMINI_API_KEY)
    genai_client = genai.GenerativeModel(
        GEMMA_MODEL,
        system_instruction=PROMPT_TEMPLATE
    )
    print(f"Cloud mode: using {GEMMA_MODEL} via Gemini API")

app = FastAPI(title="MarketGuard AI Backend", description="Offline Voice-First Auditor Engine")

# Enable CORS for frontend connection
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global variables for models (lazy loaded)
whisper_model = None

def get_whisper():
    global whisper_model
    if whisper_model is None:
        try:
            from faster_whisper import WhisperModel
            # Using CPU and int8 quantization to save memory on standard local laptops
            print("Loading Whisper model...")
            whisper_model = WhisperModel("tiny", device="cpu", compute_type="int8")
            print("Whisper model loaded successfully!")
        except Exception as e:
            print(f"Error loading Whisper model: {e}")
            raise HTTPException(status_code=500, detail=f"Whisper STT engine failed to load: {e}")
    return whisper_model

class ParseRequest(BaseModel):
    text: str

class QueryRequest(BaseModel):
    question: str

class AuthRequest(BaseModel):
    username: str
    password: str

def make_token(user: dict) -> str:
    payload = json.dumps({"id": user["id"], "username": user["username"], "exp": time.time() + 86400 * 7})
    sig = hashlib.sha256((payload + SECRET_KEY).encode()).hexdigest()
    return f"{payload}.{sig}"

def verify_token(token: str) -> dict | None:
    try:
        payload_str, _, sig = token.rpartition(".")
        expected = hashlib.sha256((payload_str + SECRET_KEY).encode()).hexdigest()
        if sig != expected:
            return None
        payload = json.loads(payload_str)
        if payload.get("exp", 0) < time.time():
            return None
        return payload
    except Exception:
        return None

def require_auth(credentials: HTTPAuthorizationCredentials = Depends(auth_scheme)):
    if credentials is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = verify_token(credentials.credentials)
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return user

@app.on_event("startup")
def startup_event():
    # Ensure database is initialized
    database.init_db()

@app.get("/health")
def health():
    llm_status = "unknown"
    try:
        if LLM_MODE == "cloud":
            llm_status = "connected" if genai_client else "not initialized"
        else:
            import ollama
            ollama.list()
            llm_status = "connected"
    except Exception as e:
        llm_status = f"disconnected: {e}"

    return {
        "status": "healthy",
        "database": "connected",
        "mode": LLM_MODE,
        "llm": llm_status
    }

@app.post("/auth/register")
def register(req: AuthRequest):
    if len(req.password) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters")
    user = database.create_user(req.username.strip().lower(), req.password)
    if user is None:
        raise HTTPException(status_code=409, detail="Username already taken")
    database.seed_products_for_user(user["id"])
    token = make_token(user)
    return {"token": token, "user": user}

@app.post("/auth/login")
def login(req: AuthRequest):
    user = database.verify_user(req.username.strip().lower(), req.password)
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    token = make_token(user)
    return {"token": token, "user": user}

@app.get("/auth/me")
def me(user: dict = Depends(require_auth)):
    return user

@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...), user: dict = Depends(require_auth)):
    # Save uploaded file temporarily
    suffix = os.path.splitext(file.filename)[1]
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp_file:
        shutil.copyfileobj(file.file, tmp_file)
        tmp_path = tmp_file.name

    try:
        model = get_whisper()
        # Transcribe audio file
        # task="transcribe" preserves Yoruba/Pidgin, task="translate" translates to English
        # For a localized experience, we transcribe the native tongue and let Gemma interpret it.
        segments, info = model.transcribe(tmp_path, beam_size=5)
        transcription = " ".join([segment.text for segment in segments])
        
        return {
            "transcription": transcription,
            "language": info.language,
            "language_probability": info.language_probability
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

def clean_raw_output(raw: str, strip_json_markers: bool = True) -> str:
    output = raw.strip()
    if strip_json_markers and output.startswith("```"):
        lines = output.splitlines()
        if lines[0].startswith("```json") or lines[0] == "```":
            lines = lines[1:-1]
        output = "\n".join(lines).strip()
    return output

def call_llm(text: str, system_prompt: str = None) -> str:
    sp = system_prompt if system_prompt else PROMPT_TEMPLATE
    if LLM_MODE == "cloud":
        import google.generativeai as genai
        temp_model = genai.GenerativeModel(GEMMA_MODEL, system_instruction=sp)
        response = temp_model.generate_content(text)
        return clean_raw_output(response.text)
    else:
        import ollama
        response = ollama.chat(
            model='gemma2:2b',
            messages=[
                {'role': 'system', 'content': sp},
                {'role': 'user', 'content': text}
            ],
            options={'temperature': 0.1}
        )
        return clean_raw_output(response['message']['content'])

def extract_json_from_text(text: str) -> dict | None:
    """Try to extract a JSON object from text that may contain extra content."""
    text = text.strip()
    # Try direct parse first
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Try to find JSON object in the text
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            pass
    return None

REPAIR_PROMPT = """You previously output invalid JSON. You MUST fix it.
Output ONLY the raw JSON object. No markdown, no explanation, no code fences.
The previous invalid output was:
{raw_output}

Fix it and output ONLY valid JSON matching this schema:
{{
  "type": "SALE" | "CREDIT" | "RESTOCK",
  "customer_name": "string or null",
  "total_amount": number,
  "amount_paid": number,
  "amount_owed": number,
  "items": [{{ "name": "string", "quantity": number, "unit_price": number }}]
}}"""

FALLBACK_DATA = {
    "type": "SALE",
    "customer_name": None,
    "total_amount": 0,
    "amount_paid": 0,
    "amount_owed": 0,
    "items": []
}

@app.post("/process-intent")
async def process_intent(request: ParseRequest, user: dict = Depends(require_auth)):
    raw_output = ""
    try:
        # Attempt 1: Normal LLM call
        raw_output = call_llm(request.text)
        parsed_json = extract_json_from_text(raw_output)

        # Attempt 2: If invalid, try repair prompt
        if parsed_json is None:
            repair_msg = REPAIR_PROMPT.format(raw_output=raw_output)
            raw_output = call_llm(repair_msg)
            parsed_json = extract_json_from_text(raw_output)

        # Attempt 3: If still invalid, try one more time with stricter prompt
        if parsed_json is None:
            strict_prompt = f"""Output ONLY valid JSON. No text before or after. No markdown.
Transaction: {request.text}
{{
  "type": "SALE",
  "customer_name": null,
  "total_amount": 0,
  "amount_paid": 0,
  "amount_owed": 0,
  "items": []
}}"""
            raw_output = call_llm(strict_prompt, system_prompt="You are a JSON parser. Output ONLY valid JSON. Nothing else.")
            parsed_json = extract_json_from_text(raw_output)

        # Final fallback: Return with warning if all attempts fail
        if parsed_json is None:
            return {
                "success": True,
                "transaction_id": None,
                "parsed_data": FALLBACK_DATA,
                "warnings": ["AI could not parse the transaction. Please rephrase and try again."],
                "raw_output": raw_output,
                "hallucination": True
            }

        tx_id, warnings = database.add_transaction(
            user_id=user["id"],
            tx_type=parsed_json.get("type", "SALE"),
            customer_name=parsed_json.get("customer_name"),
            total_amount=parsed_json.get("total_amount", 0),
            amount_paid=parsed_json.get("amount_paid", 0),
            amount_owed=parsed_json.get("amount_owed", 0),
            items=parsed_json.get("items", [])
        )

        return {
            "success": True,
            "transaction_id": tx_id,
            "parsed_data": parsed_json,
            "warnings": warnings,
            "hallucination": False
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM Processing error: {e}")

@app.get("/inventory")
def get_inventory(user: dict = Depends(require_auth)):
    return database.get_all_products(user["id"])

@app.get("/transactions")
def get_transactions(user: dict = Depends(require_auth)):
    return database.get_all_transactions(user["id"])

COMPANION_PROMPT = """You are MarketGuard AI Companion — a friendly, knowledgeable business advisor for a Nigerian market trader.

You help with:
- Business strategy and pricing decisions
- Managing debts and credit customers
- Inventory optimization
- Market trends and competitive insights
- Financial literacy basics
- Motivation and encouragement

Rules:
- Be warm, friendly, and encouraging — like a trusted business partner
- Use simple English (no jargon). Pidgin is OK occasionally for warmth.
- Reference the trader's actual data when relevant (use Naira ₦ for amounts)
- Keep responses concise (2-4 sentences max unless detail is needed)
- If asked about something outside your scope, gently redirect to business topics
- Never make up data — if you don't know, say so honestly"""

@app.post("/companion")
async def companion_chat(request: QueryRequest, user: dict = Depends(require_auth)):
    try:
        # Get recent context about the user's business
        recent_txns = database.get_all_transactions(user["id"])
        products = database.get_all_products(user["id"])

        context_parts = []
        if recent_txns:
            recent = recent_txns[:5]
            context_parts.append(f"Recent transactions: {json.dumps([{'type': t['type'], 'amount': t['total_amount'], 'customer': t.get('customer_name', 'N/A')} for t in recent], default=str)}")
        if products:
            low_stock = [p for p in products if p['stock_quantity'] < 5]
            if low_stock:
                context_parts.append(f"Low stock items: {', '.join(p['name'] for p in low_stock)}")

        total_owed = sum(t['amount_owed'] for t in recent_txns)
        if total_owed > 0:
            context_parts.append(f"Total outstanding debts: ₦{total_owed:,}")

        context_str = "\n".join(context_parts) if context_parts else "No business data available yet."

        full_prompt = f"Trader's business context:\n{context_str}\n\nTrader's question: {request.question}"

        answer = call_llm(full_prompt, system_prompt=COMPANION_PROMPT)
        return {"answer": answer}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Companion error: {e}")

DB_SCHEMA_DESC = """
Tables:
- users (columns: id, username, password_hash, display_name, created_at)
- products (columns: id, user_id, name, stock_quantity, unit, cost_price, selling_price, updated_at)
- transactions (columns: id, user_id, type, customer_name, total_amount, amount_paid, amount_owed, timestamp)
- transaction_items (columns: id, transaction_id, product_name, quantity, unit_price)

Notes:
- products.name is unique per user (use UNIQUE(user_id, name))
- transactions.type is one of: SALE, CREDIT, RESTOCK
- amount_owed > 0 means customer still owes money
- SALE and CREDIT decrease stock; RESTOCK increases it
- transaction_items links to transactions via transaction_id
- Products and transactions are scoped to a user via user_id
"""

def make_sql_prompt(user_id: int) -> str:
    return f"""You are MarketGuard AI, a business intelligence SQL generator for a market trader's database.
{DB_SCHEMA_DESC}
IMPORTANT: Always filter by user_id = {user_id} in your queries. This user only sees their own data.
Given a question in natural language (English, Pidgin, or Yoruba), generate a SQL query to answer it.
Rules:
- Return ONLY the raw SQL query, no markdown, no explanation.
- Use only SELECT queries (never INSERT, UPDATE, DELETE).
- Use datetime('now', 'start of day') for "today".
- Sort results helpfully (e.g. DESC for recent).
- Limit results to 20 rows max.
- Use LIKE for name searches (case-insensitive matching).
- Always include 'WHERE user_id = {user_id}' for products and transactions tables."""

NL_ANSWER_PROMPT = """You are MarketGuard AI, a friendly business assistant for a Nigerian market trader.
Given the user's question and the data retrieved from the database, answer in plain, warm English.
Keep it short and useful — like speaking to a trader in the market.
If the data is empty, say so politely. Use Naira (₦) for currency amounts."""

def get_safe_sqlite_connection():
    import sqlite3
    db_path = os.getenv("DB_PATH", os.path.join(os.path.dirname(__file__), "marketguard.db"))
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn

def execute_query_safe(sql: str) -> list:
    sql_upper = sql.strip().upper()
    if not sql_upper.startswith("SELECT"):
        raise HTTPException(status_code=400, detail="Only SELECT queries are allowed")
    conn = get_safe_sqlite_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(sql)
        rows = [dict(r) for r in cursor.fetchall()]
        return rows
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Query failed: {e}")
    finally:
        conn.close()

@app.post("/query")
async def query(request: QueryRequest, user: dict = Depends(require_auth)):
    try:
        raw = call_llm(request.question, system_prompt=make_sql_prompt(user["id"]))
        sql = raw.strip()
        # Strip markdown code fences and any leading text
        if sql.startswith("```"):
            lines = sql.splitlines()
            sql = "\n".join(l for l in lines if not l.startswith("```")).strip()
        # Take only the first SQL statement (up to first semicolon or SELECT)
        if "SELECT" in sql.upper() or "select" in sql:
            idx = sql.upper().find("SELECT")
            sql = sql[idx:]
        idx = sql.find(";")
        if idx != -1:
            sql = sql[:idx]
        sql = sql.strip()
        data = execute_query_safe(sql)

        context = f"Question: {request.question}\nData: {json.dumps(data, default=str)}"
        answer = call_llm(context, system_prompt=NL_ANSWER_PROMPT)

        return {"question": request.question, "answer": answer, "sql": sql, "data": data}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Query error: {e}")
