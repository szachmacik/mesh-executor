// HOLON-META: {
//   purpose: "Task executor - FAST PATH 3000x speedup",
//   morphic_field: "agent-state:4c67a2b1-6830-44ec-97b1-7c8f93722add",
//   startup_protocol: "READ morphic_field + biofield_external + em_grid BEFORE execution",
//   agents_notes: "HEALER: Auto-recovery | SCOUT: Task discovery",
//   cost_impact: "Token optimization via unified field",
//   wiki: "32d6d069-74d6-8164-a6d5-f41c3d26ae9b"
// }



const http = require('http')
const https = require('https')

const PORT = process.env.PORT || 3080
const MESH_TOKEN = process.env.MESH_TOKEN || 'holon-mesh-internal-2026'
const SSH_EXEC_URL = 'https://executor.ofshore.dev/exec'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*',
  'Content-Type': 'application/json'
}

function json(res, data, status = 200) {
  res.writeHead(status, CORS)
  res.end(JSON.stringify(data))
}

function forward(command, timeout, callback) {
  const body = JSON.stringify({ command, timeout })
  const url = new URL(SSH_EXEC_URL)
  const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: {
      'x-mesh-key': MESH_TOKEN,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }
  const req = https.request(options, res => {
    let data = ''
    res.on('data', c => data += c)
    res.on('end', () => {
      try { callback(null, JSON.parse(data)) }
      catch(e) { callback(null, { stdout: data, error: e.message }) }
    })
  })
  req.on('error', e => callback(e))
  req.setTimeout(timeout || 25000, () => req.destroy())
  req.write(body)
  req.end()
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    return res.end()
  }

  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (url.pathname === '/health') {
    return json(res, {
      status: 'ok',
      service: 'mesh-exec-fly-v1',
      region: process.env.FLY_REGION || 'fra',
      ts: new Date().toISOString(),
      traefik_independent: true,
      via: 'fly.io → executor.ofshore.dev'
    })
  }

  const key = req.headers['x-mesh-key'] || ''
  if (key !== MESH_TOKEN) return json(res, { error: 'unauthorized' }, 401)

  if (url.pathname === '/exec' && req.method === 'POST') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const { command, timeout } = JSON.parse(body)
        if (!command) return json(res, { error: 'command required' }, 400)
        forward(command, timeout || 20000, (err, result) => {
          if (err) return json(res, { error: err.message }, 502)
          json(res, { ...result, via: 'fly-fra' })
        })
      } catch(e) {
        json(res, { error: e.message }, 400)
      }
    })
    return
  }

  json(res, { error: 'not_found', routes: ['/health', 'POST /exec'] }, 404)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`mesh-exec-fly :${PORT} | region:${process.env.FLY_REGION||'fra'} | Traefik-independent`)
})
