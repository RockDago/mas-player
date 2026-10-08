package expo.modules.audiodsp

import android.content.Context
import android.media.AudioManager
import android.media.audiofx.BassBoost
import android.media.audiofx.Equalizer
import android.media.audiofx.LoudnessEnhancer
import android.media.audiofx.PresetReverb
import android.media.audiofx.Virtualizer
import android.os.Build
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.abs

class AudioDSPModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context is null")

  private var activeSessionId: Int = 0
  private var equalizer: Equalizer? = null
  private var bassBoost: BassBoost? = null
  private var virtualizer: Virtualizer? = null
  private var loudnessEnhancer: LoudnessEnhancer? = null
  private var presetReverb: PresetReverb? = null

  // Dernier état DSP mémorisé
  private var pendingBands: List<Double> = emptyList()
  private var pendingPreamp: Double = 0.0
  private var pendingBalance: Double = 0.0
  private var pendingMono: Boolean = false
  private var pendingStereoExpansion: Double = 0.0
  private var pendingEnabled: Boolean = true
  private var pendingCrossfeed: Double = 0.0
  private var pendingReverbEnabled: Boolean = false
  private var pendingRoomSize: Double = 0.0
  private var pendingDamping: Double = 0.0
  private var pendingReverbMix: Double = 0.0
  private var pendingReverbWet: Double = 0.0
  private var pendingReverbDry: Double = 1.0
  private var pendingLimitEnabled: Boolean = true

  // Les 10 fréquences canoniques de MAS Player, EN KILOHERTZ.
  //
  // `Equalizer.getCenterFreq()` rend des millihertz : la correspondance plus
  // proche voisin compare donc ces valeurs à `centerHz / 1000`. La table était
  // déclarée en Hz alors que la comparaison se fait en kHz — chaque écart était
  // donc 1000× trop grand, et la quasi-totalité des bandes recevait le gain d'une
  // autre bande (voir `mapCanonicalBands`).
  //
  // L'ordre et les valeurs correspondent exactement à `EQ_BANDS` de
  // `src/constants/presets.ts` : bande 0 = lowshelf 250 Hz, bandes 1-8 = peaking,
  // bande 9 = highshelf 8 kHz.
  private val canonicalFreqsKHz = doubleArrayOf(0.25, 0.125, 0.25, 0.5, 1.0, 2.0, 4.0, 6.0, 8.0, 8.0)

  /**
   * Répartit les 10 bandes canoniques sur les bandes réellement offertes par
   * l'`Equalizer` matériel, qui n'en a le plus souvent que 5.
   *
   * Le matériel ne sait pas porter dix bandes indépendantes : il faut donc
   * **répartir**, pas choisir. Trois temps :
   *
   *  1. **Projection** — chaque bande native adopte la bande canonique la plus
   *     proche en fréquence (comparaison faite en kHz des deux côtés).
   *  2. **Rattrapage des orphelines** — une bande canonique qu'aucune native ne
   *     réclame n'est pas perdue : son gain est réparti sur ses voisines servies,
   *     au prorata de leur proximité en fréquence.
   *  3. **Moyenne** — plusieurs bandes canoniques peuvent aboutir sur une même
   *     bande native ; on en fait la moyenne, pour ne jamais dépasser le niveau
   *     réellement demandé par l'utilisateur.
   *
   * Sans l'étape 2, un EQ 5 bandes perdrait la moitié des gains — l'aigu et le
   * médian en premier, c'est-à-dire exactement ce que le knob treble pilote. La
   * courbe obtenue reste plus grossière que celle du web (qui dispose de dix
   * `BiquadFilterNode` réels), mais aucun knob ne devient muet.
   */
  private fun mapCanonicalBands(
    nativeCentersKHz: DoubleArray,
    canonicalGainsDb: List<Double>
  ): DoubleArray {
    val n = nativeCentersKHz.size
    if (n == 0) return DoubleArray(0)

    fun gainOf(canonicalIndex: Int): Double =
      if (canonicalIndex in canonicalGainsDb.indices) canonicalGainsDb[canonicalIndex] else 0.0

    // 1. Projection : la bande canonique la plus proche pour chaque bande native.
    //
    //    Le plus-proche-voisin doit aussi **réclamer** une bande canonique
    //    encore libre, sinon les bandes 8 et 9 — toutes deux à 8 kHz, peaking et
    //    highshelf — partent ensemble sur la même bande native et le highshelf,
    //    qui pilote le knob TREBLE, ressort muet sur tous les appareils dont
    //    l'EQ matériel a moins de 10 bandes. Les bandes déjà réattribuées sont
    //    donc écartées de la recherche tant qu'il reste une canonique libre.
    val taken = BooleanArray(canonicalFreqsKHz.size)
    val projection = IntArray(n)
    for (i in 0 until n) {
      var best = -1
      var bestDist = Double.MAX_VALUE
      // Passe 1 : uniquement parmi les canoniques encore libres.
      for (c in canonicalFreqsKHz.indices) {
        if (taken[c]) continue
        val d = abs(nativeCentersKHz[i] - canonicalFreqsKHz[c])
        if (d < bestDist) {
          bestDist = d
          best = c
        }
      }
      // Passe 2 : plus rien de libre — on accepte de réemployer une bande.
      if (best < 0) {
        for (c in canonicalFreqsKHz.indices) {
          val d = abs(nativeCentersKHz[i] - canonicalFreqsKHz[c])
          if (d < bestDist) {
            bestDist = d
            best = c
          }
        }
      }
      projection[i] = best
      taken[best] = true
    }

    val served = BooleanArray(canonicalFreqsKHz.size)
    projection.forEach { served[it] = true }

    // 2 + 3 : on repartit d'abord le gain des orphelines sur les bandes natives
    //         qui portent leurs voisines, puis on moyenne par bande native.
    val sums = DoubleArray(n)
    val counts = IntArray(n)

    for (i in 0 until n) {
      sums[i] += gainOf(projection[i])
      counts[i]++
    }

    for (c in canonicalFreqsKHz.indices) {
      if (served[c]) continue

      // Une orpheline à gain nul n'a aucune énergie à redistribuer. La compter
      // quand même diluerait le gain de ses voisines : un +6 dB à 125 Hz ressortait
      // à +1 dB parce que cinq bandes muettes partageaient sa bande native.
      if (gainOf(c) == 0.0) continue

      // Cas particulier des bandes 8 et 9, toutes deux à 8 kHz (peaking puis
      // highshelf). Le plus-proche-voisin ne peut en servir qu'une, et la
      // recherche « strictement en dessous / au-dessus » ignorait l'autre : le
      // treble retombait alors sur 3,6 kHz. Une orpheline co-localisée va donc
      // sur la bande qui sert DÉJÀ cette fréquence exacte.
      val coLocated = projection.indexOfFirst {
        canonicalFreqsKHz[it] == canonicalFreqsKHz[c] && served[it]
      }
      if (coLocated >= 0) {
        // Addition, pas moyenne : le web empile les deux filtres à 8 kHz, dont
        // les gains en dB s'additionnent. Moyenable serait sous-estimer d'autant.
        sums[coLocated] += gainOf(c)
        continue
      }

      // Bandes natives portant la voisine servie juste en dessous et au-dessus.
      // Il faut la plus PROCHE de chaque côté, pas la première rencontrée :
      // l'ordre de projection n'est pas l'ordre des fréquences, et le treble
      // atterrissait sur la bande 60 Hz parce que celle-ci venait en premier.
      val lowerNative = projection.indices
        .filter { canonicalFreqsKHz[projection[it]] < canonicalFreqsKHz[c] && served[projection[it]] }
        .maxByOrNull { canonicalFreqsKHz[projection[it]] }
        ?: -1
      val upperNative = projection.indices
        .filter { canonicalFreqsKHz[projection[it]] > canonicalFreqsKHz[c] && served[projection[it]] }
        .minByOrNull { canonicalFreqsKHz[projection[it]] }
        ?: -1

      val lowerWeight: Double
      val upperWeight: Double
      when {
        lowerNative >= 0 && upperNative >= 0 -> {
          // Interpolation linéaire entre les deux voisines, par proximité en
          // fréquence : une orpheline collée à sa voisine reçoit presque tout son
          // gain de ce côté.
          val span = canonicalFreqsKHz[projection[upperNative]] - canonicalFreqsKHz[projection[lowerNative]]
          val t = if (span > 0) {
            (canonicalFreqsKHz[c] - canonicalFreqsKHz[projection[lowerNative]]) / span
          } else 0.5
          lowerWeight = 1.0 - t
          upperWeight = t
        }
        lowerNative >= 0 -> { lowerWeight = 1.0; upperWeight = 0.0 }
        upperNative >= 0 -> { lowerWeight = 0.0; upperWeight = 1.0 }
        else -> continue
      }

      val gain = gainOf(c)
      if (lowerWeight > 0) { sums[lowerNative] += gain * lowerWeight; counts[lowerNative]++ }
      if (upperWeight > 0) { sums[upperNative] += gain * upperWeight; counts[upperNative]++ }
    }

    return DoubleArray(n) { i -> if (counts[i] > 0) sums[i] / counts[i] else 0.0 }
  }


  override fun definition() = ModuleDefinition {
    Name("AudioDSP")

    Events("onProgress", "onRemoteCommand", "onSystemVolume")

    OnCreate {
      // Les effets audio sur Android sont initialisés dynamiquement dès la réception
      // d'un activeSessionId valide (> 0) provenant du lecteur ExoPlayer.
    }

    OnDestroy {
      releaseEffects()
    }

    AsyncFunction("setAudioSessionIdAsync") { sessionId: Int ->
      val targetSessionId = if (sessionId > 0) sessionId else {
        try {
          val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
          audioManager?.generateAudioSessionId() ?: 0
        } catch (_: Exception) {
          0
        }
      }
      if (targetSessionId > 0) {
        if (targetSessionId != activeSessionId || equalizer == null) {
          activeSessionId = targetSessionId
          initEffects(targetSessionId)
        }
        applyCurrentDSP()
      }
    }

    // Un seul `Map` et non quatorze scalaires.
    //
    // Le DSL `AsyncFunction` d'expo-modules-core s'arrête à `P7` (huit
    // paramètres) : tout surcharge se résout sur le overload sans paramètre, qui
    // attend un `Function0<Any?>` — c'est exactement l'erreur de compilation
    // « actual type is 'Function14<...>', but 'Function0<Any?>' was expected ».
    // Swift n'a pas ce plafond, donc iOS garde sa signature positionnelle à
    // quatorze arguments et seul Android passe par un dictionnaire ; `applyNativeDSP`
    // choisit la forme selon la plateforme.
    AsyncFunction("setDSPAsync") { state: Map<String, Any?> ->
      // Les listes arrivent en `ArrayList<*>` : on ne connaît le type qu'au
      // moment de la lecture, d'où la conversion explicite. Un `Number` absent ou
      // mal typé retombe sur le neutre plutôt que de casser tout l'état DSP.
      val rawBands = state["bands"] as? List<*>

      pendingBands = (0 until canonicalFreqsKHz.size).map { i ->
        ((rawBands?.getOrNull(i)) as? Number)?.toDouble() ?: 0.0
      }
      pendingPreamp = (state["preamp"] as? Number)?.toDouble() ?: 0.0
      pendingBalance = (state["balance"] as? Number)?.toDouble() ?: 0.0
      pendingMono = (state["mono"] as? Boolean) ?: false
      pendingStereoExpansion = (state["stereoExpansion"] as? Number)?.toDouble() ?: 0.0
      pendingEnabled = (state["enabled"] as? Boolean) ?: true
      pendingCrossfeed = (state["crossfeed"] as? Number)?.toDouble() ?: 0.0
      pendingReverbEnabled = (state["reverbEnabled"] as? Boolean) ?: false
      pendingRoomSize = (state["roomSize"] as? Number)?.toDouble() ?: 0.0
      pendingDamping = (state["damping"] as? Number)?.toDouble() ?: 0.0
      pendingReverbMix = (state["reverbMix"] as? Number)?.toDouble() ?: 0.0
      pendingReverbWet = (state["reverbWet"] as? Number)?.toDouble() ?: 0.0
      pendingReverbDry = (state["reverbDry"] as? Number)?.toDouble() ?: 1.0
      pendingLimitEnabled = (state["limitEnabled"] as? Boolean) ?: true

      applyCurrentDSP()
    }

    /**
     * État de la chaîne DSP, pour l'overlay de diagnostic.
     *
     * `processorInstalled` et `processedBuffers` répondent à la seule question
     * qui compte sur Android : le processeur PCM est-il réellement dans le sink
     * Media3, et du son le traverse-t-il ? Le module hardware `Equalizer`, lui,
     * est laissé `enabled = false` en permanence — le DSP passe par le
     * processeur, pas par lui — donc `hardwareEqEnabled` vaut `false` sur un
     * appareil sain. Ce n'est pas une panne à elle seule.
     */
    AsyncFunction("getDiagnosticsAsync") {
      mapOf(
        "sessionId" to activeSessionId,
        "processorInstalled" to AudioDSPProcessor.installed,
        "processedBuffers" to AudioDSPProcessor.processedBuffers,
        "processorChannels" to AudioDSPProcessor.lastChannels,
        "hardwareEqEnabled" to (equalizer?.enabled ?: false),
        "hardwareEqBands" to (equalizer?.numberOfBands?.toInt() ?: 0),
        "pendingBands" to pendingBands,
        "pendingEnabled" to pendingEnabled
      )
    }

    AsyncFunction("getSystemVolumeAsync") {
      try {
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        if (audioManager != null) {
          val cur = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
          val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
          if (max > 0) cur.toFloat() / max.toFloat() else 1.0f
        } else {
          1.0f
        }
      } catch (e: Exception) {
        1.0f
      }
    }

    AsyncFunction("setVolumeAsync") { value: Double ->
      try {
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        if (audioManager != null) {
          val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
          val target = (value * max).toInt().coerceIn(0, max)
          audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0)
        }
      } catch (e: Exception) {
        Log.w("AudioDSP", "setVolumeAsync failed: ${e.message}")
      }
    }

    AsyncFunction("clearNowPlayingAsync") {
      // Géré par expo-audio media session
    }

    AsyncFunction("loadTrackAsync") { uri: String, _: String?, _: String?, _: String?, _: String? ->
      mapOf(
        "duration" to 0.0,
        "uri" to uri,
        "cached" to true
      )
    }

    AsyncFunction("playAsync") { true }
    AsyncFunction("pauseAsync") { false }
    AsyncFunction("stopAsync") { }
    AsyncFunction("getStatusAsync") {
      mapOf("currentTime" to 0.0, "duration" to 0.0, "isPlaying" to false)
    }
    AsyncFunction("seekAsync") { _: Double -> }
  }

  private fun initEffects(sessionId: Int) {
    releaseEffects()
    if (sessionId <= 0) return

    try {
      val intent = android.content.Intent(android.media.audiofx.AudioEffect.ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION).apply {
        putExtra(android.media.audiofx.AudioEffect.EXTRA_AUDIO_SESSION, sessionId)
        putExtra(android.media.audiofx.AudioEffect.EXTRA_PACKAGE_NAME, context.packageName)
        putExtra(android.media.audiofx.AudioEffect.EXTRA_CONTENT_TYPE, android.media.audiofx.AudioEffect.CONTENT_TYPE_MUSIC)
      }
      context.sendBroadcast(intent)
      Log.i("AudioDSP", "Broadcasted ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION for session $sessionId")
    } catch (e: Exception) {
      Log.w("AudioDSP", "Broadcast ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION failed: ${e.message}")
    }

    try {
      equalizer = Equalizer(0, sessionId).apply {
        enabled = false
      }
    } catch (e: Exception) {
      try {
        equalizer = Equalizer(1000, sessionId).apply {
          enabled = false
        }
      } catch (e2: Exception) {
        Log.w("AudioDSP", "Failed to init Equalizer for session $sessionId: ${e2.message}")
      }
    }

    try {
      bassBoost = BassBoost(0, sessionId).apply {
        enabled = false
      }
    } catch (e: Exception) {
      try {
        bassBoost = BassBoost(1000, sessionId).apply {
          enabled = false
        }
      } catch (e2: Exception) {
        Log.w("AudioDSP", "Failed to init BassBoost for session $sessionId: ${e2.message}")
      }
    }

    try {
      virtualizer = Virtualizer(0, sessionId).apply {
        enabled = false
      }
    } catch (e: Exception) {
      try {
        virtualizer = Virtualizer(1000, sessionId).apply {
          enabled = false
        }
      } catch (e2: Exception) {
        Log.w("AudioDSP", "Failed to init Virtualizer for session $sessionId: ${e2.message}")
      }
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
      try {
        loudnessEnhancer = LoudnessEnhancer(sessionId).apply {
          enabled = false
        }
      } catch (e: Exception) {
        Log.w("AudioDSP", "Failed to init LoudnessEnhancer for session $sessionId: ${e.message}")
      }
    }

    try {
      presetReverb = PresetReverb(0, sessionId).apply {
        enabled = false
      }
    } catch (e: Exception) {
      try {
        presetReverb = PresetReverb(1000, sessionId).apply {
          enabled = false
        }
      } catch (e2: Exception) {
        Log.w("AudioDSP", "Failed to init PresetReverb for session $sessionId: ${e2.message}")
      }
    }
  }

  private fun releaseEffects() {
    if (activeSessionId > 0) {
      try {
        val intent = android.content.Intent(android.media.audiofx.AudioEffect.ACTION_CLOSE_AUDIO_EFFECT_CONTROL_SESSION).apply {
          putExtra(android.media.audiofx.AudioEffect.EXTRA_AUDIO_SESSION, activeSessionId)
          putExtra(android.media.audiofx.AudioEffect.EXTRA_PACKAGE_NAME, context.packageName)
        }
        context.sendBroadcast(intent)
      } catch (_: Exception) {}
    }
    try { equalizer?.release() } catch (_: Exception) {}
    try { bassBoost?.release() } catch (_: Exception) {}
    try { virtualizer?.release() } catch (_: Exception) {}
    try { loudnessEnhancer?.release() } catch (_: Exception) {}
    try { presetReverb?.release() } catch (_: Exception) {}
    equalizer = null
    bassBoost = null
    virtualizer = null
    loudnessEnhancer = null
    presetReverb = null
  }

  private fun applyCurrentDSP() {
    AudioDSPProcessorState.update(
      bandsDb = pendingBands,
      preampDb = pendingPreamp,
      balance = pendingBalance,
      mono = pendingMono,
      stereoExpansion = pendingStereoExpansion,
      enabled = pendingEnabled,
      crossfeed = pendingCrossfeed,
      reverbEnabled = pendingReverbEnabled,
      roomSize = pendingRoomSize,
      damping = pendingDamping,
      reverbWet = pendingReverbWet,
      reverbDry = pendingReverbDry,
      limitEnabled = pendingLimitEnabled
    )
    if (activeSessionId <= 0) {
      try {
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        val fallback = audioManager?.generateAudioSessionId() ?: 0
        if (fallback > 0) {
          activeSessionId = fallback
          initEffects(fallback)
        } else {
          return
        }
      } catch (_: Exception) {
        return
      }
    }
    if (equalizer == null && bassBoost == null) {
      initEffects(activeSessionId)
    }

    // 1. Equalizer : répartition des 10 bandes canoniques sur les bandes
    //    réellement offertes par le matériel (souvent 5, pas 10).
    equalizer?.let { eq ->
      try {
        eq.enabled = false
        if (pendingEnabled) {
          val numBands = eq.numberOfBands.toInt()
          val levelRange = eq.bandLevelRange
          val minMb = levelRange[0].toInt()
          val maxMb = levelRange[1].toInt()

          if (numBands > 0) {
            val nativeCentersKHz = DoubleArray(numBands) { b ->
              eq.getCenterFreq(b.toShort()).toDouble() / 1000.0
            }
            val mapped = mapCanonicalBands(nativeCentersKHz, pendingBands)
            for (b in 0 until numBands) {
              // Le préampli est appliqué ICI, dans les gains de bande, et pas
              // via `LoudnessEnhancer`. Deux raisons : le préampli de `applyNativeDSP`
              // est toujours ≤ 0 (`computeHeadroom` rend une marge négative),
              // alors que `LoudnessEnhancer` refuse tout gain ≤ 0 et restait donc
              // muet sur la totalité des réglages ; et l'ajouter à chaque bande
              // équivaut exactement à un gain de tête uniforme — ce qu'est le
              // préampli — sans dépendre d'un effet matériel souvent absent ou
              // refusé par le constructeur.
              val gainMb = ((mapped[b] + pendingPreamp) * 100.0)
                .toInt()
                .coerceIn(minMb, maxMb)
                .toShort()
              eq.setBandLevel(b.toShort(), gainMb)
            }
          }
        }
      } catch (e: Exception) {
        Log.w("AudioDSP", "Error applying equalizer: ${e.message}")
      }
    }

    // 2. Bass Boost
    bassBoost?.let { bb ->
      try {
        val lowGain = if (pendingBands.isNotEmpty()) pendingBands[0] else 0.0
        val effectiveBass = if (lowGain > 0) lowGain else 0.0
        val strength = ((effectiveBass / 12.0) * 1000.0).toInt().coerceIn(0, 1000).toShort()
        bb.enabled = false
        if (strength > 0 && bb.strengthSupported) {
          bb.setStrength(strength)
        }
      } catch (e: Exception) {
        Log.w("AudioDSP", "Error applying bassBoost: ${e.message}")
      }
    }

    // 3. Virtualizer (Largeur stéréo)
    virtualizer?.let { virt ->
      try {
        val strength = ((pendingStereoExpansion / 100.0) * 1000.0).toInt().coerceIn(0, 1000).toShort()
        virt.enabled = false
        if (strength > 0 && virt.strengthSupported) {
          virt.setStrength(strength)
        }
      } catch (e: Exception) {
        Log.w("AudioDSP", "Error applying virtualizer: ${e.message}")
      }
    }

    // 4. Préampli — voir l'étage 1.
    //
    // Aucun bloc `LoudnessEnhancer` ici : il n'accepte que des gains positifs,
    // alors que le préampli de `applyNativeDSP` est toujours négatif ou nul.
    // Il ne pouvait donc jamais s'activer. Le préampli est désormais porté par
    // les gains de bande, ce qui est la même opération sur le signal.
    // L'étage est conservé instancié dans `initEffects` : sa présence ne coûte
    // rien, et le jour où un gain positif existe (ex. une future version du
    // préampli) il sera disponible sans réécriture du cycle de vie.

    // 5. PresetReverb (Réverbération)
    presetReverb?.let { pr ->
      try {
        pr.enabled = false
        if (pendingReverbEnabled && pendingReverbMix > 0) {
          val preset = when {
            pendingRoomSize < 20 -> PresetReverb.PRESET_SMALLROOM
            pendingRoomSize < 40 -> PresetReverb.PRESET_MEDIUMROOM
            pendingRoomSize < 60 -> PresetReverb.PRESET_LARGEROOM
            pendingRoomSize < 80 -> PresetReverb.PRESET_PLATE
            else -> PresetReverb.PRESET_LARGEHALL
          }
          pr.preset = preset
        }
      } catch (e: Exception) {
        Log.w("AudioDSP", "Error applying presetReverb: ${e.message}")
      }
    }
  }
}
