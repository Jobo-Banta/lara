const fs=require('fs'), path=require('path'), {spawn}=require('child_process'), {pathToFileURL}=require('url');
const root=__dirname, profile=path.join(root,'.render-profile-'+Date.now());
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const proc=spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
 let ws;
 try{
  const portfile=path.join(profile,'DevToolsActivePort');
  for(let i=0;!fs.existsSync(portfile)&&i<100;i++)await delay(100);
  const port=fs.readFileSync(portfile,'utf8').split('\n')[0];
  const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
  let id=0; const pending=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const [r,j]=pending.get(m.id);pending.delete(m.id);m.error?j(new Error(m.error.message)):r(m.result)}};
  const send=(method,params={})=>new Promise((r,j)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);j(new Error('Timeout: '+method))},15000);pending.set(key,[v=>{clearTimeout(timer);r(v)},e=>{clearTimeout(timer);j(e)}]);ws.send(JSON.stringify({id:key,method,params}))});
  await send('Page.enable');
  async function shot(file,out,w,h,full=false){
   await send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:false});
   await send('Emulation.setDefaultBackgroundColorOverride',{color:{r:0,g:0,b:0,a:0}});
   await send('Page.navigate',{url:pathToFileURL(path.join(root,file)).href});
   await delay(200);
   await send('Runtime.evaluate',{expression:'new Promise(r=>{if(document.readyState==="complete")r();else window.addEventListener("load",r,{once:true})})',awaitPromise:true});
   const data=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:full,...(full?{}:{clip:{x:0,y:0,width:w,height:h,scale:1}})});
   fs.mkdirSync(path.dirname(path.join(root,out)),{recursive:true});fs.writeFileSync(path.join(root,out),Buffer.from(data.data,'base64'));console.log('Rendered '+out);
  }
  if(!process.argv.includes('--preview-only')){
   for(const filename of fs.readdirSync(path.join(root,'web/backgrounds')).filter(f=>f.endsWith('.svg'))){
    const source=fs.readFileSync(path.join(root,'web/backgrounds',filename),'utf8');const m=source.match(/width="(\d+)" height="(\d+)"/);
    await shot('web/backgrounds/'+filename,'web/backgrounds/'+filename.replace('.svg','.png'),Number(m[1]),Number(m[2]));
   }
   for(const filename of ['lara-logo-primary.svg','lara-logo-reverse.svg','lara-symbol-primary.svg','lara-symbol-reverse.svg']){
    const source=fs.readFileSync(path.join(root,'web/logos',filename),'utf8');const m=source.match(/width="(\d+)" height="(\d+)"/);const w=Number(m[1])*3,h=Number(m[2])*3;
    fs.writeFileSync(path.join(root,'.render-logo.svg'),source.replace(/width="\d+" height="\d+"/,`width="${w}" height="${h}"`));
    await shot('.render-logo.svg','web/logos/'+filename.replace('.svg','.png'),w,h);
   }
   fs.unlinkSync(path.join(root,'.render-logo.svg'));
   for(const size of [16,32,48,180,192,512]){
    const src=fs.readFileSync(path.join(root,'web/logos/lara-app-icon.svg'),'utf8').replace('width="512" height="512"',`width="${size}" height="${size}"`);
    fs.writeFileSync(path.join(root,'.render-icon.svg'),src);
    await shot('.render-icon.svg',`web/logos/lara-icon-${size}.png`,size,size);
   }
   const src=fs.readFileSync(path.join(root,'web/logos/lara-app-icon-maskable.svg'),'utf8');fs.writeFileSync(path.join(root,'.render-icon.svg'),src);
   await shot('.render-icon.svg','web/logos/lara-icon-maskable-512.png',512,512);
   const entries=[16,32,48].map(s=>fs.readFileSync(path.join(root,`web/logos/lara-icon-${s}.png`)));
   const header=Buffer.alloc(6+16*entries.length);header.writeUInt16LE(1,2);header.writeUInt16LE(entries.length,4);let offset=header.length;
   entries.forEach((buf,i)=>{const p=6+i*16,size=[16,32,48][i];header[p]=size;header[p+1]=size;header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);header.writeUInt32LE(buf.length,p+8);header.writeUInt32LE(offset,p+12);offset+=buf.length});
   fs.writeFileSync(path.join(root,'web/logos/favicon.ico'),Buffer.concat([header,...entries]));
   fs.unlinkSync(path.join(root,'.render-icon.svg'));
  }
  await shot('index.html','preview-desktop.png',1440,1080,true);
  const desktop=await send('Runtime.evaluate',{expression:'JSON.stringify({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,brokenImages:[...document.images].filter(i=>!i.complete||!i.naturalWidth).map(i=>i.getAttribute("src"))})',returnByValue:true});
  await shot('index.html','preview-mobile.png',390,844,true);
  const mobile=await send('Runtime.evaluate',{expression:'JSON.stringify({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,brokenImages:[...document.images].filter(i=>!i.complete||!i.naturalWidth).map(i=>i.getAttribute("src"))})',returnByValue:true});
  console.log(JSON.stringify({desktop:JSON.parse(desktop.result.value),mobile:JSON.parse(mobile.result.value)}));
  await send('Browser.close');ws.close();
 }finally{if(ws)ws.close();proc.kill();}
}
main().catch(e=>{console.error(e);process.exitCode=1});

