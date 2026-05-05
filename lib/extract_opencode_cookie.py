#!/usr/bin/env python3
"""
Extract OpenCode auth cookie and workspace ID from browser databases.
Used by the AI Usage Bar GNOME extension for automatic quota fetching.

Supports: Firefox, Chromium, Chrome, Brave, Edge (Linux).
Output (to stdout):
    WORKSPACE:<id>
    COOKIE:<value>
Exit code 1 only when nothing at all was found.
"""
import os
import sqlite3
import sys


# ── Firefox (unencrypted cookies in moz_cookies) ──────────────────────────────

def find_firefox_profiles():
    base = os.path.expanduser('~/.mozilla/firefox')
    if not os.path.isdir(base):
        return []
    profiles = []
    for entry in os.listdir(base):
        path = os.path.join(base, entry)
        if os.path.isdir(path):
            profiles.append(path)
    return profiles

def _copy_and_query(db_path, query):
    """Copy a locked browser DB to a temp file, run a query, return rows."""
    import tempfile
    import shutil
    with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as tmp:
        tmp_path = tmp.name
    try:
        shutil.copy2(db_path, tmp_path)
        conn = sqlite3.connect(tmp_path)
        c = conn.cursor()
        c.execute(query)
        rows = c.fetchall()
        conn.close()
        return rows
    except Exception:
        return []
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

def find_firefox_cookie(profile_path):
    cookies_db = os.path.join(profile_path, 'cookies.sqlite')
    if not os.path.exists(cookies_db):
        return None
    rows = _copy_and_query(
        cookies_db,
        "SELECT value FROM moz_cookies WHERE host='.opencode.ai' AND name='auth'"
    )
    if not rows:
        # Also try without leading dot
        rows = _copy_and_query(
            cookies_db,
            "SELECT value FROM moz_cookies WHERE host='opencode.ai' AND name='auth'"
        )
    return rows[0][0] if rows else None

def find_firefox_workspace_id(profile_path):
    import re
    places_db = os.path.join(profile_path, 'places.sqlite')
    if not os.path.exists(places_db):
        return None
    rows = _copy_and_query(
        places_db,
        "SELECT url FROM moz_places WHERE url LIKE 'https://opencode.ai/workspace/%' ORDER BY last_visit_date DESC LIMIT 5"
    )
    for row in rows:
        m = re.search(r'/workspace/([^/]+)', row[0])
        if m:
            return m.group(1)
    return None


# ── Chromium-family (AES-encrypted cookies) ───────────────────────────────────

def get_linux_pass(os_crypt_name):
    """Read the browser Safe Storage password from GNOME Keyring."""
    try:
        import secretstorage
        bus = secretstorage.dbus_init()
        collection = secretstorage.get_default_collection(bus)
        for item in collection.get_all_items():
            if item.get_label() == f'{os_crypt_name} Safe Storage':
                return item.get_secret()
    except Exception:
        pass
    return b'peanuts'

def decrypt_chromium_cookie(encrypted_value, password):
    """Decrypt a Chromium v10/v11 AES-128-CBC cookie."""
    try:
        from Crypto.Protocol.KDF import PBKDF2
        from Crypto.Cipher import AES
        from Crypto.Util.Padding import unpad
    except ImportError:
        return None

    if encrypted_value[:3] not in [b'v10', b'v11']:
        return encrypted_value.decode('utf-8', errors='replace')

    key       = PBKDF2(password,  b'saltysalt', 16, count=1, hmac_hash_module=None)
    empty_key = PBKDF2(b'',       b'saltysalt', 16, count=1, hmac_hash_module=None)
    iv        = b' ' * 16
    ciphertext = encrypted_value[3:]

    for k in (key, empty_key):
        try:
            cipher = AES.new(k, AES.MODE_CBC, iv=iv)
            decrypted = unpad(cipher.decrypt(ciphertext), AES.block_size)
            if encrypted_value[:3] == b'v11' and len(decrypted) > 32:
                decrypted = decrypted[32:]
            return decrypted.decode('utf-8')
        except (ValueError, Exception):
            pass
    return None

def find_chromium_cookie(profile_path, os_crypt_name):
    cookies_path = os.path.join(profile_path, 'Cookies')
    if not os.path.exists(cookies_path):
        return None
    password = get_linux_pass(os_crypt_name)
    rows = _copy_and_query(
        cookies_path,
        "SELECT encrypted_value FROM cookies WHERE host_key='opencode.ai' AND name='auth'"
    )
    if not rows:
        return None
    return decrypt_chromium_cookie(rows[0][0], password)

def find_chromium_workspace_id(profile_path):
    import re
    history_path = os.path.join(profile_path, 'History')
    if not os.path.exists(history_path):
        return None
    rows = _copy_and_query(
        history_path,
        "SELECT url FROM urls WHERE url LIKE 'https://opencode.ai/workspace/%' ORDER BY last_visit_time DESC LIMIT 5"
    )
    for row in rows:
        m = re.search(r'/workspace/([^/]+)', row[0])
        if m:
            return m.group(1)
    return None


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    home = os.path.expanduser('~')

    cookie      = None
    workspace_id = None

    # ── Firefox ────────────────────────────────────────────────────────────────
    for profile_path in find_firefox_profiles():
        if not cookie:
            cookie = find_firefox_cookie(profile_path)
        if not workspace_id:
            workspace_id = find_firefox_workspace_id(profile_path)
        if cookie and workspace_id:
            break

    # ── Chromium-family ────────────────────────────────────────────────────────
    chromium_candidates = [
        (f'{home}/.config/BraveSoftware/Brave-Browser/Default',  'Brave'),
        (f'{home}/.config/BraveSoftware/Brave-Browser/Profile 1','Brave'),
        (f'{home}/.config/google-chrome/Default',                'Chromium'),
        (f'{home}/.config/google-chrome/Profile 1',              'Chromium'),
        (f'{home}/.config/chromium/Default',                     'Chromium'),
        (f'{home}/.config/chromium/Profile 1',                   'Chromium'),
        (f'{home}/.config/microsoft-edge/Default',               'Chromium'),
    ]

    for profile_path, os_crypt_name in chromium_candidates:
        if not os.path.isdir(profile_path):
            continue
        if not cookie:
            cookie = find_chromium_cookie(profile_path, os_crypt_name)
        if not workspace_id:
            workspace_id = find_chromium_workspace_id(profile_path)
        if cookie and workspace_id:
            break

    # ── Output ─────────────────────────────────────────────────────────────────
    if workspace_id:
        print(f'WORKSPACE:{workspace_id}')
    if cookie:
        print(f'COOKIE:{cookie}')

    if not workspace_id and not cookie:
        sys.exit(1)

if __name__ == '__main__':
    main()
