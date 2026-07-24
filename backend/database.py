import os
import sqlite3
from datetime import datetime
from urllib.parse import urlparse, quote

USE_SQLITE = os.getenv("USE_SQLITE", "true").lower() == "true"
DB_PATH = os.getenv("DB_PATH", os.path.join(os.path.dirname(__file__), "ojaguard.db"))

def get_db_connection():
    if not USE_SQLITE:
        import psycopg2
        from psycopg2.extras import RealDictCursor

        database_url = os.getenv("DATABASE_URL")
        if database_url:
            # URL-encode @ in password if present
            parsed = urlparse(database_url)
            if parsed.password and '@' in parsed.password:
                cleaned_pass = quote(parsed.password, safe='')
                database_url = database_url.replace(
                    f":{parsed.password}@", f":{cleaned_pass}@"
                )
            conn = psycopg2.connect(database_url, cursor_factory=RealDictCursor)
            return conn

        supa_pass = os.getenv("SUPA_PASS")
        if supa_pass:
            conn = psycopg2.connect(
                host=os.getenv("SUPA_HOST", "db.gniherlifrnopuvqplzt.supabase.co"),
                port=os.getenv("SUPA_PORT", "5432"),
                database=os.getenv("SUPA_DB", "postgres"),
                user=os.getenv("SUPA_USER", "postgres"),
                password=supa_pass,
                cursor_factory=RealDictCursor
            )
            return conn

        db_host = os.getenv("DB_HOST", "localhost")
        db_port = os.getenv("DB_PORT", "5432")
        db_name = os.getenv("DB_NAME", "ojaguard")
        db_user = os.getenv("DB_USER", "postgres")
        db_pass = os.getenv("DB_PASS", "postgres")

        conn = psycopg2.connect(
            host=db_host, port=db_port, database=db_name,
            user=db_user, password=db_pass, cursor_factory=RealDictCursor
        )
        return conn

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def dict_from_row(row):
    if row is None:
        return None
    return dict(row)

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()

    if USE_SQLITE:
        cursor.executescript("""
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                stock_quantity REAL DEFAULT 0,
                unit TEXT DEFAULT 'pcs',
                cost_price REAL DEFAULT 0,
                selling_price REAL DEFAULT 0,
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                customer_name TEXT,
                total_amount REAL DEFAULT 0,
                amount_paid REAL DEFAULT 0,
                amount_owed REAL DEFAULT 0,
                timestamp TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS transaction_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                transaction_id INTEGER REFERENCES transactions(id),
                product_name TEXT NOT NULL,
                quantity REAL NOT NULL,
                unit_price REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                display_name TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now'))
            );
        """)
    else:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) UNIQUE NOT NULL,
                stock_quantity NUMERIC DEFAULT 0,
                unit VARCHAR(50) DEFAULT 'pcs',
                cost_price NUMERIC DEFAULT 0,
                selling_price NUMERIC DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                type VARCHAR(50) NOT NULL,
                customer_name VARCHAR(255),
                total_amount NUMERIC DEFAULT 0,
                amount_paid NUMERIC DEFAULT 0,
                amount_owed NUMERIC DEFAULT 0,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS transaction_items (
                id SERIAL PRIMARY KEY,
                transaction_id INTEGER REFERENCES transactions(id),
                product_name VARCHAR(255) NOT NULL,
                quantity NUMERIC NOT NULL,
                unit_price NUMERIC NOT NULL
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                display_name VARCHAR(255) DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

    initial_products = [
        ("Rice", 50, "bag", 45000, 48000),
        ("Beans", 30, "paint rubber", 8000, 9500),
        ("Garri", 100, "paint rubber", 3500, 4000),
        ("Palm Oil", 20, "litre", 1200, 1500),
    ]

    for name, stock, unit, cost, sell in initial_products:
        try:
            cursor.execute(
                "INSERT OR IGNORE INTO products (name, stock_quantity, unit, cost_price, selling_price) VALUES (?, ?, ?, ?, ?)" if USE_SQLITE else
                "INSERT INTO products (name, stock_quantity, unit, cost_price, selling_price) VALUES (%s, %s, %s, %s, %s) ON CONFLICT (name) DO NOTHING",
                (name, stock, unit, cost, sell)
            )
        except Exception as e:
            print(f"Error seeding product {name}: {e}")

    conn.commit()
    cursor.close()
    conn.close()
    print(f"Database initialized ({'SQLite' if USE_SQLITE else 'PostgreSQL'})")

def get_product(name):
    conn = get_db_connection()
    cursor = conn.cursor()
    like_op = "LIKE" if USE_SQLITE else "ILIKE"
    cursor.execute(f"SELECT * FROM products WHERE name {like_op} ?" if USE_SQLITE else f"SELECT * FROM products WHERE name {like_op} %s", (f"%{name}%",))
    product = dict_from_row(cursor.fetchone())
    cursor.close()
    conn.close()
    return product

def get_all_products():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM products ORDER BY name ASC")
    products = [dict_from_row(r) for r in cursor.fetchall()]
    cursor.close()
    conn.close()
    return products

def get_all_transactions():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM transactions ORDER BY timestamp DESC")
    txs = cursor.fetchall()

    result = []
    for tx in txs:
        tx_dict = dict_from_row(tx)
        cursor.execute("SELECT * FROM transaction_items WHERE transaction_id = ?" if USE_SQLITE else "SELECT * FROM transaction_items WHERE transaction_id = %s", (tx_dict["id"],))
        tx_dict["items"] = [dict_from_row(r) for r in cursor.fetchall()]
        result.append(tx_dict)

    cursor.close()
    conn.close()
    return result

def add_transaction(tx_type, customer_name, total_amount, amount_paid, amount_owed, items):
    conn = get_db_connection()
    cursor = conn.cursor()
    ph = "?" if USE_SQLITE else "%s"
    returning = "" if USE_SQLITE else " RETURNING id"

    try:
        cursor.execute(
            f"INSERT INTO transactions (type, customer_name, total_amount, amount_paid, amount_owed) VALUES ({ph}, {ph}, {ph}, {ph}, {ph}){returning}",
            (tx_type, customer_name, total_amount, amount_paid, amount_owed)
        )

        if USE_SQLITE:
            tx_id = cursor.lastrowid
        else:
            tx_id = cursor.fetchone()["id"]

        warnings = []

        for item in items:
            p_name = item.get("name")
            qty = item.get("quantity", 1)
            price = item.get("unit_price", 0)

            cursor.execute(
                f"INSERT INTO transaction_items (transaction_id, product_name, quantity, unit_price) VALUES ({ph}, {ph}, {ph}, {ph})",
                (tx_id, p_name, qty, price)
            )

            prod = get_product(p_name)
            if prod:
                new_qty = prod["stock_quantity"]
                if tx_type in ["SALE", "CREDIT"]:
                    new_qty -= qty
                    if price < prod["cost_price"]:
                        warnings.append(
                            f"Warning: Selling '{p_name}' at ₦{price:,.2f} which is below your restock cost of ₦{prod['cost_price']:,.2f}!"
                        )
                elif tx_type == "RESTOCK":
                    new_qty += qty
                    cursor.execute(
                        f"UPDATE products SET stock_quantity = {ph}, cost_price = {ph}, updated_at = {'datetime(\'now\')' if USE_SQLITE else 'CURRENT_TIMESTAMP'} WHERE id = {ph}",
                        (new_qty, price, prod["id"])
                    )
                    continue

                cursor.execute(
                    f"UPDATE products SET stock_quantity = {ph}, updated_at = {'datetime(\'now\')' if USE_SQLITE else 'CURRENT_TIMESTAMP'} WHERE id = {ph}",
                    (new_qty, prod["id"])
                )
            else:
                if tx_type == "RESTOCK":
                    cursor.execute(
                        f"INSERT OR IGNORE INTO products (name, stock_quantity, cost_price, updated_at) VALUES ({ph}, {ph}, {ph}, {'datetime(\'now\')' if USE_SQLITE else 'CURRENT_TIMESTAMP'})",
                        (p_name, qty, price)
                    )
                else:
                    cursor.execute(
                        f"INSERT OR IGNORE INTO products (name, stock_quantity, updated_at) VALUES ({ph}, {ph}, {'datetime(\'now\')' if USE_SQLITE else 'CURRENT_TIMESTAMP'})",
                        (p_name, -qty)
                    )

        conn.commit()
        return tx_id, warnings
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        cursor.close()
        conn.close()

import hashlib
import secrets

def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    return f"{salt}:{hashlib.sha256((salt + password).encode()).hexdigest()}"

def verify_password(password: str, password_hash: str) -> bool:
    salt, hsh = password_hash.split(":", 1)
    return hsh == hashlib.sha256((salt + password).encode()).hexdigest()

def create_user(username: str, password: str, display_name: str = "") -> dict | None:
    conn = get_db_connection()
    cursor = conn.cursor()
    ph = "?" if USE_SQLITE else "%s"
    try:
        cursor.execute(
            f"INSERT INTO users (username, password_hash, display_name) VALUES ({ph}, {ph}, {ph})",
            (username, hash_password(password), display_name or username)
        )
        conn.commit()
        uid = cursor.lastrowid if USE_SQLITE else cursor.fetchone()["id"]
        return {"id": uid, "username": username, "display_name": display_name or username}
    except Exception:
        conn.rollback()
        return None
    finally:
        cursor.close()
        conn.close()

def verify_user(username: str, password: str) -> dict | None:
    conn = get_db_connection()
    cursor = conn.cursor()
    ph = "?" if USE_SQLITE else "%s"
    try:
        cursor.execute(f"SELECT * FROM users WHERE username = {ph}", (username,))
        user = cursor.fetchone()
        if user is None:
            return None
        user = dict(user) if hasattr(user, "keys") else user
        if verify_password(password, user["password_hash"]):
            return {"id": user["id"], "username": user["username"], "display_name": user.get("display_name", user["username"])}
        return None
    finally:
        cursor.close()
        conn.close()

if __name__ == "__main__":
    init_db()
