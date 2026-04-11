const http = require('http');
const os = require('os');

const PORT = parseInt(process.env.PORT || '3080');
const MESH_TOKEN = process.env.MESH_TOKEN || 'holon-mesh-executor-2026';
const SSH_EXEC_HOST = '10.0.2.1';
const SSH_EXEC_PORT = 3022;
const SSH_EXEC_AUTH = process.env.SSH_AUTH || 'b554f5dce9ce925e9da21b44f288cdf402c8daabbff56fe7d7ed60fe60e771d5';

function auth(req) {
  const h = req.headers['x-mesh-token'] || req.headers['authorization'] || '';
  return h.replace('Bearer ', '') === MESH_TOKEN;
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-mesh-token,x-mesh-key',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch(e) { resolve({}); } });
  });
}

// Wywołaj ssh-executor v3 bezpośrednio przez Node.js HTTP (bez shellu)
function sshExec(command, timeout = 25000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ command, timeout });
    const t0 = Date.now();
    const options = {
      host: SSH_EXEC_HOST, port: SSH_EXEC_PORT,
      path: '/exec', method: 'POST',
      headers: {
        'Authorization': `Bearer ${SSH_EXEC_AUTH}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(data);
          resolve({ ...d, duration_ms: Date.now() - t0 });
        } catch(e) {
          resolve({ stdout: data, stderr: '', exit_code: 0, duration_ms: Date.now() - t0 });
        }
      });
    });
    req.on('error', (e) => resolve({ error: e.message, stdout: '', exit_code: 1, duration_ms: Date.now()-t0 }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout', stdout: '', exit_code: 124 }); });
    req.write(body);
    req.end();
  });
}

// Wywołaj dowolny endpoint ssh-executor v3
function sshRequest(path, method, body, timeout=10000) {
  return new Promise((resolve) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      host: SSH_EXEC_HOST, port: SSH_EXEC_PORT,
      path, method,
      headers: {
        'Authorization': `Bearer ${SSH_EXEC_AUTH}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? {'Content-Length': Buffer.byteLength(bodyStr)} : {}),
      },
      timeout,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ raw: data.slice(0, 500) }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-mesh-token,x-mesh-key',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  if (url.pathname === '/health') {
    return json(res, {
      status: 'ok', service: 'mesh-executor-v2',
      ts: new Date().toISOString(), uptime: process.uptime(),
      hostname: os.hostname(), free_mem_mb: Math.round(os.freemem()/1024/1024),
      ssh_exec: `${SSH_EXEC_HOST}:${SSH_EXEC_PORT}`,
    });
  }

  // Sprawdź auth dla chronionych ścieżek
  const meshKey = req.headers['x-mesh-key'] || '';
  const isAuthed = auth(req) || meshKey === MESH_TOKEN;
  if (!isAuthed && url.pathname !== '/health') {
    return json(res, { error: 'unauthorized' }, 401);
  }

  // /exec - wykonaj komendę przez ssh-executor v3
  if (url.pathname === '/exec' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.command) return json(res, { error: 'command required' }, 400);
    const result = await sshExec(body.command, body.timeout);
    return json(res, { ...result, via: 'ssh-executor-v3-direct' });
  }

  // /docker - proxy do docker endpoints ssh-executor v3
  if (url.pathname.startsWith('/docker')) {
    if (req.method === 'GET') {
      const result = await sshRequest(url.pathname + url.search, 'GET', null);
      return json(res, result);
    } else {
      const body = await parseBody(req);
      const result = await sshRequest(url.pathname, 'POST', body);
      return json(res, result);
    }
  }

  // /system - info o systemie hosta
  if (url.pathname === '/system') {
    const result = await sshRequest('/system', 'GET', null);
    return json(res, result);
  }

  // /apps - lista Coolify apps
  if (url.pathname === '/apps') {
    const result = await sshRequest('/apps', 'GET', null);
    return json(res, result);
  }

  // /deploy - deploy Coolify app
  if (url.pathname === '/deploy' && req.method === 'POST') {
    const body = await parseBody(req);
    const result = await sshRequest('/deploy', 'POST', body);
    return json(res, result);
  }

  // /info - pełny status
  if (url.pathname === '/info') {
    const [sys, apps, docker] = await Promise.all([
      sshRequest('/system', 'GET', null, 8000),
      sshRequest('/apps', 'GET', null, 8000),
      sshRequest('/docker/ps', 'GET', null, 8000),
    ]);
    return json(res, { system: sys, apps, containers: docker });
  }

  return json(res, {
    error: 'not_found',
    available: ['GET /health', 'GET /system', 'GET /apps', 'GET /info',
                'POST /exec', 'POST /docker/*', 'POST /deploy'],
  }, 404);
});

server.listen(PORT, '0.0.0.0', () => console.log(`mesh-executor v2 on :${PORT}`));
process.on('SIGTERM', () => server.close());
