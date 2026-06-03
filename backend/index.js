// index.js — Hermes Mission Control Dashboard backend
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const HOME = process.env.HOME;
const HERMES_DIR = path.join(HOME, '.hermes');
const CRON_DIR = path.join(HERMES_DIR, 'cron');
const SESSIONS_DIR = path.join(HERMES_DIR, 'sessions');
const MEMORIES_DIR = path.join(HERMES_DIR, 'memories');
const CONFIG_FILE = path.join(HERMES_DIR, 'config.yaml');
const DATA_FILE = path.join(__dirname, '..', 'data', 'data.json');
const STATE_DB = path.join(HERMES_DIR, 'state.db');

// Open state.db read-only for token lookups
let stateDb = null;
try {
  stateDb = new Database(STATE_DB, { readonly: true, fileMustExist: true });
} catch (e) { console.warn('state.db not available:', e.message); }

function getTokensForSession(sessionId) {
  if (!stateDb) return null;
  try {
    const row = stateDb.prepare(
      'SELECT input_tokens, output_tokens, cache_read_tokens FROM sessions WHERE id = ?'
    ).get(sessionId);
    if (!row) return null;
    const total = (row.input_tokens || 0) + (row.output_tokens || 0) + (row.cache_read_tokens || 0);
    return {
      total: total || null,
      input: row.input_tokens || null,
      output: row.output_tokens || null,
      cacheRead: row.cache_read_tokens || null,
    };
  } catch { return null; }
}

// Serve frontend
app.use(express.static(path.join(__dirname, '..', 'frontend'), { etag: false, lastModified: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));

// ── Data helpers ──────────────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { kanban: { columns: [] } };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return { kanban: { columns: [] } }; }
}
function saveData(d) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

// ── Cron Jobs ─────────────────────────────────────────────────
app.get('/api/cron/jobs', (req, res) => {
  try {
    const jobsPath = path.join(CRON_DIR, 'jobs.json');
    if (!fs.existsSync(jobsPath)) return res.json([]);
    const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
    const jobs = raw.jobs || [];
    res.json(jobs.map(j => ({
      id: j.id,
      name: j.name,
      enabled: j.enabled !== false,
      schedule: j.schedule,
      schedule_display: j.schedule_display || j.schedule?.display || j.schedule?.expr || '',
      state: j.state,
      next_run_at: j.next_run_at || null,
      last_run_at: j.last_run_at || null,
      last_status: j.last_status || null,
      last_error: j.last_error || null,
      deliver: j.deliver || null,
      model: j.model || null,
      repeat: j.repeat || null,
      prompt: j.prompt || '',
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cron History ──────────────────────────────────────────────
app.get('/api/cron/history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const jobsPath = path.join(CRON_DIR, 'jobs.json');
    if (!fs.existsSync(jobsPath)) return res.json([]);

    const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
    const jobs = raw.jobs || [];
    const jobMap = {};
    jobs.forEach(j => { jobMap[j.id] = j.name || j.id; });

    const allRuns = [];
    const MATCH_WINDOW = 10 * 60 * 1000; // 10 min window for matching sessions to outputs

    // Scan session files for cron sessions
    if (fs.existsSync(SESSIONS_DIR)) {
      for (const file of fs.readdirSync(SESSIONS_DIR)) {
        if (!file.startsWith('session_cron_')) continue;
        // filename: session_cron_<jobId>_<timestamp>.json
        const match = file.match(/^session_cron_([^_]+(?:_[^_]+)?)_(\d{8}_\d{6})\.json$/);
        if (!match) continue;
        const jobId = match[1];
        const tsStr = match[2]; // 20260424_080054
        try {
          const sessionPath = path.join(SESSIONS_DIR, file);
          const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' '));

          // Parse timestamp from filename
          const [datePart, timePart] = tsStr.split('_');
          const y = datePart.slice(0,4), mo = datePart.slice(4,6), d = datePart.slice(6,8);
          const h = timePart.slice(0,2), mi = timePart.slice(2,4), s = timePart.slice(4,6);
          const runAt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);

          // Get output file content if exists
          const outputDir = path.join(CRON_DIR, 'output', jobId);
          let summary = '';
          if (fs.existsSync(outputDir)) {
            // Find output file closest to this session time
            const outFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.md')).sort().reverse();
            for (const outFile of outFiles) {
              // outFile: 2026-04-24_08-01-41.md
              const outMatch = outFile.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.md$/);
              if (outMatch) {
                const outTime = new Date(`${outMatch[1]}T${outMatch[2].replace(/-/g,':')}`)
                const diffMs = Math.abs(outTime - runAt);
                if (diffMs < MATCH_WINDOW) {
                  const outContent = fs.readFileSync(path.join(outputDir, outFile), 'utf8');
                  // Extract summary from output (after ## Output or last section)
                  const lines = outContent.split('\n');
                  const outputIdx = lines.findIndex(l => l.startsWith('## Output') || l.startsWith('## Response'));
                  if (outputIdx >= 0) {
                    summary = lines.slice(outputIdx + 1).join('\n').trim().slice(0, 500);
                  } else {
                    // Get last non-empty lines
                    const nonEmpty = lines.filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('**'));
                    summary = nonEmpty.slice(-5).join(' ').trim().slice(0, 300);
                  }
                  break;
                }
              }
            }
          }

          // Look up token counts from state.db (authoritative source)
          const tkn = getTokensForSession(session.session_id);
          const tokensConsumed = tkn?.total || null;
          const totalInput = tkn?.input || 0;
          const totalOutput = tkn?.output || 0;
          const cacheRead = tkn?.cacheRead || 0;

          // Find matching job in jobs.json for status
          const job = jobs.find(j => j.id === jobId);
          // Determine status — check if last_run_at matches this session
          let status = 'ok';
          if (job && job.last_run_at) {
            const lastRun = new Date(job.last_run_at);
            const diff = Math.abs(lastRun - runAt);
            if (diff < MATCH_WINDOW) {
              status = job.last_status || 'ok';
            }
          }

          allRuns.push({
            jobId,
            jobName: jobMap[jobId] || jobId,
            ts: runAt.getTime(),
            runAt: runAt.toISOString(),
            status,
            model: session.model || null,
            durationMs: session.session_start && session.last_updated
              ? new Date(session.last_updated) - new Date(session.session_start)
              : null,
            tokens: tokensConsumed,
            tokensIn: totalInput || null,
            tokensOut: totalOutput || null,
            tokensCacheRead: cacheRead || null,
            summary,
          });
        } catch {}
      }
    }

    // Include runs from state.db (cron sessions may not have JSON files since ~May 31 2026)
    if (stateDb) {
      try {
        const dbRows = stateDb.prepare(
          `SELECT id, model, started_at, ended_at, end_reason, input_tokens, output_tokens, cache_read_tokens
           FROM sessions WHERE source = 'cron' AND id LIKE 'cron_%'
           ORDER BY started_at DESC LIMIT ?`
        ).all(limit);
        for (const row of dbRows) {
          const m = row.id.match(/^cron_(.+)_(\d{8})_(\d{6})$/);
          if (!m) continue;
          const jobId = m[1];
          const ds = m[2], ts = m[3];
          const runAt = new Date(`${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}T${ts.slice(0,2)}:${ts.slice(2,4)}:${ts.slice(4,6)}`);
          const tsMs = runAt.getTime();
          const covered = allRuns.some(r => r.jobId === jobId && Math.abs(r.ts - tsMs) < MATCH_WINDOW);
          if (covered) continue;
          const total = (row.input_tokens || 0) + (row.output_tokens || 0) + (row.cache_read_tokens || 0);
          const durationMs = row.started_at && row.ended_at
            ? Math.round((row.ended_at - row.started_at) * 1000)
            : null;
          // Try to find output summary
          let summary = '';
          const outputDir = path.join(CRON_DIR, 'output', jobId);
          if (fs.existsSync(outputDir)) {
            const outFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.md')).sort().reverse();
            for (const outFile of outFiles) {
              const om = outFile.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.md$/);
              if (!om) continue;
              const outTime = new Date(`${om[1]}T${om[2].replace(/-/g, ':')}`);
              if (Math.abs(outTime - runAt) < MATCH_WINDOW) {
                const outContent = fs.readFileSync(path.join(outputDir, outFile), 'utf8');
                const lines = outContent.split('\n');
                const outputIdx = lines.findIndex(l => l.startsWith('## Output') || l.startsWith('## Response'));
                if (outputIdx >= 0) {
                  summary = lines.slice(outputIdx + 1).join('\n').trim().slice(0, 500);
                } else {
                  const nonEmpty = lines.filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('**'));
                  summary = nonEmpty.slice(-5).join(' ').trim().slice(0, 300);
                }
                break;
              }
            }
          }
          let status = 'ok';
          if (row.end_reason === 'cron_complete') {
            status = 'ok';
          } else if (row.end_reason) {
            status = 'error';
          } else if (!row.ended_at) {
            status = 'running';
          } else {
            status = 'error';
          }
          allRuns.push({
            jobId,
            jobName: jobMap[jobId] || jobId,
            ts: tsMs,
            runAt: runAt.toISOString(),
            status,
            model: row.model || null,
            durationMs,
            tokens: total || null,
            tokensIn: row.input_tokens || null,
            tokensOut: row.output_tokens || null,
            tokensCacheRead: row.cache_read_tokens || null,
            summary,
          });
        }
      } catch (e) { console.warn('state.db cron query failed:', e.message); }
    }

    // Also include runs from output files not covered by sessions or state.db
    for (const jobId of Object.keys(jobMap)) {
      const outputDir = path.join(CRON_DIR, 'output', jobId);
      if (!fs.existsSync(outputDir)) continue;
      for (const outFile of fs.readdirSync(outputDir)) {
        if (!outFile.endsWith('.md')) continue;
        const outMatch = outFile.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.md$/);
        if (!outMatch) continue;
        const runAt = new Date(`${outMatch[1]}T${outMatch[2].replace(/-/g,':')}`);
        const tsMs = runAt.getTime();
        // Only add if not already covered
        const covered = allRuns.some(r => r.jobId === jobId && Math.abs(r.ts - tsMs) < MATCH_WINDOW);
        if (!covered) {
          const outContent = fs.readFileSync(path.join(outputDir, outFile), 'utf8');
          const lines = outContent.split('\n');
          const outputIdx = lines.findIndex(l => l.startsWith('## Output') || l.startsWith('## Response'));
          let summary = '';
          if (outputIdx >= 0) {
            summary = lines.slice(outputIdx + 1).join('\n').trim().slice(0, 500);
          }
          allRuns.push({
            jobId,
            jobName: jobMap[jobId] || jobId,
            ts: tsMs,
            runAt: runAt.toISOString(),
            status: 'ok',
            model: null,
            durationMs: null,
            tokens: null,
            summary,
          });
        }
      }
    }

    allRuns.sort((a, b) => b.ts - a.ts);
    res.json(allRuns.slice(0, limit));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cron run output (full content) ───────────────────────────
app.get('/api/cron/output/:jobId', (req, res) => {
  try {
    const { jobId } = req.params;
    const runAt = req.query.runAt; // ISO string
    const outputDir = path.join(CRON_DIR, 'output', jobId);
    if (!fs.existsSync(outputDir)) return res.json({ content: '' });

    let targetFile = null;
    if (runAt) {
      const runDate = new Date(runAt);
      let minDiff = Infinity;
      for (const f of fs.readdirSync(outputDir)) {
        if (!f.endsWith('.md')) continue;
        const m = f.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.md$/);
        if (!m) continue;
        const ft = new Date(`${m[1]}T${m[2].replace(/-/g,':')}`);
        const diff = Math.abs(ft - runDate);
        if (diff < minDiff) { minDiff = diff; targetFile = f; }
      }
    } else {
      // Latest
      const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.md')).sort().reverse();
      targetFile = files[0];
    }

    if (!targetFile) return res.json({ content: '' });
    const content = fs.readFileSync(path.join(outputDir, targetFile), 'utf8');
    res.json({ content, file: targetFile });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Memories ──────────────────────────────────────────────────
app.get('/api/memories', (req, res) => {
  try {
    const result = {};
    for (const file of ['MEMORY.md', 'USER.md']) {
      const p = path.join(MEMORIES_DIR, file);
      if (fs.existsSync(p)) result[file] = fs.readFileSync(p, 'utf8');
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Save Memory file ──────────────────────────────────────────
app.put('/api/memories/:file', (req, res) => {
  try {
    const { file } = req.params;
    // Only allow known memory files
    if (!['MEMORY.md', 'USER.md'].includes(file)) {
      return res.status(400).json({ error: 'Invalid file name' });
    }
    const { content } = req.body;
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content is required' });
    }
    const p = path.join(MEMORIES_DIR, file);
    fs.writeFileSync(p, content, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Config ────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return res.json({ raw: '' });
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    res.json({ raw });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/config', (req, res) => {
  try {
    const { content } = req.body;
    if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
    // Basic safety: backup original before overwrite
    if (fs.existsSync(CONFIG_FILE)) {
      fs.copyFileSync(CONFIG_FILE, CONFIG_FILE + '.bak');
    }
    fs.writeFileSync(CONFIG_FILE, content, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Config backup ─────────────────────────────────────────────
app.get('/api/config/backup', (req, res) => {
  try {
    const bakFile = CONFIG_FILE + '.bak';
    if (!fs.existsSync(bakFile)) return res.status(404).json({ error: 'No backup file found (config.yaml.bak does not exist).' });
    const raw = fs.readFileSync(bakFile, 'utf8');
    const stat = fs.statSync(bakFile);
    res.json({ raw, mtime: stat.mtime });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Skills list ───────────────────────────────────────────────
// Helper: read disabled skills from config.yaml
function getDisabledSkills() {
  try {
    const configPath = path.join(HERMES_DIR, 'config.yaml');
    if (!fs.existsSync(configPath)) return new Set();
    const content = fs.readFileSync(configPath, 'utf8');
    // Parse skills.disabled list with simple regex (avoid yaml dep)
    const disabledMatch = content.match(/^skills:[\s\S]*?^\s{2}disabled:\s*\n((?:\s{4}-[^\n]+\n?)*)/m);
    if (!disabledMatch) return new Set();
    const names = [...disabledMatch[1].matchAll(/^\s{4}-\s*(.+)$/mg)].map(m => m[1].trim());
    return new Set(names);
  } catch { return new Set(); }
}

// Helper: set enabled/disabled for a skill via hermes CLI
const { execSync } = require('child_process');

app.get('/api/skills', (req, res) => {
  try {
    const skillsDir = path.join(HERMES_DIR, 'skills');
    if (!fs.existsSync(skillsDir)) return res.json([]);
    const disabled = getDisabledSkills();
    const skills = [];
    function scan(dir, prefix) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          scan(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
        } else if (entry.name === 'SKILL.md') {
          const skillPath = path.join(dir, entry.name);
          const content = fs.readFileSync(skillPath, 'utf8');
          const nameMatch = content.match(/^name:\s*(.+)$/m);
          const descMatch = content.match(/^description:\s*(.+)$/m);
          const skillName = nameMatch ? nameMatch[1].trim() : prefix;
          skills.push({
            name: skillName,
            description: descMatch ? descMatch[1].trim() : '',
            category: prefix ? prefix.split('/').slice(0,-1).join('/') : '',
            path: skillPath,
            enabled: !disabled.has(skillName),
          });
        }
      }
    }
    scan(skillsDir, '');
    res.json(skills);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get raw SKILL.md content by path
app.get('/api/skills/content', (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    // Security: must be inside HERMES_DIR/skills
    const skillsDir = path.join(HERMES_DIR, 'skills');
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(skillsDir)) return res.status(403).json({ error: 'forbidden' });
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'not found' });
    const content = fs.readFileSync(resolved, 'utf8');
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Toggle skill enabled/disabled
app.post('/api/skills/:name/toggle', express.json(), (req, res) => {
  try {
    const skillName = req.params.name;
    const { enabled } = req.body; // true = enable, false = disable
    const configPath = path.join(HERMES_DIR, 'config.yaml');
    if (!fs.existsSync(configPath)) return res.status(404).json({ error: 'config.yaml not found' });

    let content = fs.readFileSync(configPath, 'utf8');

    // Parse current disabled list
    const disabled = getDisabledSkills();
    if (enabled) {
      disabled.delete(skillName);
    } else {
      disabled.add(skillName);
    }
    const sortedDisabled = [...disabled].sort();

    // Build the new disabled block
    const newBlock = sortedDisabled.length > 0
      ? `  disabled:\n${sortedDisabled.map(n => `    - ${n}`).join('\n')}\n`
      : `  disabled: []\n`;

    // Replace or insert disabled section within skills: block
    if (/^skills:[\s\S]*?^\s{2}disabled:/m.test(content)) {
      // Replace existing disabled block
      content = content.replace(
        /^(\s{2}disabled:\s*\n(?:\s{4}-[^\n]+\n?)*|\s{2}disabled:\s*\[\]\s*\n?)/m,
        newBlock
      );
    } else if (/^skills:/m.test(content)) {
      // Insert disabled after skills:
      content = content.replace(/^(skills:\s*\n)/m, `$1${newBlock}`);
    } else {
      // Append skills block
      content += `\nskills:\n${newBlock}`;
    }

    fs.writeFileSync(configPath, content, 'utf8');
    res.json({ success: true, name: skillName, enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// Helper: strip ANSI codes
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

// Helper: parse multi-line browse table (cols: # | Name | Description | Source | Trust)
function parseBrowseTable(out) {
  const lines = out.split('\n');
  const results = [];
  let cur = null;
  let totalPages = 1;
  const hdr = out.match(/page \d+\/(\d+)/);
  if (hdr) totalPages = parseInt(hdr[1]);

  for (const line of lines) {
    // First row: │  N  │ name │ desc │ source │ trust │
    const first = line.match(/^│\s+(\d+)\s+│\s+(.*?)\s+│\s+(.*?)\s+│\s+(.*?)\s+│\s+(.*?)\s+│/);
    if (first) {
      if (cur) results.push(cur);
      cur = {
        name: first[2].trim(),
        description: first[3].trim(),
        source: first[4].trim(),
        trust: first[5].replace(/★\s*/, '').trim(),
        identifier: first[2].trim()
      };
    } else if (cur) {
      // Continuation line: │      │                     │ more text │              │            │
      const cont = line.match(/^│\s+│\s+│\s+(.*?)\s+│\s+│\s+│/);
      if (cont && cont[1].trim()) {
        cur.description += ' ' + cont[1].trim();
      }
    }
  }
  if (cur) results.push(cur);
  return { results, totalPages };
}

// Helper: parse multi-line search table (cols: Name | Description | Source | Trust | Identifier)
function parseSearchTable(out) {
  const lines = out.split('\n');
  const results = [];
  let cur = null;
  for (const line of lines) {
    // First row: │ name │ desc │ source │ trust │ identifier │
    const first = line.match(/^│\s+(\S.*?\S|\S)\s+│\s+(.*?)\s+│\s+(\S+)\s+│\s+(\S+)\s+│\s+(\S+)\s+│\s*$/);
    if (first && !first[1].match(/^[─━┄═┃]/)) {
      if (cur) results.push(cur);
      cur = {
        name: first[1].trim(),
        description: first[2].trim(),
        source: first[3].trim(),
        trust: first[4].replace(/★\s*/, '').trim(),
        identifier: first[5].trim()
      };
    } else if (cur) {
      // Continuation: description text in col 2
      const cont = line.match(/^│\s+│\s+(.*?)\s+│/);
      if (cont && cont[1].trim() && !cont[1].trim().match(/^[─━┄═]/)) {
        cur.description += ' ' + cont[1].trim();
      }
    }
  }
  if (cur) results.push(cur);
  return results;
}

// ── Skills Hub: search ────────────────────────────────────────
app.get('/api/skills/hub/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  const { execSync } = require('child_process');
  try {
    const out = execSync(`hermes skills search ${JSON.stringify(q)} 2>/dev/null`, { timeout: 15000 }).toString();
    const results = parseSearchTable(out);
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Skills Hub: install ───────────────────────────────────────
app.post('/api/skills/hub/install', express.json(), (req, res) => {
  const { identifier } = req.body || {};
  if (!identifier) return res.status(400).json({ error: 'identifier required' });
  const { execSync } = require('child_process');
  try {
    const safeId = identifier.replace(/[^a-zA-Z0-9/_\-\.]/g, '');
    const out = execSync(`hermes skills install --yes ${safeId} 2>&1`, { timeout: 30000 }).toString();
    res.json({ success: true, output: out });
  } catch (e) {
    res.status(500).json({ error: e.stderr?.toString() || e.message });
  }
});

// ── Skills Hub: browse ────────────────────────────────────────
app.get('/api/skills/hub/browse', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const { execSync } = require('child_process');
  try {
    const out = execSync(`hermes skills browse --page ${page} --size 10 2>/dev/null`, { timeout: 15000 }).toString();
    const { results, totalPages } = parseBrowseTable(out);
    res.json({ results, page, totalPages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Sessions (recent) ─────────────────────────────────────────
app.get('/api/sessions', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    if (!fs.existsSync(SESSIONS_DIR)) return res.json([]);
    const files = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.startsWith('session_') && f.endsWith('.json') && !f.includes('cron') && f !== 'sessions.json')
      .map(f => ({
        file: f,
        mtime: fs.statSync(path.join(SESSIONS_DIR, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);

    const sessions = [];
    for (const { file } of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
        sessions.push({ file, ...data });
      } catch {}
    }
    res.json(sessions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Kanban ────────────────────────────────────────────────────
app.get('/api/kanban', (req, res) => {
  const d = loadData();
  if (!d.kanban || !d.kanban.columns || !d.kanban.columns.length) {
    d.kanban = {
      columns: [
        { id: 'todo', title: '📋 To Do', cards: [] },
        { id: 'doing', title: '⚡ In Progress', cards: [] },
        { id: 'done', title: '✅ Done', cards: [] },
      ]
    };
    saveData(d);
  }
  res.json(d.kanban);
});

app.post('/api/kanban/cards', (req, res) => {
  const d = loadData();
  const { columnId, title, desc, priority } = req.body;
  const col = (d.kanban?.columns || []).find(c => c.id === columnId);
  if (!col) return res.status(404).json({ error: 'column not found' });
  const card = { id: `card-${Date.now()}`, title, desc: desc || '', priority: priority || 'none' };
  col.cards.push(card);
  saveData(d); res.json(card);
});

app.put('/api/kanban/move', (req, res) => {
  const d = loadData();
  const { fromColumn, toColumn, cardId } = req.body;
  const from = (d.kanban?.columns || []).find(c => c.id === fromColumn);
  const to = (d.kanban?.columns || []).find(c => c.id === toColumn);
  if (!from || !to) return res.status(404).json({ error: 'column not found' });
  const idx = from.cards.findIndex(x => x.id === cardId);
  if (idx === -1) return res.status(404).json({ error: 'card not found' });
  const [card] = from.cards.splice(idx, 1);
  to.cards.push(card);
  saveData(d); res.json({ ok: true });
});

app.put('/api/kanban/cards/:id', (req, res) => {
  const d = loadData();
  (d.kanban?.columns || []).forEach(col => {
    const card = col.cards.find(c => c.id === req.params.id);
    if (card) Object.assign(card, req.body);
  });
  saveData(d); res.json({ ok: true });
});

app.delete('/api/kanban/cards/:id', (req, res) => {
  const d = loadData();
  (d.kanban?.columns || []).forEach(col => {
    col.cards = col.cards.filter(c => c.id !== req.params.id);
  });
  saveData(d); res.json({ ok: true });
});

// ── Archive Kanban cards ──────────────────────────────────────
app.get('/api/kanban/archive', (req, res) => {
  const d = loadData();
  res.json(d.kanban?.archive || []);
});

app.post('/api/kanban/archive/:id', (req, res) => {
  const d = loadData();
  let archived = null;
  (d.kanban?.columns || []).forEach(col => {
    const idx = col.cards.findIndex(c => c.id === req.params.id);
    if (idx !== -1) {
      [archived] = col.cards.splice(idx, 1);
      archived.archivedAt = new Date().toISOString();
      archived.fromColumn = col.id;
    }
  });
  if (!archived) return res.status(404).json({ error: 'card not found' });
  if (!d.kanban.archive) d.kanban.archive = [];
  d.kanban.archive.unshift(archived);
  saveData(d); res.json({ ok: true });
});

app.post('/api/kanban/archive/all-done', (req, res) => {
  const d = loadData();
  const doneCol = (d.kanban?.columns || []).find(c => c.id === (req.body.colId || 'done'));
  if (!doneCol) return res.status(404).json({ error: 'column not found' });
  if (!d.kanban.archive) d.kanban.archive = [];
  const ts = new Date().toISOString();
  doneCol.cards.forEach(c => { c.archivedAt = ts; c.fromColumn = doneCol.id; d.kanban.archive.unshift(c); });
  doneCol.cards = [];
  saveData(d); res.json({ ok: true });
});

app.post('/api/kanban/archive/:id/restore', (req, res) => {
  const d = loadData();
  if (!d.kanban.archive) return res.status(404).json({ error: 'not found' });
  const idx = d.kanban.archive.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const [card] = d.kanban.archive.splice(idx, 1);
  const { archivedAt, fromColumn, ...rest } = card;
  const targetCol = (d.kanban?.columns || []).find(c => c.id === fromColumn) || d.kanban.columns[0];
  targetCol.cards.push(rest);
  saveData(d); res.json({ ok: true });
});

app.delete('/api/kanban/archive/:id', (req, res) => {
  const d = loadData();
  d.kanban.archive = (d.kanban.archive || []).filter(c => c.id !== req.params.id);
  saveData(d); res.json({ ok: true });
});

app.delete('/api/kanban/archive', (req, res) => {
  const d = loadData();
  d.kanban.archive = [];
  saveData(d); res.json({ ok: true });
});

// ── Reorder Kanban columns ────────────────────────────────────
app.put('/api/kanban/columns/reorder', (req, res) => {
  const { orderedIds } = req.body; // array of column ids in new order
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds required' });
  const d = loadData();
  const colMap = {};
  (d.kanban?.columns || []).forEach(c => colMap[c.id] = c);
  const reordered = orderedIds.map(id => colMap[id]).filter(Boolean);
  // append any columns not in orderedIds (safety)
  (d.kanban?.columns || []).forEach(c => { if (!orderedIds.includes(c.id)) reordered.push(c); });
  d.kanban.columns = reordered;
  saveData(d);
  res.json({ ok: true });
});

// ── Kanban card intra-column reorder ─────────────────────────
app.put('/api/kanban/reorder', (req, res) => {
  const { columnId, cardIds } = req.body;
  if (!columnId || !Array.isArray(cardIds)) return res.status(400).json({ error: 'columnId and cardIds required' });
  const d = loadData();
  const col = (d.kanban?.columns || []).find(c => c.id === columnId);
  if (!col) return res.status(404).json({ error: 'column not found' });
  const cardMap = {};
  col.cards.forEach(c => cardMap[c.id] = c);
  col.cards = cardIds.map(id => cardMap[id]).filter(Boolean);
  // append any cards not in cardIds (safety)
  Object.values(cardMap).forEach(c => { if (!cardIds.includes(c.id)) col.cards.push(c); });
  saveData(d);
  res.json({ ok: true });
});

// ── PATCH kanban card (agentStatus, agentType, details, logs etc) ──
app.patch('/api/kanban/cards/:id', (req, res) => {
  const d = loadData();
  let found = false;
  (d.kanban?.columns || []).forEach(col => {
    const card = col.cards.find(c => c.id === req.params.id);
    if (card) { Object.assign(card, req.body); found = true; }
  });
  if (!found) return res.status(404).json({ error: 'card not found' });
  saveData(d);
  res.json({ ok: true });
});

// ── Run a kanban card (spawn agent) ──────────────────────────
app.post('/api/kanban/cards/:id/run', (req, res) => {
  const { spawn } = require('child_process');
  const d = loadData();
  let card = null, col = null;
  for (const c of (d.kanban?.columns || [])) {
    const f = c.cards.find(x => x.id === req.params.id);
    if (f) { card = f; col = c; break; }
  }
  if (!card) return res.status(404).json({ error: 'card not found' });

  // Move card to doing column
  const doingCol = d.kanban.columns.find(c => c.id === 'doing') || col;
  if (col.id !== 'doing') {
    col.cards = col.cards.filter(c => c.id !== card.id);
    doingCol.cards.push(card);
  }
  card.agentStatus = 'running';
  card.agentType = card.agentType || 'hermes';
  card.logs = card.logs || [];
  saveData(d);

  // Run hermes agent with the card details as a task
  const prompt = card.details || card.notes || card.desc || card.title;
  const logFile = path.join(path.dirname(DATA_FILE), `card-${card.id}.log`);
  const proc = spawn('hermes', ['chat', '-q', prompt, '--yolo', '--quiet'], {
    stdio: ['ignore', fs.openSync(logFile, 'w'), fs.openSync(logFile, 'a')],
    env: { ...process.env }
  });

  const cardId = card.id;

  // On process close: move card to done/error column based on exit code
  proc.on('close', (code) => {
    const d2 = loadData();
    const cols2 = d2.kanban?.columns || [];
    let c2 = null, srcCol2 = null;
    for (const col2 of cols2) {
      const f = col2.cards.find(x => x.id === cardId);
      if (f) { c2 = f; srcCol2 = col2; break; }
    }
    if (!c2) return;

    const success = code === 0;
    const targetColId = success ? 'done' : 'todo';
    const targetCol2 = cols2.find(c => c.id === targetColId) || srcCol2;

    // Move card to target column if not already there
    if (srcCol2 && srcCol2.id !== targetColId) {
      srcCol2.cards = srcCol2.cards.filter(x => x.id !== cardId);
      targetCol2.cards.push(c2);
    }

    c2.agentStatus = success ? 'done' : 'error';
    c2.completedAt = new Date().toISOString();
    if (!success) {
      c2.agentError = `Process exited with code ${code}`;
    }

    saveData(d2);
  });

  res.json({ ok: true, pid: proc.pid });
});

// ── Get kanban card logs ──────────────────────────────────────
app.get('/api/kanban/cards/:id/logs', (req, res) => {
  const logFile = path.join(path.dirname(DATA_FILE), `card-${req.params.id}.log`);
  if (!fs.existsSync(logFile)) return res.json([]);
  try {
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    res.json(lines);
  } catch(e) {
    res.json([`Error reading logs: ${e.message}`]);
  }
});

// ── Edit a cron job ───────────────────────────────────────────
app.put('/api/cron/edit/:jobId', (req, res) => {
  const { jobId } = req.params;
  const { name, schedule, prompt, deliver, repeat } = req.body;
  try {
    const jobsPath = path.join(CRON_DIR, 'jobs.json');
    const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
    const job = (raw.jobs || []).find(j => j.id === jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // Build args for hermes cron edit
  const args = ['cron', 'edit', '--accept-hooks', jobId];
  if (name)     { args.push('--name',     name); }
  if (schedule) { args.push('--schedule', schedule); }
  if (prompt)   { args.push('--prompt',   prompt); }
  if (deliver)  { args.push('--deliver',  deliver); }
  if (repeat != null && repeat !== '') { args.push('--repeat', String(repeat)); }

  const { spawnSync } = require('child_process');
  const result = spawnSync('hermes', args, { encoding: 'utf8', env: { ...process.env } });
  if (result.status !== 0) {
    return res.status(500).json({ error: result.stderr || result.stdout || 'Edit failed' });
  }
  res.json({ ok: true, stdout: result.stdout });
});

// ── Delete a cron job ─────────────────────────────────────────
app.delete('/api/cron/:jobId', (req, res) => {
  const { jobId } = req.params;
  try {
    const jobsPath = path.join(CRON_DIR, 'jobs.json');
    const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
    const job = (raw.jobs || []).find(j => j.id === jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const { spawnSync } = require('child_process');
  const result = spawnSync('hermes', ['cron', 'remove', '--accept-hooks', jobId], {
    encoding: 'utf8', env: { ...process.env }
  });
  if (result.status !== 0) {
    return res.status(500).json({ error: result.stderr || result.stdout || 'Delete failed' });
  }
  res.json({ ok: true });
});

// ── Pause / Resume a cron job ─────────────────────────────────
app.post('/api/cron/pause/:jobId', (req, res) => {
  const { jobId } = req.params;
  const { spawnSync } = require('child_process');
  const result = spawnSync('hermes', ['cron', 'pause', '--accept-hooks', jobId], {
    encoding: 'utf8', env: { ...process.env }
  });
  if (result.status !== 0) return res.status(500).json({ error: result.stderr || 'Pause failed' });
  res.json({ ok: true });
});

app.post('/api/cron/resume/:jobId', (req, res) => {
  const { jobId } = req.params;
  const { spawnSync } = require('child_process');
  const result = spawnSync('hermes', ['cron', 'resume', '--accept-hooks', jobId], {
    encoding: 'utf8', env: { ...process.env }
  });
  if (result.status !== 0) return res.status(500).json({ error: result.stderr || 'Resume failed' });
  res.json({ ok: true });
});

// ── Trigger a cron job manually ───────────────────────────────
const { spawn } = require('child_process');

app.post('/api/cron/run/:jobId', (req, res) => {
  const { jobId } = req.params;
  // Basic safety: job ID must exist
  try {
    const jobsPath = path.join(CRON_DIR, 'jobs.json');
    const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
    const job = (raw.jobs || []).find(j => j.id === jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // Stream logs back via SSE so the UI can show live output
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  send({ type: 'start', jobId });

  const proc = spawn('hermes', ['cron', 'run', '--accept-hooks', jobId], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', d => send({ type: 'log', text: d.toString() }));
  proc.stderr.on('data', d => send({ type: 'log', text: d.toString() }));
  proc.on('close', code => {
    send({ type: 'done', code });
    res.end();
  });
  proc.on('error', err => {
    send({ type: 'error', text: err.message });
    res.end();
  });

  req.on('close', () => proc.kill());
});

// ── Hermes Agent Status ────────────────────────────────────────
app.get('/api/agent-status', (req, res) => {
  const { spawnSync } = require('child_process');

  // Run `hermes status` and parse the plain-text output
  const result = spawnSync('hermes', ['status'], {
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 10000,
  });
  const raw = (result.stdout || '') + (result.stderr || '');

  // Parse Gateway section
  const gatewayRunning = /Gateway Service[\s\S]*?Status:\s*✓ running/m.test(raw);
  const gatewayPidMatch = raw.match(/PID\(s\):\s*(\d+)/);
  const gatewayPid = gatewayPidMatch ? gatewayPidMatch[1] : null;
  const gatewayManager = raw.match(/Manager:\s*(\S+)/)?.[1] || null;

  // Parse Sessions
  const sessionsMatch = raw.match(/Active:\s*(\d+) session/);
  const activeSessions = sessionsMatch ? parseInt(sessionsMatch[1]) : 0;

  // Parse Cron Jobs
  const cronMatch = raw.match(/Jobs:\s*(\d+) active,\s*(\d+) total/);
  const cronActive = cronMatch ? parseInt(cronMatch[1]) : 0;
  const cronTotal = cronMatch ? parseInt(cronMatch[2]) : 0;

  // Parse Model/Provider
  const modelMatch = raw.match(/Model:\s*(.+)/);
  const providerMatch = raw.match(/Provider:\s*(.+)/);
  const model = modelMatch ? modelMatch[1].trim() : null;
  const provider = providerMatch ? providerMatch[1].trim() : null;

  // Parse Environment section
  const envSection = raw.match(/◆ Environment([\s\S]*?)(?=◆|─────)/);
  const environment = {};
  if (envSection) {
    const envLines = envSection[1].split('\n').filter(l => l.trim());
    for (const line of envLines) {
      const m = line.match(/^\s+([^:]+):\s*(.+)/);
      if (m) environment[m[1].trim()] = m[2].trim();
    }
  }

  // Parse Terminal Backend section
  const termSection = raw.match(/◆ Terminal Backend([\s\S]*?)(?=◆|─────)/);
  const terminalBackend = {};
  if (termSection) {
    const tLines = termSection[1].split('\n').filter(l => l.trim());
    for (const line of tLines) {
      const m = line.match(/^\s+([^:]+):\s*(.+)/);
      if (m) terminalBackend[m[1].trim()] = m[2].trim();
    }
  }

  // Get gateway process stats (memory, CPU, uptime) via ps
  const processStats = {};
  if (gatewayPid) {
    try {
      const ps = spawnSync('ps', ['-p', gatewayPid, '-o', 'pid=,rss=,pcpu=,pmem=,etime='], {
        encoding: 'utf8', timeout: 5000,
      });
      const cols = (ps.stdout || '').trim().split(/\s+/);
      if (cols.length >= 5) {
        processStats.pid = cols[0];
        processStats.memoryMB = (parseInt(cols[1]) / 1024).toFixed(1);
        processStats.cpuPct = cols[2];
        processStats.memPct = cols[3];
        processStats.uptime = cols[4]; // elapsed time hh:mm:ss or mm:ss
      }
    } catch {}
  }

  // Parse cron job details via `hermes cron list`
  const cronJobs = [];
  try {
    const cronResult = spawnSync('hermes', ['cron', 'list'], {
      encoding: 'utf8', env: { ...process.env }, timeout: 8000,
    });
    const cronRaw = cronResult.stdout || '';
    // Each job block: id [active/paused] followed by indented fields
    const jobBlocks = cronRaw.split(/\n(?=\s{2}\w{12,}\s)/);
    for (const block of jobBlocks) {
      const idMatch = block.match(/^\s{2}(\w+)\s+\[(\w+)\]/);
      if (!idMatch) continue;
      const job = { id: idMatch[1], state: idMatch[2] };
      const fields = ['Name', 'Schedule', 'Repeat', 'Next run', 'Deliver', 'Last run'];
      for (const f of fields) {
        const fm = block.match(new RegExp(`${f}:\\s+(.+)`));
        if (fm) job[f.toLowerCase().replace(' ', '_')] = fm[1].trim();
      }
      cronJobs.push(job);
    }
  } catch {}

  // Parse Messaging Platforms
  const platforms = [];
  const platSection = raw.match(/◆ Messaging Platforms([\s\S]*?)(?=◆|─────)/);
  if (platSection) {
    const lines = platSection[1].split('\n').filter(l => l.trim());
    for (const line of lines) {
      const m = line.match(/^\s+([\w /()]+?)\s+(✓|✗)\s*(.*)/);
      if (m) platforms.push({ name: m[1].trim(), ok: m[2] === '✓', note: m[3].trim() || null });
    }
  }

  // Parse API Keys
  const apiKeys = [];
  const keySection = raw.match(/◆ API Keys([\s\S]*?)(?=◆|─────)/);
  if (keySection) {
    const lines = keySection[1].split('\n').filter(l => l.trim());
    for (const line of lines) {
      const m = line.match(/^\s+([\w /().]+?)\s+(✓|✗)/);
      if (m) apiKeys.push({ name: m[1].trim(), ok: m[2] === '✓' });
    }
  }

  // Parse Auth Providers (OAuth-based, e.g. GitHub Copilot, Nous Portal, Codex)
  const authProviders = [];
  const authSection = raw.match(/◆ Auth Providers([\s\S]*?)(?=◆|─────)/);
  if (authSection) {
    const lines = authSection[1].split('\n').filter(l => l.trim());
    for (const line of lines) {
      const m = line.match(/^\s+([\w /().]+?)\s+(✓|✗)\s*(.*)/);
      if (m) authProviders.push({ name: m[1].trim(), ok: m[2] === '✓', note: m[3].replace(/\(run:.*?\)/, '').trim() || null });
    }
  }

  // Get gateway log tail — agent.log has live activity; gateway.log has startup banner only
  const agentLogPath = path.join(process.env.HOME, '.hermes', 'logs', 'agent.log');
  const gatewayLogPath = path.join(process.env.HOME, '.hermes', 'logs', 'gateway.log');
  let gatewayLogTail = [];
  try {
    // Prefer agent.log (live), fall back to gateway.log
    const logPath = fs.existsSync(agentLogPath) ? agentLogPath : gatewayLogPath;
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
      gatewayLogTail = lines.slice(-100);
    }
  } catch {}

  res.json({
    gateway: {
      running: gatewayRunning,
      pid: gatewayPid,
      manager: gatewayManager,
      logTail: gatewayLogTail,
      processStats,
    },
    agent: { model, provider },
    environment,
    terminalBackend,
    sessions: { active: activeSessions },
    cron: { active: cronActive, total: cronTotal, jobs: cronJobs },
    platforms,
    apiKeys,
    authProviders,
    raw,
  });
});

// ── Gateway logs endpoint ─────────────────────────────────────────
function parseLogLevel(line) {
  const u = line.toUpperCase();
  if (u.includes('ERROR') || u.includes('CRITICAL') || u.includes('FATAL')) return 'error';
  if (u.includes('WARN')) return 'warn';
  return 'info';
}

function parseLogLine(raw) {
  const tsMatch = raw.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/);
  const ts = tsMatch ? tsMatch[1] : '';
  const text = tsMatch ? raw.slice(ts.length).replace(/^\s*[|-]?\s*/, '') : raw;
  return { ts, level: parseLogLevel(raw), text: text || raw };
}

app.get('/api/gateway/logs', (req, res) => {
  const tail = parseInt(req.query.tail) || 200;
  const levelFilter = (req.query.level || '').toLowerCase();
  const searchText = (req.query.search || '').toLowerCase();

  try {
    const logPath = fs.existsSync(agentLogPath) ? agentLogPath : gatewayLogPath;
    if (!fs.existsSync(logPath)) return res.json({ lines: [], total: 0 });
    const raw = fs.readFileSync(logPath, 'utf8');
    let lines = raw.split('\n').filter(Boolean);
    const total = lines.length;
    if (lines.length > tail) lines = lines.slice(-tail);
    let parsed = lines.map(parseLogLine);
    if (levelFilter && levelFilter !== 'all') {
      parsed = parsed.filter(l => l.level === levelFilter);
    }
    if (searchText) {
      parsed = parsed.filter(l =>
        l.text.toLowerCase().includes(searchText) || l.ts.toLowerCase().includes(searchText)
      );
    }
    res.json({ lines: parsed, total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Gateway control: start / stop / restart ─────────────────────
app.post('/api/gateway/:action', (req, res) => {
  const action = req.params.action;
  if (!['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action. Use start, stop, or restart.' });
  }
  const { spawnSync } = require('child_process');
  const result = spawnSync('hermes', ['--accept-hooks', 'gateway', action], {
    encoding: 'utf8',
    env: { ...process.env, HERMES_ACCEPT_HOOKS: '1' },
    timeout: 15000,
  });
  const output = (result.stdout || '') + (result.stderr || '');
  // exit code 0 = success; also treat empty stderr (launchd stop is silent) as ok
  const ok = result.status === 0 || (!result.stderr && result.status !== null);
  res.json({ ok, action, output, exitCode: result.status });
});

// ── Doctor Gateway Logs ───────────────────────────────────────
app.get('/api/doctor/logs', (req, res) => {
  const tail = parseInt(req.query.tail) || 200;
  const DOCTOR_HOME = path.join(HOME, '.hermes', 'profiles', 'doctor');
  const agentLogPath = path.join(DOCTOR_HOME, 'logs', 'agent.log');
  const gatewayLogPath = path.join(DOCTOR_HOME, 'logs', 'gateway.log');
  const logPath = fs.existsSync(agentLogPath) ? agentLogPath : gatewayLogPath;
  try {
    if (!fs.existsSync(logPath)) return res.json({ lines: [], total: 0 });
    const raw = fs.readFileSync(logPath, 'utf8');
    let lines = raw.split('\n').filter(Boolean);
    const total = lines.length;
    if (lines.length > tail) lines = lines.slice(-tail);
    res.json({ lines: lines.map(parseLogLine), total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Doctor Agent Status ───────────────────────────────────────
app.get('/api/doctor-status', (req, res) => {
  const { spawnSync } = require('child_process');
  const DOCTOR_HOME = path.join(HOME, '.hermes', 'profiles', 'doctor');
  const PLIST = path.join(HOME, 'Library', 'LaunchAgents', 'ai.hermes.gateway.doctor.plist');

  // Check launchctl
  const lc = spawnSync('launchctl', ['list', 'ai.hermes.gateway.doctor'], { encoding: 'utf8', timeout: 5000 });
  const lcOut = lc.stdout || '';
  const pidMatch = lcOut.match(/"PID"\s*=\s*(\d+)/);
  const exitCodeMatch = lcOut.match(/"LastExitStatus"\s*=\s*(\d+)/);
  const pid = pidMatch ? pidMatch[1] : null;
  const lastExitCode = exitCodeMatch ? parseInt(exitCodeMatch[1]) : null;
  const running = !!pid;

  // Process stats
  const processStats = {};
  if (pid) {
    try {
      const ps = spawnSync('ps', ['-p', pid, '-o', 'pid=,rss=,pcpu=,pmem=,etime='], { encoding: 'utf8', timeout: 5000 });
      const cols = (ps.stdout || '').trim().split(/\s+/);
      if (cols.length >= 5) {
        processStats.pid = cols[0];
        processStats.memoryMB = (parseInt(cols[1]) / 1024).toFixed(1);
        processStats.cpuPct = cols[2];
        processStats.memPct = cols[3];
        processStats.uptime = cols[4];
      }
    } catch {}
  }

  // Log tails
  let logTail = [], errorLogTail = [];
  try {
    const logPath = path.join(DOCTOR_HOME, 'logs', 'gateway.log');
    if (fs.existsSync(logPath)) {
      logTail = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).slice(-50);
    }
  } catch {}
  try {
    const errPath = path.join(DOCTOR_HOME, 'logs', 'gateway.error.log');
    if (fs.existsSync(errPath)) {
      errorLogTail = fs.readFileSync(errPath, 'utf8').split('\n').filter(Boolean).slice(-20);
    }
  } catch {}

  res.json({ running, pid, lastExitCode, processStats, logTail, errorLogTail, plistExists: fs.existsSync(PLIST) });
});

// ── Doctor Gateway Control ────────────────────────────────────
app.post('/api/doctor-gateway/:action', (req, res) => {
  const action = req.params.action;
  if (!['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action.' });
  }
  const { spawnSync } = require('child_process');
  const PLIST = path.join(HOME, 'Library', 'LaunchAgents', 'ai.hermes.gateway.doctor.plist');
  let ok = false, output = '';

  if (action === 'stop' || action === 'restart') {
    const r = spawnSync('launchctl', ['unload', PLIST], { encoding: 'utf8', timeout: 10000 });
    output += (r.stdout || '') + (r.stderr || '');
  }
  if (action === 'start' || action === 'restart') {
    // small delay for restart
    if (action === 'restart') { const s = Date.now(); while (Date.now() - s < 1000) {} }
    const r = spawnSync('launchctl', ['load', PLIST], { encoding: 'utf8', timeout: 10000 });
    output += (r.stdout || '') + (r.stderr || '');
    ok = r.status === 0;
  } else {
    ok = true; // stop is always ok
  }

  res.json({ ok, action, output });
});

// ── Dashboard config (app name, etc.) ────────────────────────
app.get('/api/app-config', (req, res) => {
  res.json({ title: 'Mission Control — Hermes', agent: 'Hermes Agent' });
});

// ── WebSocket log streaming ───────────────────────────────────────
const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/log' });

const agentLogPath  = path.join(HOME, '.hermes', 'logs', 'agent.log');
const gatewayLogPath = path.join(HOME, '.hermes', 'logs', 'gateway.log');

function getLogPath() {
  return fs.existsSync(agentLogPath) ? agentLogPath : gatewayLogPath;
}

// Broadcast a string to every connected WebSocket client
function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(payload);
  }
}

// Track file position per log path so we only send new bytes
let _logPos = 0;
let _watchedPath = '';

function initLogWatch() {
  const logPath = getLogPath();
  if (!fs.existsSync(logPath)) return;

  // On (re)start or path change, reset position to end-of-file
  if (logPath !== _watchedPath) {
    _watchedPath = logPath;
    try { _logPos = fs.statSync(logPath).size; } catch { _logPos = 0; }
  }

  fs.watchFile(logPath, { interval: 300, persistent: false }, () => {
    try {
      const stat = fs.statSync(logPath);
      if (stat.size < _logPos) _logPos = 0; // log was rotated
      if (stat.size === _logPos) return;

      const buf = Buffer.alloc(stat.size - _logPos);
      const fd = fs.openSync(logPath, 'r');
      fs.readSync(fd, buf, 0, buf.length, _logPos);
      fs.closeSync(fd);
      _logPos = stat.size;

      const newLines = buf.toString('utf8').split('\n').filter(Boolean);
      if (newLines.length) {
        broadcast({ type: 'lines', lines: newLines });
        // Also broadcast structured log:line events for the Logs tab
        for (const line of newLines) {
          broadcast({ type: 'log:line', data: parseLogLine(line) });
        }
      }
    } catch (e) {
      console.warn('[ws-log] watch error:', e.message);
    }
  });
}

wss.on('connection', (ws) => {
  // Send the last 100 lines immediately on connect
  try {
    const logPath = getLogPath();
    if (fs.existsSync(logPath)) {
      const all = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
      ws.send(JSON.stringify({ type: 'init', lines: all.slice(-100) }));
    }
  } catch {}

  // Make sure the file watcher is running
  initLogWatch();

  ws.on('error', () => {});
});

// ── Hermes Official Dashboard Proxy ───────────────────────────────────────────
// The official Hermes dashboard (port 9119) requires a per-session Bearer token
// injected into its HTML. We fetch + cache it, then proxy API calls through.

const HERMES_DASH = 'http://localhost:9119';
let _hermesToken = null;
let _hermesTokenFetchedAt = 0;

async function getHermesToken() {
  const now = Date.now();
  if (_hermesToken && now - _hermesTokenFetchedAt < 60_000) return _hermesToken;
  try {
    const html = await fetch(HERMES_DASH + '/').then(r => r.text());
    const m = html.match(/window\.__HERMES_SESSION_TOKEN__="([^"]+)"/);
    if (m) { _hermesToken = m[1]; _hermesTokenFetchedAt = now; }
  } catch (e) { console.warn('[hermes-proxy] token fetch failed:', e.message); }
  return _hermesToken;
}

async function hermesProxy(path, res) {
  try {
    const token = await getHermesToken();
    if (!token) return res.status(503).json({ error: 'Hermes dashboard unavailable' });
    const upstream = await fetch(HERMES_DASH + path, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await upstream.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}

// Proxy routes
app.get('/api/hermes/status',      (req, res) => hermesProxy('/api/status', res));
app.get('/api/hermes/sessions',    (req, res) => hermesProxy(`/api/sessions?limit=${req.query.limit||20}&offset=${req.query.offset||0}`, res));
app.get('/api/hermes/analytics',   (req, res) => hermesProxy(`/api/analytics/usage?days=${req.query.days||7}`, res));
app.get('/api/hermes/logs',        (req, res) => hermesProxy(`/api/logs?file=${req.query.file||'agent'}&level=${req.query.level||'all'}&component=${req.query.component||'all'}&lines=${req.query.lines||100}`, res));
app.get('/api/hermes/cron',        (req, res) => hermesProxy('/api/cron/jobs', res));
app.get('/api/hermes/skills',      (req, res) => hermesProxy('/api/skills', res));
app.get('/api/hermes/session/:id', (req, res) => hermesProxy(`/api/sessions/${req.params.id}/messages`, res));

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => console.log(`[hermes-dashboard] Running → http://localhost:${PORT}`));
