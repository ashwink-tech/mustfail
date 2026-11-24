const http = require('http');
const PORT = Number(process.env.PORT || 4124);
// One task store per Playwright worker (the fixture sets a ws cookie), so a reset in one worker cannot
// wipe a task another worker's test just created. Requests without the cookie share one store.
let tasks, nextId;
const stores = {};
const reset = () => { tasks = [
  { id: 101, title: 'Write report', done: false, priority: 'high' },
  { id: 102, title: 'Review PR', done: true, priority: 'low' },
  { id: 103, title: 'Plan sprint', done: false, priority: 'medium' }]; nextId = 104; };
const useStore = ws => { if (!stores[ws]) { reset(); stores[ws] = { tasks, nextId }; } ({ tasks, nextId } = stores[ws]); };
const saveStore = ws => { stores[ws] = { tasks, nextId }; };
reset();
const page = (body) => `<!doctype html><html><body>${body}</body></html>`;
const loginPage = page(`<h1>Sign in</h1><form id="f"><input aria-label="Email" name="email"><input aria-label="Password" type="password" name="password"><button>Sign in</button></form>
<p id="msg" role="alert"></p><script>
document.getElementById('f').onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.target);
 const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(fd))});
 if(r.ok) location.href='/app'; else document.getElementById('msg').textContent='Wrong email or password';};</script>`);
const appPage = page(`<header><span id="who"></span></header><h1>My tasks</h1>
<p id="stats"></p><div id="error" role="alert" hidden></div>
<table><tbody id="rows"></tbody></table>
<form id="add"><input aria-label="New task"><button>Add</button></form>
<script>
const err=m=>{const e=document.getElementById('error');e.hidden=false;e.textContent=m};
const row=t=>{const tr=document.createElement('tr');tr.dataset.testid='task-row';tr.innerHTML='<td class=title></td><td class=priority></td><td class=state></td><td><input type=checkbox aria-label=Done></td>';
 tr.querySelector('.title').textContent=t.title;tr.querySelector('.priority').textContent=t.priority;tr.querySelector('.state').textContent=t.done?'Done':'Open';tr.querySelector('input').checked=!!t.done;return tr};
fetch('/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationName:'Viewer',query:'query Viewer { viewer { email plan } }'})}).then(r=>r.json()).then(d=>document.getElementById('who').textContent=d.data.viewer.email+' ('+d.data.viewer.plan+')').catch(()=>{});
fetch('/api/tasks').then(r=>{if(!r.ok)throw 0;return r.json()}).then(d=>{for(const t of d.tasks)document.getElementById('rows').appendChild(row(t))}).catch(()=>err('Could not load tasks'));
fetch('/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationName:'Stats',query:'query Stats { stats { open done } }'})})
 .then(r=>r.json()).then(d=>{document.getElementById('stats').textContent=d.data.stats.open+' open, '+d.data.stats.done+' done'}).catch(()=>{});
document.getElementById('add').onsubmit=async e=>{e.preventDefault();const input=e.target.querySelector('input');const title=input.value;input.value='';
 const r=await fetch('/api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title})});
 if(!r.ok) return err('Could not save task');const t=await r.json();document.getElementById('rows').appendChild(row(t));};
</script>`);
const authed = req => /session=ok/.test(req.headers.cookie || '');
http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => { let ws = null; try { handle(); } finally { if (ws) saveStore(ws); }
  function handle() {
    const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const url = new URL(req.url, 'http://x');
    ws = ((req.headers.cookie || '').match(/(?:^|;\s*)ws=(\w+)/) || [])[1] || 'shared';
    useStore(ws);
    if (url.pathname === '/__reset') { reset(); saveStore(ws); return json({ ok: true }); }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const b = JSON.parse(body || '{}');
      if (b.email === 'ashwin@example.com' && b.password === 'secret') { res.setHeader('set-cookie', 'session=ok; Path=/'); return json({ ok: true }); }
      return json({ error: 'bad credentials' }, 401);
    }
    if (url.pathname === '/login') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(loginPage); }
    if (!authed(req)) {
      if (url.pathname.startsWith('/api') || (url.pathname === '/' && req.method === 'POST')) return json({ error: 'unauthorized' }, 401);
      res.writeHead(302, { location: '/login' }); return res.end();
    }
    if (url.pathname === '/api/me') return json({ email: 'ashwin@example.com', plan: 'pro' });
    if (url.pathname === '/labels') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<div id=label></div><script>fetch("/api/labels").then(r=>r.json()).then(d=>{document.getElementById("label").textContent=d.items[0].priorityLabel})</script>'); }
    if (url.pathname === '/api/labels') return json({ items: [{ id: 1, priority: 'High', priorityLabel: 'High' }, { id: 2, priority: 'Low', priorityLabel: 'Low' }] });
    if (url.pathname === '/api/tasks' && req.method === 'GET') return json({ tasks, total: tasks.length });
    if (url.pathname.startsWith('/api/tasks/by-title/') && req.method === 'DELETE') {
      const title = decodeURIComponent(url.pathname.slice('/api/tasks/by-title/'.length));
      const i = tasks.findIndex(t => t.title === title);
      if (i < 0) return json({ error: 'not found' }, 404);
      tasks.splice(i, 1); res.writeHead(204); return res.end();
    }
    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const t = { id: nextId++, title: JSON.parse(body).title, done: false, priority: 'medium' }; tasks.push(t); return json(t, 201);
    }
    if (url.pathname === '/' && req.method === 'POST') {
      const op = JSON.parse(body || '{}').operationName;
      if (op === 'Viewer') return json({ data: { viewer: { email: 'ashwin@example.com', plan: 'pro' } } });
      const counted = tasks.filter(t => !t.title.startsWith('cleanup-')); // the cleanup example runs in parallel
      return json({ data: { stats: { open: counted.filter(t => !t.done).length, done: counted.filter(t => t.done).length } } });
    }
    if (url.pathname === '/app') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(appPage); }
    res.writeHead(404); res.end();
  }});
}).listen(PORT);
