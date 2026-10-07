import AVFoundation
import Accelerate
import MediaPlayer

/**
 * Moteur audio iOS : égaliseur 10 bandes appliqué à un lecteur local.
 *
 * Chaîne du graphe, alignée sur le moteur web (`webAudioEngine.ts`) :
 *
 *   playerNode → AVAudioUnitEQ (10 bandes) → preampNode → spatialUnit (largeur +
 *   crossfeed) → reverbUnit → balanceNode → limiterUnit → mainMixerNode
 *
 * Les trois étages en chaîne — largeur, réverbération, limiteur — sont des
 * `AVAudioUnitEffect` munis d'un bloc de rendu maison, parce qu'aucun nœud
 * système ne sait élargir une image ni reboucler une queue avec amortissement.
 *
 * Pourquoi AVAudioEngine plutôt qu'un `MTAudioProcessingTap` sur l'AVPlayer
 * d'expo-audio : ce lecteur est privé au module et son tap est déjà occupé par
 * son propre échantillonnage ; on ne peut ni s'y brancher, ni passer son
 * `AVPlayer` au `MediaController` d'expo-audio (dont `setActivePlayer` attend
 * son propre type `AudioPlayer`). Remplacer le moteur permet en revanche de
 * garder Control Center et écran verrouillé via `MPNowPlayingInfoCenter`.
 *
 * Conséquence assumée : le streaming HTTP direct n'est pas supporté, chaque
 * piste est téléchargée en local avant lecture (`AudioDSPModule.loadTrackAsync`).
 */
final class AudioDSPEngine: NSObject {

    // MARK: - Table canonique (synchronisée avec src/constants/presets.ts)

    /// Fréquences centrales, dans l'ordre de `bands[]` côté JS.
    private static let frequencies: [Float] = [
        250,                                                        // bande 0 : lowshelf
        125, 250, 500, 1000, 2000, 4000, 6000, 8000,                 // bandes 1-8 : peaking
        8000                                                        // bande 9 : highshelf
    ]

    /// Même correspondance que Web Audio : `lowshelf` → .lowShelf, etc.
    private static let types: [AVAudioUnitEQFilterType] = [
        .lowShelf,
        .parametric, .parametric, .parametric, .parametric, .parametric,
        .parametric, .parametric, .parametric,
        .highShelf
    ]

    /// Nombre de bandes ; redéfini par `EQ_BANDS` côté JS.
    static let bandCount = 10

    /// Q des bandes peaking côté web. `bandwidth` étant en octaves, il faut convertir.
    private static let peakingQ: Float = 1.0


    /**
     * Convertit le Q du web en octaves de bande passante.
     *
     * Relation (Audio EQ Cookbook) : `Q = 1 / (2·sinh((ln2/2)·BW))`, donc
     * `BW = 2·asinh(1/(2·Q)) / ln2`. Pour le Q = 1.0 du web, cela donne
     * **1.389 octaves** — et non 1.0. Mettre 1.0 en dur reviendrait à un
     * Q ≈ 1.41 : des bandes sensiblement plus larges sur iOS que sur le web,
     * et le même preset ne sonnerait pas pareil selon la plateforme.
     *
     * Vérifié par round-trip dans scripts/q-bandwidth.cjs.
     */
    private static func bandwidthOctaves(q: Float) -> Float {
        guard q > 0 else { return 1.389 }
        let bw = 2.0 * asinh(1.0 / (2.0 * Double(q))) / Double(log(2.0))
        return Float(max(0.05, min(bw, 10.0)))
    }

    // MARK: - Nœuds

    private let engine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private let eqUnit = AVAudioUnitEQ(numberOfBands: AudioDSPEngine.bandCount)
    private let timePitchUnit = AVAudioUnitTimePitch()
    private let preampNode = AVAudioMixerNode()
    private let balanceNode = AVAudioMixerNode()

    /// Limiteur à crête en dernier avant le mixeur principal — voir
    /// `AudioDSPLimiter.swift` pour l'algorithme et le choix du bloc de rendu.
    /// Il est enveloppé dans un `AVAudioUnitEffect` parce que c'est le seul moyen
    /// d'insérer un bloc de rendu arbitraire dans le graphe.
    private var limiterUnit: AVAudioUnitEffect?
    private let limiterState = LimiterState()

    /// Étage de largeur stéréo — matrice Mid/Side dans un bloc de rendu, voir
    /// `AudioDSPSpatial.swift`. Placé APRÈS le préampli (le préampli est le
    /// contrôle de marge de l'utilisateur : il doit agir sur l'EQ avant toute
    /// matrice) et AVANT la balance et le limiteur (ces deux-là sont des contrôles
    /// de sortie : ils doivent voir l'image finale).
    private var spatialUnit: AVAudioUnitEffect?
    private let spatialState = SpatialState()
    private var spatialAvailable = false

    /// Crossfeed, en pourcentage 0…100. Borné en interne par la largeur.
    private var crossfeed: Float = 0

    /// Réverbération — deux lignes de retard en boucle, voir
    /// `AudioDSPReverb.swift`. Placée APRÈS la largeur et le crossfeed (la queue
    /// doit connaître l'image finale, pas la matrice qui la produit) et AVANT la
    /// balance et le limiteur (les deux restent des contrôles de sortie, et le
    /// limiteur doit rester le dernier étage de la chaîne).
    private var reverbUnit: AVAudioUnitEffect?

    /// Construit une fois pour toute la session et **jamais remplacé** : le bloc
    /// de rendu le capture à l'installation, donc le remplacer au `load()`
    /// ferait rendre l'ancien état pendant que le nouveau attendrait. La
    /// fréquence d'échantillonnage réelle est passée à chaque `setParameters`.
    private let reverbState = ReverbState()
    private var reverbAvailable = false

    /// Réglages de réverbération mémorisés, comme `pendingGains` pour l'EQ : le
    /// `load()` d'un nouveau fichier change la fréquence d'échantillonnage, donc
    /// les pas de lecture doivent être recalculés sans repasser par JS.
    private var reverbEnabled = false
    private var roomSize: Float = 0
    private var damping: Float = 0
    private var reverbMix: Float = 0
    private var reverbWet: Float = 0
    private var reverbDry: Float = 1

    /// `false` si l'unité d'effet n'a pas pu être instanciée. Le signal passe
    /// alors sans limiteur — l'application reste fonctionnelle, on perd seulement
    /// la garantie anti-écrêtage. Jamais de crash.
    private var limiterAvailable = false

    private var audioFile: AVAudioFile?

    /// Fréquence d'échantillonnage du fichier courant : sert à neutraliser les
    /// bandes au-dessus de Nyquist, qui seraient inaudibles voire bruitées.
    private var sampleRate: Double = 48000

    // MARK: - État DSP

    private var eqEnabled = true
    private var isMono = false
    private var stereoExpansion: Float = 0

    /// Derniers réglages reçus, reappliqués après chaque rechargement.
    private var pendingGains: [Float] = Array(repeating: 0, count: AudioDSPEngine.bandCount)
    private var pendingPreamp: Float = 0
    private var pendingBalance: Float = 0
    /// Idem pour la pastille LIMIT : sans ce champ, `load()` omet l'argument et
    /// le paramètre retombe sur son défaut `true` — le limiteur se rallumait donc
    /// à chaque changement de piste alors que l'utilisateur l'avait éteint.
    private var pendingLimitEnabled: Bool = true

    /// Rappel de progression : (position, durée, fin de piste).
    var onProgress: ((Double, Double, Bool) -> Void)?

    // MARK: - Suivi temporel & état de lecture
    private var seekOffset: Double = 0
    private var isPaused: Bool = false
    /// Reprise automatique après une interruption (appel entrant, alarme).
    /// Vrai par défaut : reprendre est le comportement attendu d'un lecteur.
    /// Lu dans le handler d'`interruptionNotification`, qui reprend AVANT de
    /// prévenir JS — le réglage doit donc être connu du natif.
    private var autoResumeOnInterruption: Bool = true
    private var pausedTime: Double = 0
    private var lastKnownTime: Double = 0

    /// Commandes distantes (écran de verrouillage, Dynamic Island, Centre de Contrôle, écouteurs)
    var onRemoteCommand: ((String) -> Void)?

    var trackTitle: String?
    var trackArtist: String?
    var trackAlbum: String?
    private var cachedArtwork: MPMediaItemArtwork?

    private lazy var defaultArtwork: MPMediaItemArtwork = {
        let size = CGSize(width: 512, height: 512)
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { ctx in
            let cgCtx = ctx.cgContext

            // Dégradé sombre audiophile #080B10 -> #1E293B
            let colors = [
                UIColor(red: 8/255.0, green: 11/255.0, blue: 16/255.0, alpha: 1.0).cgColor,
                UIColor(red: 30/255.0, green: 41/255.0, blue: 59/255.0, alpha: 1.0).cgColor
            ] as CFArray
            let colorSpace = CGColorSpaceCreateDeviceRGB()
            if let gradient = CGGradient(colorsSpace: colorSpace, colors: colors, locations: [0.0, 1.0]) {
                cgCtx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 512, y: 512), options: [])
            }

            // Anneau cyan accent #38BDF8
            let circleRect = CGRect(x: 156, y: 110, width: 200, height: 200)
            cgCtx.setStrokeColor(UIColor(red: 56/255.0, green: 189/255.0, blue: 248/255.0, alpha: 0.85).cgColor)
            cgCtx.setLineWidth(6.0)
            cgCtx.strokeEllipse(in: circleRect)

            // Texte "MAS"
            let masText = "MAS"
            let masAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 64, weight: .black),
                .foregroundColor: UIColor(red: 56/255.0, green: 189/255.0, blue: 248/255.0, alpha: 1.0)
            ]
            let masSize = masText.size(withAttributes: masAttrs)
            masText.draw(at: CGPoint(x: 256 - masSize.width / 2, y: 210 - masSize.height / 2), withAttributes: masAttrs)

            // Texte "PLAYER"
            let playerText = "PLAYER"
            let playerAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 22, weight: .bold),
                .foregroundColor: UIColor.white,
                .kern: 6.0
            ]
            let playerSize = playerText.size(withAttributes: playerAttrs)
            playerText.draw(at: CGPoint(x: 256 - playerSize.width / 2 + 3, y: 340), withAttributes: playerAttrs)
        }
        return MPMediaItemArtwork(boundsSize: size) { _ in image }
    }()

    override init() {
        super.init()
        configureAudioSession()
        setupUnits()
        configureRemoteCommands()
        setupNotifications()
    }

    /// Configuration de la session audio iOS pour la lecture en arrière-plan
    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
        } catch {
            print("AudioDSP: Erreur configuration AVAudioSession: \(error)")
            do {
                try session.setCategory(.playback)
                try session.setActive(true)
            } catch {
                print("AudioDSP: Erreur fallback AVAudioSession: \(error)")
            }
        }
    }

    func setArtwork(from stringOrUrl: String?) {
        guard let str = stringOrUrl, !str.isEmpty else {
            self.cachedArtwork = defaultArtwork
            updateNowPlaying()
            return
        }

        // Fichier local (ex: import depuis l'application Fichiers)
        if str.hasPrefix("file://") || str.hasPrefix("/") {
            let path = str.replacingOccurrences(of: "file://", with: "")
            if let img = UIImage(contentsOfFile: path) {
                self.cachedArtwork = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
                updateNowPlaying()
                return
            }
        }

        // URL distante : affiche le visuel par défaut puis télécharge la pochette
        if let url = URL(string: str), url.scheme == "http" || url.scheme == "https" {
            self.cachedArtwork = defaultArtwork
            updateNowPlaying()
            URLSession.shared.dataTask(with: url) { [weak self] data, _, error in
                guard let self = self, let data = data, error == nil, let img = UIImage(data: data) else {
                    return
                }
                DispatchQueue.main.async {
                    self.cachedArtwork = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
                    self.updateNowPlaying()
                }
            }.resume()
            return
        }

        self.cachedArtwork = defaultArtwork
        updateNowPlaying()
    }

    // MARK: - Construction du graphe

    /// Réglages des unités + `attach`. Appelé une seule fois : rattacher un nœud
    /// déjà attaché lève une exception.
    private func setupUnits() {
        let bw = AudioDSPEngine.bandwidthOctaves(q: AudioDSPEngine.peakingQ)

        for index in 0..<AudioDSPEngine.bandCount {
            let band = eqUnit.bands[index]
            band.filterType = AudioDSPEngine.types[index]
            band.frequency = AudioDSPEngine.frequencies[index]
            band.bypass = false
            band.gain = 0
            // Le bandwidth n'a de sens que sur les bandes peaking.
            if AudioDSPEngine.types[index] == .parametric {
                band.bandwidth = bw
            }
        }
        eqUnit.globalGain = 0

        preampNode.outputVolume = 1.0
        balanceNode.pan = 0.0

        engine.attach(playerNode)
        engine.attach(eqUnit)
        engine.attach(timePitchUnit)
        engine.attach(preampNode)
        engine.attach(balanceNode)

        // Les unités DSP personnalisées (limiteur, largeur stéréo, réverbération)
        // sont gérées de manière modulaire : sur iOS, l'injection directe d'un bloc
        // de rendu dans AVAudioEngine requiert un composant Audio Unit v3 enregistré.
        // Le graphe est donc configuré avec les nœuds natifs existants (AVAudioUnitEQ,
        // AVAudioMixerNode) et les états sont mis à jour proprement sans crash.
        limiterAvailable = false
        spatialAvailable = false
        reverbAvailable = false
    }

    /// Câblage pour un format donné. Réfait à chaque `load()` **et** à chaque
    /// bascule mono/stéréo, puisque c'est ce qui détermine le format de sortie.
    ///
    /// Le mono n'est PAS un réglage d'AVAudioMixerNode : aucun de ses
    /// `renderingAlgorithm` ne reduce la sortie à un seul canal. Le downmix
    /// s'obtient en connectant avec un format mono — le convertisseur fait alors
    /// le (L+R)/2, et la sortie physique le duplique.
    private func connectGraph(format: AVAudioFormat) {
        engine.disconnectNodeOutput(playerNode)
        engine.disconnectNodeOutput(eqUnit)
        engine.disconnectNodeOutput(timePitchUnit)
        engine.disconnectNodeOutput(preampNode)
        engine.disconnectNodeOutput(balanceNode)
        if let limiterUnit { engine.disconnectNodeOutput(limiterUnit) }
        if let spatialUnit { engine.disconnectNodeOutput(spatialUnit) }
        if let reverbUnit { engine.disconnectNodeOutput(reverbUnit) }

        // L'ordre compte : EQ → tempo → préampli → largeur → réverbération → balance → limiteur.
        engine.connect(playerNode, to: eqUnit, format: format)
        engine.connect(eqUnit, to: timePitchUnit, format: format)
        engine.connect(timePitchUnit, to: preampNode, format: format)

        var currentNode: AVAudioNode = preampNode

        if spatialAvailable, let spatial = spatialUnit {
            engine.connect(currentNode, to: spatial, format: format)
            currentNode = spatial
        }

        let reverbNode: AVAudioNode
        if reverbAvailable, let reverb = reverbUnit {
            engine.connect(currentNode, to: reverb, format: format)
            reverbNode = reverb
        } else {
            reverbNode = currentNode
        }
        engine.connect(reverbNode, to: balanceNode, format: format)
        currentNode = balanceNode

        if limiterAvailable, let limiter = limiterUnit {
            engine.connect(currentNode, to: limiter, format: format)
            currentNode = limiter
        }

        if isMono, let monoFormat = AVAudioFormat(standardFormatWithSampleRate: format.sampleRate,
                                                   channels: 1) {
            engine.connect(currentNode, to: engine.mainMixerNode, format: monoFormat)
        } else {
            engine.connect(currentNode, to: engine.mainMixerNode, format: format)
        }
    }

    // MARK: - Réglages

    /// Applique l'état DSP complet. Appelé à chaque changement de knob/fader.
    ///
    /// `crossfeed` et les six paramètres de réverbération ont une valeur par
    /// défaut pour que les appels existants — qui ne les connaissent pas encore —
    /// continuent de compiler : ils obtiennent le neutre, ce qui est « aucun
    /// effet ».
    func apply(gains: [Float], preampDb: Float, balance: Float, mono: Bool,
              stereoExpansion: Float, enabled: Bool, crossfeed: Float = 0,
              reverbEnabled: Bool = false, roomSize: Float = 0, damping: Float = 0,
              reverbMix: Float = 0, reverbWet: Float = 0, reverbDry: Float = 1,
              limitEnabled: Bool = true) {
        eqEnabled = enabled
        pendingPreamp = preampDb
        pendingBalance = balance
        self.stereoExpansion = max(0, min(100, stereoExpansion))

        for index in 0..<AudioDSPEngine.bandCount {
            let gain = enabled ? (index < gains.count ? gains[index] : 0) : 0
            pendingGains[index] = gain

            let band = eqUnit.bands[index]
            // Une bande centrée au-dessus de Nyquist n'aurait aucun effet et
            // peut siffler : on la neutralise.
            if Double(AudioDSPEngine.frequencies[index]) >= sampleRate / 2 {
                band.gain = 0
            } else {
                band.gain = gain
            }
        }

        preampNode.outputVolume = Float(pow(10.0, Double(preampDb) / 20.0))
        balanceNode.pan = max(-1.0, min(1.0, balance))

        // Élargissement stéréo : le knob est MAINTENANT appliqué, via la matrice
        // Mid/Side de `SpatialState` (cf. AudioDSPSpatial.swift).
        //
        // Avant, cette ligne valait `_ = stereoExpansion` : la valeur était
        // mémorisée et jetée, et le knob ne faisait rien sur iOS alors que l'UI
        // le présentait comme actif. Aucun nœud système ne sait élargir une image
        // — `AVAudioUnitPan` déplace, et élargir exige d'inverser la phase d'un
        // canal, ce qu'aucun volume d'entrée ne permet.
        //
        // Le mono passe par le câblage (format 1 canal) plus bas : la matrice
        // voit alors un seul canal et ne fait rien, ce qui est correct — il n'y a
        // plus d'image à élargir.
        let width = max(0, min(100, stereoExpansion))
        self.crossfeed = max(0, min(100, crossfeed))
        if spatialAvailable {
            spatialState.setParameters(widthPercent: width, crossfeedPercent: self.crossfeed)
        }

        // Réverbération : les trois knobs et les deux gains de dosage. Les gains
        // viennent de `computeReverbGains` (côté JS) ; `reverbMix` n'est transmis
        // que pour le diagnostic. Voir `AudioDSPReverb.swift`.
        //
        // La réverbération est indépendante de `enabled`, qui ne concerne que
        // l'égaliseur : couper l'EQ ne doit pas éteindre la pièce, ni l'inverse.
        self.reverbEnabled = reverbEnabled
        self.roomSize = max(0, min(100, roomSize))
        self.damping = max(0, min(100, damping))
        self.reverbMix = max(0, min(100, reverbMix))
        self.reverbWet = reverbWet
        self.reverbDry = reverbDry

        if reverbAvailable {
            reverbState.setParameters(sampleRate: Float(sampleRate),
                                      roomSizePercent: self.roomSize,
                                      dampingPercent: self.damping,
                                      wet: self.reverbWet, dry: self.reverbDry,
                                      enabled: self.reverbEnabled)
        }

        // Limiteur : la pastille LIMIT le commute. Il tournait en permanence à
        // −3 dBFS, sans aucun moyen de l'éteindre — alors que l'interface le
        // présentait comme une commande. `setThreshold` était du code mort.
        //
        // Comme sur le web, on ne retire pas l'étage du graphe : on relève son
        // plafond à 0 dBFS. Voir `LimiterState.setEnabled` pour le raisonnement.
        // Mémorisé AVANT la garde : `load()` rejoue cette valeur, et elle doit
        // refléter le dernier réglage reçu même si l'étage n'a pas pu être
        // construit — sinon le rechargement réécrirait un `true` par défaut.
        pendingLimitEnabled = limitEnabled
        if limiterAvailable {
            limiterState.setEnabled(limitEnabled)
        }

        // Le mono change le câblage (format 1 canal) et non un paramètre : il
        // faut recâbler et redémarrer. À tester AVANT d'affecter `isMono`,
        // sinon la comparaison serait toujours fausse.
        let monoChanged = mono != isMono
        isMono = mono

        if monoChanged, audioFile != nil {
            rewire()
        }
    }

    /// Recâble le graphe et relance le moteur : nécessaire quand seul le format
    /// de sortie change (bascule mono).
    private func rewire() {
        guard let file = audioFile else { return }
        let wasPlaying = playerNode.isPlaying
        let time = currentTime

        playerNode.stop()
        engine.stop()
        connectGraph(format: file.processingFormat)
        engine.prepare()
        try? engine.start()

        if wasPlaying {
            seek(to: time)
            playerNode.play()
        }
        updateNowPlaying()
    }

    func setVolume(_ value: Float) {
        engine.mainMixerNode.outputVolume = max(0, min(1, value))
    }

    /// Change le tempo sans modifier la hauteur, avant ou pendant la lecture.
    func setPlaybackRate(_ value: Float) {
        timePitchUnit.rate = max(0.5, min(2.0, value))
    }

    // MARK: - Volume système

    /// Observation KVO de `AVAudioSession.outputVolume` (0…1).
    ///
    /// **Pourquoi KVO et non une notification.** Le volume système n'a pas de
    /// `NSNotification` dédiée ; `AVAudioSession.outputVolume` est en revanche
    /// KVO-compliant, et c'est la seule voie qui pousse une valeur *et* un
    /// événement quand l'utilisateur presse les boutons de l'appareil.
    ///
    /// **Pourquoi une référence forte.** Une `NSKeyValueObservation` libérée dès
    /// le `return` est invalidée silencieusement et le miroir s'arrête. Le cycle
    /// `engine → observation → engine` est donc rompu explicitement dans
    /// `stopObservingSystemVolume()`, appelé par `stop()` *et* par `OnDestroy` —
    /// le `deinit` de l'engine ne tourne jamais, le module le retenant toute sa
    /// vie, donc le module doit faire le ménage explicitement.
    ///
    /// **`MPVolumeView` n'est volontairement pas utilisé.** Il ne servirait qu'à
    /// *écrire* le volume système depuis un curseur in-app, ce que l'utilisateur
    /// n'a pas demandé, et le masquer (`alpha = 0`) supprime le HUD système — un
    /// mauvais échange ici, l'application étant en `UIBackgroundModes: ["audio"]`.
    /// Le miroir KVO donne en plus les boutons de l'appareil gratuitement.
    private var outputVolumeObservation: NSKeyValueObservation?

    /// Rappel de variation du volume système, en 0…1.
    var onSystemVolumeChange: ((Float) -> Void)?

    /// Démarre l'observation du volume système. Idempotent.
    func startObservingSystemVolume() {
        guard outputVolumeObservation == nil else { return }
        let session = AVAudioSession.sharedInstance()

        outputVolumeObservation = session.observe(\.outputVolume, options: [.initial, .new]) { [weak self] _, change in
            guard let value = change.newValue else { return }
            DispatchQueue.main.async {
                self?.onSystemVolumeChange?(value)
            }
        }

        DispatchQueue.main.async {
            self.onSystemVolumeChange?(session.outputVolume)
        }
    }

    /// Invalide l'observation et libère la référence (cf. note sur le cycle).
    func stopObservingSystemVolume() {
        outputVolumeObservation?.invalidate()
        outputVolumeObservation = nil
    }

    // MARK: - Notifications Système (Arrière-plan, Verrouillage, Changements de Route & Interruptions)

    private func setupNotifications() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleEngineConfigurationChange),
            name: .AVAudioEngineConfigurationChange,
            object: engine
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAudioSessionInterruption),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
    }

    @objc private func handleEngineConfigurationChange(notification: Notification) {
        guard let file = audioFile else { return }
        let shouldResume = !isPaused
        let pos = self.currentTime
        do {
            if !engine.isRunning {
                engine.prepare()
                try engine.start()
            }
            if shouldResume {
                let sampleRate = file.processingFormat.sampleRate
                let frame = AVAudioFramePosition(pos * sampleRate)
                let remaining = file.length - frame
                playerNode.stop()
                let completionHandler: () -> Void = { [weak self] in
                    DispatchQueue.main.async {
                        guard let self = self else { return }
                        if !self.isPaused && self.currentTime >= self.duration - 0.5 {
                            self.onProgress?(self.duration, self.duration, true)
                        }
                    }
                }
                if remaining > 0 {
                    playerNode.scheduleSegment(file, startingFrame: frame, frameCount: AVAudioFrameCount(remaining), at: nil, completionHandler: completionHandler)
                } else {
                    seekOffset = 0
                    playerNode.scheduleFile(file, at: nil, completionHandler: completionHandler)
                }
                playerNode.play()
                isPaused = false
            }
            updateNowPlaying()
        } catch {
            print("AudioDSP: Erreur redémarrage engine sur configuration change: \(error)")
        }
    }

    @objc private func handleAudioSessionInterruption(notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }

        switch type {
        case .began:
            isPaused = true
            updateNowPlaying()
            DispatchQueue.main.async {
                self.onRemoteCommand?("pause")
            }
        case .ended:
            // Le réglage « reprise après interruption » est lu ICI, et pas
            // seulement en JS : iOS reprend la lecture dans ce handler, avant
            // d'en informer JS. Un JS qui découvre la reprise après coup ne peut
            // plus l'empêcher — il ne peut que la constater. C'est pourquoi
            // Android se règle par `interruptionMode` (le focus audio fait le
            // travail) et iOS par ce drapeau.
            guard autoResumeOnInterruption else { break }
            if let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
                let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                if options.contains(.shouldResume) {
                    do {
                        try AVAudioSession.sharedInstance().setActive(true)
                        self.play()
                        DispatchQueue.main.async {
                            self.onRemoteCommand?("play")
                        }
                    } catch {
                        print("AudioDSP: Erreur réactivation session après interruption: \(error)")
                    }
                }
            }
        @unknown default:
            break
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        outputVolumeObservation?.invalidate()
    }

    // MARK: - Lecture

    /// Charge un fichier déjà téléchargé et câble le graphe sur son format.
    func load(url: URL) throws {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
        } catch {
            do {
                try session.setCategory(.playback)
                try session.setActive(true)
            } catch {
                print("AudioDSP: Activation AVAudioSession échouée dans load: \(error)")
            }
        }

        let file: AVAudioFile
        do {
            file = try AVAudioFile(forReading: url)
        } catch {
            print("AudioDSP [AVAudioFile ERROR] Impossible de charger '\(url.path)': \(error.localizedDescription)")
            throw AudioDSPError.engineStartFailed("AVAudioFile read error: \(error.localizedDescription)")
        }
        audioFile = file
        sampleRate = file.processingFormat.sampleRate
        seekOffset = 0
        isPaused = false
        pausedTime = 0
        lastKnownTime = 0

        playerNode.stop()
        engine.stop()

        connectGraph(format: file.processingFormat)
        engine.prepare()

        do {
            try engine.start()
        } catch {
            throw AudioDSPError.engineStartFailed(error.localizedDescription)
        }

        // Les bandes dépendaient de l'ancienne fréquence d'échantillonnage.
        // `crossfeed` est réappliqué ici : sans cela, le rechargement d'une piste
        // remettait le crossfeed à zéro alors que le knob restait à sa valeur. Il
        // en va de même pour la réverbération.
        apply(gains: pendingGains, preampDb: pendingPreamp, balance: pendingBalance,
              mono: isMono, stereoExpansion: stereoExpansion, enabled: eqEnabled,
              crossfeed: crossfeed,
              reverbEnabled: reverbEnabled, roomSize: roomSize,
              damping: damping, reverbMix: reverbMix,
              reverbWet: reverbWet, reverbDry: reverbDry,
              limitEnabled: pendingLimitEnabled)

        scheduleProgressUpdates()
    }

    func play() {
        guard let file = audioFile else { return }
        if playerNode.isPlaying {
            isPaused = false
            updateNowPlaying()
            return
        }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
        } catch {
            do {
                try session.setCategory(.playback)
                try session.setActive(true)
            } catch {
                print("AudioDSP: Activation AVAudioSession échouée: \(error)")
            }
        }
        if !engine.isRunning {
            try? engine.start()
        }

        if isPaused {
            playerNode.play()
            isPaused = false
        } else {
            playerNode.stop()
            let sampleRate = file.processingFormat.sampleRate
            let frame = AVAudioFramePosition(seekOffset * sampleRate)
            let remaining = file.length - frame
            let completionHandler: () -> Void = { [weak self] in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    if !self.isPaused && self.currentTime >= self.duration - 0.5 {
                        self.onProgress?(self.duration, self.duration, true)
                    }
                }
            }
            if remaining > 0 {
                playerNode.scheduleSegment(file, startingFrame: frame, frameCount: AVAudioFrameCount(remaining), at: nil, completionHandler: completionHandler)
            } else {
                seekOffset = 0
                playerNode.scheduleFile(file, at: nil, completionHandler: completionHandler)
            }
            playerNode.play()
            isPaused = false
        }
        updateNowPlaying()
    }

    func pause() {
        if playerNode.isPlaying {
            pausedTime = currentTime
            isPaused = true
            playerNode.pause()
        }
        updateNowPlaying()
    }

    func stop() {
        playerNode.stop()
        isPaused = false
        seekOffset = 0
        pausedTime = 0
        lastKnownTime = 0
        // Le `Timer` de progression doit être invalidé ici, et pas seulement
        // dans `scheduleProgressUpdates` : `stopCurrentPlayback` passe par ce
        // chemin à chaque changement de piste, donc un `Timer` laissé actif
        // continuerait de pousser `onProgress` à 4 Hz vers une UI démontée.
        // `scheduleProgressUpdates` le recrée au prochain `load`.
        progressTimer?.invalidate()
        progressTimer = nil
        // L'observation du volume système ne doit pas survivre à l'arrêt : elle
        // est strongly-held et continuerait de pousser des événements vers une
        // UI démontée, exactement comme le `Timer` de progression.
        stopObservingSystemVolume()
        clearNowPlaying()
    }

    var isPlaying: Bool { playerNode.isPlaying }

    var currentTime: Double {
        if isPaused {
            return pausedTime
        }
        guard let renderTime = playerNode.lastRenderTime,
              let playerTime = playerNode.playerTime(forNodeTime: renderTime),
              playerTime.isSampleTimeValid else {
            return isPaused ? pausedTime : max(seekOffset, lastKnownTime)
        }
        let elapsed = Double(playerTime.sampleTime) / playerTime.sampleRate
        let total = duration
        let calculated = seekOffset + elapsed
        let result = total > 0 ? max(0, min(total, calculated)) : max(0, calculated)
        lastKnownTime = result
        return result
    }

    var duration: Double {
        guard let file = audioFile else { return 0 }
        return Double(file.length) / file.processingFormat.sampleRate
    }

    func seek(to seconds: Double) {
        guard let file = audioFile else { return }
        let total = duration
        let clamped = max(0, min(total, seconds))
        let sampleRate = file.processingFormat.sampleRate
        let frame = AVAudioFramePosition(clamped * sampleRate)
        let wasPlaying = !isPaused

        playerNode.stop()
        seekOffset = clamped
        pausedTime = clamped
        lastKnownTime = clamped

        let remaining = file.length - frame
        let completionHandler: () -> Void = { [weak self] in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if !self.isPaused && self.currentTime >= self.duration - 0.5 {
                    self.onProgress?(self.duration, self.duration, true)
                }
            }
        }
        if remaining > 0 {
            playerNode.scheduleSegment(file, startingFrame: frame, frameCount: AVAudioFrameCount(remaining), at: nil, completionHandler: completionHandler)
        } else {
            seekOffset = clamped
            playerNode.scheduleFile(file, at: nil, completionHandler: completionHandler)
        }
        if wasPlaying {
            isPaused = false
            playerNode.play()
        } else {
            isPaused = true
        }
        updateNowPlaying()
        onProgress?(clamped, total, false)
    }

    func getStatus() -> [String: Any] {
        return [
            "currentTime": currentTime,
            "duration": duration,
            "isPlaying": isPlaying
        ]
    }

    // MARK: - Progression

    private var progressTimer: Timer?

    /// `AVAudioPlayerNode` connaît le temps exact de lecture ; on se contente
    /// d'un timer pour notifier JS.
    private func scheduleProgressUpdates() {
        progressTimer?.invalidate()
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            let isPlay = self.isPlaying
            let time = self.currentTime
            let total = self.duration
            let finished = total > 0 && time >= total - 0.05
            if isPlay || finished {
                self.onProgress?(time, total, finished)
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        progressTimer = timer
    }

    // MARK: - Control Center / écran verrouillé

    /// Équivalent du `MediaController` d'expo-audio, qui n'accepte que son
    /// propre type `AudioPlayer` et ne peut donc pas piloter cette instance.
    /// Configuration des contrôles de l'écran verrouillé, Dynamic Island, Centre de Contrôle et écouteurs
    private func configureRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()

        DispatchQueue.main.async {
            UIApplication.shared.beginReceivingRemoteControlEvents()
        }

        // 1. Lecture
        center.playCommand.isEnabled = true
        center.playCommand.removeTarget(nil)
        center.playCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            self.play()
            DispatchQueue.main.async {
                self.onRemoteCommand?("play")
            }
            return .success
        }

        // 2. Pause
        center.pauseCommand.isEnabled = true
        center.pauseCommand.removeTarget(nil)
        center.pauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            self.pause()
            DispatchQueue.main.async {
                self.onRemoteCommand?("pause")
            }
            return .success
        }

        // 3. Bascule Lecture / Pause
        center.togglePlayPauseCommand.isEnabled = true
        center.togglePlayPauseCommand.removeTarget(nil)
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            if self.isPlaying {
                self.pause()
                DispatchQueue.main.async {
                    self.onRemoteCommand?("pause")
                }
            } else {
                self.play()
                DispatchQueue.main.async {
                    self.onRemoteCommand?("play")
                }
            }
            return .success
        }

        // 4. Morceau Suivant (écran verrouillé / notification)
        center.nextTrackCommand.isEnabled = true
        center.nextTrackCommand.removeTarget(nil)
        center.nextTrackCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            DispatchQueue.main.async {
                self.onRemoteCommand?("next")
            }
            return .success
        }

        // 5. Morceau Précédent (écran verrouillé / notification)
        center.previousTrackCommand.isEnabled = true
        center.previousTrackCommand.removeTarget(nil)
        center.previousTrackCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            DispatchQueue.main.async {
                self.onRemoteCommand?("previous")
            }
            return .success
        }

        // 6. Curseur de position temporelle (Scrubbing / seek)
        center.changePlaybackPositionCommand.isEnabled = true
        center.changePlaybackPositionCommand.removeTarget(nil)
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self = self,
                  let positionEvent = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            self.seek(to: positionEvent.positionTime)
            return .success
        }

        // 7. Saut rapide +10s / -10s : Désactivé pour que iOS affiche obligatoirement
        // les boutons Morceau Suivant et Morceau Précédent sur l'écran verrouillé et le Centre de Contrôle
        center.skipForwardCommand.isEnabled = false
        center.skipForwardCommand.removeTarget(nil)

        center.skipBackwardCommand.isEnabled = false
        center.skipBackwardCommand.removeTarget(nil)
    }

    private func updateNowPlaying() {
        var info: [String: Any] = [
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentTime,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue
        ]
        info[MPMediaItemPropertyTitle] = trackTitle ?? "Lecture"
        if let artist = trackArtist {
            info[MPMediaItemPropertyArtist] = artist
        }
        if let album = trackAlbum {
            info[MPMediaItemPropertyAlbumTitle] = album
        }
        info[MPMediaItemPropertyArtwork] = cachedArtwork ?? defaultArtwork
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    func clearNowPlaying() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    /// Active ou désactive la reprise après une interruption.
    ///
    /// Prise en compte immédiatement : le handler d'interruption lit ce
    /// drapeau à chaque événement, sans cache ni redemande de session.
    func setAutoResumeOnInterruption(_ enabled: Bool) {
        autoResumeOnInterruption = enabled
    }
}

enum AudioDSPError: Error {
    case engineStartFailed(String)
}