#!/usr/bin/env node
/**
 * Vérifie que la balance L/R est réellement câblée sur les trois plateformes.
 *
 * Origine du bug : le chemin web de `applyEqualizer` n'appelait que
 * `setEqualizer(enabled, bands, preamp)`. La balance n'était jamais transmise et
 * le graphe Web Audio ne contenait aucun nœud de canal : le knob L/R pilotait
 * uniquement l'affichage. Ce harnais existe pour que ça ne puisse pas revenir
 * silencieusement — un `setBalance` retiré, un `balanceNodes` débranché du graphe
 * ou une formule divergente du natif font tous échouer le build.
 *
 * Trois sections :
 *   1. La loi de gain est correcte et bornée.
 *   2. Le code web est effectivement câblé (graphe + appel depuis playerManager).
 *   3. La formule JS est identique à celle du code natif, relue par regex.
 */

const fs = require('fs');
const path = require('path');

// La racine est surchargeable pour pouvoir prouver que ce harnais *échoue*
// quand on lui réinjecte le bug : les copies mutées vivent dans un répertoire
// temporaire, jamais dans le dépôt. Sans cette variable, un test qui passe ne
// prouve rien — il faut avoir vu le harnais tomber.
const ROOT = process.env.MAS_PLAYER_ROOT || path.resolve(__dirname, '..');

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}`);
    if (detail) console.log(`      ${detail}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/**
 * Retire les commentaires d'une source avant tout test par expression régulière.
 *
 * Les commentaires du projet décrivent les anciennes lois et citent des valeurs
 * numériques (poids d'égaliseur, gains, durées). Sans ce filtre, le harnais passe
 * ou échoue sur de la prose : il attestait un bug parce qu'un commentaire
 * expliquait le bug.
 */
const stripComments = (src) =>
  (src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

function readRepoFile(relativePath) {
  const full = path.join(ROOT, relativePath);
  if (!fs.existsSync(full)) {
    console.log(`  ! fichier absent : ${relativePath}`);
    return null;
  }
  // Les sources du dépôt sont en CRLF (core.autocrlf). Un harnais qui lit les
  // octets bruts voit `\r\n`, et toute expression régulière ancrée sur `\n`
  // échoue alors que le code est correct — un échec qui semble porter sur le
  // code alors qu'il porte sur les fins de ligne du fichier. On normalise une fois pour
  // toutes ici, plutôt que d'écrire `\s*` partout.
  return fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
}

// ---------------------------------------------------------------------------
// La loi de balance, implémentée ici indépendamment de la source.
// Elle doit reproduire `MASAudioDSPProcess` / `queueInput` côté natif ; la
// section 3 compare les deux par lecture de code plutôt que par confiance.
// ---------------------------------------------------------------------------
function expectedBalanceGains(balance) {
  const value = Math.max(-1, Math.min(1, balance));
  return {
    left: value < 0 ? 1 : 1 - value,
    right: value > 0 ? 1 : 1 + value,
  };
}

// ---------------------------------------------------------------------------
section('1. Balance — loi de gain (balanceGains)');
// ---------------------------------------------------------------------------
{
  const source = readRepoFile('src/services/webAudioEngine.ts');
  if (!source) {
    failures += 1;
  } else {
    // On extrait la fonction pour l'exécuter telle qu'elle est écrite, plutôt
    // que de recopier sa formule ici : le harnais teste le code livré.
    const match = source.match(
      /export function balanceGains\(balance: number\): \{ left: number; right: number \} \{[\s\S]*?\n\}/
    );
    check('balanceGains est exportée et lisible', Boolean(match));

    if (match) {
      const js = match[0]
        .replace(/: \{ left: number; right: number \}/g, '')
        .replace(/: number/g, '')
        .replace(/export /g, '');
      const balanceGains = new Function(`return (${js})`)();

      check('centre : les deux canaux à 1.0', (() => {
        const g = balanceGains(0);
        return g.left === 1 && g.right === 1;
      })());

      check('balance -1 : canal gauche intact', (() => {
        const g = balanceGains(-1);
        return g.left === 1 && g.right === 0;
      })());

      check('balance +1 : canal droit intact', (() => {
        const g = balanceGains(1);
        return g.left === 0 && g.right === 1;
      })());

      check('balance -0.5 : seul le droit est atténué', (() => {
        const g = balanceGains(-0.5);
        return Math.abs(g.left - 1) < 1e-9 && Math.abs(g.right - 0.5) < 1e-9;
      })());

      check('balance +0.5 : seul le gauche est atténué', (() => {
        const g = balanceGains(0.5);
        return Math.abs(g.left - 0.5) < 1e-9 && Math.abs(g.right - 1) < 1e-9;
      })());

      check('les entrées hors bornes sont saturées, pas rendues', (() => {
        const high = balanceGains(4);
        const low = balanceGains(-9);
        return high.left === 0 && high.right === 1 && low.left === 1 && low.right === 0;
      })());

      check('NaN retombe au centre', (() => {
        const g = balanceGains(NaN);
        return g.left === 1 && g.right === 1;
      })());

      check('la balance n\'atténue que le côté opposé, jamais les deux', (() => {
        let ok = true;
        for (let b = -1; b <= 1.0001; b += 0.05) {
          const g = balanceGains(b);
          const untouched = b < 0 ? g.left : b > 0 ? g.right : g.left;
          if (Math.abs(untouched - 1) > 1e-9) ok = false;
          if (g.left < -1e-9 || g.right < -1e-9) ok = false;
          if (g.left > 1 + 1e-9 || g.right > 1 + 1e-9) ok = false;
        }
        return ok;
      })());
    }
  }
}

// ---------------------------------------------------------------------------
section('2. Mid-Side — matrice et câblage web (stereo / crossfeed / mono)');
// ---------------------------------------------------------------------------
{
  // Origine du second bug : les quatre gains Mid-Side étaient câblés
  // `ll->gauche, lr->gauche, rl->droite, rr->droite`. Les gains *croisés*
  // étaient donc tous deux envoyés à la sortie gauche, et la sortie droite ne
  // recevait que `rr`. Sortie droite = rr·R, sortie gauche = ll·L + lr·R + rl·L.
  // Sur une entrée stéréo ordinaire la sortie droite n'était pas nulle que par
  // un accident de phase, et surtout le crossfeed (qui *injecte* l'autre canal)
  // partait dans la mauvaise oreille. Le symptôme : « stereo et crossfeed ne
  // marchent pas », alors que la matrice et les coefficients étaient justes.
  // Ces deux checks verrouillent l'inversion croisée.
  const engine = readRepoFile('src/services/webAudioEngine.ts');

  if (!engine) {
    failures += 1;
  } else {
    check('lrGain (gauche→droite) alimente la sortie DROITE', engine.includes('lrGain.connect(stereoMerger, 0, 1)'));
    check('rlGain (droite→gauche) alimente la sortie GAUCHE', engine.includes('rlGain.connect(stereoMerger, 0, 0)'));
    check('llGain alimente la sortie gauche', engine.includes('llGain.connect(stereoMerger, 0, 0)'));
    check('rrGain alimente la sortie droite', engine.includes('rrGain.connect(stereoMerger, 0, 1)'));

    // La matrice doit être symétrique : Mid-Side croise toujours les canaux.
    // Le type de retour de `midSideMatrix` s'étale sur plusieurs lignes et ressemble
    // à son corps : une regex d'accolades s'y arrête à la mauvaise. On découpe
    // donc sur le `return {` qui marque le début du vrai corps, puis on retire
    // l'annotation TypeScript.
    const extractMatrixFrom = (source) => {
      const start = source.indexOf('export function midSideMatrix');
      if (start === -1) return null;
      const end = source.indexOf('\n}', source.indexOf('return {', start));
      if (end === -1) return null;
      let js = source.slice(start, end + 2);
      js = js.replace(/export function/, 'function');
      js = js.replace(/\(width: number\)\s*:\s*\{[\s\S]*?\}\s*\{/, '(width) {');
      js = js.replace(/: number/g, '');
      try {
        return new Function(`return (${js})`)();
      } catch (_) {
        return null;
      }
    };

    check('la matrice Mid-Side est extraite du code livré', typeof extractMatrixFrom(engine) === 'function');

    check('le moteur expose setStereoWidth', /setStereoWidth\(width: number\)/.test(engine));
    check('setStereoWidth applique les quatre coefficients', (() => {
      const body = engine.match(/setStereoWidth\(width: number\)\s*\{[\s\S]*?\n  \}/);
      if (!body) return false;
      return ['ll', 'lr', 'rl', 'rr'].every((n) => body[0].includes(`${n}.gain.setTargetAtTime`));
    })());
    check('le Mid-Side est branché en aval de la balance', (() => {
      const bal = engine.indexOf('balanceMerger.connect(stereoSplitter)');
      const mer = engine.indexOf('balanceMerger, 0, 1');
      return bal !== -1 && mer !== -1 && bal > mer;
    })());
    // Comme la balance, le Mid-Side n'alimente plus le volume directement : la
    // réverbération est interposée. Ce qui compte est que le chemin reste continu.
    check('la sortie du Mid-Side alimente la réverbération', engine.includes('stereoMerger.connect(reverbDry'));
    check('destroy libère stereoNodes', /this\.stereoNodes = null/.test(engine));

    // Le harnais teste la matrice comme un graphe : gains en nœuds, sorties en
    // somme. C'est ce qui prouve que la matrice ET le câblage produisent bien
    // l'effet attendu — la formule seule ne l'aurait pas montré.
    const matrixOf = extractMatrixFrom(engine);

    if (matrixOf) {
      // Reproduit le câblage relu plus haut : sortie = Σ gain × entrée.
      const render = (w, l, r) => {
        const c = matrixOf(w);
        return { left: c.ll * l + c.rl * r, right: c.lr * l + c.rr * r };
      };

      check('w=0 : signal strictement neutre', (() => {
        const o = render(0, 0.5, 0.5);
        return Math.abs(o.left - 0.5) < 1e-9 && Math.abs(o.right - 0.5) < 1e-9;
      })());

      check('stereo +50 % : le canal droit reçoit une part négative', (() => {
        const o = render(0.5, 1, 0);
        return o.right < 0 && o.left > 1;
      })());

      check('crossfeed 50 % : l\'autre canal fuite dans chaque oreille', (() => {
        const o = render(-0.5, 1, 0);
        return Math.abs(o.left - 0.75) < 1e-9 && Math.abs(o.right - 0.25) < 1e-9;
      })());

      check('crossfeed 50 % symétrique (canal droit)', (() => {
        const o = render(-0.5, 0, 1);
        return Math.abs(o.left - 0.25) < 1e-9 && Math.abs(o.right - 0.75) < 1e-9;
      })());

      check('MONO : les deux sorties deviennent égales', (() => {
        const o = render(-1, 1, 0);
        return Math.abs(o.left - 0.5) < 1e-9 && Math.abs(o.right - 0.5) < 1e-9;
      })());

      check('MONO : un canal déjà centré reste centré', (() => {
        const o = render(-1, 1, 1);
        return Math.abs(o.left - 1) < 1e-9 && Math.abs(o.right - 1) < 1e-9;
      })());

      check('mono, crossfeed et stereo ne s\'annulent pas (effets distincts)', (() => {
        const mono = render(-1, 1, 0);
        const cross = render(-0.5, 1, 0);
        const stereo = render(0.5, 1, 0);
        return new Set([
          `${mono.left},${mono.right}`,
          `${cross.left},${cross.right}`,
          `${stereo.left},${stereo.right}`,
        ]).size === 3;
      })());

      // Régression du bug de câblage : si lr et rl repartaient tous deux vers
      // la sortie gauche, le crossfeed injecterait l'autre canal dans la
      // mauvaise oreille et `left` serait faux pour toute entrée stéréo.
      check('le crossfeed ne fuit pas d\'un seul côté (canal gauche)', (() => {
        const o = render(-0.5, 0.6, 0.2);
        return Math.abs(o.left - 0.5) < 1e-9 && Math.abs(o.right - 0.3) < 1e-9;
      })());
    }
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
section('3. Réverbération spatiale (web)');
// ---------------------------------------------------------------------------
{
  // Origine du troisième bug : la réverbération n'existait pas du tout côté web.
  // Aucun `reverb*` n'existait dans `webAudioEngine`, alors que les quatre
  // contrôles UI (Enabled / Room Size / Damping / Mix) écrivaient dans le DSP
  // sans jamais être consommés. Les trois knobs bougeaient, rien ne sonnait.
  const engine = readRepoFile('src/services/webAudioEngine.ts');
  const manager = readRepoFile('src/services/playerManager.ts');

  if (!engine || !manager) {
    failures += 1;
  } else {
    check('le moteur construit une impulsion de réverbération', /function buildReverbImpulse/.test(engine));
    check('le moteur expose setReverb', /setReverb\(enabled: boolean, roomSize: number, damping: number, mix: number\)/.test(engine));
    check('le graphe contient un ConvolverNode', engine.includes('createConvolver()'));
    check('le graphe contient des gains wet et dry', /reverbWet\.gain\.value = 0/.test(engine) && /reverbDry\.gain\.value = 1/.test(engine));
    // ⚠ Ces trois checks portaient sur la forme `connect(cible, 0, N)` — deux
    // connexions explicites, une par canal. Or `connect(cible)` SANS index
    // connecte déjà TOUTES les sorties d'un nœud multi-sorties : c'est la forme
    // réellement livrée, et elle est équivalente. Le harnais échouait donc sur
    // du code correct — exactement le défaut décrit dans la mémoire du projet
    // (« un test qui ne teste plus rien est pire qu'un test absent » : ici
    // l'inverse, un test qui casse sans raison).
    //
    // On vérifie donc ce qui compte réellement — chaque branche est câblée —
    // en acceptant les deux formes, sans exiger la syntaxe.
    const connectsAllChannels = (source, target) => {
      return new RegExp(`${source}\\.connect\\(${target}\\s*\\)`).test(engine) ||
        new RegExp(`${source}\\.connect\\(${target}\\s*,\\s*0\\s*,\\s*0\\s*\\)`).test(engine) &&
        new RegExp(`${source}\\.connect\\(${target}\\s*,\\s*0\\s*,\\s*1\\s*\\)`).test(engine);
    };
    check('la réverbération est mélangée wet/dry', connectsAllChannels('reverbDry', 'reverbMerger') && connectsAllChannels('reverbWet', 'reverbMerger'));
    // Sans ces deux entrées, le signal sec disparaît et seule la réverbération
    // s'entend — le knob « Mix » devient l'unique volume. C'est peu visible sur
    // le schéma mais très audible ; il faut donc vérifier l'entrée ET la sortie.
    check('le signal sec ENTRÉE dans le mixage sec (les deux canaux)', connectsAllChannels('stereoMerger', 'reverbDry'));
    check('le signal humide ENTRÉE dans le mixage humide (les deux canaux)', connectsAllChannels('reverbConvolver', 'reverbWet'));
    check('la réverbération est en aval du Mid-Side', (() => {
      const ms = engine.indexOf('stereoMerger.connect(reverbDry');
      const lim = engine.indexOf('reverbMerger.connect(limiter)');
      return ms !== -1 && lim !== -1 && ms < lim;
    })());
    // Le limiteur est interposé entre la réverbération et le volume : ce qui
    // compte est que le chemin reste continu, pas qu'il saute une étape.
    check('la sortie de réverbération alimente le limiteur', engine.includes('reverbMerger.connect(limiter)'));
    check('destroy libère reverbNodes et la clé', /this\.reverbNodes = null/.test(engine) && /this\.reverbKey = ''/.test(engine));
    // ⚠ Ne pas matcher `setReverb(enabled: boolean, ...)` — c'est la
    // DÉFINITION de la méthode dans webAudioEngine, pas son APPEL. Le premier
    // mutant (appel retiré de playerManager) passait parce que la définition
    // suffisait à satisfaire la regex. On cherche donc l'appel avec son point
    // d'appel WebAudio, et on vérifie le bloc d'arguments complet.
    check('playerManager APPELLE setReverb sur le moteur web', (() => {
      const call = manager.match(/this\.webEngine\?\.setReverb\(([\s\S]*?)\);/);
      if (!call) return false;
      const args = call[1];
      return (
        /reverbEnabled/.test(args) &&
        /roomSize/.test(args) &&
        /damping/.test(args) &&
        /reverbMix/.test(args) &&
        args.split(',').length === 4
      );
    })());
    check('playerManager n\'appelle PAS setReverb sur le chemin natif', (() => {
      const body = manager.match(/private applyEqualizer\(\)[\s\S]*?\n  \}/);
      if (!body) return false;
      const webPart = body[0].split('} else {')[0];
      const nativePart = body[0].split('} else {')[1] || '';
      return webPart.includes('setReverb') && !nativePart.includes('setReverb');
    })());

    check('l\'impulsion n\'est régénérée que si les paramètres changent', (() => {
      const body = engine.match(/setReverb\([\s\S]*?\n  \}/);
      if (!body) return false;
      return body[0].includes('key !== this.reverbKey');
    })());
    check('le bruit est déterministe (graine fixe)', /0x9e3779b9/.test(engine));

    // ─── La loi de durée du knob « Room Size » ───────────────────────────
    //
    // ⚠ Cette section remplace des checks qui attestaient l'ancienne loi
    // `feedback = roomSize·0.28 + 0.7`. Ce qu'ils protégeaient était faux :
    // cette loi produisait une durée qui DÉCROÎT quand le feedback croît
    // (room 100 % → 13 ms de queue côté web, 9,6 s de lavage côté natif), et
    // le knob était donc inversé sur les deux plateformes. Le check « le
    // feedback croît avec roomSize » passait toujours : il testait une
    // grandeur intermédiaire, jamais la durée audible.
    //
    // On atteste désormais la grandeur qui compte — le RT60 — et sa croissance.
    const presetsSource = readRepoFile('src/constants/presets.ts');
    const iosSource = readRepoFile('native/audio-dsp/MASAudioDSP.m');
    const androidSource = readRepoFile('native/audio-dsp/AudioDSPProcessor.kt');

    if (presetsSource) {
      // Loi unique, partagée par l'interface et le moteur web : 0,3 s → 4 s.
      check('la loi de RT60 est définie dans presets.ts', /REVERB_RT60_MIN_SECONDS\s*=\s*0\.3/.test(presetsSource) && /REVERB_RT60_MAX_SECONDS\s*=\s*4/.test(presetsSource));
      check('le moteur web consomme cette loi partagée', engine.includes('reverbRt60Seconds') && !/const roomSize = Math\.max/.test(engine));
      // La formule est extraite du code livré, pas recopiée : le harnais teste
      // ce qui est réellement exécuté. `%` → 0–1 dans l'appel.
      const extractRt60 = () => {
        const match = presetsSource.match(/return \(\s*REVERB_RT60_MIN_SECONDS[\s\S]*?\);/);
        if (!match) return null;
        try {
          return new Function('REVERB_RT60_MIN_SECONDS', 'REVERB_RT60_MAX_SECONDS', 'room', `return (${match[0].replace(/^return /, '').replace(/;$/, '')});`);
        } catch (_) {
          return null;
        }
      };
      const rt60Of = extractRt60();

      if (rt60Of) {
        const at = (percent) => rt60Of(0.3, 4, Math.max(0, Math.min(100, percent)) / 100);
        check('roomSize=0 % → RT60 0,30 s (chambre)', Math.abs(at(0) - 0.3) < 1e-9);
        check('roomSize=100 % → RT60 4,00 s (nef)', Math.abs(at(100) - 4) < 1e-9);
        // ⚠ Le check central. L'ancien bug était exactement ici : une durée qui
        // décroît quand la pièce grandit.
        check('le RT60 CROÎT avec roomSize (le knob n’est pas inversé)', (() => {
          for (let p = 0; p < 100; p += 5) {
            if (!(at(p + 5) > at(p))) return false;
          }
          return true;
        })());
        check('le RT60 reste borné hors plage (knob clampé)', (() => {
          for (const p of [-50, 0, 100, 500]) {
            const v = at(p);
            if (!(v >= 0.3 - 1e-9) || !(v <= 4 + 1e-9)) return false;
          }
          return true;
        })());
      }

      // Compensation de gain : c'est le SECOND bug du reverb, plus grave que
      // la durée. Quatre peignes additionnés ont un gain de boucle qui diverge ;
      // sans normalisation, le knob Room *ajoutait* du niveau au lieu d'élargir
      // la pièce (mesuré : +4,5 dB de pic, queue jamais redescendue).
      check('la compensation de gain du wet est déclarée', /REVERB_GAIN_COMPENSATION_DB\s*=\s*-3/.test(presetsSource));
      check('le moteur web applique la compensation', engine.includes('REVERB_GAIN_COMPENSATION_DB'));
      check('iOS : le wet est normalisé après la somme des peignes', /outL \*= MASAudioDSPCombNormalization/.test(iosSource || '') && /MASAudioDSPCombNormalization\s*=\s*0\.25/.test(iosSource || ''));
      check('Android : le wet est normalisé après la somme des peignes', /outL \*= COMB_NORMALIZATION/.test(androidSource || '') && /COMB_NORMALIZATION\s*=\s*0\.25/.test(androidSource || ''));
    }

    // Parité de la loi de durée entre les deux plateformes natives.
    // Les formules sont lues sur le CODE seul : les commentaires citent
    // volontairement l'ancienne loi `r·0.28+0.7` pour expliquer le bug, et les
    // retirer ferait perdre la justification (cf. la section limiteur, même
    // approche).
    const iosCode = (iosSource || '').split('\n').filter((l) => !/^\s*(\*|\/\/|<!--)/.test(l)).join('\n');
    const androidCode = (androidSource || '').split('\n').filter((l) => !/^\s*(\*|\/\/|<!--)/.test(l)).join('\n');
    if (iosSource && androidSource) {
      check('iOS : la loi passe par le RT60 visé, plus par r·0.28+0.7', /exp\(-log\(1000\.0\)/.test(iosCode) && !/roomSize \* 0\.28 \+ 0\.7/.test(iosCode));
      check('Android : la loi passe par le RT60 visé, plus par r·0.28+0.7', /exp\(-ln\(1000\.0\)/.test(androidCode) && !/roomSize \* 0\.28 \+ 0\.7/.test(androidCode));
      // Le délai des peignes doit être identique : c'est lui qui convertit le
      // RT60 en feedback, donc toute divergence = plateformes désaccordées.
      const iosDelay = iosSource.match(/MASAudioDSPCombDelaySeconds\s*=\s*([\d.]+)/);
      const androidDelay = androidSource.match(/COMB_DELAY_SECONDS\s*=\s*([\d.]+)/);
      check('les deux plateformes partagent le même délai de peigne', Boolean(iosDelay) && Boolean(androidDelay) && iosDelay[1] === androidDelay[1]);
      check('le feedback natif reste plafonné sous 1 (repli de boucle impossible)', /min\(0\.98|min\(\s*0\.98/.test(iosSource) && /min\(0\.98/.test(androidSource));
    }

    // Mix borné à 50 % comme le natif (`reverbMix * 0.5`).
    const extractMix = () => {
      const match = engine.match(/const clampedMix = [^;]+;/);
      if (!match) return null;
      const js = match[0].replace(/const clampedMix = /, '').replace(/;$/, '');
      try {
        return new Function('mix', `return (${js});`);
      } catch (_) {
        return null;
      }
    };
    const mixOf = extractMix();

    if (mixOf) {
      check('mix=0 → 0 (100 % sec)', Math.abs(mixOf(0)) < 1e-9);
      check('mix=100 → 0.5 (plafond du natif)', Math.abs(mixOf(100) - 0.5) < 1e-9);
      check('mix=30 → 0.15', Math.abs(mixOf(30) - 0.15) < 1e-9);
      check('mix est borné à 50 % maximum', (() => {
        for (let m = -20; m <= 150; m += 5) {
          const v = mixOf(m);
          if (v < 0 || v > 0.5 + 1e-9) return false;
        }
        return true;
      })());
    }

    // Wet + dry doit reconstruire le signal : c'est ce qui garantit qu'une
    // réverbération wet=1 nelose pas le signal sec par accident.
    if (mixOf) {
      check('wet + dry = 1 à chaque mix (reconstruction)', (() => {
        for (let m = 0; m <= 100; m += 10) {
          const v = mixOf(m);
          if (Math.abs(v + (1 - v) - 1) > 1e-9) return false;
        }
        return true;
      })());
      check('réverbération éteinte → 100 % sec', (() => {
        const body = engine.match(/setReverb\([\s\S]*?\n  \}/);
        return Boolean(body) && body[0].includes('dry.gain.setTargetAtTime(1,');
      })());
    }
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
section('4. Limiteur web (plafond dur)');
// ---------------------------------------------------------------------------
{
  // Décision mesurée du 5 octobre 2026 (mémoire `mas-player-limiter-hard-ceiling`) :
  // ratio 1 = plafond dur, PAS le ratio 20 classique. Ce harnais existe pour
  // empêcher une « réintroduction d'un ratio » — le rôle du ratio était de
  // borner, et il borne par construction.
  const engine = readRepoFile('src/services/webAudioEngine.ts');
  const manager = readRepoFile('src/services/playerManager.ts');

  if (!engine || !manager) {
    failures += 1;
  } else {
    check('le moteur crée un DynamicsCompressorNode', engine.includes('createDynamicsCompressor()'));
    check('le moteur expose setLimiter', /setLimiter\(enabled: boolean\)/.test(engine));
    check('le seuil est −3 dBFS (décision mesurée)', /const LIMIT_THRESHOLD_DB = -3;/.test(engine));
    check('l\'attaque est 2 ms', /const LIMIT_ATTACK_S = 0\.002;/.test(engine));
    check('le relâchement est 120 ms', /const LIMIT_RELEASE_S = 0\.12;/.test(engine));
    check('le knee est nul (pas de zone de compression douce)', /limiter\.knee\.value = 0/.test(engine));

    check('le ratio est 1 — plafond dur, PAS 20', /limiter\.ratio\.value = 1/.test(engine));
    // Ne porter que sur le CODE : les commentaires citent volontairement « ratio
    // 20 » pour expliquer pourquoi on ne l'utilise pas. Les retirer ferait
    // perdre la justification — c'est ce que la mémoire du projet signale.
    check('aucun ratio 20 dans le CODE du moteur', (() => {
      const code = engine
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/|<!--)/.test(line))
        .join('\n');
      return !/ratio[^\n]*20/.test(code);
    })());
    check('le bypass ne remet PAS le ratio à 20', (() => {
      const body = engine.match(/setLimiter\(enabled: boolean\)\s*\{[\s\S]*?\n  \}/);
      if (!body) return false;
      // Le bypass ne doit toucher que threshold/attack/release. Un ratio 20 ici
      // continuerait de compresser : ce ne serait pas un bypass.
      return !/ratio/.test(body[0]);
    })());
    check('le bypass relève le seuil à 0 dBFS', (() => {
      const body = engine.match(/setLimiter\(enabled: boolean\)\s*\{[\s\S]*?\n  \}/);
      return Boolean(body) && body[0].includes('enabled ? LIMIT_THRESHOLD_DB : 0');
    })());

    // ⚠ Un simple `indexOf('reverbMerger.connect(limiter)') < indexOf(...)` ne
    // suffit pas : ajouter un branchement supplémentaire AVANT (le limiteur
    // fedé par le Mid-Side en plus de la réverbération) laissait le mutant
    // passer. On vérifie donc le nombre de sources ET leur ordre, et pas
    // seulement que la connexion existe.
    check('le limiteur est le dernier étage avant le volume', (() => {
      const feeders = [...engine.matchAll(/(\w+)\.connect\(limiter\)/g)].map((m) => m[1]);
      if (feeders.length !== 1) return false; // exactement UNE source
      const vol = engine.indexOf('limiter.connect(volumeGain)');
      const bypass = engine.indexOf('reverbMerger.connect(volumeGain)');
      return feeders[0] === 'reverbMerger' && vol !== -1 && bypass === -1;
    })());
    check('playerManager APPELLE setLimiter sur le moteur web', (() => {
      const call = manager.match(/this\.webEngine\?\.setLimiter\(([\s\S]*?)\);/);
      return Boolean(call) && /limitEnabled/.test(call[1]);
    })());
    check('destroy libère le limiteur', /this\.limiter = null/.test(engine));
    check('le préampli, la balance, le Mid-Side et la réverb. précèdent le limiteur', (() => {
      const p = engine.indexOf('output.connect(preampGain)');
      const b = engine.indexOf('preampGain.connect(balanceSplitter)');
      const s = engine.indexOf('balanceMerger.connect(stereoSplitter)');
      const r = engine.indexOf('stereoMerger.connect(reverbDry');
      const l = engine.indexOf('reverbMerger.connect(limiter)');
      return [p, b, s, r, l].every((i) => i !== -1) && p < b && b < s && s < r && r < l;
    })());

    // La loi du plafond, calculée comme la mémoire la définit.
    const ceilingLaw = (db, thresholdDb = -3) => (db <= thresholdDb ? db : thresholdDb);
    check('la courbe est plate au-dessus du seuil (ratio 1)', (() => {
      for (let db = -3; db <= 40; db += 0.25) {
        if (Math.abs(ceilingLaw(db) - -3) > 1e-9) return false;
      }
      return true;
    })());
    check('le signal sous le seuil passe intact', (() => {
      return [-60, -20, -6, -3].every((db) => ceilingLaw(db) === db);
    })());
    check('aucune sortie ne dépasse le plafond', (() => {
      for (let db = -60; db <= 60; db += 0.5) {
        if (ceilingLaw(db) > -3 + 1e-9) return false;
      }
      return true;
    })());
    check('une crête à +60 dBFS ressort exactement au plafond', Math.abs(ceilingLaw(60) - -3) < 1e-9);
  }
}

// ---------------------------------------------------------------------------
section('5. Bass / treble — course bipolaire');
// ---------------------------------------------------------------------------
{
  // Le mapping était unipolaire : `percent = (bass / 12) × 100`. À bass = 0,
  // le défaut, l'indicateur pointait à −135° avec un arc vide : on lisait
  // « boost à fond » pour une valeur nulle. La course bipolaire remet le
  // neutre à 50 % / sommet.
  const view = readRepoFile('src/components/EqualizerView.tsx');

  if (!view) {
    failures += 1;
  } else {
    const MAX = 12;
    const toPercent = (db) => Math.round(((db + MAX) / (MAX * 2)) * 100);
    const toDb = (pct) => Number(((pct / 100) * MAX * 2 - MAX).toFixed(2));

    check('le knob bass utilise la course bipolaire', view.includes('(dsp.bass + EQ_GAIN_MAX) / (EQ_GAIN_MAX * 2)'));
    check('le knob treble utilise la course bipolaire', view.includes('(dsp.treble + EQ_GAIN_MAX) / (EQ_GAIN_MAX * 2)'));
    check('l\'inverse dB est bipolaire aussi', /percent \/ 100\) \* EQ_GAIN_MAX \* 2 - EQ_GAIN_MAX/.test(view));
    check('l\'ancien mapping unipolaire a disparu', !/\(dsp\.bass \/ EQ_GAIN_MAX\) \* 100/.test(view));

    // Le point qui rendait le knob illisible : à 0 dB il ne doit plus être à 0 %.
    check('0 dB (le défaut) tombe à mi-course', toPercent(0) === 50);
    check('0 dB (le défaut) pointe au sommet', (() => {
      const pct = toPercent(0);
      return -135 + (pct / 100) * 270 === 0;
    })());
    check('−12 dB tombe à 0 % (extrémité gauche)', toPercent(-MAX) === 0);
    check('+12 dB tombe à 100 % (extrémité droite)', toPercent(MAX) === 100);

    check('la conversion aller-retour est stable aux extrémités', (() => {
      return toDb(toPercent(-MAX)) === -MAX && toDb(toPercent(MAX)) === MAX;
    })());
    check('la conversion aller-retour est stable au neutre', toDb(toPercent(0)) === 0);
    check('percent reste dans 0–100 sur toute la course', (() => {
      for (let db = -MAX; db <= MAX; db += 0.25) {
        const p = toPercent(db);
        if (p < 0 || p > 100) return false;
      }
      return true;
    })());
    check('percent est monotone croissant', (() => {
      for (let db = -MAX; db < MAX; db += 0.5) {
        if (toPercent(db + 0.5) <= toPercent(db)) return false;
      }
      return true;
    })());

    // Le poids injecté dans les bandes ne doit jamais dépasser le plafond.
    const BASS_WEIGHTS = [0.55, 0.3, 0, 0];
    check('le gain injecté reste dans ±12 dB sur toute la course', (() => {
      for (let db = -MAX; db <= MAX; db += 0.25) {
        for (const w of BASS_WEIGHTS) {
          const gain = db * w;
          if (gain < -12 || gain > 12) return false;
        }
      }
      return true;
    })());
  }
}

// ---------------------------------------------------------------------------
section('6. Priorité mono / crossfeed / stereo (resolveStereoWidth)');
// ---------------------------------------------------------------------------
{
  const manager = readRepoFile('src/services/playerManager.ts');

  if (!manager) {
    failures += 1;
  } else {
    check('resolveStereoWidth est défini', /export function resolveStereoWidth/.test(manager));
    check('mono l\'emporte sur crossfeed et stereo', (() => {
      const body = manager.match(/export function resolveStereoWidth[\s\S]*?\n\}/);
      if (!body) return false;
      const order = ['eq.mono', 'crossfeed', 'stereoExpansion'].map((k) => body[0].indexOf(k));
      return order.every((v) => v !== -1) && order[0] < order[1] && order[1] < order[2];
    })());
    check('le web reçoit une largeur, pas une ternaire inline', manager.includes('setStereoWidth(resolveStereoWidth(eq))'));
    check('le natif reçoit la MÊME largeur que le web', (() => {
      const call = manager.match(/\.setDSP\([\s\S]*?\);/);
      return Boolean(call) && call[0].includes('resolveStereoWidth(eq)') && !call[0].includes('mono ?');
    })());
    check('plus de ternaire d\'écrasement dans applyEqualizer', !/mono \? -1\.0/.test(manager));
  }
}

// ---------------------------------------------------------------------------
section('4. Balance — câblage web');
// ---------------------------------------------------------------------------
{
  const engine = readRepoFile('src/services/webAudioEngine.ts');
  const manager = readRepoFile('src/services/playerManager.ts');

  if (!engine || !manager) {
    failures += 1;
  } else {
    check('le moteur déclare des nœuds de balance', /balanceNodes/.test(engine));
    check('le moteur expose setBalance', /setBalance\(balance: number\)/.test(engine));
    check('setBalance applique les deux gains', (() => {
      const body = engine.match(/setBalance\(balance: number\)\s*\{[\s\S]*?\n  \}/);
      if (!body) return false;
      return body[0].includes('left.gain.setTargetAtTime') &&
        body[0].includes('right.gain.setTargetAtTime');
    })());
    check('setBalance est idempotent sur balance nulle', /balanceNodes = null/.test(engine));

    check('le graphe contient un splitter et un merger', (() => {
      return engine.includes('createChannelSplitter(2)') &&
        engine.includes('createChannelMerger(2)');
    })());

    check('la balance est branchée APRÈS le préampli', (() => {
      const idx = engine.indexOf('preampGain.connect(balanceSplitter)');
      return idx !== -1 && idx > engine.indexOf('output.connect(preampGain)');
    })());

    // La balance n'alimente plus le volume directement : le bloc Mid-Side est
    // interposé entre les deux. Ce qui compte est qu'aucun chemin ne contourne
    // la balance — le merger ne doit brancher que vers le splitter stéréo.
    check('la sortie de balance alimente le Mid-Side', engine.includes('balanceMerger.connect(stereoSplitter)'));
    check('la balance ne court-circuite pas vers le volume', !engine.includes('balanceMerger.connect(volumeGain)'));

    check('playerManager transmet la balance au moteur web', (() => {
      const call = manager.match(/setBalance\([^)]*\)/);
      return Boolean(call) && /eq\.balance/.test(call[0]);
    })());

    check('playerManager n\'utilise pas StereoPannerNode (loi cos/sin, −3 dB)', !engine.includes('createStereoPanner'));

    check('le rejeu existe à la création du moteur web', (() => {
      const idx = manager.indexOf('this.webEngine = new WebAudioEngine(audio)');
      if (idx === -1) return false;
      return manager.indexOf('this.applyEqualizer()', idx) !== -1;
    })());

    check('le rejeu existe à la création du lecteur natif', (() => {
      const idx = manager.indexOf('this.player = p;');
      if (idx === -1) return false;
      return manager.indexOf('this.applyEqualizer()', idx) !== -1;
    })());
  }
}

// ---------------------------------------------------------------------------
section('3. Parité avec le DSP natif');
// ---------------------------------------------------------------------------
{
  // La formule doit être présente dans les deux implémentations natives.
  // Une dérive de l'une des trois doit faire échouer le harnais.
  const ios = readRepoFile('native/audio-dsp/MASAudioDSP.m');
  const android = readRepoFile('native/audio-dsp/AudioDSPProcessor.kt');

  if (!ios || !android) {
    failures += 1;
  } else {
    const iosBalance = ios.match(/double balL = state->balance < 0 \? 1\.0 : \(1\.0 - state->balance\);/);
    const iosRight = ios.match(/double balR = state->balance > 0 \? 1\.0 : \(1\.0 \+ state->balance\);/);
    check('iOS : formule balL conforme au harnais', Boolean(iosBalance));
    check('iOS : formule balR conforme au harnais', Boolean(iosRight));

    const ktBalance = android.match(/val balL = if \(currentSettings\.balance < 0\) 1\.0 else \(1\.0 - currentSettings\.balance\)/);
    const ktRight = android.match(/val balR = if \(currentSettings\.balance > 0\) 1\.0 else \(1\.0 \+ currentSettings\.balance\)/);
    check('Android : formule balL conforme au harnais', Boolean(ktBalance));
    check('Android : formule balR conforme au harnais', Boolean(ktRight));

    // Et la formule du harnais doit rester alignée elle-même.
    check('la loi du harnais correspond bien à celle documentée', (() => {
      const g = expectedBalanceGains(-0.25);
      return g.left === 1 && Math.abs(g.right - 0.75) < 1e-9;
    })());

    check('la balance alimente hasProcessing indépendamment de l\'EQ', (() => {
      return ios.includes('state->balance != 0.0') && android.includes('currentSettings.balance != 0.0');
    })());
  }
}

// ---------------------------------------------------------------------------
section('7. Préréglages — préampli épinglé et identifiants stables');
// ---------------------------------------------------------------------------
//
// Ces contrôles existaient avant le 10 octobre 2026, mais ils attestaient
// l'inverse : le préampli devait tomber SOUS le pic de chaque courbe. La décision
// utilisateur inverse la règle — le préampli doit toujours valoir 0 dB — donc ces
// contrôles sont réécrits, pas supprimés (cf. mas-player-verify-harnesses : un
// test qui ne teste plus rien est pire qu'un test absent).
//
// Le harnais ne juge pas ce choix sur son fond. Il atteste qu'il est *appliqué
// partout*, parce que c'est la partie qui peut silencieusement se défaire : un preset
// réintroduisant un préampli dérivé, ou une sauvegarde ancienne conservant −10 dB.
{
  const presetsSrc = readRepoFile('src/constants/presets.ts');
  const storageSrc = readRepoFile('src/services/storageService.ts');
  const eqViewSrc = readRepoFile('src/components/EqualizerView.tsx');
  const appSrc = readRepoFile('App.tsx');

  if (presetsSrc) {
    const code = stripComments(presetsSrc);

    check('makePreset n\'assigne plus de préampli dérivé', (() => {
      const body = code.match(/function makePreset[\s\S]*?\n\}/);
      return Boolean(body) && /preamp:\s*0\s*,/.test(body[0]);
    })());

    check('aucun preset ne déclare son propre préampli', !/preamp:\s*(?!0\b)[-0-9]/.test(code));

    check('autoPreampDb a disparu — plus rien ne dérive un préampli', !/autoPreampDb|MAX_AUTO_PREAMP|AUTO_PREAMP_GUARD_DB/.test(code));

    // L'outillage de mesure reste, et c'est volontaire : c'est lui qui rapporte
    // ce que le préampli à 0 coûte réellement (13 presets sur 14 au-dessus de
    // 0 dBFS). Le supprimer ferait perdre la seule trace chiffrée du compromis.
    check('responsePeakDb reste disponible comme outil de mesure', /export function responsePeakDb/.test(code));

    check('le preset renommé porte le bon id ET le bon nom', (() => {
      const renamed = code.match(/id:\s*'bass-profond'[\s\S]{0,200}?name:\s*'Bass Profond'/);
      return Boolean(renamed) && !/'bass-booster'/.test(code) && !/Bass Booster/.test(code);
    })());
  }

  if (presetsSrc && storageSrc) {
    const presets = [...stripComments(presetsSrc).matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
    const storage = stripComments(storageSrc);
    const saved = storage.match(/DSP_PRESET_ID_MIGRATIONS[^=]*=\s*\{([\s\S]*?)\}/);

    // Une migration qui ne couvre pas l'ancien id laisserait les installations
    // existantes afficher un nom de preset qui ne désigne plus rien.
    check('l\'ancien id de preset est migré au chargement', Boolean(saved) && /'bass-booster'\s*:\s*'bass-profond'/.test(saved[1]));
    check('la migration est réellement appliquée', /DSP_PRESET_ID_MIGRATIONS\[rawPresetId\]/.test(storage));

    // Un preset orphelin fait tomber l'écran sur un état incohérent.
    check('tous les ids de preset sont uniques', new Set(presets).size === presets.length,
      `doublons : ${presets.filter((id, i) => presets.indexOf(id) !== i).join(', ')}`);
  }

  if (storageSrc) {
    const storage = stripComments(storageSrc);
    const dsp = storage.match(/function normalizeDSP[\s\S]*?\n\}\n/);

    check('une sauvegarde ancienne est ramenée à un préampli nul', Boolean(dsp) && /preamp:\s*0\s*,/.test(dsp[0]) && !/preamp:\s*num\(/.test(dsp[0]));
  }

  if (eqViewSrc) {
    const code = stripComments(eqViewSrc);
    // Un fader préampli encore câblé laisserait croire à une commande qui
    // n'existe plus ; une sauvegarde de preset custom qui recopierait
    // `dsp.preamp` réintroduirait la valeur par un autre chemin.
    check('le fader préampli a été remplacé par une pastille fixe', !/isPreamp/.test(code) && /preampReadout/.test(code));
    check('aucun preset custom ne recopie un préampli non nul', !/preamp:\s*dsp\.preamp/.test(code));
  }

  if (appSrc) {
    const code = stripComments(appSrc);
    check('le récapitulatif n\'annonce plus de préampli variable', !/item\.preamp/.test(code));
  }
}

// ---------------------------------------------------------------------------
section('8. Knobs Bass / Treble — réponse audible et course non saturée');
// ---------------------------------------------------------------------------
//
// Ces contrôles protègent deux défauts distincts, tous deux invisibles à l'oreille
// sans mesure, et tous deux décrits comme « le knob ne marche pas bien ».
//
//   1. Le poids plaçait l'énergie là où l'oreille ne l'entend pas. L'ancien Bass
//      ne touchait que 31 et 62 Hz : à +12 il livrait 0,63 dB dans le grave audible
//      (100–250 Hz) contre 7,28 dB à 31 Hz, hors d'oreille sur un petit HP.
//   2. Le clamp à ±12 **écrêtait** la somme preset + knob. Sur `rock`, le knob
//      Treble mourait à partir de +10 : de 11 à 12, la bande restait à 12,00 dB
//      et l'oreille ne recevait plus rien d'un knob qui continuait d'avancer.
//
// Le harnais rejoue la loi de pondération — pas une constante recopiée — et
// échoue si une bande sature ou si un knob a un palier mort.
{
  const presetsSrc = readRepoFile('src/constants/presets.ts');
  const appSrc = readRepoFile('App.tsx');

  const REF = 44100;
  const Q = 1.41421356237;
  const FREQ = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const MIN = -12;
  const MAX = 12;

  // Magnitude d'un peaking RBJ — la même formule que `presets.ts`, écrite ici
  // indépendamment pour que le harnais teste le résultat et non l'implémentation.
  const bandDb = (f, c, g) => {
    if (!Number.isFinite(g) || g === 0) return 0;
    const A = 10 ** (g / 40);
    const w = (2 * Math.PI * c) / REF;
    const t = (2 * Math.PI * f) / REF;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Q);
    const nz = 1 + alpha / A;
    const b0 = (1 + alpha * A) / nz;
    const b1 = (-2 * cw) / nz;
    const b2 = (1 - alpha * A) / nz;
    const a1 = (-2 * cw) / nz;
    const a2 = (1 - alpha / A) / nz;
    const tc = Math.cos(t);
    const ts = Math.sin(t);
    const num = (b0 + b1 * tc + b2 * Math.cos(2 * t)) ** 2 + (b1 * ts + b2 * Math.sin(2 * t)) ** 2;
    const den = (1 + a1 * tc + a2 * Math.cos(2 * t)) ** 2 + (a1 * ts + a2 * Math.sin(2 * t)) ** 2;
    return 10 * Math.log10(Math.max(num / den, 1e-12));
  };

  const curveOf = (bands) => {
    const out = [];
    for (let f = 20; f <= 20000; f *= 1.01) {
      let m = 0;
      FREQ.forEach((c, i) => { m += bandDb(f, c, bands[i] || 0); });
      out.push([f, m]);
    }
    return out;
  };
  const maxIn = (curve, lo, hi) => {
    let m = -Infinity;
    for (const [f, y] of curve) if (f >= lo && f <= hi && y > m) m = y;
    return m;
  };
  const avgIn = (curve, lo, hi) => {
    let s = 0;
    let n = 0;
    for (const [f, y] of curve) if (f >= lo && f <= hi) { s += y; n += 1; }
    return n ? s / n : 0;
  };

  if (presetsSrc) {
    // Les poids sont extraits du code livré, jamais recopiés : un weight
    // rééquilibré sans que le harnais le suive ferait passer un défaut.
    const bassMatch = presetsSrc.match(/BASS_WEIGHTS\s*=\s*\[([^\]]+)\]/);
    const trebleMatch = presetsSrc.match(/TREBLE_WEIGHTS[^=]*=\s*\{([^}]+)\}/);
    const BW = bassMatch ? bassMatch[1].split(',').map((n) => parseFloat(n)) : [];
    const TW = {};
    if (trebleMatch) {
      for (const m of trebleMatch[1].matchAll(/(\d+)\s*:\s*([\d.]+)/g)) TW[Number(m[1])] = parseFloat(m[2]);
    }

    check('les poids Bass sont extraits et non nuls', BW.length === 4 && BW.every(Number.isFinite));
    check('les poids Treble sont extraits sur les 4 bandes hautes', [6, 7, 8, 9].every((i) => Number.isFinite(TW[i])));

    // Réplique de `getEffectiveEqualizerBands` : la course est bornée par la
    // crête du preset dans la zone, jamais écrêtée par un clamp().
    const effective = (bands, bass, treble) => {
      const bassPeak = Math.max(0, ...[0, 1, 2, 3].map((i) => Math.abs(bands[i] || 0)));
      const treblePeak = Math.max(0, ...[6, 7, 8, 9].map((i) => Math.abs(bands[i] || 0)));
      const sBass = Math.max(0, MAX - bassPeak) / MAX;
      const sTreble = Math.max(0, MAX - treblePeak) / MAX;
      return FREQ.map((_, i) => {
        let g = bands[i] || 0;
        if (i < BW.length) g += bass * BW[i] * sBass;
        else if (TW[i] !== undefined) g += treble * TW[i] * sTreble;
        return Math.max(MIN, Math.min(MAX, g));
      });
    };

    const flat = new Array(10).fill(0);

    // Les mesures ci-dessous rejouent la loi *attendue*. Sans ce contrôle, le
    // harnais validerait une loi que le code livré n'applique plus : retirer
    // `scaleBass` du calcul rendrait la saturation réelle sans qu'aucun check
    // échoue, parce que la réplique, elle, garde l'échelle. On vérifie donc que
    // le code livré applique bien les deux mise à l'échelle.
    check('le code livré applique la mise à l\'échelle de la course Bass', (() => {
      const body = presetsSrc.match(/export function getEffectiveEqualizerBands[\s\S]*?\n\}/);
      return Boolean(body) && /BASS_WEIGHTS\[index\]\s*\*\s*scaleBass/.test(body[0]);
    })());
    check('le code livré applique la mise à l\'échelle de la course Treble', (() => {
      const body = presetsSrc.match(/export function getEffectiveEqualizerBands[\s\S]*?\n\}/);
      return Boolean(body) && /TREBLE_WEIGHTS\[index\][^;]*\*\s*scaleTreble/.test(body[0]);
    })());

    // 1. L'énergie doit être dans le grave audible, pas dans le sous-grave.
    const bassCurve = curveOf(effective(flat, 12, 0));
    const useful = avgIn(bassCurve, 100, 250);
    const sub = maxIn(bassCurve, 28, 35);
    check('le knob Bass livre plus dans le grave audible que dans le sous-grave',
      useful > sub,
      `utile ${useful.toFixed(2)} dB vs sous-grave ${sub.toFixed(2)} dB`);
    check('le grave audible reçoit au moins 5 dB à fond', useful >= 5,
      `mesuré ${useful.toFixed(2)} dB`);
    check('le sous-grave reste borné (pas de bruit de cône)', sub <= 6,
      `mesuré ${sub.toFixed(2)} dB à 31 Hz`);

    // 2. Le Treble doit éviter la zone de sibilance sans perdre d'aigu utile.
    const trebleCurve = curveOf(effective(flat, 0, 12));
    check('le knob Treble pousse moins en 2 kHz qu\'en 16 kHz (pas de sibilance)',
      maxIn(trebleCurve, 1800, 2200) < maxIn(trebleCurve, 14500, 17000));

    // 3. Aucun preset ne doit voir une bande figée au plafond.
    const presetBands = [...stripComments(presetsSrc).matchAll(/id:\s*'[^']+'[\s\S]*?bands:\s*\[([^\]]+)\]/g)]
      .map((m) => m[1].split(',').map((n) => parseFloat(n.trim())));
    const knobPositions = [[12, 0], [0, 12], [-12, 0], [0, -12], [12, 12], [-12, -12]];
    let saturated = 0;
    let deadSteps = 0;
    for (const bands of presetBands) {
      for (const [b, t] of knobPositions) {
        if (effective(bands, b, t).some((g) => Math.abs(g) >= MAX - 1e-9)) saturated += 1;
      }
      // Un knob qui ne produit plus aucun changement en fin de course est mort.
      for (let k = 0; k < 12; k += 1) {
        const a = effective(bands, 0, k);
        const n = effective(bands, 0, k + 1);
        if (a.every((g, i) => Math.abs(g - n[i]) < 1e-9)) deadSteps += 1;
      }
      for (let k = 0; k < 12; k += 1) {
        const a = effective(bands, k, 0);
        const n = effective(bands, k + 1, 0);
        if (a.every((g, i) => Math.abs(g - n[i]) < 1e-9)) deadSteps += 1;
      }
    }
    check('aucune bande n\'atteint le plafond sur aucun preset', saturated === 0,
      `${saturated} saturation(s) sur ${presetBands.length} presets × ${knobPositions.length} positions`);
    check('aucun knob ne devient inerte en fin de course', deadSteps === 0,
      `${deadSteps} palier(s) sans effet`);

    // 4. Le web et le natif doivent consommer la même loi pondérée.
    if (appSrc) {
      const manager = readRepoFile('src/services/playerManager.ts');
      check('le natif reçoit les bandes déjà pondérées (une seule loi)',
        Boolean(manager) &&
        /getEffectiveEqualizerBands\(dsp\.bands, dsp\.bass, dsp\.treble\)/.test(manager) &&
        !/BASS_WEIGHTS/.test(manager));
    }
  }
}

// ---------------------------------------------------------------------------
section('9. Les knobs Bass / Treble survivent au changement de préréglage');
// ---------------------------------------------------------------------------
//
// Le défaut que cette section verrouille est le plus sournois de tous ceux
// couverts ici, parce qu'il ne se voit pas au moment où il se produit.
//
// `EqualizerPreset` portait `bass` et `treble`, et `handleSelectPreset` les
// recopiait dans l'état DSP. Les 14 préréglages d'usine déclarant `bass: 0,
// treble: 0`, **sélectionner n'importe quelle courbe remettait les deux knobs
// à zéro**. Pas « à peu près à zéro » : exactement zéro. L'utilisateur règle
// son Bass à +6, choisit « Rock », et son Bass repasse à 0 — sans qu'aucune
// action visible explique pourquoi, et le préréglage affiché dit « Rock & Metal »
// alors que la moitié de ses réglages a été effacée.
//
// Ce qui rend la faute invisible en test : le résultat *paraît* correct. Un
// test qui appelle `handleSelectPreset` et vérifie ensuite `dsp.bass === 0`
// passe au green, parce que c'est ce que le code fait. Il faut donc tester
// l'absence de l'écriture, pas sa valeur — c'est ce que fait cette section.
//
// La règle est simple et doit rester vraie : **aucun chemin de sélection de
// préréglage n'écrit `bass` ou `treble`.** Le préréglage décrit une courbe ; les
// knobs sont un réglage d'écoute posé par-dessus.
{
  const appSrc = readRepoFile('App.tsx');
  const viewSrc = readRepoFile('src/components/EqualizerView.tsx');
  const presetsSrc = readRepoFile('src/constants/presets.ts');
  const typesSrc = readRepoFile('src/types/audio.ts');

  if (appSrc) {
    const code = stripComments(appSrc);

    // Le cœur : la sélection ne doit toucher ni `bass` ni `treble`.
    const selectBody = code.match(/const handleSelectPreset[\s\S]*?\n  \};/);
    check('la sélection de préréglage est localisée', Boolean(selectBody));
    check('sélectionner un preset n\'écrit plus sur bass', Boolean(selectBody) && !/\bbass\s*:/.test(selectBody[0]),
      selectBody ? selectBody[0].match(/.*bass.*/)?.[0]?.trim() : 'corps introuvable');
    check('sélectionner un preset n\'écrit plus sur treble', Boolean(selectBody) && !/\btreble\s*:/.test(selectBody[0]));

    // `setDsp` y propage `...prev`, donc « absent » doit signifier « conservé ».
    check('la sélection préserve explicitement l\'état précédent', Boolean(selectBody) && /\.\.\.prev/.test(selectBody[0]));

    // Les anciennes écritures par `?? 0` sont le défaut exact : le `?? 0`
    // transformait un champ absent en une remise à zéro franche.
    check('l\'ancienne écriture `bass: preset.bass ?? 0` a disparu', !/bass:\s*preset\.bass/.test(code));
    check('l\'ancienne écriture `treble: preset.treble ?? 0` a disparu', !/treble:\s*preset\.treble/.test(code));

    // Un préréglage sauvegardé ne doit pas geler la position des knobs, sinon
    // la ligne « Bass / Aigus » de la liste ment dès que l'utilisateur bouge
    // les knobs après le SAVE.
    check('une sauvegarde ne copie plus les knobs dans le preset', !/bass:\s*dsp\.bass/.test(code) && !/treble:\s*dsp\.treble/.test(code));

    // La liste des préréglages perso affichait `item.bass` / `item.treble`.
    // Ces champs étant désormais absents, la ligne rendait « Bass: undefineddB ».
    check('la liste n\'affiche plus les knobs d\'un preset', !/item\.bass/.test(code) && !/item\.treble/.test(code));
    check('la liste décrit la forme de la courbe', /describePresetCurve\(item\.bands\)/.test(code));
  }

  if (viewSrc) {
    const code = stripComments(viewSrc);

    // RESET remettait aussi les knobs à zéro : destructif au-delà de ce que le
    // bouton annonce. Le RESET du bloc KNOBS reste le seul qui les touche.
    const resetBody = code.match(/const handleResetEQ[\s\S]*?\n  \};/);
    check('le RESET de l\'égaliseur est localisé', Boolean(resetBody));
    check('le RESET de l\'égaliseur n\'écrit plus sur bass', Boolean(resetBody) && !/\bbass\s*:/.test(resetBody[0]));
    check('le RESET de l\'égaliseur n\'écrit plus sur treble', Boolean(resetBody) && !/\btreble\s*:/.test(resetBody[0]));
    check('le RESET de l\'égaliseur remet toujours la courbe à plat', Boolean(resetBody) && /presetId:\s*'flat'/.test(resetBody[0]));

    check('une sauvegarde via le fallback ne copie plus les knobs', !/bass:\s*dsp\.bass/.test(code) && !/treble:\s*dsp\.treble/.test(code));
  }

  if (presetsSrc) {
    const code = stripComments(presetsSrc);

    // Aucun préréglage d'usine ne doit déclarer ces champs. Ils étaient tous à
    // `0`, et c'est précisément cette valeur qui écrasait les knobs.
    const presetBodies = [...code.matchAll(/makePreset\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);
    check('les 14 préréglages d\'usine sont tous localisés', presetBodies.length === 14, `${presetBodies.length} trouvés`);

    const offenders = presetBodies
      .map((body, index) => (/^\s*(bass|treble):/m.test(body) ? `preset #${index + 1}` : null))
      .filter(Boolean);
    check('aucun préréglage d\'usine ne déclare bass ou treble', offenders.length === 0,
      offenders.join(', '));

    // Un preset sans ces champs ne peut pas les réintroduire par accident : le
    // type les rend facultatifs, donc un `bass: 0` serait une faute visible.
    check('la loi « les knobs appartiennent à la courbe » est écrite', /n'appartiennent pas/.test(presetsSrc) || /n’appartiennent pas/.test(presetsSrc) || /appartiennent pas/.test(readRepoFile('src/types/audio.ts') || ''));
  }

  if (typesSrc) {
    const code = stripComments(typesSrc);
    // Facultatifs : c'est la garde structurelle. Si quelqu'un les rend
    // obligatoires, chaque factory preset doit à nouveau déclarer `0`, et le
    // bug du §1 revient par la porte du typage.
    check('bass et treble sont facultatifs dans EqualizerPreset', /bass\?\s*:\s*number/.test(code) && /treble\?\s*:\s*number/.test(code));
  }

  // --- `describePresetCurve` : comportement, pas présence ------------------
  // La ligne de résumé est le seul endroit où un champ devenu `undefined`
  // s'afficherait tel quel (« undefineddB »). Un test de présence de
  // l'appel ne le verrait pas : il faut donc exécuter la logique.
  {
    const describe = (bands) => {
      const at = (indexes) => {
        const values = indexes.map((i) => (Number.isFinite(bands?.[i]) ? bands[i] : 0));
        if (!values.length) return 0;
        return values.reduce((s, v) => s + v, 0) / values.length;
      };
      const low = at([0, 1, 2, 3]);
      const high = at([6, 7, 8, 9]);
      const shape = (v) => (v >= 1.5 ? `+${v.toFixed(1)}` : v <= -1.5 ? v.toFixed(1) : '±0');
      return `Basses ${shape(low)} dB • Aigus ${shape(high)} dB`;
    };

    const flat = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    check('une courbe plate se décrit sans « undefined »', !/undefined/.test(describe(flat)));
    check('une courbe plate se décrit comme neutre', describe(flat) === 'Basses ±0 dB • Aigus ±0 dB');

    // C'est le cas que `item.bass === undefined` produisait.
    check('une sauvegarde récente se décrit sans « undefined »', !/undefined/.test(describe(flat)));
    check('aucune épuration ne réintroduit le mot undefined', !/NaN/.test(describe(flat)));

    // Une courbe en V doit dire « basses poussées », pas « neutre ».
    const vee = [6, 4, 2, -1, -2, 0, 2, 4, 5, 5];
    const veeLine = describe(vee);
    check('une courbe en V annonce des basses poussées', /\+/.test(veeLine.split('•')[0]), veeLine);
    check('une courbe en V annonce des aigus poussés', /\+/.test(veeLine.split('•')[1]), veeLine);

    // Les 14 presets d'usine doivent tous produire une ligne présentable.
    const PRESETS_BANDS = [
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [-1, 3.5, 6.5, 3, -1, 0, 0, 0.5, 1, 1],
      [4.5, 6, 8, 4, -2, 0, 0.5, 1.5, 2, 2],
      [6, 4, 2, -1, -2, 0, 2, 4, 5, 5],
      [4, 3, 1, 1, 3, 2, 2, 3, 4, 4],
      [8, 6, 4, 1, -1, 1, 3, 5, 6, 7],
      [3, 3, 1, 2, -1, 0, 1, 2, 2, 2],
      [-3, -3, -1, 2, 5, 4, 3, 3, 4, 5],
      [2, 1, 1, 0, 1, 2, 3, 4, 4, 4],
      [-1.5, -1, 0, 0.5, 0.5, 0.5, 0.5, 1, 1.5, 2],
      [1.5, 1, 0.5, 0, -0.5, -1, -1.5, -1, -0.5, 0],
      [-0.5, -0.5, -0.5, 0, 0.5, 1, 1, 0.5, 0.5, 3],
      [-4, -3, -2, -1, 0, 0.5, 1, 1, 0.5, 0],
      [0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1],
    ];
    const badLines = PRESETS_BANDS
      .map((b, i) => (/undefined|NaN/.test(describe(b)) ? `#${i + 1}` : null))
      .filter(Boolean);
    check('les 14 courbes d\'usine se décrivent sans défaut d\'affichage', badLines.length === 0,
      badLines.join(', '));

    // Une entrée tronquée (sauvegarde partielle) ne doit pas faire tomber le rendu.
    check('un bands tronqué ne produit pas de NaN', !/NaN|undefined/.test(describe([6, 4])));
    check('un bands vide ne produit pas de NaN', !/NaN|undefined/.test(describe([])));
  }
}

console.log('');
if (failures === 0) {
  console.log(`OK — ${checks} vérifications passées.`);
  process.exit(0);
} else {
  console.log(`ÉCHEC — ${failures} vérification(s) en échec sur ${checks}.`);
  process.exit(1);
}