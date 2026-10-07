import CryptoKit
import ExpoModulesCore
import Foundation
import UIKit

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
            var bgTask: UIBackgroundTaskIdentifier = .invalid
            await MainActor.run {
                bgTask = UIApplication.shared.beginBackgroundTask(withName: "MASPlayer-LoadTrack") {
                    UIApplication.shared.endBackgroundTask(bgTask)
                    bgTask = .invalid
                }
            }
            defer {
                if bgTask != .invalid {
                    let taskToEnd = bgTask
                    DispatchQueue.main.async {
                        UIApplication.shared.endBackgroundTask(taskToEnd)
                    }
                }
            }

            let parsedURL: URL? = {
                if uri.hasPrefix("file://") {
                    let clean = String(uri.dropFirst(7))
                    let decoded = clean.removingPercentEncoding ?? clean
                    return URL(fileURLWithPath: decoded)
                }
                if let u = URL(string: uri) {
                    return u
                }
                let clean = uri.removingPercentEncoding ?? uri
                return URL(fileURLWithPath: clean)
            }()
            guard let remote = parsedURL else {
                throw AudioDSPModuleException.invalidUrl(uri)
            }

            let targetURL: URL
            // Support transparent des fichiers locaux (imports) et distants (streaming avec cache)
            if remote.isFileURL || !["http", "https"].contains(remote.scheme?.lowercased()) {
                targetURL = self.resolveLocalFileURL(remote)
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

            let isSecurityScoped = targetURL.startAccessingSecurityScopedResource()
            defer {
                if isSecurityScoped {
                    targetURL.stopAccessingSecurityScopedResource()
                }
            }

            self.engine.trackTitle = title
            self.engine.trackArtist = artist
            self.engine.trackAlbum = album
            self.engine.setArtwork(from: artwork)
            try await self.engine.load(url: targetURL)

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

        AsyncFunction("setPlaybackRateAsync") { (rate: Float) -> Void in
            self.engine.setPlaybackRate(rate)
        }

        AsyncFunction("getSystemVolumeAsync") { () -> Float in
            return AVAudioSession.sharedInstance().outputVolume
        }

        AsyncFunction("clearNowPlayingAsync") { () -> Void in
            self.engine.clearNowPlaying()
        }

        /**
         * Reprise automatique après une interruption (appel entrant, alarme).
         *
         * iOS seulement. Android n'a pas besoin de ce drapeau : le focus audio
         * d'`expo-audio` gère déjà la pause et la reprise, et JS le pilote par
         * `interruptionMode`. Ici, l'engine reprend dans son handler
         * d'`interruptionNotification` avant de prévenir JS, donc JS ne peut pas
         * annuler la reprise — il doit la désider en amont.
         */
        AsyncFunction("setAutoResumeAsync") { (enabled: Bool) -> Void in
            self.engine.setAutoResumeOnInterruption(enabled)
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
             reverbEnabled: Bool, roomSize: Float, damping: Float,
             reverbMix: Float, reverbWet: Float, reverbDry: Float,
             limitEnabled: Bool) -> Void in

            self.applyDSP(
                bands: bands, preamp: preamp, balance: balance,
                mono: mono, stereoExpansion: stereoExpansion, enabled: enabled,
                crossfeed: crossfeed,
                reverbEnabled: reverbEnabled, roomSize: roomSize,
                damping: damping, reverbMix: reverbMix,
                reverbWet: reverbWet, reverbDry: reverbDry,
                limitEnabled: limitEnabled
            )
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

    /// Résolution robuste des URLs locales (sandbox, documents, caches, symlinks)
    private func resolveLocalFileURL(_ remote: URL) -> URL {
        var candidates: [URL] = [remote]

        let decodedPath = remote.path.removingPercentEncoding ?? remote.path
        if decodedPath != remote.path {
            candidates.append(URL(fileURLWithPath: decodedPath))
        }

        // Support standard /private/var/ mobile paths on iOS
        if decodedPath.hasPrefix("/var/") {
            candidates.append(URL(fileURLWithPath: "/private" + decodedPath))
        } else if decodedPath.hasPrefix("/private/var/") {
            candidates.append(URL(fileURLWithPath: String(decodedPath.dropFirst(8))))
        }

        // Résolution dynamique des sous-dossiers lors de migrations de conteneur d'app
        if let docRange = decodedPath.range(of: "/Documents/") {
            let subPath = String(decodedPath[docRange.upperBound...])
            if let currentDocDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
                candidates.append(appendingSubPath(currentDocDir, subPath))
            }
        }
        if let cacheRange = decodedPath.range(of: "/Library/Caches/") {
            let subPath = String(decodedPath[cacheRange.upperBound...])
            if let currentCacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
                candidates.append(appendingSubPath(currentCacheDir, subPath))
            }
        }
        if let tmpRange = decodedPath.range(of: "/tmp/") {
            let subPath = String(decodedPath[tmpRange.upperBound...])
            let tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
            candidates.append(appendingSubPath(tmpDir, subPath))
        }

        for candidate in candidates {
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
        }

        return candidates.first ?? remote
    }

    private func appendingSubPath(_ base: URL, _ subPath: String) -> URL {
        var current = base
        let clean = subPath.removingPercentEncoding ?? subPath
        let components = clean.split(separator: "/").map { String($0) }
        for component in components {
            if !component.isEmpty {
                current = current.appendingPathComponent(component)
            }
        }
        return current
    }

    private func applyDSP(
        bands: [Float], preamp: Float, balance: Float, mono: Bool,
        stereoExpansion: Float, enabled: Bool, crossfeed: Float,
        reverbEnabled: Bool = false, roomSize: Float = 0, damping: Float = 0,
        reverbMix: Float = 0, reverbWet: Float = 0, reverbDry: Float = 1,
        limitEnabled: Bool = true
    ) {
        var normalized = bands
        if normalized.count < AudioDSPEngine.bandCount {
            normalized += Array(repeating: 0, count: AudioDSPEngine.bandCount - normalized.count)
        }
        self.engine.apply(
            gains: normalized, preampDb: preamp, balance: balance,
            mono: mono, stereoExpansion: stereoExpansion, enabled: enabled,
            crossfeed: crossfeed,
            reverbEnabled: reverbEnabled, roomSize: roomSize,
            damping: damping, reverbMix: reverbMix,
            reverbWet: reverbWet, reverbDry: reverbDry,
            limitEnabled: limitEnabled
        )
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