// HOLON-META: {
//   purpose: "mesh-executor",
//   morphic_field: "agent-state:4c67a2b1-6830-44ec-97b1-7c8f93722add",
//   startup_protocol: "READ morphic_field + biofield_external + em_grid",
//   wiki: "32d6d069-74d6-8164-a6d5-f41c3d26ae9b"
// }


const REDIS = Bun.env.REDIS_HOST || "redis-tgowks044g4888ks44o4g84w"
const RPORT = 6379
const QUEUE  = "mesh:task_queue"
const RESULTS= "mesh:task_results"
const COOLIFY= "11|XEeSb5dSVT6ldvdg3pFn3oOvMROvSvtPlj5aUeI7b041f38c"
const N8N_API= "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJiYmMyN2JjYy1mZjNkLTRiMzUtODI4ZS0yZTg2NGNmMGVjNjEiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiMzFjMWI0YzYtMjc4OS00ZmI3LTk0OTQtMzczODNmNWQzOWQ3IiwiaWF0IjoxNzc0NDE5MzQwfQ.pokW3TCBxc1wtsdTChQoUq6exVKEuEmcD1e_ts_VPVU"

async function rcmd(...args: string[]): Promise<string> {
  return new Promise(resolve => {
    const cmd = "*" + args.length + "\r\n" + args.map(a => "$" + a.length + "\r\n" + a + "\r\n").join("")
    let resp = ""
    Bun.connect({hostname: REDIS, port: RPORT, socket: {
      data(s,d){ resp += d.toString(); s.end() },
      open(s){ s.write(cmd) },
      close(){ resolve(resp.trim()) },
      error(_,e){ resolve("ERR:" + e.message) }
    }}).catch(e => resolve("ERR:" + e.message))
    setTimeout(() => resolve("ERR:timeout"), 3000)
  })
}

async function popTask(): Promise<any|null> {
  const r = await rcmd("RPOP", QUEUE)
  if (!r || r.startsWith("$-1") || r.startsWith("ERR")) return null
  const s = r.replace(/^\$\d+\r\n/, "").replace(/\r\n$/, "")
  try { return JSON.parse(s) } catch { return null }
}

async function exec_task(task: any) {
  const {action, payload, command} = task
  if (action === "exec" || action === "shell") {
    const p = Bun.spawn(["bash","-c",command||payload?.command||"echo ok"],{stdout:"pipe",stderr:"pipe"})
    return {stdout: await new Response(p.stdout).text(), exit_code: await p.exited}
  }
  if (action === "coolify_restart") {
    const r = await fetch(`https://coolify.ofshore.dev/api/v1/applications/${payload?.uuid}/restart`,
      {method:"POST",headers:{"Authorization":`Bearer ${COOLIFY}`},signal:AbortSignal.timeout(10000)})
    return r.json()
  }
  if (action === "n8n_webhook") {
    const r = await fetch(`http://n8n-tg40804g08wk44gksc48o0wg:5678/webhook/${payload?.path}`,
      {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload?.data||{}),signal:AbortSignal.timeout(20000)})
    return r.json().catch(() => ({status: r.status}))
  }
  if (action === "n8n_activate_workflow") {
    const r = await fetch(`http://n8n-tg40804g08wk44gksc48o0wg:5678/api/v1/workflows/${payload?.id}/activate`,
      {method:"POST",headers:{"X-N8N-API-KEY":N8N_API},signal:AbortSignal.timeout(10000)})
    return r.json()
  }
  if (action === "spawn_worker") {
    // Push to executor via HTTP
    const r = await fetch("https://executor.ofshore.dev/worker/deploy",
      {method:"POST",headers:{"x-mesh-key":"holon-mesh-internal-2026","Content-Type":"application/json"},
       body:JSON.stringify(payload),signal:AbortSignal.timeout(30000)})
    return r.json()
  }
  return {error: `unknown action: ${action}`}
}

let processed = 0
console.log(`[CONSUMER] Task Queue Consumer v2 | Redis:${REDIS}:${RPORT}`)
while (true) {
  const task = await popTask()
  if (task) {
    processed++
    console.log(`[CONSUMER] #${processed} action=${task.action} id=${(task.id||"?").slice(0,8)}`)
    try {
      const result = await exec_task(task)
      await rcmd("LPUSH", RESULTS, JSON.stringify({taskId:task.id,ok:true,result,ts:new Date().toISOString()}))
      await rcmd("LTRIM", RESULTS, "0", "99")
      console.log(`[CONSUMER] ✅`, JSON.stringify(result).slice(0,80))
    } catch(e: any) {
      console.log(`[CONSUMER] ❌`, e.message)
    }
  } else {
    await Bun.sleep(2_000)
  }
}
