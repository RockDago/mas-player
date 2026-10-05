import AVFoundation
import os

/**
 Étage de largeur stéréo — matrice Mid/Side, aligné sur `webAudioEngine.ts`.

 ## Pourquoi un bloc de rendu et pas un nœud système

 La matrice canonique de reconstruction est

     L' = M + S·w        avec  M = (L+R)/2,  S = (L-R)/2
     R' = M - S·w

 ce qui, une fois les gains de ligne aplatis, donne `L' = a·L + b·R` et
 `R' = b·L + a·R` avec `a = (1+w)/(2n)`, `b = (1-w)/(2n)` et `n = max(1, w)`.

 Élargir, c'est rendre `b` **négatif** : à w = 2.2 on obtient `b = -0.2727`. Or
 `AVAudioUnitMatrixMixer` ne documente que des volumes d'entrée et de sortie dans
 **0…1**, et ne donne aucun mécanisme d'inversion de phase. Aucun nœud système ne
 sait retourner un canal : `AVAudioUnitPan` déplace l'image, `AVAudioUnitEQ` travaille
 en dB sans changer le signe, et un délai ne l'inverse pas. Un étage « élargir » doit
 donc écrire les échantillons — d'où le bloc de rendu.

 **Ce que le bloc n'est pas** : une HRTF. Le Dolby Atmos est un format à objets sous
 licence ; ce qu'on peut livrer honnêtement ici est de l'**imagerie** — élargir la
 source stéréo au-delà de ses deux canaux d'origine. Le mot « HRTF » n'apparaît
 volontairement dans aucune interface.

 ## Le niveau

 Les valeurs singulières de `[[a,b],[b,a]]` sont `{a+b, a-b}`, soit `{1, 1}` avec la
 normalisation `n = max(1, w)` : le pic est **exactement 1 à toute largeur**.
 C'est le même calcul que la section 10 de `scripts/verify-dsp.cjs`.

 Avant correction, la normalisation ne portait que sur le Mid et le pic valait `w`,
 soit **+6.85 dBFS à width=100** : élargir l'image faisait monter le volume. Sur iOS
 le knob était ignoré (`_ = stereoExpansion`), donc le bug n'était pas audible —
 mais il l'aurait été dès la première implémentation.

 ## Interaction avec le crossfeed

 La largeur *écarte*, le crossfeed *rapproche*. Appliqués naivement, ils s'annulent :
 c'est pourquoi le crossfeed est borné à `0.15 · (1 - width/100)`, ce qui garantit
 que les deux réglages restent auditifs et qu'aucun ne peut annuler l'autre.

 ## Sûreté Swift 6

 Même discipline que `LimiterState` : les coefficients sont résolus par le thread de
 contrôle, stockés sous `OSAllocatedUnfairLock`, et copiés **une fois par tampon**.
 Le rendu ne fait ensuite que des multiplications — il ne lit aucun état partagé
 mutuel pendant la boucle, donc aucune course n'est possible même à l'intérieur d'un
 tampon.

 `AVAudioUnitRenderBlock` n'étant pas `@Sendable`, capturer `self` de classe compile
 sans diagnostic — c'est voulu plutôt que `nonisolated(unsafe)`, qui a déjà produit
 une famille d'erreurs dans ce projet.

 Aucune allocation dans le rendu.
 */
final class SpatialState {

    // MARK: - Constantes

    /// Largeur maximale : w = 1 + pct/100 × 1.2 donne w = 2.2 à 100 %.
    /// La même plage que le web, pour que le knob ait le même sens partout.
    private static let maxWidthExponent: Float = 1.2

    /// Gain de crossfeed maximal, avant pondération par la largeur.
    private static let maxCrossfeed: Float = 0.15

    // MARK: - Paramètres

    private struct Coeffs {
        /// Composante directe, a = (1+w)/(2n).
        var a: Float = 0.5
        /// Composante croisée, b = (1-w)/(2n). Négative : c'est elle qui élargit.
        var b: Float = 0.5
        /// Crossfeed, c ≤ 0.15.
        var c: Float = 0.0
        /// Vrai une fois qu'un réglage a été appliqué au moins une fois.
        var configured: Bool = false
    }

    private let lock = OSAllocatedUnfairLock(initialState: Coeffs())

    // MARK: - Réglages

    /**
     Applique largeur (0…100) et crossfeed (0…100) depuis le thread de contrôle.
     Le crossfeed est ici borné par `0.15 · (1 - width/100)` pour que les deux
     réglages ne s'annulent pas.
     */
    func setParameters(widthPercent: Float, crossfeedPercent: Float) {
        let wPct = max(0, min(100, widthPercent))
        let xPct = max(0, min(100, crossfeedPercent))

        let width = 1.0 + (wPct / 100) * Self.maxWidthExponent
        let normaliser = max(1, width)
        let a = (1.0 + width) / (2.0 * normaliser)
        let b = (1.0 - width) / (2.0 * normaliser)
        // Le crossfeed décroît avec la largeur : c'est la règle qui empêche
        // « élargir » et « rapprocher » de se neutraliser.
        let c = Self.maxCrossfeed * (xPct / 100) * (1.0 - wPct / 100)

        lock.withLock { coeffs in
            coeffs.a = a
            coeffs.b = b
            coeffs.c = c
            coeffs.configured = true
        }
    }

    // MARK: - Rendu

    /**
     Applique la matrice en place sur deux lignes de canal. N'alloue pas.

     Une seule prise de verrou, AVANT la boucle : le rendu ne relit l'état
     partagé à aucun moment pendant le traitement.

     - Parameters:
       - left: ligne gauche.
       - right: ligne droite.
     */
    func process(left: UnsafeMutablePointer<Float>,
                 right: UnsafeMutablePointer<Float>,
                 frameCount: Int) {
        guard frameCount > 0 else { return }

        let (a, b, c, configured) = lock.withLock { coeffs -> (Float, Float, Float, Bool) in
            (coeffs.a, coeffs.b, coeffs.c, coeffs.configured)
        }
        guard configured else { return }

        if c <= 0 {
            // Cas courant : crossfeed nul, une seule matrice 2×2.
            for i in 0..<frameCount {
                let l = left[i], r = right[i]
                left[i] = a * l + b * r
                right[i] = b * l + a * r
            }
        } else {
            // Crossfeed appliqué APRÈS reconstruction : le signal déjà élargi est
            // renvoyé partiellement vers l'autre oreille. L'appliquer avant
            // annulerait une partie de l'élargissement.
            for i in 0..<frameCount {
                let l = left[i], r = right[i]
                let wideL = a * l + b * r
                let wideR = b * l + a * r
                left[i] = wideL + c * wideR
                right[i] = wideR + c * wideL
            }
        }
    }

    /// Coefficients effectivement en vigueur, pour le diagnostic JS.
    func currentCoefficients() -> [String: Double] {
        lock.withLock { coeffs in
            ["a": Double(coeffs.a), "b": Double(coeffs.b), "c": Double(coeffs.c)]
        }
    }
}
