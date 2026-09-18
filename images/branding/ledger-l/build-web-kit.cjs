const fs = require('fs');
const path = require('path');
const root = __dirname, web = path.join(root, 'web');
const C = {teal:'#125D66',mint:'#69D5C4',paper:'#F6F8F5',ink:'#202E3A'};
function save(file, data) {const p=path.join(root,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,data);}
function svg(w,h,body,label='') {return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${label?` role="img" aria-label="${label}"`:''}>${body}</svg>`;}
// Canonical geometric reconstruction of the approved Ledger-L symbol.
function mark(main=C.teal,accent=C.mint) {return `<g fill="${main}"><path d="M8 0H28V74H82Q86 74 86 78V96Q86 100 82 100H6Q0 100 0 94V8Q0 0 8 0Z"/><rect x="36" y="37" width="39" height="10" rx="1.4"/><rect x="36" y="55" width="39" height="10" rx="1.4"/></g><path fill="${accent}" d="M46 0H51Q53 0 55 2L74 21Q79 27 73 28H49Q46 28 46 25Z"/>`;}
function wordmark(color) {return `<g fill="${color}" fill-rule="evenodd"><path d="M0 0H17V58H52V73H0Z"/><path d="M61 73L87 0H109L135 73H116L111 57H85L80 73ZM90 42H106L98 17Z"/><path d="M145 0H180C215 0 216 39 195 47L216 73H194L175 49H163V73H145ZM163 15V34H179C195 34 196 15 179 15Z"/><path d="M224 73L250 0H272L298 73H279L274 57H248L243 73ZM253 42H269L261 17Z"/></g>`;}
for(const [name,main,accent] of [['primary',C.teal,C.mint],['mono',C.teal,C.teal],['reverse','#FFFFFF',C.mint],['white','#FFFFFF','#FFFFFF']]) {
 save(`web/logos/lara-symbol-${name}.svg`,svg(100,112,`<g transform="translate(7 6)">${mark(main,accent)}</g>`,'LARA'));
 save(`web/logos/lara-logo-${name}.svg`,svg(464,112,`<g transform="translate(7 6)">${mark(main,accent)}</g><g transform="translate(124 21)">${wordmark(main)}</g>`,'LARA'));
}
const app = `<rect width="512" height="512" rx="104" fill="${C.teal}"/><g transform="translate(113 86) scale(3.35)">${mark('#FFFFFF')}</g>`;
save('web/logos/lara-app-icon.svg',svg(512,512,app,'LARA'));
save('web/logos/lara-app-icon-maskable.svg',svg(512,512,`<rect width="512" height="512" fill="${C.teal}"/><g transform="translate(140 121) scale(2.7)">${mark('#FFFFFF')}</g>`,'LARA'));
save('web/logos/favicon.svg',svg(32,32,`<rect width="32" height="32" rx="6" fill="${C.teal}"/><g transform="translate(6 4) scale(.24)">${mark('#FFFFFF')}</g>`,'LARA'));
const P = d=>`<path d="${d}"/>`, R=(x,y,w,h,r=2)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/>`, O=(x,y,r)=>`<circle cx="${x}" cy="${y}" r="${r}"/>`;
const doc = P('M6 3h8l4 4v14H6Z M14 3v5h4');
const icons = {
 'dashboard':R(3,3,7,7)+R(14,3,7,7)+R(3,14,7,7)+R(14,14,7,7),
 'ledger':R(4,3,16,18)+P('M9 3v18 M12 8h5 M12 12h5 M12 16h5'),
 'journal':P('M5 4h13v7 M5 4v17h9 M8 8h6 M8 12h3 M14 19l5-5 2 2-5 5h-2Z'),
 'invoice':doc+P('M9 12h6 M9 16h6'),
 'receipt':P('M6 3h12v18l-3-2-3 2-3-2-3 2Z M9 7h6 M9 11h6 M9 15h3'),
 'receivables':R(3,5,18,15)+P('M3 10h18 M12 12v6 M9 15l3 3 3-3'),
 'payables':R(3,5,18,15)+P('M3 10h18 M12 18v-6 M9 15l3-3 3 3'),
 'bank':P('M3 8l9-5 9 5Z M5 11v7 M10 11v7 M14 11v7 M19 11v7 M3 21h18'),
 'reconcile':P('M4 7h15l-3-3 M20 17H5l3 3 M4 7v4 M20 17v-4 M9 12l2 2 4-4'),
 'reports':P('M4 3v18h17 M8 17v-5 M13 17V8 M18 17V4'),
 'tax':doc+P('M9 17l6-6')+O(9.5,11.5,1)+O(14.5,16.5,1),
 'calendar':R(3,5,18,16)+P('M7 3v4 M17 3v4 M3 10h18 M7 14h2 M14 14h2 M7 18h2'),
 'period-close':R(3,5,18,16)+P('M7 3v4 M17 3v4 M3 10h18 M8 15l3 3 5-5'),
 'review':O(10,10,6)+P('M15 15l6 6 M7 10l2 2 4-4'),
 'evidence':P('M8 12l6-6a3 3 0 014 4l-8 8a5 5 0 01-7-7l8-8 M6 14l8-8'),
 'audit-trail':P('M6 4v16 M6 6h6 M6 12h10 M6 18h6')+O(16,6,2)+O(19,12,2)+O(16,18,2),
 'approval':O(12,12,9)+P('M7 12l3 3 7-7'),
 'exception':P('M12 3L2 21h20Z M12 9v5 M12 17v1'),
 'users':O(9,7,3)+P('M3 21v-3a6 6 0 0112 0v3 M16 4a3 3 0 010 6 M18 14a5 5 0 013 4v3'),
 'branch':R(8,3,8,5)+R(2,17,7,5)+R(15,17,7,5)+P('M12 8v5 M5.5 17v-4h13v4'),
 'inventory':P('M3 7l9-4 9 4v11l-9 4-9-4Z M3 7l9 5 9-5 M12 12v10 M7 5l9 5'),
 'assets':R(3,4,18,13)+P('M8 21h8 M12 17v4 M7 8h10 M7 12h5'),
 'budget':O(12,12,9)+P('M12 3v9h9 M5.5 18.5L12 12'),
 'search':O(10,10,7)+P('M15 15l6 6'),
 'upload':P('M12 16V3 M7 8l5-5 5 5 M3 15v6h18v-6'),
 'download':P('M12 3v13 M7 11l5 5 5-5 M3 15v6h18v-6'),
 'settings':P('M4 7h16 M4 17h16')+R(7,4,4,6,1)+R(14,14,4,6,1),
 'lock':R(5,10,14,11)+P('M8 10V7a4 4 0 018 0v3 M12 14v3'),
 'help':O(12,12,9)+P('M9 8a3 3 0 016 0c0 2-3 2-3 5 M12 17h.01'),
 'notification':P('M5 17h14l-2-3V9a5 5 0 00-10 0v5Z M10 21h4'),
 'next':P('M4 12h16 M14 6l6 6-6 6'),
 'menu':P('M4 6h16 M4 12h16 M4 18h16')
};
let symbols='';
for(const [name,body] of Object.entries(icons)) {
 const g=`<g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
 save(`web/icons/${name}.svg`,svg(24,24,g));symbols+=`<symbol id="lara-${name}" viewBox="0 0 24 24">${g}</symbol>`;
}
save('web/icons/sprite.svg',`<svg xmlns="http://www.w3.org/2000/svg">${symbols}</svg>`);
const bgNames=[];
function bg(name,w,h,body){save(`web/backgrounds/${name}.svg`,svg(w,h,body));bgNames.push(name);}
bg('page-light',1920,1080,`<rect width="1920" height="1080" fill="${C.paper}"/><g stroke="${C.teal}" stroke-opacity=".045" fill="none"><path d="M1440 0v1080 M1536 0v1080 M1632 0v1080 M1728 0v1080 M1824 0v1080"/><path d="M1400 120h520 M1400 240h520 M1400 360h520 M1400 480h520 M1400 600h520 M1400 720h520 M1400 840h520 M1400 960h520"/></g>`);
bg('page-dark',1920,1080,`<rect width="1920" height="1080" fill="${C.ink}"/><g transform="translate(1380 200) scale(8)" opacity=".045">${mark('#FFFFFF','#FFFFFF')}</g>`);
bg('banner-light',1920,640,`<rect width="1920" height="640" fill="${C.paper}"/><path d="M1410 0h510v640h-740V430h230Z" fill="${C.teal}" opacity=".055"/><g transform="translate(1510 155) scale(3.4)" opacity=".22">${mark()}</g>`);
bg('banner-dark',1920,640,`<rect width="1920" height="640" fill="${C.ink}"/><path d="M1470 0h450v640h-800V430h350Z" fill="${C.teal}" opacity=".7"/><g transform="translate(1510 155) scale(3.4)" opacity=".25">${mark('#FFFFFF',C.mint)}</g>`);
bg('banner-teal',1920,640,`<rect width="1920" height="640" fill="${C.teal}"/><g transform="translate(1470 130) scale(3.8)" opacity=".16">${mark('#FFFFFF','#FFFFFF')}</g><path d="M1330 510h590 M1390 550h530" stroke="${C.mint}" stroke-opacity=".25" stroke-width="3"/>`);
bg('banner-mobile',720,960,`<rect width="720" height="960" fill="${C.paper}"/><path d="M380 650h340v310H180V830h200Z" fill="${C.teal}" opacity=".065"/><g transform="translate(475 720) scale(1.8)" opacity=".2">${mark()}</g>`);
bg('social-square',1200,1200,`<rect width="1200" height="1200" fill="${C.ink}"/><path d="M820 600h380v600H460V940h360Z" fill="${C.teal}" opacity=".65"/><g transform="translate(950 940) scale(1.8)" opacity=".4">${mark('#FFFFFF')}</g>`);
bg('ledger-tile',160,160,`<g fill="none" stroke="${C.teal}" stroke-opacity=".07"><path d="M0 40h160 M0 80h160 M0 120h160 M40 0v160 M120 0v160"/></g>`);
for(const [name,icon,title] of [['empty-records','ledger','No records'],['empty-search','search','No matches'],['review-complete','approval','Review complete']]) {
save(`web/illustrations/${name}.svg`,svg(320,240,`<rect x="60" y="34" width="200" height="164" rx="28" fill="#E7F2F0"/><g transform="translate(112 72) scale(4)" color="${C.teal}" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">${icons[icon]}</g><path d="M90 212h140" stroke="#C7DEDA" stroke-width="3" stroke-linecap="round"/>`,title));}
save('web/lara-theme.css',`:root{--lara-primary:#125D66;--lara-accent:#69D5C4;--lara-background:#F6F8F5;--lara-ink:#202E3A;--lara-border:#C7DEDA;--lara-surface:#fff;--lara-radius:12px;--lara-font:Manrope,system-ui,sans-serif} .lara-icon{width:24px;height:24px;display:inline-block;fill:none;color:var(--lara-primary);flex:none}.lara-banner{background:var(--lara-background) url('./backgrounds/banner-light.svg') right center/cover no-repeat;color:var(--lara-ink);padding:clamp(24px,5vw,80px);border-radius:var(--lara-radius)}.lara-banner-content{max-width:58%}@media(max-width:640px){.lara-banner{background-image:url('./backgrounds/banner-mobile.svg');background-position:center bottom}.lara-banner-content{max-width:100%}}`);
save('web/manifest.webmanifest',JSON.stringify({name:'LARA',short_name:'LARA',display:'standalone',background_color:C.paper,theme_color:C.teal,icons:[{src:'logos/lara-app-icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any'},{src:'logos/lara-app-icon-maskable.svg',sizes:'any',type:'image/svg+xml',purpose:'maskable'}]},null,2));
let html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LARA brand and web assets</title><style>*{box-sizing:border-box}body{margin:0;background:#F6F8F5;color:#202E3A;font:16px/1.5 system-ui,sans-serif}main{max-width:1240px;margin:auto;padding:48px 24px}h1{font-size:40px;line-height:1.12}h2{margin-top:48px}a{color:#125D66}header img{width:300px;max-width:100%}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px}.card{padding:24px;border:1px solid #C7DEDA;border-radius:16px;background:white}.card img{width:100%;display:block}.dark{background:#202E3A;color:white}.icons{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px}.icon{padding:20px 8px;border:1px solid #C7DEDA;border-radius:12px;background:white;text-align:center;font-size:12px}.icon svg{width:32px;height:32px;color:#125D66;display:block;margin:0 auto 12px}.swatches{display:flex;gap:10px;flex-wrap:wrap}.swatches span{padding:12px 20px;border-radius:8px}.banner{aspect-ratio:3;display:flex;align-items:center;padding:5%;background-size:cover;border-radius:16px;margin:16px 0}.banner h3{font-size:clamp(16px,3vw,32px);max-width:58%;line-height:1.2}.caption{font-size:14px;color:#50616B}.brand img{max-height:500px;object-fit:contain}footer{margin-top:48px;font-size:14px}</style><main><header><img src="web/logos/lara-logo-primary.svg" alt="LARA"><h1>Clear books.<br>Clear next steps.</h1><p>Approved Ledger-L identity · Brand and web asset library</p><p class="caption">Scalable logos, 32 interface icons, eight backgrounds and three supporting illustrations.</p></header><h2>Logo family</h2><div class="grid"><div class="card"><img src="web/logos/lara-logo-primary.svg" alt="Primary logo"><p>Primary · transparent SVG</p></div><div class="card dark"><img src="web/logos/lara-logo-reverse.svg" alt="Reversed logo"><p>Reversed · dark surfaces</p></div><div class="card"><img style="height:112px" src="web/logos/lara-app-icon.svg" alt="App icon"><p>App icon · SVG and PNG</p></div></div><h2>Palette</h2><div class="swatches">${Object.entries(C).map(([n,c])=>`<span style="background:${c};color:${n==='teal'||n==='ink'?'white':C.ink}">${n} ${c}</span>`).join('')}</div><h2>Accounting and interface icons</h2><p class="caption">24 × 24 grid · 1.75 stroke · currentColor · individual files and SVG sprite</p><div class="icons">${Object.entries(icons).map(([name,body])=>`<div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>${name}</div>`).join('')}</div><h2>Banner backgrounds</h2><p class="caption">Background files contain no text. Keep desktop copy in the left 58%; use the dedicated mobile background on narrow screens.</p>${['light','dark','teal'].map(n=>`<div class="banner" style="background-image:url(web/backgrounds/banner-${n}.svg);color:${n==='light'?C.ink:'white'}"><h3>Clarity for every<br>next step.</h3></div><a href="web/backgrounds/banner-${n}.svg">banner-${n}.svg</a>`).join('')}<h2>Page, mobile and social backgrounds</h2><div class="grid">${['page-light','page-dark','banner-mobile','social-square','ledger-tile'].map(n=>`<div class="card"><img style="height:180px;object-fit:cover" src="web/backgrounds/${n}.svg" alt="${n}"><a href="web/backgrounds/${n}.svg">${n}</a></div>`).join('')}</div><h2>Supporting illustrations</h2><div class="grid">${['empty-records','empty-search','review-complete'].map(n=>`<div class="card"><img src="web/illustrations/${n}.svg" alt="${n}"><p>${n}</p></div>`).join('')}</div><h2>Updated brand artwork</h2><div class="grid brand">${['avatar-accounting-expert','brand-overview','website-hero','launch-campaign','product-infographic'].map(n=>`<div class="card"><a href="brand/LARA-${n}.png"><img src="brand/LARA-${n}.png" alt="${n}">${n}</a></div>`).join('')}</div><footer>Product artwork describes planned capabilities, not validated live results. See README.md for usage and the current brand guide.</footer></main></html>`;
html=html.replace('<h2>Updated brand artwork</h2>','<h2>Web mascot</h2><div class="card" style="max-width:360px;background:repeating-conic-gradient(#eef4f2 0% 25%,white 0% 50%) 50%/24px 24px"><img src="web/illustrations/lara-mascot-transparent.png" alt="LARA accounting companion"></div><h2>Updated brand artwork</h2>');
save('index.html',html);
console.log(`Created ${Object.keys(icons).length} icons, ${bgNames.length} backgrounds, 3 illustrations and 11 logo variants.`);
