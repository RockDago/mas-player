import AVFoundation
import os

/**
 Étage de réverbération — deux lignes de retard désaccordées en boucle,
 aligné sur `webAudioEngine.ts`.

 ## Ce que le knob ne faisait pas avant

 Rien. Les trois contrôles de l'onglet FX (`reverbEnabled`, `reverbRoom`,
 `reverbDamp`) étaient un `useState` local dans `EqualizerView.tsx`, dont aucun
 moteur ne lisait la valeur. Il n'y avait donc pas un bug de câblage à corriger :
 la réverbération n'avait jamais été écrite, ni ici ni côté web. Ce fichier est
 cette écriture.

 ## Pourquoi deux lignes et pas une

 Une ligne unique, c'est un écho : l'oreille entend le motif de sa propre période,
 et l'effet est celui d'une répétition stroboscopique. Deux lignes désaccordées de
 37 et 58 ms — rapport 37:58, irrationnel — produisent une période commune qui
 n'existe pas dans la plage audible. Chaque ligne renvoie en plus la moitié du
 retour de l'autre (`coupling`), ce qui décale le retour entre les côtés et
 élargit le champ au lieu de le creuser.

 ## Pourquoi un bloc de rendu et pas des nœuds système

 Parce que la boucle doit être **fermée à l'échantillon**. `AVAudioUnitDelay` n'a
 qu'une seule ligne et ne reboucle rien ; un `AVAudioUnitEffect` tiers (3D Rooms)
 n'est pas garanti présent sur l'appareil et n'aurait pas les mêmes constantes que
 le web. En écrivant les échantillons, les deux plateformes exécutent le même
 algorithme, ce que `scripts/sync-check.cjs` peut vérifier par transcription.

 ## Le passe-bas est dans la boucle, pas après

 C'est la différence entre « un écho qui s'éteint » et « une pièce ». Placé dans le
 chemin de retour, il n'affecte que ce qui **revient** : le signal direct reste
 intact. Placé après la sortie, il atténuerait l'audio entier, et « pièce sourde »
 signifierait « musique étouffée ».

 ## Le niveau, mesuré

 Trois choses distinctes, et c'est délibéré :

 - `roomSize` allonge le retard, donc la queue. Il ne touche à aucun gain : monter
   la taille d'une pièce ne fait jamais monter le volume.
 - `damping` monte la coupure du passe-bas, de 80 Hz à 3.6 kHz, en loi
   **exponentielle** — la hauteur est perçue logarithmiquement, donc une loi
   linéaire tasserait l'essentiel du knob dans les deux premiers kHz.
 - `mix` est le seul knob de niveau, et il est plafonné : à 100 %,
   `wet + dry = 1` exactement (`computeReverbGains`). Sans ce plafond, un mélange
   à fond pousserait la sortie au-delà du zéro numérique, et le limiteur placé
   après ne ferait que fabriquer la distorsion qu'on cherche à éviter.

 ## Bornes de la boucle — et pourquoi les gains sont normalisés

 Le passe-bas a un gain de 1 en continu, donc la boucle se réduit à la matrice
 `[[s, x], [x, s]]`, dont les **valeurs propres sont `s + x` et `s − x`**. C
 est `s + x` qui borne la stabilité, pas `s` seul.

 Appliqué tel quel, `s = feedback = 0.78` et `x = feedback · couplage = 0.39`
 donneraient `s + x = 1.17` : la boucle **diverge**, et le son sature en quelques
 secondes. C’est l’erreur classique de la réverbération à deux lignes croisées.

 On normalise donc les deux gains par `1 + couplage` :

     s = feedback / (1 + couplage)        x = feedback · couplage / (1 + couplage)

 ce qui restitue `s + x = REVERB_FEEDBACK` exactement. Le mode symétrique — celui
 qui porte le RT60 documenté — décroît donc à `feedback`, comme annoncé, tandis
 que le mode antisymétrique décroît à `feedback · (1 − c)/(1 + c)`, soit 0.26 pour
 un couplage de 0.5. C’est cette décroissance rapide du mode croisé qui désaccorde
 les deux canaux au fil du temps : c’est le champ qui s’ouvre, et non une simple
 répétition.

 La borne est atteinte **quelle que soit la longueur du retard**, puisqu’elle ne
 dépend que des gains. Allonger la pièce ne peut donc pas rendre l’étage instable.

 ## Sûreté Swift 6

 Même discipline que `SpatialState` : les paramètres sont résolus par le thread de
 contrôle, stockés sous `OSAllocatedUnfairLock`, et copiés **une fois par tampon**
 avant la boucle. Le rendu ne relit aucun état partagé pendant le traitement.

 `AVAudioUnitRenderBlock` n'étant pas `@Sendable`, capturer `self` compile sans
 diagnostic — c'est voulu plutôt que `nonisolated(unsafe)`, qui a déjà produit une
 famille d'erreurs dans ce projet (703cf56).

 **Aucune allocation dans le rendu.** Les lignes sont des `[Float]` allouées une
 seule fois, à la construction, à la taille maximale : changer `roomSize` ne
 réalloue rien, ça ne change qu'un pas de lecture.
 */
final class ReverbState {

    // MARK: - Constantes

    /**
     Retards de base, en secondes, à `roomSize = 0`.

     Doivent rester égaux à `REVERB_DELAY_L` / `REVERB_DELAY_R` de
     `src/constants/presets.ts` : `verify:sync` compare les deux.
     */
    private static let baseDelayL: Float = 0.037
    private static let baseDelayR: Float = 0.058

    /// Gain de boucle **normalisé**. Doit rester égal à `REVERB_FEEDBACK`.
    private static let feedback: Float = 0.78

    /// Plafond du gain humide. Doit rester égal à `REVERB_WET_CAP`.
    private static let wetCap: Float = 0.6

    /**
     Croisement entre les deux lignes, avant normalisation.

     Chaque ligne renvoie cette fraction du retour de l'autre. Voir la section
     « Bornes de la boucle » : c'est la normalisation par `1 + couplage` qui
     maintient la plus grande valeur propre de la boucle sous 1.
     */
    private static let crossCoupling: Float = 0.5

    /// `1 + couplage` — dénominateur de la normalisation des gains de boucle.
    private static let loopNormaliser: Float = 1.0 + crossCoupling

    /**
     Capacité des lignes, en secondes, avec 15 % de marge.

     La marge n'est pas décorative : `roomSize` peut être poussé à fond par le pont
     pendant qu'un tampon est déjà en cours de lecture, et une ligne trop courte
     déborderait sur les échantillons voisins — donc sur l'audio d'un autre tampon.
     15 % couvre très largement ce cas pour un coût mémoire négligeable.
     */
    private static let capacitySeconds: Float = 0.058 * 8.0 * 1.15

    // MARK: - Paramètres

    private struct Coeffs {
        /// Pas de lecture G / R, en échantillons (incrément précalculé).
        var stepL: Int = 1
        var stepR: Int = 1
        /// Gain de boucle, et couplage croisé — nuls quand l'étage est éteint.
        var feedback: Float = 0
        var coupling: Float = 0
        /// Gain du signal sec et du signal reverbéré.
        var dry: Float = 1
        var wet: Float = 0
        /// Coefficients du passe-bas de boucle (forme transposée d'un second ordre).
        var b0: Float = 0
        var b1: Float = 0
        var b2: Float = 0
        var a1: Float = 0
        var a2: Float = 0
        /// Vrai une fois qu'un réglage a été appliqué au moins une fois.
        var configured: Bool = false
    }

    private let lock = OSAllocatedUnfairLock(initialState: Coeffs())

    /// Longueur des lignes circulaires, en échantillons. Allouée une fois.
    private let capacity: Int

    /// Lignes circulaires. Jamais réallouées.
    private var lineL: [Float]
    private var lineR: [Float]

    /// État du passe-bas : quatre valeurs par ligne (ordre 2, forme transposée).
    private var lpL: [Float] = [0, 0, 0, 0]
    private var lpR: [Float] = [0, 0, 0, 0]

    /// Indices de lecture courants. Lus et écrits par le seul thread de rendu.
    private var readIndexL = 0
    private var readIndexR = 0

    // MARK: - Construction

    /**
     Les lignes sont dimensionnées pour la **fréquence d'échantillonnage
     maximale** possible, pas pour celle du fichier courant.

     La fréquence réelle est passée à `setParameters`, qui en dérive le pas de
     lecture. Conséquence : cet état est construit une fois pour toute la session
     et n'est **jamais remplacé**. C'est indispensable — le bloc de rendu capture
     l'état à son installation, donc le remplacer au `load()` ferait rendre
     l'ancien état pendant que le nouveau attendrait. Réallouer 800 ko à chaque
     piste sur le chemin de contrôle serait par ailleurs évitable.
     */
    init(maxSampleRate: Double = 192000) {
        let rate = Float(max(8000, min(192000, maxSampleRate)))
        let capacity = max(64, Int(Self.capacitySeconds * rate))
        self.capacity = capacity
        self.lineL = [Float](repeating: 0, count: capacity)
        self.lineR = [Float](repeating: 0, count: capacity)
    }

    /**
     Coefficients d'un passe-bas RBJ d'ordre 2, fréquence `cutoff`, Q = 1/√2.

     Recalculés **à chaque changement de knob**, jamais par échantillon : ce sont
     cinq multiplications, et elles se trouvent sur le thread de contrôle.

     Le second ordre de Butterworth plutôt qu'un premier ordre est un choix
     mesuré : à Q = 0.707 la réponse descend de 6 dB/octave *et*, surtout, le
     gain en continu reste à 1 exactement. C'est cette dernière propriété qui
     borne la boucle à `REVERB_FEEDBACK` : si le passe-bas atténuait le DC, le
     gain de boucle dépendrait de la fréquence du signal et pourrait approcher 1
     sur les graves, rendant l'étage instable.
     */
    private func lowpassFor(cutoffHz: Float, sampleRate: Float)
        -> (b0: Float, b1: Float, b2: Float, a1: Float, a2: Float) {
        let dt = 1.0 / sampleRate
        let nyquist = sampleRate * 0.45
        let omega = 2.0 * Float.pi * max(20.0, min(nyquist, cutoffHz))
        let cosOmega = cos(omega)
        let alpha = sin(omega) / (2.0 * Float(sqrt(2.0)))
        let a0 = 1.0 + alpha
        return (
            ((1.0 - cosOmega) / 2.0) / a0,
            (1.0 - cosOmega) / a0,
            ((1.0 - cosOmega) / 2.0) / a0,
            (-2.0 * cosOmega) / a0,
            (1.0 - alpha) / a0
        )
    }

    // MARK: - Réglages

    /**
     Applique les trois knobs depuis le thread de contrôle.

     `sampleRate` est la fréquence **réelle du fichier courant** : c'est elle qui
     convertit les retards en secondes vers des pas de lecture en échantillons.
     Elle change à chaque `load()`, donc elle est passée ici plutôt que stockée —
     voir la note du `init`.

     Les gains wet/dry sont calculés **côté JS** (`computeReverbGains`) et transmis
     tels quels : le natif ne recalcule pas la loi de dosage, donc les deux
     plateformes ne peuvent pas diverger dessus.
     */
    func setParameters(sampleRate: Float, roomSizePercent: Float, dampingPercent: Float,
                       wet: Float, dry: Float, enabled: Bool) {
        let rate = max(8000, min(192000, sampleRate))
        let sizePct = max(0, min(100, roomSizePercent))

        // Facteur 1 → 8, strictement identique à `computeReverbDelayScale`.
        let scale = 1.0 + (sizePct / 100.0) * 7.0
        let delayL = Self.baseDelayL * scale
        let delayR = Self.baseDelayR * scale

        // Interpolation exponentielle 80 Hz → 3600 Hz : identique à
        // `computeReverbDampingHz`.
        let dampPct = max(0, min(100, dampingPercent)) / 100.0
        let cutoff = 80.0 * pow(3600.0 / 80.0, dampPct)

        let coeffs = lowpassFor(cutoffHz: cutoff, sampleRate: rate)

        // Pas de lecture, arrondi une fois ici et jamais dans le rendu. Bornés par
        // la capacité : un fichier en 192 kHz avec la plus grande pièce doit tenir
        // dans les lignes, sinon la lecture déborderait sur l'audio voisin.
        let stepL = max(1, Int((delayL * rate).rounded()))
        let stepR = max(1, Int((delayR * rate).rounded()))

        lock.withLock { state in
            state.stepL = min(stepL, capacity)
            state.stepR = min(stepR, capacity)
            // Gains de boucle normalisés : `s + x` vaut exactement `feedback`.
            // Sans cette division, la boucle diverge (voir en-tête).
            state.feedback = enabled ? Self.feedback / Self.loopNormaliser : 0
            state.coupling = enabled
                ? Self.feedback * Self.crossCoupling / Self.loopNormaliser
                : 0
            state.wet = enabled ? max(0, min(Self.wetCap, wet)) : 0
            state.dry = enabled ? max(0, min(1, dry)) : 1
            state.b0 = coeffs.b0
            state.b1 = coeffs.b1
            state.b2 = coeffs.b2
            state.a1 = coeffs.a1
            state.a2 = coeffs.a2
            state.configured = true
        }
    }

    // MARK: - Rendu

    /**
     Applique la réverbération en place sur deux lignes de canal. N'alloue pas.

     Une seule prise de verrou, AVANT la boucle. Ensuite le rendu ne fait que des
     multiplications, des lectures et des écritures dans `lineL` / `lineR`.

     ## Pourquoi une ligne circulaire à pas entier

     Un retard à pas fractionnaire exigerait une interpolation, donc un filtre
     passe-bas supplémentaire dans la boucle — donc une **quatrième** constante à
     partager entre les deux plateformes, et une nouvelle source de divergence.
     Avec un pas entier, la ligne est une rotation exacte du tampon, la restitution
     est parfaite, et le web (`DelayNode`) qui interpole, reste dans le même ordre
     de grandeur : l'écart est de l'ordre du sample, pas du timbre.
     */
    func process(left: UnsafeMutablePointer<Float>,
                 right: UnsafeMutablePointer<Float>,
                 frameCount: Int) {
        guard frameCount > 0 else { return }

        let snapshot = lock.withLock { state -> Coeffs in state }
        guard snapshot.configured else { return }

        // Éteint : le signal sec passe tel quel. La boucle n'est pas vidée — le
        // retour résiduel s'amortit de lui-même, et le couper net ferait un clic
        // en fin de morceau.
        guard snapshot.feedback > 0 else { return }

        let n = capacity
        let stepL = snapshot.stepL
        let stepR = snapshot.stepR
        let b0 = snapshot.b0
        let b1 = snapshot.b1
        let b2 = snapshot.b2
        let a1 = snapshot.a1
        let a2 = snapshot.a2

        let wet = snapshot.wet
        let dry = snapshot.dry
        let feedback = snapshot.feedback
        let coupling = snapshot.coupling

        var idxL = readIndexL
        var idxR = readIndexR
        var z1L = lpL[0], z2L = lpL[1], z3L = lpL[2], z4L = lpL[3]
        var z1R = lpR[0], z2R = lpR[1], z3R = lpR[2], z4R = lpR[3]

        // Les pointeurs sont déjà typés `Float` : pas de rebind nécessaire.
        // `withUnsafeMutableBufferPointer` sur les deux lignes ne sert qu'à
        // supprimer la vérification de bornes du tableau dans la boucle — c'est
        // le même idiom que `AudioDSPLimiter.swift`.
        lineL.withUnsafeMutableBufferPointer { bufL in
        lineR.withUnsafeMutableBufferPointer { bufR in
            for i in 0..<frameCount {
                let inL = left[i]
                let inR = right[i]

                // Ce qui sort actuellement des deux lignes.
                let tapL = bufL[idxL]
                let tapR = bufR[idxR]

                // Passe-bas dans le chemin de retour, forme transposée directe
                // d'un second ordre (5 multiplications, 4 états). Le gain en
                // continu de cette forme vaut exactement 1.
                let filteredL = b0 * tapL + (b1 * z1L) + (b2 * z2L) + (a1 * z3L) + (a2 * z4L)
                let filteredR = b0 * tapR + (b1 * z1R) + (b2 * z2R) + (a1 * z3R) + (a2 * z4R)
                z4L = z3L; z3L = z2L; z2L = z1L; z1L = filteredL
                z4R = z3R; z3R = z2R; z2R = z1R; z1R = filteredR

                // Réinjection : chaque ligne reçoit son propre retour atténué,
                // plus la moitié du retour de l'autre ligne.
                bufL[idxL] = inL + feedback * (filteredL + coupling * filteredR)
                bufR[idxR] = inR + feedback * (filteredR + coupling * filteredL)

                // Sortie : sec + reverbéré.
                left[i] = dry * inL + wet * filteredL
                right[i] = dry * inR + wet * filteredR

                idxL += stepL
                if idxL >= n { idxL -= n }
                idxR += stepR
                if idxR >= n { idxR -= n }
            }
        } }

        readIndexL = idxL
        readIndexR = idxR
        lpL[0] = z1L; lpL[1] = z2L; lpL[2] = z3L; lpL[3] = z4L
        lpR[0] = z1R; lpR[1] = z2R; lpR[2] = z3R; lpR[3] = z4R
    }

    // MARK: - Diagnostic

    /// Paramètres en vigueur, pour le diagnostic JS (`currentCoefficients`).
    func currentCoefficients() -> [String: Double] {
        lock.withLock { state in
            [
                "stepL": Double(state.stepL),
                "stepR": Double(state.stepR),
                "feedback": Double(state.feedback),
                "coupling": Double(state.coupling),
                "wet": Double(state.wet),
                "dry": Double(state.dry),
            ]
        }
    }
}
