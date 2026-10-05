import CryptoKit
import ExpoModulesCore
import Foundation

/**
 * Surface JS du moteur d'égaliseur.
 *
 * Utilisable seulement dans un build natif (`expo run:ios` / EAS). Dans Expo Go,
 * `requireOptionalNativeModule('AudioDSP')` renvoie `null` et l'app bascule sur
 * le chemin `expo-audio` — sans que l'égaliseur web soit affecté, ce sont deux
 * plateformes différentes.
 */
public class AudioDSPModule: Module {

    private let engine = AudioDSPEngine()

    // MARK: - Cache local

    /// `AVAudioFile` exige un vrai fichier sur disque : chaque piste distante est
    /// téléchargée une fois puis servie depuis le cache. Clé = empreinte de l'URL.
    private let cacheDirectory: URL = {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("expo-audio-dsp", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    public func definition() -> ModuleDefinition {
        Name("AudioDSP")

        Events("onProgress", "onRemoteCommand", "onSystemVolume")

        OnDestroy {
            self.engine.stop()
            // `stop()` invalide déjà l'observation, mais l'appel explicite
            // documente la responsabilité du module : son `deinit` d'engine ne
            // s'exécute jamais, puisque le module le retient toute sa vie.
            self.engine.stopObservingSystemVolume()
            self.engine.onSystemVolumeChange = nil
        }

        // MARK: Chargement

        AsyncFunction("loadTrackAsync") { (uri: String, title: String?, artist: String?, album: String?, artwork: String?) async throws -> [String: Any] in
            guard let remote = URL(string: uri) else {
                throw AudioDSPModuleException.invalidUrl(uri)
            }

            let targetURL: URL
            // Support transparent des fichiers locaux (imports) et distants (streaming avec cache)
            if remote.isFileURL || !["http", "https"].contains(remote.scheme?.lowercased()) {
                var resolved = remote
                if !FileManager.default.fileExists(atPath: resolved.path) {
                    let path = resolved.path
                    if let docRange = path.range(of: "/Documents/") {
                        let subPath = String(path[docRange.upperBound...])
                        if let currentDocDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
                            let candidate = currentDocDir.appendingPathComponent(subPath)
                            if FileManager.default.fileExists(atPath: candidate.path) {
                                resolved = candidate
                            }
                        }
                    } else if let cacheRange = path.range(of: "/Library/Caches/") {
                        let subPath = String(path[cacheRange.upperBound...])
                        if let currentCacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
                            let candidate = currentCacheDir.appendingPathComponent(subPath)
                            if FileManager.default.fileExists(atPath: candidate.path) {
                                resolved = candidate
                            }
                        }
                    }
                }
                targetURL = resolved
            } else {
                let local = self.localURL(for: remote)
                if !FileManager.default.fileExists(atPath: local.path) {
                    let (temporary, response) = try await URLSession.shared.download(from: remote)
                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        throw AudioDSPModuleException.downloadFailed(http.statusCode)
                    }
                    try? FileManager.default.removeItem(at: local)
                    try FileManager.default.moveItem(at: temporary, to: local)
                }
                targetURL = local
            }

            self.engine.trackTitle = title
            self.engine.trackArtist = artist
            self.engine.trackAlbum = album
            self.engine.setArtwork(from: artwork)
            try self.engine.load(url: targetURL)

            return [
                "duration": self.engine.duration,
                "uri": targetURL.path,
                "cached": true
            ]
        }

        // MARK: Transport

        AsyncFunction("playAsync") { () -> Bool in
            self.engine.play()
            return self.engine.isPlaying
        }

        AsyncFunction("pauseAsync") { () -> Bool in
            self.engine.pause()
            return self.engine.isPlaying
        }

        AsyncFunction("stopAsync") { () -> Void in
            self.engine.stop()
        }

        AsyncFunction("getStatusAsync") { () -> [String: Any] in
            return self.engine.getStatus()
        }

        AsyncFunction("seekAsync") { (seconds: Double) -> Void in
            self.engine.seek(to: seconds)
        }

        AsyncFunction("setVolumeAsync") { (value: Float) -> Void in
            self.engine.setVolume(value)
        }

        AsyncFunction("getSystemVolumeAsync") { () -> Float in
            return AVAudioSession.sharedInstance().outputVolume
        }

        AsyncFunction("clearNowPlayingAsync") { () -> Void in
            self.engine.clearNowPlaying()
        }

        // MARK: DSP

        /**
         * Pousse l'état DSP complet.
         *
         * `bands` doit contenir 10 gains en dB, dans l'ordre de la table
         * canonique (250 Hz lowshelf, 125 Hz → 8 kHz peaking, 8 kHz highshelf) —
         * c'est exactement l'ordre de `EQ_BANDS` dans presets.ts.
         *
         * Les quatre derniers paramètres sont la réverbération. Ils ont une
         * **valeur par défaut** : un appelant plus ancien, qui ne les connaît pas,
         * obtient `enabled = false`, donc aucune réverbération — le neutre. C'est ce
         * qui permet d'ajouter l'étage sans casser les appelants existants.
         *
         * `wet` et `dry` sont calculés côté JS (`computeReverbGains`) et transmis
         * tels quels : le natif ne recalcule pas la loi de dosage, donc les deux
         * plateformes ne peuvent pas diverger dessus.
         */
        AsyncFunction("setDSPAsync") {
            (bands: [Float], preamp: Float, balance: Float, mono: Bool,
             stereoExpansion: Float, enabled: Bool, crossfeed: Float,
             reverbEnabled: Bool = false, roomSize: Float = 0, damping: Float = 0,
             reverbMix: Float = 0, reverbWet: Float = 0, reverbDry: Float = 1,
             limitEnabled: Bool = true) -> Void in

            var normalized = bands
            if normalized.count < AudioDSPEngine.bandCount {
                normalized += Array(repeating: 0, count: AudioDSPEngine.bandCount - normalized.count)
            }
            self.engine.apply(gains: normalized, preampDb: preamp, balance: balance,
                              mono: mono, stereoExpansion: stereoExpansion, enabled: enabled,
                              crossfeed: crossfeed,
                              reverbEnabled: reverbEnabled, roomSize: roomSize,
                              damping: damping, reverbMix: reverbMix,
                              reverbWet: reverbWet, reverbDry: reverbDry,
                              limitEnabled: limitEnabled)
        }

        OnStartObserving {
            self.engine.onProgress = { [weak self] time, duration, finished in
                self?.sendEvent("onProgress", [
                    "currentTime": time,
                    "duration": duration,
                    "isPlaying": self?.engine.isPlaying ?? false,
                    "didFinish": finished
                ])
            }
            self.engine.onRemoteCommand = { [weak self] action in
                self?.sendEvent("onRemoteCommand", [
                    "action": action
                ])
            }
            // Volume système : `readable` distingue « l'OS dit 0.42 » de
            // « module natif absent », pour que le JS bascule son affichage
            // sans jamais deviner.
            self.engine.onSystemVolumeChange = { [weak self] value in
                self?.sendEvent("onSystemVolume", [
                    "volume": value,
                    "readable": true
                ])
            }
            self.engine.startObservingSystemVolume()
        }

        OnStopObserving {
            self.engine.onProgress = nil
            self.engine.onRemoteCommand = nil
            self.engine.onSystemVolumeChange = nil
            self.engine.stopObservingSystemVolume()
        }
    }

    // MARK: - Utilitaires

    /// URL de cache stable pour une URL distante.
    ///
    /// `hashValue` est volontairement écarté : Swift le randomise à chaque
    /// lancement du programme, donc le cache ne serait jamais retrouvé d'une
    /// session à l'autre (le fichier serait retéléchargé à chaque lancement).
    /// On passe par CryptoKit, dont le SHA-256 est déterministe.
    private func localURL(for remote: URL) -> URL {
        let digest = SHA256.hash(data: Data(remote.absoluteString.utf8))
            .prefix(8)
            .map { String(format: "%02x", $0) }
            .joined()
        let ext = remote.pathExtension.isEmpty ? "mp3" : remote.pathExtension
        return cacheDirectory.appendingPathComponent("\(digest).\(ext)")
    }
}

/**
 * Erreurs du module. `Exception` simple plutôt que `GenericException` : ce
 * dernier ne prend qu'un seul paramètre et ne peut donc pas porter le motif
 * *et* le code HTTP. `Exception(name:description:)` stocke déjà le message dans
 * `customReason`, que `reason` retourne par défaut — inutile de le redéfinir.
 */
public class AudioDSPModuleException: Exception, @unchecked Sendable {
    public static func invalidUrl(_ uri: String) -> AudioDSPModuleException {
        AudioDSPModuleException(name: "AudioDSPModuleException.invalidUrl",
                                description: "URL de morceau invalide : \(uri)")
    }

    public static func downloadFailed(_ code: Int) -> AudioDSPModuleException {
        AudioDSPModuleException(name: "AudioDSPModuleException.downloadFailed",
                                description: "Téléchargement du morceau impossible (HTTP \(code)).")
    }
}