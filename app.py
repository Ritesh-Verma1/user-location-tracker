from flask import Flask, render_template, request, jsonify, redirect, session, url_for
from flask_socketio import SocketIO
from werkzeug.security import generate_password_hash, check_password_hash
from flask_dance.contrib.google import make_google_blueprint, google

import secrets
from datetime import timedelta, datetime
import smtplib
from email.mime.text import MIMEText
import os
from dotenv import load_dotenv
from typing import Optional

import psycopg2
from psycopg2.extras import RealDictCursor

load_dotenv()

app = Flask(__name__)

# Only for localhost OAuth testing (keep OFF in production)
# IMPORTANT: do NOT set this on Render/production HTTPS
if os.getenv("FLASK_ENV") == "development":
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

# ✅ IMPORTANT: secret key must be STABLE, not regenerated every restart
app.secret_key = os.environ["SECRET_KEY"]

# Session lifetime
app.permanent_session_lifetime = timedelta(days=7)

active_users = set()
socketio = SocketIO(app, cors_allowed_origins="*")

# ----------------------------
# CONFIG HELPERS
# ----------------------------
def get_base_url() -> str:
    """
    Prefer BASE_URL from .env (e.g. https://tracksphere.com)
    Fallback to request.url_root when available.
    """
    base = os.getenv("BASE_URL", "").strip().rstrip("/")
    if base:
        return base
    try:
        return request.url_root.strip().rstrip("/")
    except Exception:
        return "http://127.0.0.1:5000"


def is_ajax(req: Optional[object] = None) -> bool:
    """
    Better AJAX detection:
    - X-Requested-With: XMLHttpRequest (classic)
    - Accept header prefers JSON (fetch APIs / modern clients)
    """
    r = req or request
    xrw = r.headers.get("X-Requested-With", "")
    accept = r.headers.get("Accept", "")
    return (xrw == "XMLHttpRequest") or ("application/json" in (accept or "").lower())


def json_or_text(success: bool, message: str, status: int = 200, redirect_url: Optional[str] = None):
    """
    Standard response helper:
    - If AJAX: JSON in the format frontend expects
    - Else: plain text fallback
    """
    if is_ajax():
        payload = {"success": success}
        if success:
            payload["message"] = message
            if redirect_url:
                payload["redirect"] = redirect_url
        else:
            payload["error"] = message
        return jsonify(payload), status
    return message, status


# ----------------------------
# GOOGLE OAUTH
# ----------------------------
google_bp = make_google_blueprint(
    client_id=os.getenv("GOOGLE_CLIENT_ID"),
    client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
    scope=["openid", "email", "profile"],
    offline=True,
)
app.register_blueprint(google_bp, url_prefix="/login")


# ----------------------------
# DATABASE (POSTGRES)
# ----------------------------
def get_db():
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise RuntimeError("DATABASE_URL is not set")

    conn = psycopg2.connect(db_url, cursor_factory=RealDictCursor)

    # Ensure tables exist (safe to call)
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                role TEXT DEFAULT 'user',
                is_verified INTEGER DEFAULT 0,
                verification_token TEXT,
                reset_token TEXT,
                token_expiry TIMESTAMP
            );
        """)

        cur.execute("""
            CREATE TABLE IF NOT EXISTS locations (
                id SERIAL PRIMARY KEY,
                username TEXT NOT NULL,
                latitude DOUBLE PRECISION NOT NULL,
                longitude DOUBLE PRECISION NOT NULL,
                accuracy DOUBLE PRECISION,
                time TIMESTAMP NOT NULL DEFAULT NOW()
            );
        """)

    conn.commit()
    return conn


# ----------------------------
# EMAIL SENDER
# ----------------------------
def _send_email(to_email: str, subject: str, body: str):
    sender_email = os.getenv("EMAIL_USER")
    app_password = os.getenv("EMAIL_PASS")

    # Always print in terminal (dev-friendly)
    print(f"📩 Email debug → To: {to_email} | Subject: {subject}\n{body}\n")

    # If env vars missing, don’t crash
    if not sender_email or not app_password:
        print("⚠️ EMAIL_USER / EMAIL_PASS missing. Email not sent (dev mode).")
        return

    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = sender_email
    msg["To"] = to_email

    try:
        server = smtplib.SMTP_SSL("smtp.gmail.com", 465)
        server.login(sender_email, app_password)
        server.send_message(msg)
        server.quit()
        print("✅ Email sent to:", to_email)
    except Exception as e:
        print("❌ Email sending failed:", e)
        print("⚠️ Use the link printed above (dev mode).")


def send_verification_email(email: str, token: str):
    base = get_base_url()
    verification_link = f"{base}/verify-email/{token}"
    _send_email(
        to_email=email,
        subject="Verify Your Track Sphere Account",
        body=f"Click the link to verify your account:\n\n{verification_link}"
    )


def send_reset_email(email: str, token: str):
    base = get_base_url()
    reset_link = f"{base}/reset-password/{token}"
    _send_email(
        to_email=email,
        subject="Reset your Track Sphere password",
        body=f"Use this link to reset your password (valid for 15 minutes):\n\n{reset_link}"
    )


# ----------------------------
# HELPERS
# ----------------------------
def make_unique_username(conn, base_username: str) -> str:
    """
    Postgres-safe username collision handler.
    """
    candidate = base_username
    i = 1
    with conn.cursor() as cur:
        while True:
            cur.execute("SELECT 1 FROM users WHERE username = %s", (candidate,))
            if not cur.fetchone():
                return candidate
            candidate = f"{base_username}{i}"
            i += 1


# ----------------------------
# ROUTES
# ----------------------------
@app.route("/")
def home():
    return render_template("index.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "GET":
        # If your site is modal-only login, you can redirect("/")
        return render_template("login.html")

    username = (request.form.get("username") or "").strip()
    password = request.form.get("password") or ""

    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE username = %s", (username,))
            user = cur.fetchone()
    finally:
        conn.close()

    if not user or not check_password_hash(user["password"], password):
        if is_ajax():
            return jsonify(success=False, error="Invalid username or password."), 401
        return render_template("login.html", error="Invalid username or password."), 401

    if user["is_verified"] == 0:
        if is_ajax():
            return jsonify(success=False, error="Please verify your email first."), 403
        return render_template("login.html", error="Please verify your email first."), 403

    session.permanent = True
    session["username"] = user["username"]
    session["role"] = user.get("role", "user")
    active_users.add(user["username"])

    if is_ajax():
        return jsonify(success=True, redirect="/map")
    return redirect("/map")


@app.route("/google_login")
def google_login():
    if not google.authorized:
        return redirect(url_for("google.login"))

    resp = google.get("/oauth2/v2/userinfo")
    if not resp.ok:
        print("⚠️ v2 endpoint failed. Trying v3...")
        resp = google.get("https://www.googleapis.com/oauth2/v3/userinfo")

    if not resp.ok:
        print("❌ Google userinfo request failed:", resp.text)
        return "Failed to fetch user info from Google", 400

    try:
        info = resp.json()
        print("✅ Google user info:", info)
    except Exception as e:
        print("❌ Failed to parse Google response:", e)
        return "Invalid response from Google", 400

    email = info.get("email")
    if not email:
        print("❌ Email missing in Google response:", info)
        return "Google did not return an email address. Check OAuth scopes / test users / redirect URI.", 400

    base_username = email.split("@")[0]

    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE email = %s", (email,))
            user = cur.fetchone()

            if not user:
                username = make_unique_username(conn, base_username)

                # OAuth users don't need local password; store random hashed password
                random_pw_hash = generate_password_hash(secrets.token_urlsafe(32))

                cur.execute(
                    "INSERT INTO users (username, email, password, is_verified, role) VALUES (%s, %s, %s, %s, %s)",
                    (username, email, random_pw_hash, 1, "user")
                )
                conn.commit()
            else:
                username = user["username"]
    finally:
        conn.close()

    session.permanent = True
    session["username"] = username
    session["role"] = "user"
    active_users.add(username)

    return redirect("/map")


# ----------------------------
# FORGOT PASSWORD
# ----------------------------
@app.route("/forgot-password", methods=["POST"])
def forgot_password():
    email = (request.form.get("email") or "").strip().lower()

    generic_msg = "If an account exists for this email, a reset link has been sent."
    if not email:
        return json_or_text(False, "Email is required.", 400)

    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE email = %s", (email,))
            user = cur.fetchone()

            if user:
                token = secrets.token_urlsafe(32)
                expiry_dt = datetime.now() + timedelta(minutes=15)

                cur.execute(
                    "UPDATE users SET reset_token = %s, token_expiry = %s WHERE email = %s",
                    (token, expiry_dt, email)
                )
                conn.commit()

                send_reset_email(email, token)
    finally:
        conn.close()

    return json_or_text(True, generic_msg, 200)


@app.route("/reset-password/<token>", methods=["GET", "POST"])
def reset_password(token):
    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE reset_token = %s", (token,))
            user = cur.fetchone()

            if not user:
                return "Invalid token", 400

            expiry_dt = user.get("token_expiry")
            if not expiry_dt:
                return "Token expired or invalid", 400

            if datetime.now() > expiry_dt:
                cur.execute(
                    "UPDATE users SET reset_token = NULL, token_expiry = NULL WHERE reset_token = %s",
                    (token,)
                )
                conn.commit()
                return "Token expired. Please request a new reset link.", 400

            if request.method == "POST":
                new_password = request.form.get("password") or ""
                if not new_password:
                    return "Password is required", 400

                hashed = generate_password_hash(new_password)
                cur.execute(
                    "UPDATE users SET password = %s, reset_token = NULL, token_expiry = NULL WHERE reset_token = %s",
                    (hashed, token)
                )
                conn.commit()
                return redirect("/")
    finally:
        conn.close()

    return render_template("reset_password.html")


# ----------------------------
# REGISTER + VERIFY
# ----------------------------
@app.route("/register", methods=["POST"])
def register():
    username = (request.form.get("username") or "").strip()
    email = (request.form.get("email") or "").strip().lower()
    password = request.form.get("password") or ""

    if not username or not email or not password:
        return json_or_text(False, "All fields are required.", 400)

    hashed_password = generate_password_hash(password)
    token = secrets.token_urlsafe(32)

    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO users (username, email, password, is_verified, verification_token)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (username, email, hashed_password, 0, token)
            )
        conn.commit()
    except psycopg2.Error:
        conn.rollback()
        conn.close()
        return json_or_text(False, "User already exists (username/email already used).", 400)
    finally:
        try:
            conn.close()
        except Exception:
            pass

    send_verification_email(email, token)
    return json_or_text(True, "Verification email sent. Please check your inbox.", 200)


@app.route("/verify-email/<token>")
def verify_email(token):
    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE verification_token = %s", (token,))
            user = cur.fetchone()
            if not user:
                return "Invalid or expired token", 400

            cur.execute(
                "UPDATE users SET is_verified = 1, verification_token = NULL WHERE verification_token = %s",
                (token,)
            )
        conn.commit()
    finally:
        conn.close()

    return "Email verified successfully. You can now login."


# ----------------------------
# LOGOUT + ACTIVE USERS
# ----------------------------
@app.route("/logout")
def logout():
    username = session.get("username")
    if username in active_users:
        active_users.remove(username)
    session.clear()
    return redirect("/")


@app.route("/api/active_users")
def get_active_users():
    return jsonify({"count": len(active_users)})


# ----------------------------
# SAVE LOCATION
# ----------------------------
@app.route("/location", methods=["POST"])
def save_location():
    if "username" not in session:
        return jsonify({"error": "Unauthorized"}), 403

    data = request.get_json(silent=True) or {}
    latitude = data.get("latitude")
    longitude = data.get("longitude")
    accuracy = data.get("accuracy")

    if latitude is None or longitude is None:
        return jsonify({"error": "Invalid location data"}), 400

    if accuracy and accuracy > 2000:
        return jsonify({"error": "Low accuracy signal ignored"}), 400

    now_dt = datetime.now()

    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO locations (username, latitude, longitude, accuracy, time)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (session["username"], latitude, longitude, accuracy, now_dt)
            )
        conn.commit()
    finally:
        conn.close()

    socketio.emit("location_update", {
        "username": session["username"],
        "latitude": latitude,
        "longitude": longitude,
        "accuracy": accuracy,
        "time": now_dt.strftime("%Y-%m-%d %H:%M:%S")
    })

    return jsonify({"message": "Location saved successfully"})


# ----------------------------
# FETCH LOCATIONS
# ----------------------------
@app.route("/api/locations")
def api_locations():
    if "username" not in session:
        return jsonify({"error": "Unauthorized"}), 403

    conn = get_db()
    try:
        with conn.cursor() as cur:
            if session.get("role") == "admin":
                cur.execute("SELECT * FROM locations ORDER BY id ASC")
            else:
                cur.execute(
                    "SELECT * FROM locations WHERE username = %s ORDER BY id ASC",
                    (session["username"],)
                )
            rows = cur.fetchall()
    finally:
        conn.close()

    return jsonify(rows)


# ----------------------------
# ADMIN LIVE MONITORING API
# ----------------------------
@app.route("/api/live_users")
def live_users():
    if session.get("role") != "admin":
        return jsonify({"error": "Admin access required"}), 403

    conn = get_db()
    try:
        with conn.cursor() as cur:
            # Latest row per username (Postgres-friendly)
            cur.execute("""
                SELECT DISTINCT ON (username) *
                FROM locations
                ORDER BY username, id DESC;
            """)
            rows = cur.fetchall()
    finally:
        conn.close()

    return jsonify(rows)


# ----------------------------
# ADMIN CLEAR DATA
# ----------------------------
@app.route("/api/clear", methods=["POST"])
def clear_locations():
    if session.get("role") != "admin":
        return jsonify({"error": "Admin access required"}), 403

    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM locations")
        conn.commit()
    finally:
        conn.close()

    return jsonify({"message": "All location data cleared"})


# ----------------------------
# PAGES
# ----------------------------
@app.route("/map")
def map_page():
    if "username" not in session:
        return redirect("/")
    return render_template("map.html", role=session.get("role", "user"))


@app.route("/view")
def view_locations():
    if "username" not in session:
        return redirect("/")
    return render_template("view.html", role=session.get("role", "user"), username=session.get("username"))


# ----------------------------
# RUN SERVER
# ----------------------------
if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5000, debug=True)