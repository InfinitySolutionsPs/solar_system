const express = require('express');
const initSqlJs = require('sql.js');
const path = require('path');
const app = express();
const dbPath = process.env.DB_FILE || path.join(__dirname, 'data/electricity.db');
require('fs').mkdirSync(path.dirname(dbPath), {recursive:true});
let db;
const ready = initSqlJs().then(SQL=>{
  db = require('fs').existsSync(dbPath) ? new SQL.Database(require('fs').readFileSync(dbPath)) : new SQL.Database();
  db.run(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS subscribers(id INTEGER PRIMARY KEY AUTOINCREMENT,account_no TEXT UNIQUE NOT NULL,name TEXT NOT NULL,phone TEXT,address TEXT,joined_on TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY AUTOINCREMENT,subscriber_id INTEGER NOT NULL REFERENCES subscribers(id),period_start TEXT NOT NULL,period_end TEXT NOT NULL,previous_reading REAL NOT NULL,current_reading REAL NOT NULL,kwh REAL NOT NULL,rate REAL NOT NULL,amount REAL NOT NULL,paid INTEGER NOT NULL DEFAULT 0,paid_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(subscriber_id,period_start,period_end));
  INSERT OR IGNORE INTO settings(key,value) VALUES('current_rate','1.00');`);
  const subscriberColumns = all('PRAGMA table_info(subscribers)').map(column=>column.name);
  if(!subscriberColumns.includes('initial_reading')) db.run('ALTER TABLE subscribers ADD COLUMN initial_reading REAL NOT NULL DEFAULT 0');
  persist();
  return db;
});
function persist(){require('fs').writeFileSync(dbPath,Buffer.from(db.export()))}
function all(sql,...params){const st=db.prepare(sql);st.bind(params);const out=[];while(st.step())out.push(st.getAsObject());st.free();return out}
function get(sql,...params){return all(sql,...params)[0]}
function run(sql,...params){db.run(sql,params);const lastID=db.exec('SELECT last_insert_rowid() AS id')[0]?.values[0][0];persist();return {lastID}}
app.use(express.json()); app.use((req,res,next)=>ready.then(()=>next()).catch(next)); app.use(express.static(path.join(__dirname,'public')));

app.get('/api/summary',(req,res)=>{const {from,to}=req.query; let where='1=1',p=[];if(from){where+=' AND period_start>=?';p.push(from)}if(to){where+=' AND period_end<=?';p.push(to)}const s=get(`SELECT COALESCE(SUM(kwh),0) kwh,COALESCE(SUM(amount),0) due,COALESCE(SUM(CASE WHEN paid=1 THEN amount ELSE 0 END),0) collected,COUNT(*) count, SUM(CASE WHEN paid=0 THEN 1 ELSE 0 END) unpaid FROM invoices WHERE ${where}`,...p);res.json(s)});
app.get('/api/settings',(_,res)=>res.json({rate:Number(get("SELECT value FROM settings WHERE key='current_rate'").value)}));
app.put('/api/settings',(req,res)=>{const rate=Number(req.body.rate);if(!Number.isFinite(rate)||rate<0)return res.status(400).json({error:'السعر غير صحيح'});run("UPDATE settings SET value=? WHERE key='current_rate'",String(rate));res.json({rate})});
app.get('/api/subscribers',(req,res)=>res.json(all(`SELECT s.*,COUNT(i.id) invoices,COALESCE(SUM(CASE WHEN i.paid=0 THEN i.amount ELSE 0 END),0) balance FROM subscribers s LEFT JOIN invoices i ON i.subscriber_id=s.id GROUP BY s.id ORDER BY s.id DESC`)));
app.post('/api/subscribers',(req,res)=>{const {account_no,name,phone,address,joined_on,initial_reading}=req.body;const initial=Number(initial_reading);if(!account_no||!name||!joined_on||!Number.isFinite(initial)||initial<0)return res.status(400).json({error:'رقم الحساب والاسم وتاريخ الاشتراك وقراءة العداد الابتدائية مطلوبة'});try{const r=run('INSERT INTO subscribers(account_no,name,phone,address,joined_on,initial_reading) VALUES(?,?,?,?,?,?)',account_no,name,phone||'',address||'',joined_on,initial);res.status(201).json({id:r.lastID})}catch(e){res.status(400).json({error:e.message.includes('UNIQUE')?'رقم الحساب مستخدم مسبقاً':'تعذر حفظ المشترك'})}});
app.put('/api/subscribers/:id',(req,res)=>{const {account_no,name,phone,address,joined_on,active}=req.body;try{run('UPDATE subscribers SET account_no=?,name=?,phone=?,address=?,joined_on=?,active=? WHERE id=?',account_no,name,phone||'',address||'',joined_on,active?1:0,req.params.id);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.delete('/api/subscribers/:id',(req,res)=>{if(get('SELECT 1 FROM invoices WHERE subscriber_id=?',req.params.id))return res.status(409).json({error:'للمشترك فواتير؛ يمكن إيقاف الحساب بدلاً من حذفه'});run('DELETE FROM subscribers WHERE id=?',req.params.id);res.json({ok:true})});
app.get('/api/subscribers/:id/last-reading',(req,res)=>{const subscriber=get('SELECT id,initial_reading FROM subscribers WHERE id=?',req.params.id);if(!subscriber)return res.status(404).json({error:'المشترك غير موجود'});const latest=get('SELECT current_reading,period_end FROM invoices WHERE subscriber_id=? ORDER BY period_end DESC,id DESC LIMIT 1',req.params.id);res.json({reading:latest?Number(latest.current_reading):Number(subscriber.initial_reading),date:latest?.period_end||null,source:latest?'invoice':'initial'})});
app.get('/api/invoices',(req,res)=>{let sql=`SELECT i.*,s.account_no,s.name FROM invoices i JOIN subscribers s ON s.id=i.subscriber_id WHERE 1=1`,p=[];if(req.query.from){sql+=' AND i.period_start>=?';p.push(req.query.from)}if(req.query.to){sql+=' AND i.period_end<=?';p.push(req.query.to)}if(req.query.subscriber){sql+=' AND i.subscriber_id=?';p.push(req.query.subscriber)}if(req.query.status==='unpaid')sql+=' AND i.paid=0';sql+=' ORDER BY i.period_end DESC,i.id DESC';res.json(all(sql,...p))});
app.post('/api/invoices',(req,res)=>{const {subscriber_id,period_start,period_end,current_reading}=req.body;const cur=Number(current_reading);const subscriber=get('SELECT id,initial_reading FROM subscribers WHERE id=? AND active=1',subscriber_id);if(!subscriber)return res.status(400).json({error:'المشترك غير موجود أو غير نشط'});const latest=get('SELECT current_reading FROM invoices WHERE subscriber_id=? ORDER BY period_end DESC,id DESC LIMIT 1',subscriber_id);const prev=latest?Number(latest.current_reading):Number(subscriber.initial_reading);if(!period_start||!period_end||!Number.isFinite(cur)||cur<prev)return res.status(400).json({error:'القراءة الحالية يجب ألا تقل عن آخر قراءة محفوظة ('+prev+')'});const kwh=cur-prev,rate=Number(get("SELECT value FROM settings WHERE key='current_rate'").value),amount=+(kwh*rate).toFixed(2);try{const r=run('INSERT INTO invoices(subscriber_id,period_start,period_end,previous_reading,current_reading,kwh,rate,amount) VALUES(?,?,?,?,?,?,?,?)',subscriber_id,period_start,period_end,prev,cur,kwh,rate,amount);res.status(201).json({id:r.lastID,previous_reading:prev,kwh,rate,amount})}catch(e){res.status(400).json({error:e.message.includes('UNIQUE')?'توجد فاتورة لهذه الفترة مسبقاً':'تعذر إنشاء الفاتورة'})}});
app.patch('/api/invoices/:id/payment',(req,res)=>{const inv=get('SELECT * FROM invoices WHERE id=?',req.params.id);if(!inv)return res.status(404).json({error:'الفاتورة غير موجودة'});const paid=!!req.body.paid;run('UPDATE invoices SET paid=?,paid_at=? WHERE id=?',paid?1:0,paid?(req.body.paid_at||new Date().toISOString().slice(0,10)):null,req.params.id);res.json({ok:true})});
app.delete('/api/invoices/:id',(req,res)=>{run('DELETE FROM invoices WHERE id=?',req.params.id);res.json({ok:true})});
app.get('*',(_,res)=>res.sendFile(path.join(__dirname,'public/index.html')));
const port=process.env.PORT||3000;app.listen(port,'0.0.0.0',()=>console.log(`Electricity Billing running on ${port}`));
