/**
 * MESH SSH Executor Server
 * Node.js HTTP server do wykonywania komend shell na serwerze.
 * Wystawiony przez Coolify/Traefik na HTTPS.
 * Auth: MESH_TOKEN z env
 * Endpoints:
 *   GET  /health - status
 *   POST /exec   - wykonaj komendę
 *   POST /script - wykonaj skrypt (multiline)
 *   GET  /info   - info o serwerze
 */
const http = require('http');
const { exec, execFile } = require('child_process');
const os = require('os');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3080');
const MESH_TOKEN = process.env.MESH_TOKEN || 'holon-mesh-executor-2026';
const MAX_TIMEOUT = parseInt(process.env.MAX_TIMEOUT || '30000');
const ALLOWED_CMDS = (process.env.ALLOWED_CMDS || '').split(',').filter(Boolean);

console.log(`MESH Executor starting on port ${PORT}`);

function auth(req) {
  const h = req.headers['authorization'] || req.headers['x-mesh-token'] || '';
  return h.replace('Bearer ', '') === MESH_TOKEN;
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-mesh-token',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch(e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

function runCmd(cmd, timeout) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    exec(cmd, {
      timeout: timeout || MAX_TIMEOUT,
      maxBuffer: 1024 * 1024 * 10, // 10MB
      shell: '/bin/bash',
    }, (err, stdout, stderr) => {
      resolve({
        exit_code: err ? (err.code || 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        error: err ? err.message : null,
        duration_ms: Date.now() - t0,
      });
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-mesh-token',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  if (url.pathname === '/health') {
    return json(res, {
      status: 'ok',
      service: 'mesh-executor-v1',
      ts: new Date().toISOString(),
      uptime: process.uptime(),
      hostname: os.hostname(),
      platform: os.platform(),
      free_mem_mb: Math.round(os.freemem() / 1024 / 1024),
      load: os.loadavg(),
    });
  }

  if (!auth(req)) return json(res, { error: 'unauthorized' }, 401);

  if (url.pathname === '/info') {
    const sys = await runCmd('docker ps --format "{{.Names}}\\t{{.Status}}" 2>/dev/null | head -30', 8000);
    const disk = await runCmd('df -h / 2>/dev/null | tail -1', 3000);
    const mem = await runCmd('free -h 2>/dev/null | head -2', 3000);
    return json(res, {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      total_mem_gb: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
      free_mem_mb: Math.round(os.freemem() / 1024 / 1024),
      load: os.loadavg(),
      uptime_h: Math.round(os.uptime() / 3600),
      docker_containers: sys.stdout,
      disk: disk.stdout,
      memory: mem.stdout,
    });
  }

  if (url.pathname === '/exec' && req.method === 'POST') {
    const body = await parseBody(req);
    const { command, timeout, cwd } = body;
    if (!command) return json(res, { error: 'command required' }, 400);

    // Safety: jeśli ALLOWED_CMDS skonfigurowane, sprawdź whitelist
    if (ALLOWED_CMDS.length > 0) {
      const allowed = ALLOWED_CMDS.some(prefix => command.trim().startsWith(prefix));
      if (!allowed) return json(res, { error: 'command not in allowlist', allowed: ALLOWED_CMDS }, 403);
    }

    const fullCmd = cwd ? `cd ${cwd} && ${command}` : command;
    const result = await runCmd(fullCmd, timeout);
    return json(res, { command, ...result });
  }

  if (url.pathname === '/script' && req.method === 'POST') {
    const body = await parseBody(req);
    const { script, timeout } = body;
    if (!script) return json(res, { error: 'script required' }, 400);

    // Zapisz skrypt do pliku temp i wykonaj
    const tmpFile = `/tmp/mesh-script-${crypto.randomUUID()}.sh`;
    const writeResult = await runCmd(`cat > ${tmpFile} << 'MESHSCRIPT'\n${script}\nMESHSCRIPT\nchmod +x ${tmpFile}`, 3000);
    if (writeResult.exit_code !== 0) return json(res, { error: 'failed to write script', ...writeResult }, 500);

    const result = await runCmd(`bash ${tmpFile}`, timeout);
    await runCmd(`rm -f ${tmpFile}`, 1000); // cleanup
    return json(res, { ...result });
  }

  if (url.pathname === '/docker' && req.method === 'POST') {
    const body = await parseBody(req);
    const { action, container } = body;
    const allowed_actions = ['start', 'stop', 'restart', 'logs', 'ps', 'stats'];
    if (!allowed_actions.includes(action)) return json(res, { error: `action must be one of: ${allowed_actions.join(',')}` }, 400);

    let cmd;
    if (action === 'ps') cmd = 'docker ps --format "{{json .}}" 2>/dev/null';
    else if (action === 'stats') cmd = 'docker stats --no-stream --format "{{json .}}" 2>/dev/null | head -20';
    else if (container) cmd = `docker ${action} ${container} 2>&1`;
    else return json(res, { error: 'container required for this action' }, 400);

    const result = await runCmd(cmd, 15000);
    return json(res, { action, container, ...result });
  }

  return json(res, {
    error: 'not_found',
    available: ['GET /health', 'GET /info', 'POST /exec', 'POST /script', 'POST /docker'],
  }, 404);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MESH Executor ready on :${PORT}`);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
