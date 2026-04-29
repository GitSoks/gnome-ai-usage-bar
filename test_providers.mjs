/**
 * Live API test for all providers — verifies fetch + parsing logic.
 * Run: node test_providers.mjs
 */
import { readFileSync, existsSync } from 'fs';
import { writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

const HOME = homedir();

function section(name) {
  console.log('\n' + '─'.repeat(60));
  console.log(`  ${name}`);
  console.log('─'.repeat(60));
}

function ok(msg)   { console.log('  ✓ ' + msg); }
function warn(msg) { console.log('  ⚠ ' + msg); }
function fail(msg) { console.log('  ✗ ' + msg); }

// ── Helpers ────────────────────────────────────────────────────────────────────

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function pct(remaining) {
  if (remaining === null || remaining === undefined) return '—';
  return Math.round(remaining * 100) + '%';
}

function countdown(isoOrMs) {
  if (!isoOrMs) return '—';
  const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
  const ms = d - Date.now();
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── CLAUDE ─────────────────────────────────────────────────────────────────────

async function testClaude() {
  section('CLAUDE');

  const credsPath = join(HOME, '.claude/.credentials.json');
  const creds = readJson(credsPath);
  if (!creds?.claudeAiOauth) { fail('No credentials file or missing claudeAiOauth'); return; }

  const oauth = creds.claudeAiOauth;
  const token = oauth.accessToken ?? oauth.access_token;
  if (!token) { fail('No access token'); return; }

  const expMs = typeof oauth.expiresAt === 'number'
    ? (oauth.expiresAt > 1e12 ? oauth.expiresAt : oauth.expiresAt * 1000)
    : Number(oauth.expiresAt ?? 0);
  const valid = expMs > Date.now() + 30000;
  if (!valid) { fail(`Token expired at ${new Date(expMs).toISOString()}`); return; }
  ok(`Token valid, expires in ${countdown(expMs)}`);

  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
      'User-Agent': 'claude-code/2.1.119',
    }
  });
  console.log(`  HTTP ${res.status}`);
  if (res.status !== 200) { fail(`API returned ${res.status}`); return; }

  const json = await res.json();
  console.log('  Top-level keys:', Object.keys(json).join(', '));

  // Parse exactly as claude.js does
  const parseWindow = (obj) => {
    if (!obj) return null;
    let remaining = null;
    if (obj.utilization !== undefined && obj.utilization !== null) {
      // utilization is 0–100 (percentage used)
      remaining = Math.max(0, 1 - obj.utilization / 100);
    } else {
      const usedPct = obj.used_percentage ?? obj.usedPercentage ?? obj.percent_used ?? null;
      if (usedPct !== null) remaining = Math.max(0, 1 - usedPct / 100);
    }
    const resetStr = obj.resets_at ?? obj.resetsAt ?? obj.reset_at ?? obj.resetAt ?? null;
    const resetAt = resetStr ? new Date(resetStr) : null;
    if (remaining === null) return null;
    return { remaining, resetAt };
  };

  const session = parseWindow(json.five_hour ?? json.fiveHour);
  const weekly  = parseWindow(json.seven_day ?? json.sevenDay);

  if (session) {
    ok(`Session (5h):  remaining=${pct(session.remaining)}  resets in ${countdown(session.resetAt)}`);
  } else {
    warn('No session window in response (five_hour missing or unparseable)');
    if (json.five_hour) console.log('  five_hour raw:', JSON.stringify(json.five_hour));
  }

  if (weekly) {
    ok(`Weekly (7d):   remaining=${pct(weekly.remaining)}  resets in ${countdown(weekly.resetAt)}`);
  } else {
    warn('No weekly window in response (seven_day missing or unparseable)');
    if (json.seven_day) console.log('  seven_day raw:', JSON.stringify(json.seven_day));
  }
}

// ── GEMINI ─────────────────────────────────────────────────────────────────────

async function testGemini() {
  section('GEMINI');

  const credsPath = join(HOME, '.gemini/oauth_creds.json');
  const creds = readJson(credsPath);
  if (!creds?.access_token) { fail('No credentials file or missing access_token'); return; }

  const expMs = creds.expiry_date ?? 0;
  const valid = expMs > Date.now() + 30000;
  if (!valid) { warn(`Token expired at ${new Date(expMs).toISOString()} — would need refresh`); }
  else { ok(`Token valid, expires in ${countdown(expMs)}`); }

  const token = creds.access_token;

  const res = await fetch('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  console.log(`  HTTP ${res.status}`);
  if (res.status !== 200) {
    const body = await res.text();
    fail(`API returned ${res.status}: ${body.slice(0, 200)}`);
    return;
  }

  const json = await res.json();
  console.log('  Top-level keys:', Object.keys(json).join(', '));

  const buckets = json.buckets ?? [];
  console.log(`  Buckets count: ${buckets.length}`);
  if (buckets.length === 0) { fail('No buckets in response'); return; }

  // Parse exactly as gemini.js does
  const modelMap = {};
  for (const b of buckets) {
    if (!b.modelId) continue;
    const frac = b.remainingFraction ?? b.remaining_fraction;
    if (frac === undefined || frac === null) continue;
    if (!(b.modelId in modelMap) || frac < modelMap[b.modelId].frac) {
      modelMap[b.modelId] = { frac, resetTime: b.resetTime ?? b.reset_time ?? null };
    }
  }

  for (const [modelId, { frac, resetTime }] of Object.entries(modelMap)) {
    ok(`${modelId}: remaining=${pct(frac)}  resets in ${countdown(resetTime)}`);
  }

  if (Object.keys(modelMap).length === 0) {
    warn('No parseable buckets (missing modelId or remainingFraction)');
    console.log('  First bucket raw:', JSON.stringify(buckets[0]));
  }
}

// ── COPILOT ────────────────────────────────────────────────────────────────────

async function testCopilot() {
  section('COPILOT');

  let ghToken = null;

  const hostsYml = join(HOME, '.config/gh/hosts.yml');
  if (existsSync(hostsYml)) {
    const text = readFileSync(hostsYml, 'utf8');
    const m = text.match(/oauth_token:\s*([^\s\n]+)/);
    if (m) ghToken = m[1];
  }
  if (!ghToken) {
    const hostsJson = join(HOME, '.config/github-copilot/hosts.json');
    if (existsSync(hostsJson)) {
      const d = readJson(hostsJson);
      ghToken = d?.['github.com']?.oauth_token ?? d?.['github.com']?.token ?? null;
    }
  }
  if (!ghToken) {
    // Newer gh stores token in keyring — ask gh directly
    try {
      const { execSync } = await import('child_process');
      ghToken = execSync('gh auth token', { encoding: 'utf8' }).trim() || null;
    } catch { /* gh not found or not logged in */ }
  }
  if (!ghToken) { fail('No GitHub token found (gh auth login needed)'); return; }
  ok(`GitHub token found: ${ghToken.slice(0, 6)}...`);

  const res = await fetch('https://api.github.com/copilot_internal/user', {
    headers: {
      'Authorization': `token ${ghToken}`,
      'Accept': 'application/json',
      'Editor-Version': 'vscode/1.96.2',
      'Editor-Plugin-Version': 'copilot-chat/0.26.7',
      'User-Agent': 'GitHubCopilotChat/0.26.7',
      'X-Github-Api-Version': '2025-04-01',
    }
  });
  console.log(`  HTTP ${res.status}`);
  if (res.status !== 200) {
    const body = await res.text();
    fail(`API returned ${res.status}: ${body.slice(0, 300)}`);
    return;
  }

  const json = await res.json();
  console.log('  Top-level keys:', Object.keys(json).join(', '));

  const snapshots = json.quotaSnapshots ?? json.quota_snapshots ?? {};
  console.log('  quotaSnapshots keys:', Object.keys(snapshots).join(', '));

  const makeWindow = (s, label) => {
    if (!s) return null;
    if (s.isPlaceholder === true || s.is_placeholder === true) return null;
    const pctVal = s.percentRemaining ?? s.percent_remaining ?? null;
    if (pctVal === null) return null;
    return { remaining: Math.max(0, Math.min(1, pctVal / 100)), label };
  };

  const premium = makeWindow(snapshots.premiumInteractions ?? snapshots.premium_interactions, 'Premium Requests');
  const chat    = makeWindow(snapshots.chat, 'Chat');

  if (premium) ok(`Premium Requests: remaining=${pct(premium.remaining)}`);
  else warn(`No premiumInteractions data. Raw: ${JSON.stringify(snapshots.premiumInteractions ?? 'missing')}`);

  if (chat) ok(`Chat: remaining=${pct(chat.remaining)}`);
  else warn(`No chat quota data.`);

  if (json.copilotPlan) ok(`Plan: ${json.copilotPlan}`);
}

// ── Run all ────────────────────────────────────────────────────────────────────

await testClaude().catch(e => console.log('  ERROR:', e.message));
await testGemini().catch(e => console.log('  ERROR:', e.message));
await testCopilot().catch(e => console.log('  ERROR:', e.message));
console.log('\n' + '─'.repeat(60));
console.log('  Done.');
console.log('─'.repeat(60) + '\n');
