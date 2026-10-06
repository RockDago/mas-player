/**
 * Vérifie que chaque réglage de `AppSettings` est réellement lu quelque part.
 *
 * Le problème que ce harnais existe pour empêcher : l'écran de paramètres écrit
 * un réglage, `saveSettings` le persiste, et rien ne le consulte jamais. Le
 * réglage est alors affiché comme actif, il survit au redémarrage, et il ne
 * produit aucun effet — un interrupteur qui ment sans jamais lever le moindre
 * doute. C'est ce qui est arrivé à 30 des 35 champs de `AppSettings`.
 *
 * Ce que le harnais refuse de compter comme une lecture :
 * - la déclaration dans l'interface `AppSettings` ;
 * - la valeur par défaut dans `DEFAULT_APP_SETTINGS` ;
 * - l'écriture depuis `SettingsModal` (l'UI qui *produit* la valeur) ;
 * - la comparaison `settings.x === ...` dans `SettingsModal` elle-même, qui ne
 *   fait que redessiner la pastille de ce même réglage — un réglage se lisant
 *   lui-même n'est pas un réglage lu.
 *
 * Lancer : node scripts/check-settings-wiring.cjs
 */
const { readFileSync } = require('fs');

const storage = readFileSync('src/services/storageService.ts', 'utf8');
const modal = readFileSync('src/components/SettingsModal.tsx', 'utf8');
const app = readFileSync('App.tsx', 'utf8');

/** Liste les champs déclarés dans l'interface `AppSettings`. */
function readInterfaceFields(source) {
  const start = source.indexOf('export interface AppSettings {');
  if (start === -1) throw new Error('Interface AppSettings introuvable');
  const body = source.slice(start);
  // Le corps s'arrête à la première ligne `}` en colonne 0 : c'est la fermeture
  // de l'interface.
  const end = body.search(/^\}/m);
  if (end === -1) throw new Error("Fin de l'interface AppSettings introuvable");
  const fields = [];
  for (const line of body.slice(0, end).split('\n')) {
    const m = /^\s{2}(\w+)\??\s*:/.exec(line);
    if (m) fields.push(m[1]);
  }
  return fields;
}

/**
 * Retire les commentaires avant de fouiller le code.
 *
 * Sans cela, un nom cité uniquement dans un commentaire — ce harnais lui-même,
 * ou une note expliquant pourquoi un réglage est mort — serait compté comme une
 * lecture. Un test qui passe pour la mauvaise raison est pire qu'un test absent :
 * il retire l'avertissement sans lever le problème.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const appCode = stripComments(app);

/**
 * Occurrences de `field` dans le code applicatif, hors écriture.
 *
 * On ne retient que les positions où la VALEUR influence le comportement :
 * lecture de propriété (`appSettings.x`, `appSettingsRef.current.x`,
 * `savedSettings?.x`). Le côté gauche d'une affectation est une écriture, pas
 * une lecture, et ne doit pas ce champ « câblé ».
 */
function findReads(field, source) {
  const reads = [];
  const re = new RegExp(
    `\\b(?:appSettings|appSettingsRef\\.current|savedSettings)\\s*\\??\\.${field}\\b`,
    'g'
  );
  let m;
  while ((m = re.exec(source)) !== null) {
    const line = source.slice(0, m.index).split('\n').length;
    const after = source.slice(m.index + m[0].length);
    // Ignore l'occurrence où le champ est *écrit* : `appSettings.x = ...`.
    if (/^\s*=(?!=)/.test(after)) continue;
    reads.push(line);
  }
  return reads;
}

const fields = readInterfaceFields(storage);

/**
 * Réglages dont l'absence de lecteur est DÉLIBÉRÉE, avec la raison.
 *
 * Une liste blanche sans motif est une liste de settings volés : le harnais
 * passe au vert, et plus personne ne sait pourquoi. Chaque entrée porte donc la
 * justification qui survit à la mémoire de son auteur.
 *
 * Elle est vide aujourd'hui. Les deux réglages qui y figuraient — `beatPulse`
 * et `showAudioDetails` — ont été retirés de l'interface et de la modale : le
 * premier parce que son composant cible n'est rendu nulle part, le second
 * parce qu'aucune vue plein écran de pochette n'existe dans l'application.
 * Un réglage retiré ne peut pas rester dans la liste verte : il n'existe plus,
 * donc plus rien à justifier.
 */
const INTENTIONAL = {};

console.log(`AppSettings — ${fields.length} champs déclarés\n`);

const dead = [];
const okFields = [];

for (const field of fields) {
  const reads = findReads(field, appCode);

  if (reads.length === 0 && INTENTIONAL[field]) {
    console.log(`  OK   ${field.padEnd(24)} ${INTENTIONAL[field]}`);
    okFields.push(field);
    continue;
  }

  if (reads.length === 0) {
    dead.push(field);
    console.log(`  MORT ${field.padEnd(24)} écrit par SettingsModal, jamais lu`);
  } else {
    console.log(`  OK   ${field.padEnd(24)} lu App.tsx:${reads.join(', App.tsx:')}`);
    okFields.push(field);
  }
}

console.log(`\n${okFields.length} RÉELLEMENT CÂBLÉS · ${dead.length} MORTS`);

if (dead.length > 0) {
  console.log('\nRéglage écrit et persisté mais jamais lu — la bascule bouge, rien ne se passe :');
  for (const field of dead) console.log(`  - ${field}`);
  console.log(
    '\nLe brancher, ou le retirer de l\'interface et de la modale. Une exception ' +
      'intentionnelle\nse déclare dans INTENTIONAL, avec sa raison.'
  );
  process.exit(1);
}

console.log('\nAucun réglage mort.');
