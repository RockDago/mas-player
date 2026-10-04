import AVFoundation
import Accelerate
import MediaPlayer

/**
 * Moteur audio iOS : égaliseur 10 bandes appliqué à un lecteur local.
 *
 * Chaîne du graphe, alignée sur le moteur web (`webAudioEngine.ts`) :
 *
 *   playerNode → AVAudioUnitEQ (10 bandes) → preamp → stereo → balance → limiteur → master
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

    /// Limiteur : seuil -3 dBFS, ratio 20 (mesuré, cf. scripts/verify-dsp.cjs).
    private static let limiterThreshold: Float = -3

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
    private let preamp = AVAudioUnitGain()
    private let balancePan = AVAudioUnitPan()
    private let limiter = AVAudioUnitDynamicsProcessor()
    private let master = AVAudioUnitGain()

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

    /// Rappel de progression : (position, durée, fin de piste).
    var onProgress: ((Double, Double, Bool) -> Void)?

    var trackTitle: String?
    var trackArtist: String?

    override init() {
        super.init()
        setupUnits()
        configureRemoteCommands()
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

        preamp.gain = 1
        balancePan.pan = 0
        master.gain = 1

        // Limiteur : seuil bas, ratio élevé, aucun attack/release audible.
        limiter.threshold = AudioDSPEngine.limiterThreshold
        limiter.headRoom = 0.1
        limiter.expansionThreshold = -80
        limiter.expansionRatio = 1
        limiter.attackTime = 0.002
        limiter.releaseTime = 0.12
        limiter.masterGain = 0

        engine.attach(playerNode)
        engine.attach(eqUnit)
        engine.attach(preamp)
        engine.attach(balancePan)
        engine.attach(limiter)
        engine.attach(master)
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
        engine.disconnectNodeOutput(preamp)
        engine.disconnectNodeOutput(balancePan)
        engine.disconnectNodeOutput(limiter)
        engine.disconnectNodeOutput(master)

        // L'ordre compte : EQ → préampli → balance → limiteur. Le préampli doit
        // rester avant le limiteur : c'est lui qui réserve la marge.
        engine.connect(playerNode, to: eqUnit, format: format)
        engine.connect(eqUnit, to: preamp, format: format)
        engine.connect(preamp, to: balancePan, format: format)
        engine.connect(balancePan, to: limiter, format: format)
        engine.connect(limiter, to: master, format: format)

        if isMono, let monoFormat = AVAudioFormat(standardFormatWithSampleRate: format.sampleRate,
                                                   channels: 1) {
            engine.connect(master, to: engine.mainMixerNode, format: monoFormat)
        } else {
            engine.connect(master, to: engine.mainMixerNode, format: format)
        }
    }

    // MARK: - Réglages

    /// Applique l'état DSP complet. Appelé à chaque changement de knob/fader.
    func apply(gains: [Float], preampDb: Float, balance: Float, mono: Bool,
              stereoExpansion: Float, enabled: Bool) {
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

        preamp.gain = pow(10, Double(preampDb) / 20)
        balancePan.pan = max(-1, min(1, balance))

        // Élargissement stéréo : `AVAudioUnitPan` ne sait que déplacer l'image,
        // et aucun nœud système n'a de réglage de largeur. Il faudrait un
        // traitement par échantillon, donc repasser par de l'ObjC (tap
        // MTAudioProcessingTap ou Audio Unit) — non fait ici. La valeur est
        // mémorisée, et reste neutre sur iOS.
        _ = stereoExpansion

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
        master.gain = max(0, min(1, value))
    }

    // MARK: - Lecture

    /// Charge un fichier déjà téléchargé et câble le graphe sur son format.
    func load(url: URL) throws {
        let file = try AVAudioFile(forReading: url)
        audioFile = file
        sampleRate = file.processingFormat.sampleRate

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
        apply(gains: pendingGains, preampDb: pendingPreamp, balance: pendingBalance,
              mono: isMono, stereoExpansion: stereoExpansion, enabled: eqEnabled)

        scheduleProgressUpdates()
    }

    func play() {
        guard let file = audioFile else { return }
        playerNode.stop()
        playerNode.scheduleFile(file, at: nil)
        playerNode.play()
        updateNowPlaying()
    }

    func pause() {
        playerNode.pause()
        updateNowPlaying()
    }

    func stop() {
        playerNode.stop()
    }

    var isPlaying: Bool { playerNode.isPlaying }

    var currentTime: Double {
        guard let renderTime = playerNode.lastRenderTime,
              let playerTime = playerNode.playerTime(forNodeTime: renderTime) else {
            return 0
        }
        return Double(playerTime.sampleTime) / playerTime.sampleRate
    }

    var duration: Double {
        guard let file = audioFile else { return 0 }
        return Double(file.length) / file.processingFormat.sampleRate
    }

    func seek(to seconds: Double) {
        guard let file = audioFile else { return }
        let sampleRate = file.processingFormat.sampleRate
        let frame = AVAudioFramePosition(seconds * sampleRate)
        let wasPlaying = playerNode.isPlaying

        playerNode.stop()
        let remaining = file.length - frame
        guard remaining > 0 else { return }
        playerNode.scheduleSegment(file, startingFrame: frame, frameCount: AVAudioFrameCount(remaining),
                                   at: nil)
        if wasPlaying {
            playerNode.play()
        }
        updateNowPlaying()
    }

    // MARK: - Progression

    private var progressTimer: Timer?

    /// `AVAudioPlayerNode` connaît le temps exact de lecture ; on se contente
    /// d'un timer lent pour notifier JS (l'autre option est un listener JS).
    private func scheduleProgressUpdates() {
        progressTimer?.invalidate()
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            let time = self.currentTime
            let total = self.duration
            let finished = total > 0 && time >= total - 0.05
            self.onProgress?(time, total, finished)
        }
        RunLoop.main.add(timer, forMode: .common)
        progressTimer = timer
    }

    // MARK: - Control Center / écran verrouillé

    /// Équivalent du `MediaController` d'expo-audio, qui n'accepte que son
    /// propre type `AudioPlayer` et ne peut donc pas piloter cette instance.
    private func configureRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()

        center.playCommand.addTarget { [weak self] _ in
            self?.play()
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            self?.pause()
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            if self.isPlaying { self.pause() } else { self.play() }
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self = self,
                  let positionEvent = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            self.seek(to: positionEvent.positionTime)
            return .success
        }
    }

    private func updateNowPlaying() {
        var info: [String: Any] = [
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentTime,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0
        ]
        info[MPMediaItemPropertyTitle] = trackTitle ?? "Lecture"
        if let artist = trackArtist {
            info[MPMediaItemPropertyArtist] = artist
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}

enum AudioDSPError: Exception {
    case engineStartFailed(String)
}