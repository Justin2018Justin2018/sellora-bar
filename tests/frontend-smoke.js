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
  {id:'p-k',name:'Tusker Lager (keg)',cat:'Keg',dept:'store',price:0,cost:107.16,stock:47.5,reorder:0,active:true,unit:'L',packSize:50,packCost:5358},{id:'p-j',name:'Tusker Jug',cat:'Draught',dept:'bar',price:210,cost:0,stock:0,reorder:0,active:true,priceOpts:[210,250],recipe:[{pid:'p-k',qty:1.5}]},{id:'p-9',name:'Retired item',cat:'Beer',dept:'bar',price:100,cost:50,stock:0,reorder:0,active:false},{id:'p-3',name:'Beef kg',cat:'Ingredient',dept:'store',price:0,cost:900,stock:10,reorder:2,active:true},{id:'p-4',name:'Nyama',cat:'Food',dept:'rest',price:900,cost:0,stock:0,reorder:0,active:true,recipe:[{pid:'p-3',qty:0.5}]}],
 rooms:[{no:'1',type:'Single',rate:2500,status:'vacant'},{no:"2'x",type:'Double',rate:3500,status:'dirty'}],
 sales:[{id:'S-1',ts:new Date().toISOString(),dept:'bar',items:[{pid:'p-1',name:'Tusker',qty:2,price:300,cost:220}],total:600,staff:'u-3',staffName:'Wai"ter',by:'x',table:'',status:'completed',served:false,pay:'paid',cust:'',bid:'',voidReason:'',balance:0},
  {id:'S-2',ts:new Date().toISOString(),dept:'rest',items:[{pid:'p-4',name:'Nyama',qty:1,price:900,cost:0}],total:900,staff:'u-3',staffName:'W',by:'x',table:'T1',status:'pending',served:false,pay:'open',cust:'',bid:'',voidReason:'',balance:900}],
 bookings:[{id:'B-3',room:'1',guest:'Out Guest',phone:'',in:'2026-10-01',out:'2026-10-02',status:'out',folio:{ch:2500,pa:5000,bal:-2500,payStatus:'credit'}},{id:'B-1',room:'1',guest:'Jo',phone:'07',in:'2026-10-09',out:'2026-10-11',status:'in',folio:{ch:0,pa:1000,bal:-1000,payStatus:'deposit',est:5000,estNights:2}},{id:'B-2',room:"2'x",guest:'Al',phone:'',in:'2026-10-20',out:'2026-10-21',status:'reserved',folio:{ch:0,pa:0,bal:0,payStatus:'none'}}],
 charges:[],payments:[],moves:[{id:'m',ts:new Date().toISOString(),pid:'zzz',qty:1,reason:'r',user:'u'}],expenses:[{ts:new Date().toISOString(),cat:'Other',desc:'d',amount:10,user:'u'}],
 shifts:[{id:'sh',user:'u-1',userName:'T',open:new Date().toISOString(),float:0,close:null,expected:null,counted:null}],priceLog:[{ts:new Date().toISOString(),user:'u',item:'Tusker',changes:[{field:'price',from:1,to:2}],reason:'r'}],audit:[{ts:new Date().toISOString(),user:'u',action:'a',detail:'d'}]});
const rpt={rev:{bar:600,rest:0,lodging:0},cost:{bar:440,rest:0,lodging:0},rv:600,gp:160,exp:10,np:150,pm:{Cash:600},bySalesperson:{W:600},out:900,outSales:900,outBookings:0,deposits:1000,stockValue:5000};
const roles={admin:['*'],manager:['sell','pay','void','rooms','stock','price','finance','reports','kitchen','approve','shift'],cashier:['sell','pay','shift'],bartender:['sell','shift'],waiter:['sell','kitchen'],kitchen:['kitchen'],receptionist:['rooms','pay','sell','shift'],storekeeper:['stock']};
let bad=0;
for(const [role,perms] of Object.entries(roles)){
  ctx.__S=mk(role,perms);ctx.__R={d:rpt,w:rpt,m:rpt,r:rpt,k:[{id:'p-k',name:'Tusker Lager (keg)',unit:'L',capacity:50,kegCost:5358,costPerLitre:107.16,remaining:47.5,stockValue:5090,lifetime:{received:50,sold:2.5,adjusted:0,remaining:47.5,reconciled:true},period:{litresSold:2.5,revenue:350,cost:267.9,grossProfit:82.1,servings:[{name:'Tusker Glass',qty:2,litres:1,revenue:140,cost:107.16}]}}]};
  vm.runInContext('S=__S;ME=S.me;AUTH="app";R=__R;CART=[{pid:"p-1",qty:2}];',ctx);
  const tabs=vm.runInContext('vis().map(t=>t[0])',ctx);
  for(const t of tabs){ try{ vm.runInContext('TAB="'+t+'";render()',ctx); const h=app.innerHTML; if(!h||/undefined|NaN|\[object/.test(h)){bad++;console.log('BAD output',role,t,(h.match(/.{30}(undefined|NaN|\[object).{30}/)||[''])[0]);} }catch(e){bad++;console.log('THROW',role,t,e.message)} }
  console.log(role,'tabs:',tabs.join(','));
}
// html-injection check: names with quotes/tags must be escaped
vm.runInContext('TAB="bar";render()',ctx); if(/Wai"ter<b>/.test(app.innerHTML)){bad++;console.log('UNESCAPED name')}
// money formatting on receipts is exact (JS floats would print 37.019999999999996)
const rh=vm.runInContext('receiptHtml({id:"S-1",ts:new Date().toISOString(),dept:"bar",items:[{name:"Odd",qty:3,price:12.34},{name:"Half",qty:0.5,price:33.33}],total:53.68,staffName:"A",table:"",status:"void",pay:"paid"})',ctx);
if(!/ x3  37\.02/.test(rh)||!/ x0\.5  16\.67/.test(rh)||/\d{6,}/.test(rh.replace(/S-1|\d{1,2}[\/:.,-]\d{1,2}[^\n]*/g,''))){bad++;console.log('RECEIPT ROUNDING',rh)}
if(!/STATUS: VOID/.test(rh)){bad++;console.log('receipt status missing')}
// the credit-refund and retire/restore controls are offered to a manager, not to a cashier
ctx.__S=mk('manager',roles.manager);vm.runInContext('S=__S;ME=S.me;AUTH="app";R=__R;TAB="rooms";render()',ctx);if(!/refundCredit\('B-3'\)/.test(app.innerHTML)){bad++;console.log('no refund-credit button for manager')}
vm.runInContext('TAB="stock";render()',ctx);if(!/Restore/.test(app.innerHTML)||!/Retire/.test(app.innerHTML)){bad++;console.log('no retire/restore buttons')}
ctx.__S=mk('receptionist',roles.receptionist);vm.runInContext('S=__S;ME=S.me;TAB="rooms";render()',ctx);if(/refundCredit/.test(app.innerHTML)){bad++;console.log('receptionist must not see refund-credit')}
// keg screens: litres, receive-keg, admin price choice, litres report with reconciliation
ctx.__S=mk('admin',roles.admin);vm.runInContext('S=__S;ME=S.me;AUTH="app";TAB="stock";render()',ctx);if(!/Receive keg/.test(app.innerHTML)||!/Set up a keg/.test(app.innerHTML)||!/47\.5 L/.test(app.innerHTML)){bad++;console.log('keg stock row/buttons missing')}
vm.runInContext('TAB="rep";render()',ctx);if(!/litres report/.test(app.innerHTML)||!/reconciled/.test(app.innerHTML)||!/Cost per litre/.test(app.innerHTML)||/NaN|undefined/.test(app.innerHTML)){bad++;console.log('keg report card wrong')}
vm.runInContext('TAB="bar";render()',ctx);if(!/Tusker Jug/.test(app.innerHTML)||!/can make 31/.test(app.innerHTML)){bad++;console.log('jug serving should show 31 possible from 47.5 L')}
// login / setup screens
vm.runInContext('NEEDKEY=true',ctx);vm.runInContext('ME=null;S=null;AUTH="setup";render()',ctx);if(!/id="sk"/.test(app.innerHTML)){bad++;console.log('setup key field missing')}vm.runInContext('NEEDKEY=false',ctx);
for(const a of ['boot','setup','login']){vm.runInContext('ME=null;S=null;AUTH="'+a+'";render()',ctx); if(!app.innerHTML){bad++;console.log('empty',a)}}
console.log(bad?'FAILURES: '+bad:'ALL VIEWS RENDER');
