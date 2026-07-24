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
LLM_MODE = os.getenv("LLM_MODE", "cloud").lower()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMMA_MODEL = os.getenv("GEMMA_MODEL", "gemma-2.5-flash")

# --- STT Mode Selection ---
# STT_MODE = "local"  -> uses faster-whisper (runs locally, no API key needed)
# STT_MODE = "cloud"  -> uses Google Cloud Speech-to-Text (better for Nigerian languages)
STT_MODE = os.getenv("STT_MODE", "local").lower()
GOOGLE_STT_API_KEY = os.getenv("GOOGLE_STT_API_KEY", "")

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
    try:
        import google.generativeai as genai
        genai.configure(api_key=GEMINI_API_KEY)
        genai_client = genai.GenerativeModel(
            GEMMA_MODEL,
            system_instruction=PROMPT_TEMPLATE
        )
        print(f"Cloud mode: using {GEMMA_MODEL} via Gemini API")
    except Exception as e:
        print(f"Warning: Failed to initialize cloud LLM: {e}")
        print("Falling back to local mode if available.")
        LLM_MODE = "local"

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
            print("Loading Whisper model (local STT)...")
            whisper_model = WhisperModel("tiny", device="cpu", compute_type="int8")
            print("Whisper model loaded successfully!")
        except Exception as e:
            print(f"Error loading Whisper model: {e}")
            raise HTTPException(status_code=500, detail=f"Whisper STT engine failed to load: {e}")
    return whisper_model

def transcribe_cloud(audio_path: str) -> dict:
    """Transcribe audio using Google Cloud Speech-to-Text API.
    
    Supports Nigerian languages (Yoruba, Pidgin English) with enhanced models.
    Falls back to basic model if enhanced is unavailable.
    """
    import requests
    
    if not GOOGLE_STT_API_KEY:
        raise HTTPException(status_code=500, detail="GOOGLE_STT_API_KEY is not set for cloud STT mode")
    
    # Read audio file as base64
    import base64
    with open(audio_path, "rb") as f:
        audio_content = base64.b64encode(f.read()).decode("utf-8")
    
    # Google Cloud Speech-to-Text API
    url = f"https://speech.googleapis.com/v1/speech:recognize?key={GOOGLE_STT_API_KEY}"
    
    # Try enhanced model first (supports more languages), fall back to default
    configs_to_try = [
        {
            "config": {
                "encoding": "LINEAR16",
                "sampleRateHertz": 16000,
                "languageCode": "en-NG",  # English (Nigeria)
                "alternativeLanguageCodes": ["yo-NG", "ha-NG"],  # Yoruba, Hausa
                "model": "latest_long",
                "useEnhanced": True,
                "enableAutomaticPunctuation": True,
            }
        },
        {
            "config": {
                "encoding": "LINEAR16",
                "sampleRateHertz": 16000,
                "languageCode": "en-US",
                "model": "default",
                "enableAutomaticPunctuation": True,
            }
        }
    ]
    
    last_error = None
    for config in configs_to_try:
        body = {
            "audio": {"content": audio_content},
            **config
        }
        
        try:
            resp = requests.post(url, json=body, timeout=30)
            if resp.status_code == 200:
                data = resp.json()
                results = data.get("results", [])
                if results:
                    transcript = results[0]["alternatives"][0]["transcript"]
                    confidence = results[0]["alternatives"][0].get("confidence", 0.0)
                    language = results[0].get("languageCode", "en")
                    return {
                        "transcription": transcript,
                        "language": language,
                        "language_probability": confidence
                    }
            else:
                last_error = resp.text
                continue
        except Exception as e:
            last_error = str(e)
            continue
    
    raise HTTPException(
        status_code=500,
        detail=f"Google Cloud STT failed. Last error: {last_error}"
    )

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

    # Seed test accounts with products and transactions
    test_accounts = ["trader_a", "trader_b", "trader_c"]
    for username in test_accounts:
        user = database.verify_user(username, "pass1234")
        if user:
            database.seed_products_for_user(user["id"])
            database.seed_transactions_for_user(user["id"])

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

    stt_status = "unknown"
    if STT_MODE == "cloud":
        stt_status = "connected" if GOOGLE_STT_API_KEY else "not configured"
    else:
        try:
            from faster_whisper import WhisperModel
            stt_status = "connected"
        except ImportError:
            stt_status = "not installed"

    return {
        "status": "healthy",
        "database": "connected",
        "mode": LLM_MODE,
        "llm": llm_status,
        "stt": STT_MODE,
        "stt_status": stt_status
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
    suffix = os.path.splitext(file.filename)[1]
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp_file:
        shutil.copyfileobj(file.file, tmp_file)
        tmp_path = tmp_file.name

    try:
        if STT_MODE == "cloud":
            return transcribe_cloud(tmp_path)
        else:
            model = get_whisper()
            segments, info = model.transcribe(tmp_path, beam_size=5)
            transcription = " ".join([segment.text for segment in segments])
            return {
                "transcription": transcription,
                "language": info.language,
                "language_probability": info.language_probability
            }
    except HTTPException:
        raise
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
    
    if LLM_MODE == "cloud" and genai_client:
        try:
            import google.generativeai as genai
            temp_model = genai.GenerativeModel(GEMMA_MODEL, system_instruction=sp)
            response = temp_model.generate_content(text)
            return clean_raw_output(response.text)
        except Exception as e:
            error_msg = str(e).lower()
            # Handle specific API errors gracefully
            if "quota" in error_msg or "429" in error_msg or "rate" in error_msg:
                raise HTTPException(
                    status_code=429,
                    detail="AI service is temporarily at capacity. Please try again in a moment."
                )
            elif "safety" in error_msg or "blocked" in error_msg:
                raise HTTPException(
                    status_code=422,
                    detail="The AI could not process that request. Please try rephrasing."
                )
            elif "api_key" in error_msg or "401" in error_msg or "403" in error_msg:
                raise HTTPException(
                    status_code=500,
                    detail="AI service authentication failed. Please check API configuration."
                )
            else:
                raise HTTPException(
                    status_code=500,
                    detail=f"AI service temporarily unavailable. Error: {e}"
                )
    
    # Fallback to local Ollama
    try:
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
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail="AI service unavailable. Please try again later."
        )

LOGBOOK_PROMPT = """You are MarketGuard AI, a vision-powered business assistant for Nigerian market traders.

A trader has taken a photo of their handwritten inventory logbook. Your job is to read the handwritten text in the image and extract ALL inventory items into structured JSON.

The logbook may contain:
- Product names (English, Pidgin, or Yoruba)
- Quantities and units (bags, pieces, litres, paint rubber, crates, etc.)
- Prices (cost price, selling price) — may be in Naira (₦) format
- Stock levels
- Notes in any combination

You MUST output ONLY a valid JSON array of objects matching this schema:
[
  {
    "name": "standardized product name (capitalized, English)",
    "stock_quantity": number (0 if not visible),
    "unit": "pcs" | "bag" | "litre" | "crate" | "paint rubber" | "kg" | "dozen" | "carton" | "tubers",
    "cost_price": number (0 if not visible),
    "selling_price": number (0 if not visible)
  }
]

Rules:
1. If a price looks like "45k" or "45,000", interpret as 45000 (Naira)
2. If only one price is shown, use it as selling_price (set cost_price to 0)
3. Standardize product names to English: "ewa" -> "Beans", "iresi" -> "Rice", "epo pupa" -> "Palm Oil", "garri" -> "Garri"
4. If you see "2 bags" or "2 bags of rice", quantity=2, unit="bag", name="Rice"
5. Output ONLY the raw JSON array. No markdown, no explanation, no code fences."""

@app.post("/parse-logbook")
async def parse_logbook_image(file: UploadFile = File(...), user: dict = Depends(require_auth)):
    """Parse a photo of a handwritten logbook and extract inventory items."""
    # Try to re-init client if key is available but client was not created
    global genai_client
    if genai_client is None and GEMINI_API_KEY and LLM_MODE == "cloud":
        try:
            import google.generativeai as genai
            genai.configure(api_key=GEMINI_API_KEY)
            genai_client = genai.GenerativeModel(GEMMA_MODEL, system_instruction=PROMPT_TEMPLATE)
        except Exception:
            pass

    if not genai_client:
        raise HTTPException(
            status_code=400,
            detail="Logbook photo parsing requires Gemini API. Set GEMINI_API_KEY and LLM_MODE=cloud."
        )

    content = await file.read()
    if len(content) > 10 * 1024 * 1024:  # 10MB limit
        raise HTTPException(status_code=400, detail="Image too large. Max 10MB.")

    import google.generativeai as genai
    import PIL.Image
    import io

    try:
        image = PIL.Image.open(io.BytesIO(content))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid image file. Please upload a photo.")

    model = genai.GenerativeModel(GEMMA_MODEL)

    try:
        response = model.generate_content(
            [LOGBOOK_PROMPT, image],
            generation_config=genai.GenerationConfig(
                temperature=0.1,
                max_output_tokens=4096,
            )
        )
        raw = clean_raw_output(response.text)

        # Try to extract JSON array
        parsed = None
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            # Try to find array in the text
            start = raw.find("[")
            end = raw.rfind("]")
            if start != -1 and end != -1 and end > start:
                try:
                    parsed = json.loads(raw[start:end + 1])
                except json.JSONDecodeError:
                    pass

        if parsed is None or not isinstance(parsed, list):
            return {
                "success": False,
                "items": [],
                "raw_output": raw,
                "message": "AI could not read the logbook. Please try a clearer photo or adjust the lighting."
            }

        # Filter out empty items
        valid_items = [item for item in parsed if isinstance(item, dict) and item.get("name", "").strip()]

        return {
            "success": True,
            "items": valid_items,
            "count": len(valid_items),
            "message": f"Found {len(valid_items)} products in your logbook."
        }

    except Exception as e:
        error_msg = str(e).lower()
        if "quota" in error_msg or "429" in error_msg:
            raise HTTPException(status_code=429, detail="AI service at capacity. Try again in a moment.")
        raise HTTPException(status_code=500, detail=f"Failed to parse image: {e}")

@app.post("/parse-logbook/confirm")
async def confirm_logbook_items(
    request_data: dict = None,
    user: dict = Depends(require_auth)
):
    """Confirm and save parsed logbook items to inventory."""
    items = request_data.get("items", []) if request_data else []
    if not items:
        raise HTTPException(status_code=400, detail="No items to save.")

    saved = 0
    for item in items:
        try:
            database.add_product(
                user["id"],
                item.get("name", ""),
                item.get("stock_quantity", 0),
                item.get("unit", "pcs"),
                item.get("cost_price", 0),
                item.get("selling_price", 0),
            )
            saved += 1
        except Exception:
            pass  # Skip duplicates silently

    return {"saved": saved, "total": len(items)}

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

class ProductRequest(BaseModel):
    name: str
    stock_quantity: float = 0
    unit: str = "pcs"
    cost_price: float = 0
    selling_price: float = 0

class ProductUpdateRequest(BaseModel):
    name: Optional[str] = None
    stock_quantity: Optional[float] = None
    unit: Optional[str] = None
    cost_price: Optional[float] = None
    selling_price: Optional[float] = None

@app.post("/inventory/add")
def add_product(req: ProductRequest, user: dict = Depends(require_auth)):
    return database.add_product(user["id"], req.name, req.stock_quantity, req.unit, req.cost_price, req.selling_price)

@app.put("/inventory/{product_id}")
def update_product(product_id: int, req: ProductUpdateRequest, user: dict = Depends(require_auth)):
    return database.update_product(product_id, user["id"], req.model_dump(exclude_none=True))

@app.delete("/inventory/{product_id}")
def delete_product(product_id: int, user: dict = Depends(require_auth)):
    database.delete_product(product_id, user["id"])
    return {"success": True}

@app.post("/inventory/import")
async def import_inventory(file: UploadFile = File(...), user: dict = Depends(require_auth)):
    content = await file.read()
    text = content.decode("utf-8")
    filename = file.filename or "import.csv"

    imported = 0
    errors = []

    if filename.endswith(".json"):
        try:
            data = json.loads(text)
            if not isinstance(data, list):
                data = [data]
            for i, item in enumerate(data):
                try:
                    database.add_product(
                        user["id"],
                        item.get("name", ""),
                        item.get("stock_quantity", 0),
                        item.get("unit", "pcs"),
                        item.get("cost_price", 0),
                        item.get("selling_price", 0),
                    )
                    imported += 1
                except Exception as e:
                    errors.append(f"Row {i+1}: {e}")
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=400, detail=f"Invalid JSON: {e}")
    else:
        import csv
        import io
        reader = csv.DictReader(io.StringIO(text))
        for i, row in enumerate(reader):
            try:
                database.add_product(
                    user["id"],
                    row.get("name", ""),
                    float(row.get("stock_quantity", 0)),
                    row.get("unit", "pcs"),
                    float(row.get("cost_price", 0)),
                    float(row.get("selling_price", 0)),
                )
                imported += 1
            except Exception as e:
                errors.append(f"Row {i+1}: {e}")

    return {"imported": imported, "errors": errors}

@app.get("/transactions")
def get_transactions(user: dict = Depends(require_auth)):
    return database.get_all_transactions(user["id"])

class ManualTransactionRequest(BaseModel):
    type: str
    customer_name: Optional[str] = None
    total_amount: float = 0
    amount_paid: float = 0
    amount_owed: float = 0
    items: list = []

@app.post("/transactions/manual")
def manual_transaction(req: ManualTransactionRequest, user: dict = Depends(require_auth)):
    if req.type not in ("SALE", "CREDIT", "RESTOCK"):
        raise HTTPException(status_code=400, detail="Type must be SALE, CREDIT, or RESTOCK")
    tx_id, warnings = database.add_transaction(
        user["id"],
        req.type,
        req.customer_name,
        req.total_amount,
        req.amount_paid,
        req.amount_owed,
        [{"name": it.get("name", ""), "quantity": it.get("quantity", 1), "unit_price": it.get("unit_price", 0)} for it in req.items],
    )
    return {"transaction_id": tx_id, "warnings": warnings}

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
        recent_txns = database.get_all_transactions(user["id"])
        products = database.get_all_products(user["id"])

        q = request.question.lower()
        is_inventory = any(w in q for w in ["product", "stock", "inventory", "restock", "supply", "item", "goods", "remain", "left", "running out", "low", "price", "cost", "profit", "margin"])
        is_transactions = any(w in q for w in ["sale", "sold", "sell", "transaction", "record", "daily", "today", "week", "month", "revenue", "income", "earn", "money"])
        is_debt = any(w in q for w in ["debt", "owe", "credit", "owed", "balance", "unpaid", "customer", "owing"])
        is_general = not is_inventory and not is_transactions and not is_debt

        context_parts = []

        # Always include summary stats
        total_sales = sum(t['total_amount'] for t in recent_txns if t['type'] in ('SALE', 'CREDIT'))
        total_owed = sum(t['amount_owed'] for t in recent_txns)
        total_products = len(products)
        total_stock_value = sum(p['stock_quantity'] * p['cost_price'] for p in products)
        context_parts.append(f"SUMMARY: Total sales value: ₦{total_sales:,} | Outstanding debts: ₦{total_owed:,} | Products: {total_products} | Stock value: ₦{total_stock_value:,}")

        # Inventory context — detailed when asked about inventory/products/prices
        if is_inventory or is_general:
            product_list = []
            for p in products:
                status = "LOW" if p['stock_quantity'] < 5 else "OK"
                margin = p['selling_price'] - p['cost_price']
                product_list.append(f"{p['name']}: {p['stock_quantity']} {p['unit']} | cost ₦{p['cost_price']:,} | sell ₦{p['selling_price']:,} | margin ₦{margin:,} | stock: {status}")
            if product_list:
                context_parts.append(f"INVENTORY ({len(products)} products):\n" + "\n".join(product_list))

        # Transaction context — detailed when asked about sales/transactions
        if is_transactions or is_general:
            sale_count = sum(1 for t in recent_txns if t['type'] == 'SALE')
            credit_count = sum(1 for t in recent_txns if t['type'] == 'CREDIT')
            restock_count = sum(1 for t in recent_txns if t['type'] == 'RESTOCK')
            context_parts.append(f"TRANSACTIONS: {len(recent_txns)} total ({sale_count} sales, {credit_count} credits, {restock_count} restocks)")
            if recent_txns:
                recent = recent_txns[:8]
                tx_details = []
                for t in recent:
                    items_str = ", ".join(f"{it['product_name']}x{it['quantity']}" for it in t.get('items', []))
                    tx_details.append(f"  {t['type']} | {t.get('customer_name') or 'General'} | ₦{t['total_amount']:,} | paid ₦{t['amount_paid']:,} | owed ₦{t['amount_owed']:,} | {items_str}")
                context_parts.append("Recent transactions:\n" + "\n".join(tx_details))

        # Debt context — detailed when asked about debts/credits
        if is_debt:
            credit_txns = [t for t in recent_txns if t['type'] == 'CREDIT' and t['amount_owed'] > 0]
            if credit_txns:
                debt_details = []
                for t in credit_txns:
                    debt_details.append(f"  {t.get('customer_name') or 'Unknown'}: ₦{t['total_amount']:,} total, paid ₦{t['amount_paid']:,}, still owes ₦{t['amount_owed']:,}")
                context_parts.append(f"CREDIT/DEBT RECORDS ({len(credit_txns)} outstanding):\n" + "\n".join(debt_details))
            else:
                context_parts.append("CREDIT/DEBT RECORDS: No outstanding debts. All customers have paid up!")

        context_str = "\n\n".join(context_parts)

        full_prompt = f"""{context_str}

TRADER'S QUESTION: {request.question}

Answer the trader's question using the data above. Be specific — reference actual numbers, product names, and customer names from the data."""

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
CRITICAL SECURITY RULES:
- Always filter by user_id = {user_id} in your queries. This user only sees their own data.
- You MUST include 'WHERE user_id = {user_id}' for products and transactions tables.
- NEVER use INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, EXEC, GRANT, REVOKE, or UNION.
- ONLY generate SELECT queries. Nothing else.
- NEVER access the users table directly (no password_hash exposure).

Given a question in natural language (English, Pidgin, or Yoruba), generate a SQL query to answer it.
Rules:
- Return ONLY the raw SQL query, no markdown, no explanation.
- Use only SELECT queries (never INSERT, UPDATE, DELETE).
- Use datetime('now', 'start of day') for "today".
- Sort results helpfully (e.g. DESC for recent).
- Limit results to 20 rows max.
- Use LIKE for name searches (case-insensitive matching)."""

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
    """Execute a SQL query with strict safety guardrails."""
    sql_upper = sql.strip().upper()

    # Only allow SELECT
    if not sql_upper.startswith("SELECT"):
        raise HTTPException(status_code=400, detail="Only SELECT queries are allowed")

    # Block dangerous keywords
    blocked = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "TRUNCATE",
               "EXEC", "EXECUTE", "GRANT", "REVOKE", "COPY", "LOAD", "UNION"]
    for keyword in blocked:
        # Check for keyword as whole word (not substring)
        if f" {keyword} " in f" {sql_upper} ":
            raise HTTPException(status_code=400, detail=f"Forbidden SQL keyword: {keyword}")

    # Enforce user_id filter for data tables
    if "USER_ID" not in sql_upper and ("PRODUCTS" in sql_upper or "TRANSACTIONS" in sql_upper):
        raise HTTPException(status_code=400, detail="Queries must filter by user_id")

    # Limit results
    if "LIMIT" not in sql_upper:
        sql = sql.strip().rstrip(";") + " LIMIT 50"

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
