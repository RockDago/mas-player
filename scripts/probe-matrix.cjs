/**
 * Banc de calcul : que fait RÉELLEMENT la matrice M/S câblée dans
 * webAudioEngine.ts ? Réponse par le graphe, pas par la mémoire.
 *
 * On reproduit le câblage nœud par nœud :
 *   M = midSum·(0.5L + 0.5R)   S = sideGain·(0.5L − 0.5R)   R' = midSum·M − S
 *   L' = midSum·M + S
 * puis on balaie toutes les directions d'entrée possibles pour trouver le pic.
 */

function matrixPeak(midG, sideG) {
  // L' = midG·(L+R)/2 + sideG·(L−R)/2  =  a·L + b·R
  // R' = midG·(L+R)/2 − sideG·(L−R)/2  =  b·L + a·R
  const a = (midG + sideG) / 2, b = (midG - sideG) / 2;
  // Valeurs singulières d'une matrice symétrique [[a,b],[b,a]] : {a+b, a−b}.
  return Math.max(Math.abs(a + b), Math.abs(a - b));
}

const widthOf = (pct) => 1.0 + (pct / 100) * 1.2;

console.log('MATRICE ACTUELLE  (midSum = 1/((1+w)/2), sideGain = w)');
console.log('  pct     w     midG    sideG      pic     dBFS');
for (const pct of [0, 25, 50, 75, 100]) {
  const w = widthOf(pct);
  const midG = 1 / ((1 + w) / 2);
  const sideG = w;
  const p = matrixPeak(midG, sideG);
  console.log(`  ${String(pct).padStart(3)}  ${w.toFixed(3)}  ${midG.toFixed(4)}  ${sideG.toFixed(3)}   ${p.toFixed(4)}  ${(20 * Math.log10(p)).toFixed(2).padStart(6)}`);
}

console.log('\nCORRECTION CANDIDATE  (n = max(1,w) ; midSum = 1/n, sideGain = w/n)');
console.log('  pct     w     midG    sideG      pic     dBFS');
let allUnity = true;
for (const pct of [0, 25, 50, 75, 100]) {
  const w = widthOf(pct);
  const n = Math.max(1, w);
  const midG = 1 / n;
  const sideG = w / n;
  const p = matrixPeak(midG, sideG);
  if (Math.abs(p - 1) > 1e-12) allUnity = false;
  console.log(`  ${String(pct).padStart(3)}  ${w.toFixed(3)}  ${midG.toFixed(4)}  ${sideG.toFixed(4)}   ${p.toFixed(6)}  ${(20 * Math.log10(p)).toFixed(4).padStart(8)}`);
}
console.log(`  -> pic constant a 1 : ${allUnity}`);

console.log('\nCas particuliers');
// Mono : sideG = 0, midG = 1  =>  L' = R' = (L+R)/2
console.log(`  mono (midG=1, sideG=0)     pic = ${matrixPeak(1, 0).toFixed(6)}  (attendu 1)`);
console.log(`  neutre (w=1)               pic = ${matrixPeak(1, 1).toFixed(6)}  (attendu 1)`);
// Le signe de b doit rester négatif : c'est l'inversion de phase qui élargit.
{
  const w = widthOf(100), n = Math.max(1, w);
  const a = (1 / n + w / n) / 2, b = (1 / n - w / n) / 2;
  console.log(`  a = ${a.toFixed(4)}, b = ${b.toFixed(4)}  (b doit etre < 0)`);
  console.log(`  signal dur pan L=1,R=0 ->  L' = ${(a).toFixed(4)}, R' = ${(b).toFixed(4)}`);
}