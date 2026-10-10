// Sonde de mutation : prouve que verify-balance.cjs TOMBE quand le bug
// revient. Sans cela, 175/175 ne prouve rien — un harnais qui passe au vert
// sur un code qui a le bug ne teste pas le bug.
//
// Copie le dépôt dans un dossier temporaire, retire le useEffect qui pousse
// l'egaliseur, et lance le harnais avec MAS_PLAYER_ROOT pointe vers la copie.
//
// Verdict attendu : le harnais doit ECHOUER. Un code de sortie 0 ici signifie
// que le harnais passe sur du code casse, donc qu'il ne teste rien — c'est
// l'échec de ce script, pas du harnais.
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-probe-'));
const FILES = ['App.tsx', 'src/services/playerManager.ts'];

for (const rel of FILES) {
  const dest = path.join(probe, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(REPO, rel), dest);
}

// Retirer le bloc useEffect : c'est exactement l'etat d'avant le correctif.
const appPath = path.join(probe, 'App.tsx');
const before = fs.readFileSync(appPath, 'utf8');
const after = before.replace(
  /\r?\n {2}\/\/ Pousse l'egaliseur vers le moteur natif\.[\s\S]*?dsp\.reverbMix,\r?\n {2}\]\);\r?\n/,
  '\n'
);
if (after === before) {
  console.error('SONDE INVALIDE : le bloc useEffect n a pas ete trouve, le test ne prouverait rien.');
  process.exit(2);
}
fs.writeFileSync(appPath, after, 'utf8');
console.log('useEffect absent de la copie mutante :', !/playerManager\.setEqualizer/.test(after));

// Lancer le harnais sur la copie mutante.
const { spawnSync } = require('child_process');
const result = spawnSync(
  process.execPath,
  [path.join(REPO, 'scripts', 'verify-balance.cjs')],
  { env: { ...process.env, MAS_PLAYER_ROOT: probe }, encoding: 'utf8' }
);

const out = (result.stdout || '') + (result.stderr || '');
const lignes = out.split('\n').filter((l) => /✗|ECHEC|vérifications? (passées|en échec)/.test(l));

console.log('\n--- lignes pertinentes ---');
lignes.forEach((l) => console.log(l.trim()));

const attendu = result.status === 1 && /✗/.test(out);
console.log('\nVERDICT :', attendu
  ? 'OK — le harnais echoue bien sur le code sans le correctif.'
  : 'ECHEC DU HARNAIS — il passe sur un code casse, il ne teste rien.');

fs.rmSync(probe, { recursive: true, force: true });
process.exit(attendu ? 0 : 1);