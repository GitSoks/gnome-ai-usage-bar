#!/usr/bin/env python3
"""
Extract OpenCode auth cookie from Chromium/Brave/Chrome browser databases.
Used by the AI Usage Bar GNOME extension for automatic quota fetching.
"""
import os
import sqlite3
import base64
import hashlib
import sys

def get_linux_pass(os_crypt_name):
    """Read the browser Safe Storage password from GNOME Keyring."""
    try:
        import secretstorage
        bus = secretstorage.dbus_init()
        collection = secretstorage.get_default_collection(bus)
        for item in collection.get_all_items():
            label = item.get_label()
            if label == f'{os_crypt_name} Safe Storage':
                return item.get_secret()
    except Exception:
        pass
    return b'peanuts'

def decrypt_cookie(encrypted_value, password):
    """Decrypt a Chromium v10/v11 cookie value using AES-128-CBC."""
    from Crypto.Protocol.KDF import PBKDF2
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import unpad
    
    if encrypted_value[:3] not in [b'v10', b'v11']:
        return encrypted_value.decode('utf-8', errors='replace')
    
    # Derive keys (v11 uses same derivation as v10, just tries different passwords)
    key = PBKDF2(password, b'saltysalt', 16, count=1, hmac_hash_module=None)
    empty_key = PBKDF2(b'', b'saltysalt', 16, count=1, hmac_hash_module=None)
    iv = b' ' * 16
    
    ciphertext = encrypted_value[3:]
    
    # Try password-derived key first, then empty password key
    for k in (key, empty_key):
        try:
            cipher = AES.new(k, AES.MODE_CBC, iv=iv)
            decrypted = unpad(cipher.decrypt(ciphertext), AES.block_size)
            # v11 cookies on Linux have a 32-byte integrity prefix
            if encrypted_value[:3] == b'v11' and len(decrypted) > 32:
                decrypted = decrypted[32:]
            return decrypted.decode('utf-8')
        except ValueError:
            pass
    
    return None

def find_cookie(profile_path, os_crypt_name):
    """Find the opencode.ai auth cookie in a browser profile."""
    cookies_path = os.path.join(profile_path, 'Cookies')
    if not os.path.exists(cookies_path):
        return None
    
    password = get_linux_pass(os_crypt_name)
    
    try:
        # Copy to avoid database locks
        import tempfile
        import shutil
        
        with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as tmp:
            tmp_path = tmp.name
        shutil.copy2(cookies_path, tmp_path)
        
        conn = sqlite3.connect(tmp_path)
        c = conn.cursor()
        c.execute(
            "SELECT encrypted_value FROM cookies WHERE host_key='opencode.ai' AND name='auth'"
        )
        row = c.fetchone()
        conn.close()
        os.unlink(tmp_path)
        
        if not row:
            return None
        
        return decrypt_cookie(row[0], password)
    
    except Exception:
        return None

def find_workspace_id(profile_path):
    """Find the most recent OpenCode workspace ID from browser history."""
    history_path = os.path.join(profile_path, 'History')
    if not os.path.exists(history_path):
        return None
    
    try:
        import tempfile
        import shutil
        import re
        
        with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as tmp:
            tmp_path = tmp.name
        shutil.copy2(history_path, tmp_path)
        
        conn = sqlite3.connect(tmp_path)
        c = conn.cursor()
        c.execute(
            "SELECT url FROM urls WHERE url LIKE 'https://opencode.ai/workspace/%' ORDER BY last_visit_time DESC LIMIT 5"
        )
        rows = c.fetchall()
        conn.close()
        os.unlink(tmp_path)
        
        for row in rows:
            url = row[0]
            m = re.search(r'/workspace/([^/]+)', url)
            if m:
                return m.group(1)
        
        return None
    
    except Exception:
        return None

def main():
    home = os.path.expanduser('~')
    
    # Search common browser profiles
    browser_candidates = [
        # Brave
        (f'{home}/.config/BraveSoftware/Brave-Browser/Default', 'Brave'),
        (f'{home}/.config/BraveSoftware/Brave-Browser/Profile 1', 'Brave'),
        # Chrome
        (f'{home}/.config/google-chrome/Default', 'Chromium'),
        (f'{home}/.config/google-chrome/Profile 1', 'Chromium'),
        # Chromium
        (f'{home}/.config/chromium/Default', 'Chromium'),
        (f'{home}/.config/chromium/Profile 1', 'Chromium'),
        # Edge
        (f'{home}/.config/microsoft-edge/Default', 'Chromium'),
    ]
    
    cookie = None
    workspace_id = None
    
    for profile_path, os_crypt_name in browser_candidates:
        if not cookie:
            cookie = find_cookie(profile_path, os_crypt_name)
        if not workspace_id:
            workspace_id = find_workspace_id(profile_path)
        
        if cookie and workspace_id:
            break
    
    if cookie and workspace_id:
        print(f'WORKSPACE:{workspace_id}')
        print(f'COOKIE:{cookie}')
        return
    
    if workspace_id:
        print(f'WORKSPACE:{workspace_id}')
    
    if cookie:
        print(f'COOKIE:{cookie}')
        return
    
    # Not found
    sys.exit(1)

if __name__ == '__main__':
    main()
