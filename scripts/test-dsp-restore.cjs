/**
 * Test de robustesse de la restauration du DSP.
 *
 * `getDSP` relit une chaîne JSON du stockage natif. Cette chaîne peut venir
 * d'une version antérieure du schéma, d'une écriture tronquée ou d'un roaming
 * raté. Avant `normalizeDSP`, chacun de ces cas produisait un `undefined` que le
 * rendu déréférence (`dsp.bands.join(',')` dans le dep-array de `App.tsx`) —
 * écran blanc au lancement, avant tout affichage.
 *
 * Utilise le compilateur TypeScript déjà présent dans le projet, comme
 * `verify-dsp.cjs` : aucun outil supplémentaire n'est nécessaire.
 *
 * Lancer : node scripts/test-dsp-restore.cjs
 */
const ts = require('typescript');
const { mkdtempSync, writeFileSync, readFileSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

/** Compile `src/services/storageService.ts` avec des stubs AsyncStorage/Platform. */
function loadStorageService() {
  const src = readFileSync('src/services/storageService.ts', 'utf8');

  // Le module importe AsyncStorage et Platform : remplacés par des stubs pour
  // que le test tourne hors React Native.
  const dir = mkdtempSync(join(tmpdir(), 'dsprestore-'));
  const file = join(dir, 'storageService.ts');
  writeFileSync(
    file,
    src
      .replace(
        /^import AsyncStorage.*$/m,
        'const AsyncStorage = { getItem: async (_k: string) => (globalThis as any).__STUB, ' +
          'setItem: async (_k: string, _v: string) => {}, ' +
          'removeItem: async (_k: string) => {} };'
      )
      .replace(/^import \{ Platform \}.*$/m, 'const Platform: any = { OS: "ios" };')
      .replace(
        /^import \{ Track.*$/m,
        'type Track = any; type Playlist = any; type DSPState = any; type EqualizerPreset = any;'
      )
  );

  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    strict: true,
    esModuleInterop: true,
  });
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    console.error('storageService.ts ne compile pas :', errors.length, 'erreur(s)');
    process.exit(1);
  }
  program.emit();

  // `getDSP` est une méthode de l'objet `storageService`, pas un export de module.
  const { storageService } = require(join(dir, 'storageService.js'));
  return storageService;
}

const CASES = [
  ['bands absent', { enabled: true, volume: 50 }],
  ['bands trouée', { bands: [1, , 3] }],
  ['NaN / inf', { bands: [NaN, Infinity, -Infinity, 1], volume: 'x', preamp: null }],
  ['null', null],
  ['tableau', []],
  ['texte', 'pas du JSON'],
  ['valide', { enabled: false, volume: 33, bands: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
];

const isFiniteArray = (a) =>
  Array.isArray(a) &&
  a.length === 10 &&
  a.every((v) => typeof v === 'number' && Number.isFinite(v));

async function main() {
  const storageService = loadStorageService();
  let ok = true;

  for (const [label, payload] of CASES) {
    // JSON.stringify d'un tableau troué produit `null` : c'est exactement le cas
    // que le joueur peut relire après une écriture tronquée.
    globalThis.__STUB = JSON.stringify(payload);
    try {
      const dsp = await storageService.getDSP();
      const good =
        isFiniteArray(dsp && dsp.bands) &&
        typeof dsp.volume === 'number' &&
        Number.isFinite(dsp.volume);
      ok &&= good;
      console.log(
        `   ${good ? 'OK  ' : 'FAIL'} ${label.padEnd(14)} bands=${
          dsp && dsp.bands ? dsp.bands.length : 'null'
        } volume=${dsp ? dsp.volume : '-'}`
      );
    } catch (e) {
      ok = false;
      console.log(`   THROW ${label.padEnd(14)} ${e.message}`);
    }
  }

  console.log(
    '\n' + (ok ? 'RESTAURATION DSP ROBUSTE' : 'FUITE : un cas produit un état invalide')
  );
  process.exit(ok ? 0 : 1);
}

main();