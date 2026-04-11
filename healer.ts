
const N8N = "http://n8n-tg40804g08wk44gksc48o0wg:5678"
const PG  = "n8n-postgres-tg40804g08wk44gksc48o0wg"
const NC  = "n8n-tg40804g08wk44gksc48o0wg"
const TG  = "8394457153:AAFZQ4eMHaiAnmwejmTfWZHI_5KSqhXgCXg"
const CHAT = "8149345223"
let lastFix = 0, fixes = 0, checks = 0

async function tg(text: string) {
  await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({chat_id: CHAT, text, parse_mode:"HTML"}),
    signal: AbortSignal.timeout(5000)
  }).catch(() => {})
}

async function isHealthy(): Promise<boolean> {
  try {
    const r = await fetch(`${N8N}/healthz`, {signal: AbortSignal.timeout(8000)})
    return (await r.json()).status === "ok"
  } catch { return false }
}

async function doFix() {
  if (Date.now() - lastFix < 5 * 60_000) return
  lastFix = Date.now(); fixes++
  console.log(`[HEALER] Fix #${fixes} started`)

  // Truncate stuck executions
  const trunc = Bun.spawn(["docker","exec",PG,"psql","-U","n8n","-d","n8n","-c","TRUNCATE execution_entity CASCADE;"], {stdout:"pipe",stderr:"pipe"})
  await trunc.exited
  console.log("[HEALER] Truncated executions")

  // Restart n8n
  const restart = Bun.spawn(["docker","restart",NC], {stdout:"pipe",stderr:"pipe"})
  await restart.exited
  console.log("[HEALER] Restarting n8n...")

  await Bun.sleep(15_000)
  const ok = await isHealthy()
  console.log(`[HEALER] Fix #${fixes} result: ${ok ? "OK" : "FAILED"}`)
  await tg(`🔧 <b>n8n Auto-Healer Fix #${fixes}</b>\nStatus: ${ok ? "✅ healthy" : "❌ still down"}\n${new Date().toISOString().slice(0,16)} UTC`)
}

console.log("[HEALER] n8n Self-Healing Daemon v2 started (30s interval)")
while (true) {
  checks++
  const healthy = await isHealthy()
  if (!healthy) {
    console.log(`[HEALER] ❌ unhealthy at check #${checks}`)
    await doFix()
  } else if (checks % 20 === 0) {
    console.log(`[HEALER] ✅ #${checks} | fixes: ${fixes}`)
  }
  await Bun.sleep(30_000)
}
