// Compile le TS du détecteur et le teste sur un signal synthétique.
const ts = require('typescript');
const fs = require('fs');

const src = fs.readFileSync('src/services/beatAnalyzer.ts', 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const Module = require('module');
const path = require('path');
const m = new Module('/tmp/beatAnalyzer.js', null);
m.filename = '/tmp/beatAnalyzer.js';
m.paths = Module._nodeModulePaths(process.cwd());
m._compile(js, '/tmp/beatAnalyzer.js');
const { BeatAnalyzer } = m.exports;

// --- Construit 10 s de 120 BPM : 4 temps par mesure, 0,5 s entre temps ---
const RATE = 48000;
const DUR = 10;
const CLICK_INTERVAL = 0.5; // 120 BPM

// Date.now() est simulé pour avancer le temps de façon déterministe.
let fakeNow = 1700000000000;
const realNow = Date.now;
Date.now = () => fakeNow;

const total = RATE * DUR;
const pcm = new Float32Array(total);
// Percussions sur chaque temps + un sustain sinusoïdal entre les temps.
for (let i = 0; i < total; i++) {
  const t = i / RATE;
  const sinceClick = t % CLICK_INTERVAL;
  let s = 0.12 * Math.sin(2 * Math.PI * 220 * t); // sustain
  if (sinceClick < 0.05) {
    const env = Math.exp(-sinceClick * 60);
    s += 0.9 * env * Math.sin(2 * Math.PI * 70 * sinceClick);
  }
  pcm[i] = s;
}

const a = new BeatAnalyzer(RATE);

// Pousse par tampons de 1024, comme le fait le tap natif.
const BUF = 1024;
const framesPerBuffer = BUF;
let bufferIdx = 0;
const pulses = [];
const readings = [];

// On avance l'horloge : une fenêtre = 1024/48000 s.
const winSec = 1024 / RATE;
let winCount = 0;
for (let off = 0; off < total; off += BUF) {
  const chunk = Array.from(pcm.slice(off, off + BUF));
  fakeNow += winSec * 1000;
  a.pushPcm(chunk);
  winCount++;
  const f = a.read();
  readings.push(f);
  pulses.push(f.pulse);
}

// --- Assertions ---
const f = a.read();
console.log('beatCount      :', f.beatCount, '(attendu ~20 = 10s @120BPM)');
console.log('bpm            :', f.bpm, '(attendu ~120)');

// Compte les montées de pulse (chaque beat = une attack).
let onsetsSeen = 0, prev = 0;
for (const p of readings) {
  if (p.pulse > 0.5 && prev <= 0.5) onsetsSeen++;
  prev = p.pulse;
}
console.log('attacks vues   :', onsetsSeen);

const maxPulse = Math.max(...pulses);
const avgNonZero = pulses.filter(p=>p>0).reduce((x,y)=>x+y,0)/Math.max(1,pulses.filter(p=>p>0).length);
console.log('pulse max/avg  :', maxPulse.toFixed(3), '/', avgNonZero.toFixed(3));
console.log('energy finale  :', f.energy.toFixed(3));

const pass = Math.abs((f.bpm ?? 0) - 120) < 8 && onsetsSeen >= 15 && onsetsSeen <= 24 && maxPulse > 0.5;
console.log(pass ? '\nPASS' : '\nFAIL');
Date.now = realNow;
