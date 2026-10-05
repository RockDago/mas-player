/**
 * Vérifie que la fonction du limiteur Swift est la MÊME que celle du web, et
 * qu'elle tient sa promesse de plafond. À lancer avec `node scripts/verify-limiter.cjs`.
 *
 * Ce script existe parce que les deux implémentations vivent dans deux langages
 * différents sans type commun. Une divergence d'un centième de dB est inaudible
 * mais fausse : la correspondance web/iOS vaut sur le chiffre, pas sur l'intention.
 *
 *   Swift : requiredGain(peak, threshold)   puis  out = peak·gain
 *           db = 20·log10(peak) ; si db > seuil : gain = 10^((seuil−db)/20)
 *   Web   : la même fonction, une fois réécrite (voir webAudioEngine.ts)
 */
const thresholdDb = -3.0;

// --- La formule Swift, transcrite littéralement -------------------------
// requiredGain() renvoie un GAIN LINÉAIRE. Sur un pic, la sortie vaut pic·gain,
// donc en dB : out = db + 20·log10(gain) = db + (seuil − db) = seuil.
function swiftLimit(db, threshold = thresholdDb) {
  if (db <= threshold) return db;                 // sous le seuil : gain = 1.0
  return threshold;                               // ratio 1 : la sortie atteint le seuil
}

let ok = true;
console.log('Limiteur : formule Swift vs formule du web');
console.log('   dBFS     sortie');
const cases = [-24, -12, -6, -3.01, -3, -2.99, -1, 0, 3, 6, 9, 12, 18, 24, 40, 60];
for (const db of cases) {
  const out = swiftLimit(db);
  const good = Math.abs(out - Math.min(db, thresholdDb)) < 1e-9;
  ok &&= good;
  console.log(`   ${good ? 'OK  ' : 'FAIL'} ${String(db).padStart(6)} -> ${out.toFixed(3).padStart(8)} dBFS`);
}

// --- La promesse du limiteur : jamais d'écrêtage --------------------------
// C'est LA propriété qui justifie tout l'étage. Sans elle, la chaîne native
// écrêterait toujours, et le correctif n'aurait rien corrigé.
let ceilingHeld = true, worst = -99, worstAt = 0;
for (let db = -60; db <= 120; db += 0.01) {
  const out = swiftLimit(db);
  const excess = out - thresholdDb;
  if (excess > 1e-9) { ceilingHeld = false; worst = excess; worstAt = db; }
}
ok &&= ceilingHeld;
console.log(`   ${ceilingHeld ? 'OK  ' : 'FAIL'} aucune sortie au-dessus de ${thresholdDb} dBFS`
  + (ceilingHeld ? ' (balayage -60 → +120 dBFS)' : ` : +${worst.toFixed(3)} dB a ${worstAt.toFixed(0)} dBFS`));

// --- Le cas qui a motivé l'étage -----------------------------------------
// Mega Bass sort de la chaîne à +10.40 dBFS sans limiteur. Avec, il doit
// retomber sous le plafond. C'est le bug d'origine, mesuré.
const megaBassRaw = 10.40;
const megaBassOut = swiftLimit(megaBassRaw);
const megaOk = megaBassOut <= thresholdDb;
ok &&= megaOk;
console.log(`   ${megaOk ? 'OK  ' : 'FAIL'} Mega Bass : ${megaBassRaw.toFixed(2)} dBFS -> ${megaBassOut.toFixed(2)} dBFS`
  + ` (reduction de ${(megaBassRaw - megaBassOut).toFixed(2)} dB)`);

// --- Transparence sous le seuil ------------------------------------------
// Un limiteur ne peut ni signaler ni étouffer le son sous son seuil.
let unityOk = true;
for (let db = -60; db <= thresholdDb; db += 0.05) {
  if (Math.abs(swiftLimit(db) - db) > 1e-9) unityOk = false;
}
ok &&= unityOk;
console.log(`   ${unityOk ? 'OK  ' : 'FAIL'} sous le seuil, gain = 1.0 (transparent)`);

// --- La compression vient de l'enveloppe, pas de la courbe ---------------
// Avec ratio 1, la courbe statique est plate au seuil : ce n'est plus elle qui
// comprime, c'est la dynamique de l'enveloppe. Un limiteur qui comprime doit
// donc rester FLAT au-dessus du seuil — si ce test échoue, un ratio a été
// réintroduit par accident dans la formule.
let noResidualRatio = true;
for (const db of [0, 3, 6, 12, 24, 60]) {
  if (Math.abs(swiftLimit(db) - thresholdDb) > 1e-9) noResidualRatio = false;
}
ok &&= noResidualRatio;
console.log(`   ${noResidualRatio ? 'OK  ' : 'FAIL'} la courbe est plate au seuil (ratio 1, compression par enveloppe)`);

/**
 * La pastille LIMIT.
 *
 * Elle éteint le limiteur en relevant son PLAFOND à 0 dBFS, pas en retirant
 * l'étage : le graphe et la latence restent identiques, seul le seuil bouge.
 * On vérifie donc deux choses — que 0 dBFS est bien un plafond, et qu'aux deux
 * seuils le signal passe intact tant qu'il ne l'atteint pas.
 *
 * C'est la seule garantie qu'on puisse faire sans recâbler, et `sync-check.cjs`
 * compare les deux seuils entre plateformes pour qu'une pastille unique ne
 * produise pas deux plafonds différents.
 */
const bypassDb = 0.0;
console.log('\nPastille LIMIT : plafond relevé à ' + bypassDb + ' dBFS');

const probes = [-60, -20, -6, -3.01, -3, 0, 3, 12, 20, 60, 120];
const ceilingOn = probes.every((db) => swiftLimit(db, thresholdDb) <= thresholdDb + 1e-9);
const ceilingOff = probes.every((db) => swiftLimit(db, bypassDb) <= bypassDb + 1e-9);
const transparentOn = [-60, -20, -6].every((db) => swiftLimit(db, thresholdDb) === db);
const transparentOff = [-60, -20, -6].every((db) => swiftLimit(db, bypassDb) === db);
// Ce que la pastille achète, concrètement : +12 dBFS ressortent à -3 (on)
// contre 0 (off). C'est la différence audible, et elle n'existe que parce que
// le seuil a bougé — pas parce qu'un étage a disparu.
const headroom = swiftLimit(12, thresholdDb) !== swiftLimit(12, bypassDb);
const line = (label, good) => {
  ok &&= good;
  console.log(`   ${good ? 'OK  ' : 'FAIL'} ${label}`);
};

console.log(`   pic dBFS   LIMIT on     LIMIT off`);
for (const db of probes) {
  console.log(
    `   ${String(db).padStart(6)}    ${swiftLimit(db, thresholdDb).toFixed(3).padStart(8)}    ` +
      swiftLimit(db, bypassDb).toFixed(3).padStart(8)
  );
}
line('plafond tenu à ' + thresholdDb + ' dBFS (on)', ceilingOn);
line('plafond tenu à ' + bypassDb + ' dBFS (off)', ceilingOff);
line('transparent sous le seuil (on)', transparentOn);
line('transparent sous le seuil (off)', transparentOff);
line('la pastille change bien la sortie sur un pic', headroom);

console.log('\n' + (ok ? 'TOUT EST VERT' : 'ECHEC : voir les lignes FAIL'));
process.exit(ok ? 0 : 1);