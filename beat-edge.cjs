const ts = require('typescript'); const fs = require('fs');
const src = fs.readFileSync('src/services/beatAnalyzer.ts','utf8');
const js = ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const Module=require('module'); const m=new Module('/tmp/ba.js',null);
m.filename='/tmp/ba.js'; m.paths=Module._nodeModulePaths(process.cwd()); m._compile(js,'/tmp/ba.js');
const {BeatAnalyzer}=m.exports;

let fakeNow=1700000000000; const realNow=Date.now; Date.now=()=>fakeNow;
const RATE=48000, WIN=1024, winSec=WIN/RATE;

function run(signalFn, durSec, a){
  const total=RATE*durSec; let onsets=0, prev=0, maxP=0;
  const pcm=new Float32Array(total);
  for(let i=0;i<total;i++) pcm[i]=signalFn(i/RATE);
  for(let off=0;off<total;off+=WIN){
    fakeNow+=winSec*1000;
    a.pushPcm(Array.from(pcm.slice(off,off+WIN)));
    const p=a.read().pulse; maxP=Math.max(maxP,p);
    if(p>0.5&&prev<=0.5) onsets++;
    prev=p;
  }
  return {onsets,maxP};
}

// 1) SILENCE ABSOLU -> 0 onset attendu
const a1=new BeatAnalyzer(RATE);
const r1=run(()=>0, 5, a1);
console.log(`silence        : ${r1.onsets} onset(s)  maxPulse=${r1.maxP.toFixed(2)}  ${r1.onsets===0?'OK':'ECHEC'}`);

// 2) BRUIT DE FOND tres faible -> peu ou pas d'onset (le plancher doit tenir)
const a2=new BeatAnalyzer(RATE);
let seed=1; const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff*2-1;};
const r2=run(()=>0.0009*rnd(), 5, a2);
console.log(`bruit de fond  : ${r2.onsets} onset(s)  maxPulse=${r2.maxP.toFixed(2)}  ${r2.onsets<=2?'OK':'ECHEC (stroboscope)'}`);

// 3) ADAPTATION: meme morceau a 0.3x puis 3x le volume, meme objet BeatAnalyzer
const click=(t)=>{const s=t%0.5;let v=0.12*Math.sin(2*Math.PI*220*t);if(s<0.05)v+=0.9*Math.exp(-s*60)*Math.sin(2*Math.PI*70*s);return v;};
const a3=new BeatAnalyzer(RATE);
const q=run((t)=>click(t)*0.3, 6, a3);
const r=run((t)=>click(t)*3.0, 6, a3);
console.log(`volume bas x6  : ${q.onsets} onset(s)  ${q.onsets>=8?'OK':'ECHEC'}`);
console.log(`puis fort x6   : ${r.onsets} onset(s)  ${r.onsets>=8?'OK':'ECHEC (seuil fige)'}`);

// 4) PAS de double trigger grosse caisse + charleston a 25ms d'ecart
const a4=new BeatAnalyzer(RATE);
const doubleKick=(t)=>{const s=t%0.5;let v=0.1*Math.sin(2*Math.PI*220*t);
  if(s<0.045) v+=0.9*Math.exp(-s*60)*Math.sin(2*Math.PI*70*s);
  if(s>=0.025&&s<0.05) v+=0.55*Math.exp(-(s-0.025)*90)*(seed=(seed*1103515245+12345)&0x7fffffff, Math.sin(2*Math.PI*9000*s));
  return v;};
const r4=run(doubleKick, 6, a4);
console.log(`double trigger : ${r4.onsets} onset(s) (attendu ~12)  ${r4.onsets<=15?'OK':'ECHEC (stroboscope)'}`);

Date.now=realNow;
