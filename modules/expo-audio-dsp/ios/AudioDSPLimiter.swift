import AVFoundation
import os

/**
 Limiteur à crête stéréo-lié, avec 6 ms d'avance, destiné au chemin de rendu
 audio — donc exécuté sur le thread temps réel, où l'allocation est interdite.

 ## Pourquoi un bloc de rendu maison plutôt qu'une Audio Unit

 Les trois unités système ont été écartées pour une raison commune : aucune ne
 donne le contrôle du pré-délai, et c'est le pré-délai qui est le but de cet étage.

 - `AVAudioUnitDynamicsProcessor` : son pré-délai est interne et non documenté, donc
   impossible à aligner sur le web. Son `headRoom` n'est de surcroît pas un seuil.
 - `kAudioUnitSubType_PeakLimiter` : pas de ratio et courbe de transfert différente
   de celle du web, donc **non vérifiable**. Un limiteur qu'on ne peut pas mesurer
   contre le harnais vaut moins que l'écrêtage qu'il est censé supprimer.

 Sans avance, une attaque de 2 ms arrive toujours trop tard : la crête est déjà
 passée, et chaque kick et chaque snare se déforme.

 ## La fonction : un PLAFOND, pas une compression

     N    = ceil(0.006 × fréquence)          // 48 k → 288 ; 192 k → 1152
     pic  = max(|x|) sur la fenêtre glissante // le pic qui va sortir
     gain = 1                    si pic ≤ seuil
     gain = 10^((seuil − 20·log10(pic)) / 20)   sinon
     env  = gain                 si gain < env   // attaque gratuite :
                                                    // c'est ce que l'avance achète
     env += (gain − env) · releaseCoef          sinon
     y[i] = x[i − N] · env

 **Pourquoi ratio 1 au-dessus du seuil.** La première version utilisait la courbe
 classique d'un compresseur, `out = seuil + (db − seuil)/ratio`, avec ratio 20. Elle
 est correcte en tant que compression, mais elle **ne borne rien** : elle se réduit
 à `0.05·db − 2.85`, donc une crête à +60 dBFS ressort encore à +0.15 dBFS, au-dessus
 du zéro numérique. Or le but de cet étage est précisément d'interdire l'écrêtage —
 Mega Bass sort de la chaîne à +10.4 dBFS, et une pointe de mixage à +20 ou +30 n'est
 pas rare. Un étage qui laisse passer le zéro n'est pas un limiteur.

 Le ratio 1 d'origine est donc le bon choix, et il faut dire ce qu'il reste de
 compression : l'**enveloppe**. Le gain Required descend instantanément vers la
 crête et remonte par relâchement ; c'est cette dynamique temporelle qui comprime le
 signal, pas la courbe statique. C'est exactement la définition d'un limiteur.

 Ce que le seuil ne fait plus, en revanche : adoucir la transition. Une entrée à
 0 dBFS sort à **-3.00 dBFS** exactement, et non à -2.85. C'est le prix du plafond
 dur, et il est voulu.

 **Conséquence à assumer** : `webAudioEngine.ts` doit être modifié pour appliquer la
 même fonction, sinon le même preset sonnerait différemment sur les deux
 plateformes. C'est un changement réel du comportement web, de 0.15 dB sur les
 crêtes — inaudible, mais rendu explicite plutôt que subi.

 ## Stéréo-lié, nécessairement

 Un limiteur par canal fait pomper l'image : le canal le plus fort tire seul vers le
 bas, et l'écart entre les deux devient audible comme une respiration de l'image
 stéréo. On prend donc le **minimum** des deux canaux.

 ## Sûreté Swift 6

 `AVAudioUnitRenderBlock` n'est pas `@Sendable` dans le SDK : une capture forte
 d'une classe non-Sendable compile proprement, et c'est ce qu'on fait ici. L'état
 vit dans `LimiterState` — une **classe**, pas une structure, parce qu'on a besoin
 d'une identité stable pour les lignes de retard.

 Les paramètres traversent la frontière de thread derrière un `OSAllocatedUnfairLock`
 (iOS 16+, et le podspec exige 16.4), pris **une fois par tampon** (~512
 échantillons), jamais par échantillon. C'est le seul verrou du chemin audio et
 c'est le prix explicite de la sûreté Swift 6.

 ## Le point d'honnêteté sur les allocations

 `process()` n'alloue **jamais**. `prepare(sampleRate:)` en alloue, et il est appelé
 depuis `process()` quand le format change — c'est-à-dire au chargement d'une piste,
 jamais en régime. C'est un compromis assumé : dupliquer les lignes de retard à
 chaque changement de fréquence éviterait cette exception, pour un coût permanent
 sur le chemin audio. Le changement de fréquence est rare ; le rendu est permanent.

 Un `log10f` et un `powf` par échantillon restent sur le chemin critique. C'est le
 prix d'une courbe dont la correspondance avec le web est vérifiée par
 `scripts/verify-limiter.cjs`.
 */
final class LimiterState {

    // MARK: - Constantes de la courbe

    /// Plafond du limiteur en dBFS. Doit rester aligné sur `webAudioEngine.ts`.
    private static let thresholdDb: Float = -3.0

    /// Seuil du mode contourné, en dBFS.
    ///
    /// À 0 et non « +infinité » : `setThreshold` borne déjà la plage à −24…0,
    /// et 0 est le seul point où `requiredGain` renvoie systématiquement 1.0 —
    /// donc le seul point où le limiteur est garanti transparent.
    ///
    /// Ce que la pastille LIMIT éteint est le **plafond**, pas le limiteur : à
    /// 0 dBFS une crête à +3 dBFS ressort encore bornée à 0 dBFS. On ne peut pas
    /// faire mieux sans retirer l'étage du graphe, ce qui relierait la balance
    /// directement au mixeur principal — un changement de câblage, pas de
    /// réglage. Le web est dans la même contrainte (`DynamicsCompressorNode`
    /// n'a pas de contournement) et applique donc la même loi : `sync-check.cjs`
    /// compare les deux seuils.
    static let bypassThresholdDb: Float = 0.0

    /// Avance, en secondes. 6 ms = la latence du `DynamicsCompressorNode` de
    /// Chromium, ce qui fait converger web et iOS sans réglage supplémentaire.
    private static let lookaheadSeconds: Double = 0.006

    /// Relâchement, en secondes. Le web utilise `release = 0.12` ; on reproduit
    /// cette durée, pas sa formule interne.
    private static let releaseSeconds: Double = 0.120

    /// Longueur minimale des lignes de retard. Au-delà de 4 096 échantillons
    /// (85 ms à 48 kHz) l'avance n'a plus aucun intérêt audible.
    private static let minDelayCapacity = 4096

    // MARK: - Paramètres (partagés avec le thread de rendu)

    private struct Params {
        /// Seuil effectif, en dBFS.
        var threshold: Float
        /// Avance convertie en échantillons, recalculée à chaque fréquence.
        var lookaheadSamples: Int
        /// Convergence du relâchement par tampon.
        var releaseCoef: Float
    }

    /// Verrou protégeant `pending`. Pris une fois par tampon dans `process()`.
    private let lock = OSAllocatedUnfairLock(initialState: Params(
        threshold: LimiterState.thresholdDb,
        lookaheadSamples: 288,
        releaseCoef: 0.0005
    ))

    // MARK: - État de rendu (thread audio uniquement)

    /// Enveloppe de gain courante, une seule valeur pour les deux canaux.
    private var envelope: Float = 1.0

    /// Lignes de retard préallouées, une par canal.
    private var delayL = [Float](repeating: 0, count: LimiterState.minDelayCapacity)
    private var delayR = [Float](repeating: 0, count: LimiterState.minDelayCapacity)

    /// Position du prochain écrasement. Par convention, `writeIndex` pointe
    /// toujours vers l'échantillon **le plus ancien** conservé.
    private var writeIndex: Int = 0

    /// Fréquence pour laquelle les lignes sont validées, et fréquence pour
    /// laquelle les paramètres ont été convertis en échantillons.
    private var allocatedSampleRate: Double = 0
    private var preparedSampleRate: Double = 0

    // MARK: - Réglages

    /// Applique un nouveau seuil depuis le thread de contrôle.
    func setThreshold(_ threshold: Float) {
        lock.withLock { params in
            params.threshold = max(-24.0, min(0.0, threshold))
        }
    }

    /// Commute le limiteur selon la pastille LIMIT de l'onglet FX.
    ///
    /// Éteint, le seuil passe à `bypassThresholdDb` (0 dBFS) : `requiredGain`
    /// renvoie alors 1.0 pour toute crête, et le limiteur laisse le signal
    /// intact. L'enveloppe et les lignes de retard ne sont pas remises à zéro —
    /// leur contenu résiduel s'amortit de lui-même, et les vider ferait un clic
    /// en fin de morceau.
    func setEnabled(_ enabled: Bool) {
        setThreshold(enabled ? Self.thresholdDb : Self.bypassThresholdDb)
    }

    /**
     Recalcule les paramètres dépendants de la fréquence et valide les lignes de
     retard.

     Alloue : ne doit donc pas être appelé sur un tampon en cours de rendu hors
     changement de format — voir la note d'honnêteté ci-dessus.
     */
    func prepare(sampleRate: Double) {
        guard sampleRate > 0 else { return }

        let lookahead = max(1, Int((Self.lookaheadSeconds * sampleRate).rounded()))
        // 1 − exp(−1 / (release · fs)) : convergence vers la cible, par tampon.
        let releaseCoef = Float(1.0 - exp(-1.0 / max(1.0, Self.releaseSeconds * sampleRate)))

        lock.withLock { params in
            params.lookaheadSamples = lookahead
            params.releaseCoef = releaseCoef
        }
        preparedSampleRate = sampleRate

        let capacity = max(lookahead + 1, Self.minDelayCapacity)
        if allocatedSampleRate != sampleRate || delayL.count < capacity {
            delayL = [Float](repeating: 0, count: capacity)
            delayR = [Float](repeating: 0, count: capacity)
            allocatedSampleRate = sampleRate
        }
        envelope = 1.0
        writeIndex = 0
    }

    // MARK: - Rendu

    /**
     Point d'entrée principal, appelé depuis le bloc de rendu de l'unité d'effet.

     Travaille EN PLACE sur les deux lignes de canal. N'alloue pas — c'est la
     raison pour laquelle cette variante existe à côté de `process(_:frameCount:)` :
     cette dernière doit construire un `AVAudioPCMBuffer`, ce qui alloue et n'a pas
     sa place sur le chemin temps réel.

     - Parameters:
       - left: ligne gauche, ou nil si le format n'a qu'un canal.
       - right: ligne droite.
     */
    func processChannels(left: UnsafeMutablePointer<Float>?,
                         right: UnsafeMutablePointer<Float>?,
                         frameCount: Int,
                         sampleRate: Double) {
        guard frameCount > 0 else { return }
        if preparedSampleRate != sampleRate {
            prepare(sampleRate: sampleRate)
        }

        let (threshold, lookahead, releaseCoef) = lock.withLock { params -> (Float, Int, Float) in
            (params.threshold, params.lookaheadSamples, params.releaseCoef)
        }
        let delay = min(lookahead, delayL.count - 1)

        switch (left, right) {
        case let (l?, r?):
            processStereo(l, r, frameCount: frameCount, threshold: threshold,
                          delay: delay, releaseCoef: releaseCoef)
        case let (l?, nil):
            processMono(l, frameCount: frameCount, threshold: threshold,
                        delay: delay, releaseCoef: releaseCoef)
        default:
            break
        }
    }

    /**
     Variante entrelacée : L, R, L, R… dans une seule ligne.

     Le traitement reste stéréo-lié : on lit les deux canaux de chaque frame avant
     d'écrire, ce qui évite d'appliquer deux enveloppes distinctes.
     */
    func processInterleaved(_ samples: UnsafeMutablePointer<Float>,
                            frameCount: Int, sampleRate: Double) {
        guard frameCount > 0 else { return }
        if preparedSampleRate != sampleRate {
            prepare(sampleRate: sampleRate)
        }

        let (threshold, lookahead, releaseCoef) = lock.withLock { params -> (Float, Int, Float) in
            (params.threshold, params.lookaheadSamples, params.releaseCoef)
        }
        let delay = min(lookahead, delayL.count - 1)
        let capacity = delayL.count

        for i in 0..<frameCount {
            let readIndex = (writeIndex + delay) % capacity
            let delayedL = delayL[readIndex]
            let delayedR = delayR[readIndex]
            let inL = samples[i * 2]
            let inR = samples[i * 2 + 1]

            let peak = max(abs(delayedL), abs(delayedR))
            let gain = requiredGain(peak: peak, threshold: threshold)

            if gain < envelope {
                envelope = gain
            } else {
                envelope += (gain - envelope) * releaseCoef
            }

            samples[i * 2] = delayedL * envelope
            samples[i * 2 + 1] = delayedR * envelope

            delayL[writeIndex] = inL
            delayR[writeIndex] = inR
            writeIndex += 1
            if writeIndex >= capacity { writeIndex = 0 }
        }
    }

    /**
     Applique le limiteur sur un tampon `AVAudioPCMBuffer`, en place.

     Cette variante alloue (via l'accès à `floatChannelData`) : elle est prévue
     pour les tests et les chemins hors rendu temps réel. Le chemin audio utilise
     `processChannels(left:right:frameCount:sampleRate:)`.

     - Parameters:
       - buffer: tampon d'entrée/sortie.
       - frameCount: nombre d'échantillons **par canal** à traiter.
     */
    func process(_ buffer: AVAudioPCMBuffer, frameCount: Int) {
        let channels = Int(buffer.format.channelCount)
        guard channels > 0, frameCount > 0,
              let channelData = buffer.floatChannelData else { return }

        let sampleRate = buffer.format.sampleRate

        // Changement de format : rare, et le seul endroit où le chemin audio est
        // autorisé à allouer.
        if preparedSampleRate != sampleRate {
            prepare(sampleRate: sampleRate)
        }

        // Une seule prise de verrou par tampon, comme prévu.
        let (threshold, lookahead, releaseCoef) = lock.withLock { params -> (Float, Int, Float) in
            (params.threshold, params.lookaheadSamples, params.releaseCoef)
        }
        let delay = min(lookahead, delayL.count - 1)

        if channels == 1 {
            processMono(channelData[0], frameCount: frameCount, threshold: threshold,
                        delay: delay, releaseCoef: releaseCoef)
        } else {
            processStereo(channelData[0], channelData[1], frameCount: frameCount,
                          threshold: threshold, delay: delay, releaseCoef: releaseCoef)
        }
    }

    /// Traitement stéréo-lié : le gain vient du canal le plus fort, ce qui évite
    /// que l'image ne « respire » quand un seul canal domine.
    private func processStereo(_ l: UnsafeMutablePointer<Float>,
                               _ r: UnsafeMutablePointer<Float>,
                               frameCount: Int, threshold: Float,
                               delay: Int, releaseCoef: Float) {
        let capacity = delayL.count

        for i in 0..<frameCount {
            // `writeIndex` pointe l'échantillon le plus ancien ; l'échantillon
            // retardé de `delay` échantillons est donc `delay` cases plus loin.
            let readIndex = (writeIndex + delay) % capacity
            let delayedL = delayL[readIndex]
            let delayedR = delayR[readIndex]
            let inL = l[i], inR = r[i]

            let peak = max(abs(delayedL), abs(delayedR))
            let gain = requiredGain(peak: peak, threshold: threshold)

            if gain < envelope {
                envelope = gain          // attaque : instantanée, grâce à l'avance
            } else {
                envelope += (gain - envelope) * releaseCoef
            }

            l[i] = delayedL * envelope
            r[i] = delayedR * envelope

            delayL[writeIndex] = inL
            delayR[writeIndex] = inR
            writeIndex += 1
            if writeIndex >= capacity { writeIndex = 0 }
        }
    }

    /// Variante mono : même algorithme, sans liaison stéréo.
    private func processMono(_ samples: UnsafeMutablePointer<Float>, frameCount: Int,
                             threshold: Float, delay: Int, releaseCoef: Float) {
        let capacity = delayL.count

        for i in 0..<frameCount {
            let readIndex = (writeIndex + delay) % capacity
            let delayed = delayL[readIndex]
            let inSample = samples[i]

            let gain = requiredGain(peak: abs(delayed), threshold: threshold)

            if gain < envelope {
                envelope = gain
            } else {
                envelope += (gain - envelope) * releaseCoef
            }

            samples[i] = delayed * envelope

            delayL[writeIndex] = inSample
            writeIndex += 1
            if writeIndex >= capacity { writeIndex = 0 }
        }
    }

    /**
     Gain linéaire à appliquer pour un pic de `peak` sous un seuil `threshold`.

     Ratio 1 au-dessus du seuil : la sortie atteint le seuil et ne le franchit
     jamais, quelle que soit l'entrée. C'est ce qui distingue un limiteur d'un
     compresseur, et c'est la garantie que l'étape 1 du correctif doit donner —
     sans elle, ce étage n'empêcherait pas l'écrêtage qu'il est censé supprimer.
     */
    @inline(__always)
    private func requiredGain(peak: Float, threshold: Float) -> Float {
        guard peak > 1e-6 else { return 1.0 }
        let db = 20.0 * log10f(peak)
        guard db > threshold else { return 1.0 }
        return powf(10.0, (threshold - db) / 20.0)
    }
}