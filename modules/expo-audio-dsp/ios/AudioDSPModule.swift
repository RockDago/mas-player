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

        Events("onProgress")

        OnDestroy {
            self.engine.stop()
        }

        // MARK: Chargement

        AsyncFunction("loadTrackAsync") { (uri: String, title: String?, artist: String?) async throws -> [String: Any] in
            guard let remote = URL(string: uri) else {
                throw AudioDSPModuleException.invalidUrl(uri)
            }
            let local = self.localURL(for: remote)

            // Fichier déjà en cache : on n'y touche pas.
            if !FileManager.default.fileExists(atPath: local.path) {
                let (temporary, response) = try await URLSession.shared.download(from: remote)
                if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                    throw AudioDSPModuleException.downloadFailed(http.statusCode)
                }
                try? FileManager.default.removeItem(at: local)
                try FileManager.default.moveItem(at: temporary, to: local)
            }

            self.engine.trackTitle = title
            self.engine.trackArtist = artist
            try self.engine.load(url: local)

            return [
                "duration": self.engine.duration,
                "uri": local.path,
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

        AsyncFunction("seekAsync") { (seconds: Double) -> Void in
            self.engine.seek(to: seconds)
        }

        AsyncFunction("setVolumeAsync") { (value: Float) -> Void in
            self.engine.setVolume(value)
        }

        // MARK: DSP

        /**
         * Pousse l'état DSP complet.
         *
         * `bands` doit contenir 10 gains en dB, dans l'ordre de la table
         * canonique (250 Hz lowshelf, 125 Hz → 8 kHz peaking, 8 kHz highshelf) —
         * c'est exactement l'ordre de `EQ_BANDS` dans presets.ts.
         */
        AsyncFunction("setDSPAsync") {
            (bands: [Float], preamp: Float, balance: Float, mono: Bool,
             stereoExpansion: Float, enabled: Bool) -> Void in

            var normalized = bands
            if normalized.count < AudioDSPEngine.bandCount {
                normalized += Array(repeating: 0, count: AudioDSPEngine.bandCount - normalized.count)
            }
            self.engine.apply(gains: normalized, preampDb: preamp, balance: balance,
                              mono: mono, stereoExpansion: stereoExpansion, enabled: enabled)
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
        }

        OnStopObserving {
            self.engine.onProgress = nil
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
public class AudioDSPModuleException: Exception {
    public static func invalidUrl(_ uri: String) -> AudioDSPModuleException {
        AudioDSPModuleException(name: "AudioDSPModuleException.invalidUrl",
                                description: "URL de morceau invalide : \(uri)")
    }

    public static func downloadFailed(_ code: Int) -> AudioDSPModuleException {
        AudioDSPModuleException(name: "AudioDSPModuleException.downloadFailed",
                                description: "Téléchargement du morceau impossible (HTTP \(code)).")
    }
}