const vm=require('vm'),fs=require('fs');
const el=()=>({innerHTML:'',textContent:'',className:'',style:{},dataset:{},classList:{toggle(){},add(){},remove(){}},setAttribute(){},appendChild(){},remove(){},focus(){},querySelector(){return null},querySelectorAll(){return []},addEventListener(){},click(){}});
const app=el(), calls=[];
const doc={querySelector:s=>s==='#app'?app:el(),querySelectorAll:()=>[],getElementById:()=>el(),createElement:()=>el(),body:el(),documentElement:{classList:{add(){},remove(){}},dataset:{}},addEventListener(){},removeEventListener(){}};
const ctx={document:doc,innerWidth:1200,screen:{width:1200,height:800},matchMedia:()=>({matches:false}),localStorage:{getItem:()=>null,setItem(){}},addEventListener(){},scrollTo(){},setTimeout,clearTimeout,setInterval:()=>0,console,
 fetch:async(p,o)=>{calls.push([o.method,p,o.body]);return{status:200,json:async()=>({ok:true,data:p==='/api/status'?{needsSetup:false}:{}})}},URL:{createObjectURL:()=>'x',revokeObjectURL(){}},Blob:class{},FileReader:class{},confirm:()=>true,alert(){}};
vm.createContext(ctx);
const code=fs.readFileSync(require('path').join(__dirname,'..','public','app.js'),'utf8');
vm.runInContext(code,ctx);
const mk=(role,perms)=>({me:{id:'u-1',name:'Test '+role,role,perms},tables:['T1','T2'],
 users:[{id:'u-1',username:'t',name:'Test',role,active:true},{id:'u-2',username:'k',name:'Chef',role:'kitchen',active:true},{id:'u-3',username:'w',name:'Wai"ter<b>',role:'waiter',active:true}],
 products:[{id:'p-1',name:'Tusker',cat:'Beer',dept:'bar',price:300,cost:220,stock:20,reorder:5,active:true},{id:'p-2',name:'No price',cat:'Beer',dept:'bar',price:0,cost:0,stock:0,reorder:5,active:true},
  {id:'p-3',name:'Beef kg',cat:'Ingredient',dept:'store',price:0,cost:900,stock:10,reorder:2,active:true},{id:'p-4',name:'Nyama',cat:'Food',dept:'rest',price:900,cost:0,stock:0,reorder:0,active:true,recipe:[{pid:'p-3',qty:0.5}]}],
 rooms:[{no:'1',type:'Single',rate:2500,status:'vacant'},{no:"2'x",type:'Double',rate:3500,status:'dirty'}],
 sales:[{id:'S-1',ts:new Date().toISOString(),dept:'bar',items:[{pid:'p-1',name:'Tusker',qty:2,price:300,cost:220}],total:600,staff:'u-3',staffName:'Wai"ter',by:'x',table:'',status:'completed',served:false,pay:'paid',cust:'',bid:'',voidReason:'',balance:0},
  {id:'S-2',ts:new Date().toISOString(),dept:'rest',items:[{pid:'p-4',name:'Nyama',qty:1,price:900,cost:0}],total:900,staff:'u-3',staffName:'W',by:'x',table:'T1',status:'pending',served:false,pay:'open',cust:'',bid:'',voidReason:'',balance:900}],
 bookings:[{id:'B-1',room:'1',guest:'Jo',phone:'07',in:'2026-10-09',out:'2026-10-11',status:'in',folio:{ch:0,pa:1000,bal:-1000,payStatus:'deposit',est:5000,estNights:2}},{id:'B-2',room:"2'x",guest:'Al',phone:'',in:'2026-10-20',out:'2026-10-21',status:'reserved',folio:{ch:0,pa:0,bal:0,payStatus:'none'}}],
 charges:[],payments:[],moves:[{id:'m',ts:new Date().toISOString(),pid:'zzz',qty:1,reason:'r',user:'u'}],expenses:[{ts:new Date().toISOString(),cat:'Other',desc:'d',amount:10,user:'u'}],
 shifts:[{id:'sh',user:'u-1',userName:'T',open:new Date().toISOString(),float:0,close:null,expected:null,counted:null}],priceLog:[{ts:new Date().toISOString(),user:'u',item:'Tusker',changes:[{field:'price',from:1,to:2}],reason:'r'}],audit:[{ts:new Date().toISOString(),user:'u',action:'a',detail:'d'}]});
const rpt={rev:{bar:600,rest:0,lodging:0},cost:{bar:440,rest:0,lodging:0},rv:600,gp:160,exp:10,np:150,pm:{Cash:600},bySalesperson:{W:600},out:900,outSales:900,outBookings:0,deposits:1000,stockValue:5000};
const roles={admin:['*'],manager:['sell','pay','void','rooms','stock','price','finance','reports','kitchen','approve','shift'],cashier:['sell','pay','shift'],bartender:['sell','shift'],waiter:['sell','kitchen'],kitchen:['kitchen'],receptionist:['rooms','pay','sell','shift'],storekeeper:['stock']};
let bad=0;
for(const [role,perms] of Object.entries(roles)){
  ctx.__S=mk(role,perms);ctx.__R={d:rpt,w:rpt,m:rpt,r:rpt};
  vm.runInContext('S=__S;ME=S.me;AUTH="app";R=__R;CART=[{pid:"p-1",qty:2}];',ctx);
  const tabs=vm.runInContext('vis().map(t=>t[0])',ctx);
  for(const t of tabs){ try{ vm.runInContext('TAB="'+t+'";render()',ctx); const h=app.innerHTML; if(!h||/undefined|NaN|\[object/.test(h)){bad++;console.log('BAD output',role,t,(h.match(/.{30}(undefined|NaN|\[object).{30}/)||[''])[0]);} }catch(e){bad++;console.log('THROW',role,t,e.message)} }
  console.log(role,'tabs:',tabs.join(','));
}
// html-injection check: names with quotes/tags must be escaped
vm.runInContext('TAB="bar";render()',ctx); if(/Wai"ter<b>/.test(app.innerHTML)){bad++;console.log('UNESCAPED name')}
// login / setup screens
for(const a of ['boot','setup','login']){vm.runInContext('ME=null;S=null;AUTH="'+a+'";render()',ctx); if(!app.innerHTML){bad++;console.log('empty',a)}}
console.log(bad?'FAILURES: '+bad:'ALL VIEWS RENDER');
