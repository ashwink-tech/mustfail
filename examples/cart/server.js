const http = require('http');
const page = `<!doctype html><html><body>
<h1>Your cart</h1><div id="user"></div><ul id="items"></ul>
<p>Total: <span id="total">-</span></p><div id="err" role="alert"></div>
<input aria-label="Coupon" id="coupon"><button id="pay">Checkout</button><div id="done"></div>
<script>
fetch('/api/user').then(r=>r.json()).then(u=>{document.getElementById('user').textContent='Hi '+u.name}).catch(()=>{});
fetch('/api/notifications').then(r=>r.json()).catch(()=>{});
fetch('/api/cart').then(r=>{if(!r.ok)throw 0;return r.json()}).then(c=>{
  for(const i of c.items){const li=document.createElement('li');li.textContent=i.name+' x'+i.qty;document.getElementById('items').appendChild(li)}
  document.getElementById('total').textContent=c.total.toFixed(2);
}).catch(()=>{document.getElementById('err').textContent='Could not load cart'});
document.getElementById('pay').onclick=()=>fetch('/api/checkout',{method:'POST'}).then(r=>{
  document.getElementById('done').textContent=r.ok?'Order placed':'Payment failed'});
</script></body></html>`;
let orders = 0;
http.createServer((q,s)=>{
  const j=o=>{s.setHeader('content-type','application/json');s.end(JSON.stringify(o))};
  if(q.url==='/api/user') return j({name:'Asha',id:7});
  if(q.url==='/api/notifications') return j({unread:3});
  if(q.url==='/api/cart') return j({items:[{name:'Beans',qty:2},{name:'Filter',qty:1}],total:42});
  if(q.url==='/api/checkout'){orders++;return j({ok:true,orders})}
  if(q.url==='/orders') return j({orders});
  s.setHeader('content-type','text/html');s.end(page);
}).listen(4123);
