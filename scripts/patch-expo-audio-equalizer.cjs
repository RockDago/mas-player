const fs = require('fs');
const path = require('path');

const audioRoot = path.resolve(__dirname, '../node_modules/expo-audio');
const androidRoot = path.join(audioRoot, 'android/src/main/java/expo/modules/audio');
const iosRoot = path.join(audioRoot, 'ios');
const dspSourceRoot = path.resolve(__dirname, '../native/audio-dsp');

function copyNativeFile(sourceName, targetPath) {
  const sourcePath = path.join(dspSourceRoot, sourceName);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`[audio-equalizer] Missing native source: ${sourcePath}`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function patchAndroid() {
  const playerPath = path.join(androidRoot, 'AudioPlayer.kt');
  const modulePath = path.join(androidRoot, 'AudioModule.kt');
  const processorPath = path.join(androidRoot, '../audiodsp/AudioDSPProcessor.kt');
  const rendererPath = path.join(androidRoot, 'MASAudioRenderersFactory.kt');

  copyNativeFile('AudioDSPProcessor.kt', processorPath);
  copyNativeFile('MASAudioRenderersFactory.kt', rendererPath);

  let playerContent = fs.readFileSync(playerPath, 'utf8');
  if (!playerContent.includes('MASAudioRenderersFactory(context)')) {
    if (!playerContent.includes('ExoPlayer.Builder(context)')) {
      throw new Error(`[audio-equalizer] Could not find Android renderer insertion point in ${playerPath}`);
    }
    playerContent = playerContent.replace(
      'ExoPlayer.Builder(context)',
      'ExoPlayer.Builder(context, MASAudioRenderersFactory(context))'
    );
    fs.writeFileSync(playerPath, playerContent, 'utf8');
  }

  let moduleContent = fs.readFileSync(modulePath, 'utf8');
  moduleContent = moduleContent.replace(
    /\n[ \t]*Function\("setEqualizer"\) \{[^\n]*\n[\s\S]*?\n[ \t]*\}/g,
    ''
  );
  moduleContent = moduleContent.replace(
    /\n[ \t]*Function\("setDSP"\) \{[^\n]*\n[\s\S]*?\n[ \t]*\}/g,
    ''
  );
  const samplingAnchor = '      Function("setAudioSamplingEnabled")';
  if (!moduleContent.includes(samplingAnchor)) {
    throw new Error(`[audio-equalizer] Could not find Android AudioPlayer API insertion point in ${modulePath}`);
  }
  moduleContent = moduleContent.replace(
    samplingAnchor,
    '      Function("setDSP") { _: AudioPlayer, enabled: Boolean, bands: List<Double>, preamp: Double, balance: Double, stereo: Double, limit: Boolean, reverb: List<Double> ->\n' +
    '        val revEnabled = reverb.isNotEmpty() && reverb[0] > 0.5\n' +
    '        val room = if (reverb.size > 1) reverb[1] else 40.0\n' +
    '        val damp = if (reverb.size > 2) reverb[2] else 50.0\n' +
    '        val mix = if (reverb.size > 3) reverb[3] else 25.0\n' +
    '        expo.modules.audiodsp.AudioDSPProcessor.update(enabled, bands, preamp, balance, stereo, limit, revEnabled, room, damp, mix)\n' +
    '      }\n\n' + samplingAnchor
  );
  fs.writeFileSync(modulePath, moduleContent, 'utf8');
}

function patchIos() {
  const tapHeaderPath = path.join(iosRoot, 'AudioTapProcessor.h');
  const tapSourcePath = path.join(iosRoot, 'AudioTapProcessor.m');
  const playerPath = path.join(iosRoot, 'AudioPlayer.swift');
  const modulePath = path.join(iosRoot, 'AudioModule.swift');

  copyNativeFile('MASAudioDSP.h', path.join(iosRoot, 'MASAudioDSP.h'));
  copyNativeFile('MASAudioDSP.m', path.join(iosRoot, 'MASAudioDSP.m'));

  let header = fs.readFileSync(tapHeaderPath, 'utf8');
  if (!header.includes('MASAudioDSP.h')) {
    header = header.replace(
      '#import <AVFoundation/AVFoundation.h>',
      '#import <AVFoundation/AVFoundation.h>\n#import "MASAudioDSP.h"'
    );
    header = header.replace(
      '@property (nonatomic, readonly) BOOL isTapInstalled;',
      '@property (nonatomic, readonly) BOOL isTapInstalled;\n' +
        // ⚠ `dspState` n est PAS une @property, mais un accessor C en lecture seule.\n' +
        '//\n' +
        '// Le thread de rendu audio ne peut pas passer par une @property : lire une\n' +
        '// propriete ObjC est un message send a `objc_msgSend`, donc un envoi de\n' +
        '// message a un objet engage dans `dealloc` — comportement indefini, et sur\n' +
        '// le thread audio il tue le process sans exception. Or `dspState` est\n' +
        '// detruit dans `dealloc` : un `tapProcess` deja engage pouvait lire\n' +
        '// l accessor apres, ou pendant, la liberation de l objet. L accessor lit\n' +
        '// l ivar directement : plus de message send, donc plus rien qui passe par\n' +
        '// l objet.\n' +
        'MASAudioDSPState *MASAudioDSPGetState(AudioTapProcessor *processor);\n' +
        '- (void)setDSPEnabled:(BOOL)enabled bands:(NSArray<NSNumber *> *)bands preamp:(double)preamp balance:(double)balance stereo:(double)stereo limit:(BOOL)limit reverb:(BOOL)reverb room:(double)room damp:(double)damp mix:(double)mix;\n- (void)setSampleRate:(double)sampleRate;'
    );
    fs.writeFileSync(tapHeaderPath, header, 'utf8');
  }

  let tapSource = fs.readFileSync(tapSourcePath, 'utf8');
  // L ivar est declare explicitement dans le bloc @implementation : c est lui
  // que lit `MASAudioDSPGetState`, sur le thread de rendu. Declare en dur, il
  // ne depend pas du synthese de propriete (qui elle, passe par objc).
  if (!tapSource.includes('MASAudioDSPState *_dspState;')) {
    tapSource = tapSource.replace(
      '  BOOL _isInvalidated;\n}',
      '  BOOL _isInvalidated;\n  MASAudioDSPState *_dspState;\n}'
    );
  }
  // L accessor C : seul chemin du thread audio vers l etat du DSP. Il ne fait
  // aucun message send, donc reste valide meme si l objet est en dealloc — il
  // ne reste alors qu a lire un pointeur que le dealloc vient de remettre a
  // NULL, et `MASAudioDSPProcess`/tsont deja blindes sur NULL.
  if (!tapSource.includes('MASAudioDSPState *MASAudioDSPGetState(')) {
    tapSource = tapSource.replace(
      '#pragma mark - Audio Sample Buffer Callbacks (MTAudioProcessingTapCallbacks)',
      [
        'MASAudioDSPState *MASAudioDSPGetState(AudioTapProcessor *processor) {',
        '  // Lecture directe de l ivar, sans passer par un getter ObjC : le',
        '  // thread de rendu ne doit jamais envoyer de message a cet objet.',
        '  return processor->_dspState;',
        '}',
        '',
        '#pragma mark - Audio Sample Buffer Callbacks (MTAudioProcessingTapCallbacks)'
      ].join('\n')
    );
  }
  if (!tapSource.includes('#import "MASAudioDSP.h"')) {
    tapSource = tapSource.replace(
      '#import "AudioTapProcessor.h"',
      '#import "AudioTapProcessor.h"\n#import "MASAudioDSP.h"'
    );
  }
  // `CFRelease` est utilise plus bas pour liberer le tap. Il arrive
  // aujourd'hui en transitif via Foundation, mais une dependance transitive
  // n'est pas une garantie : si Expo Audio leve un jour cet import, le
  // build echoue sur `undeclared function`. CoreFoundation est explicitement
  // importe plutot que laisse au hasard.
  if (!tapSource.includes('#import <CoreFoundation/CoreFoundation.h>')) {
    tapSource = tapSource.replace(
      '#import <AudioToolbox/AudioToolbox.h>',
      '#import <AudioToolbox/AudioToolbox.h>\n#import <CoreFoundation/CoreFoundation.h>'
    );
  }
  if (!tapSource.includes('_dspState = MASAudioDSPCreate()')) {
    tapSource = tapSource.replace(
      '  _audioProcessingTap = NULL;\n',
      '  _audioProcessingTap = NULL;\n    _dspState = MASAudioDSPCreate();\n'
    );
  }
  if (!tapSource.includes('- (void)setDSPEnabled:')) {
    tapSource = tapSource.replace(
      '- (BOOL)isTapInstalled {',
      '- (void)setDSPEnabled:(BOOL)enabled bands:(NSArray<NSNumber *> *)bands preamp:(double)preamp balance:(double)balance stereo:(double)stereo limit:(BOOL)limit reverb:(BOOL)reverb room:(double)room damp:(double)damp mix:(double)mix {\n  MASAudioDSPSetParameters(_dspState, enabled, bands, preamp, balance, stereo, limit, reverb, room, damp, mix);\n}\n\n- (void)setSampleRate:(double)sampleRate {\n  MASAudioDSPSetSampleRate(_dspState, sampleRate);\n}\n\n- (BOOL)isTapInstalled {'
    );
  }
  // ⚠ Ce remplacement a son PROPRE garde, et non celui de la creation ci-dessus.
  //
  // Regroupes sous un meme `if (!includes(_dspState...))`, la correction de
  // cycle de vie n'etait appliquee que sur un arbre vierge. Sur un node_modules
  // deja patche, le garde evaluait faux et ce bloc etait saute en silence :
  // l'arbre installe conservait l'ancien `dealloc` sans destruction du tap,
  // pendant que le script annoncait quand meme son succes.
  //
  // Le motif est donc borne au corps du dealloc lui-meme : `invalidate` (qui
  // precede dealloc dans le fichier) contient lui aussi un `CFRelease`, et une
  // recherche globale dirait a tort que dealloc est deja corrige.
  const deallocPattern = /- \(void\)dealloc \{[\s\S]*?\n\}/;
  const deallocMatch = tapSource.match(deallocPattern);
  if (!deallocMatch) {
    throw new Error(`[audio-equalizer] Could not find iOS dealloc in ${tapSourcePath}`);
  }
  if (!deallocMatch[0].includes('CFRelease(_audioProcessingTap)')) {
    tapSource = tapSource.replace(
      deallocPattern,
      [
        '- (void)dealloc {',
        '  [self invalidate];',
        '',
        '  // Le DSP ne doit pas etre libere tant que le thread de rendu peut',
        '  // encore l\'atteindre.',
        '  //',
        '  // `invalidate` libere deja le tap (CFRelease + NULL), donc dans le',
        '  // cas ordinaire ce bloc ne fait rien et le tap est detruire avant',
        '  // cette ligne. Il reste necessaire pour les deux cas qu\'il ne',
        '  // couvre pas : si `_audioProcessingTap` a ete reaffecte entre-temps,',
        '  // ou si `dealloc` est atteint alors qu\'`invalidate` n\'a pas libere',
        '  // (tapie pose mais jamais installee). Sans cette garde, un tap encore',
        '  // vivant pourrait appeler `MASAudioDSPProcess` sur un etat libere —',
        '  // relecture sur zone liberee sur le thread de rendu, qui tue le',
        '  // process sans exception.',
        '  //',
        '  // Le tap est un objet Core Foundation : `MTAudioProcessingTapCreate`',
        '  // est sa seule fonction d\'API, et la liberation passe par',
        '  // `CFRelease` — qui declenche le `finalize` du tap, donc la liberation',
        '  // de son contexte. Il n\'existe AUCUN `MTAudioProcessingTapDestroy` :',
        '  // l\'appeler ne compile pas ("call to undeclared function",',
        '  // run 103089817507). Le CFRelease attend que la reference',
        '  // commentairee tombe a zero, donc jusqu\'a ce qu\'aucun callback ne',
        '  // puisse plus courir — ce qui rend le `MASAudioDSPDestroy` ci-dessous',
        '  // sur. C\'est le seul endroit ou cette attente est legitime : le',
        '  // dealloc n\'est pas un chemin rapide.',
        '  if (_audioProcessingTap) {',
        '    CFRelease(_audioProcessingTap);',
        '    _audioProcessingTap = NULL;',
        '  }',
        '',
        '  MASAudioDSPDestroy(_dspState);',
        '  _dspState = NULL;',
        '}'
      ].join('\n')
    );
  }
  tapSource = tapSource.replace(
    'context->supportedTapProcessingFormat = true;',
    'context->supportedTapProcessingFormat = processingFormat->mFormatID == kAudioFormatLinearPCM && (processingFormat->mFormatFlags & kAudioFormatFlagIsFloat);'
  );
  // `invalidate` et `uninstallTap` remettent le contexte a `isValid = NO` mais
  // laissaient vivre le tap. Or c'est ce qui rendait la reinstallation
  // instable : `installTap` fait `invalidate()` puis remplace le processeur, dont
  // le `dealloc` libere le DSP, alors que le tap d'avant pouvait encore
  // appeler `tapProcess`. Le `CFRelease` ici bloque jusqu'a ce qu'aucun callback
  // ne puisse plus courir, donc jusqu'a ce que la liberation du DSP soit sur.
  const invalidatePattern = /- \(void\)invalidate \{[\s\S]*?\n\}\n\n- \(void\)dealloc/;
  const invalidateMatch = tapSource.match(invalidatePattern);
  if (!invalidateMatch) {
    throw new Error(`[audio-equalizer] Could not find iOS tap invalidation function in ${tapSourcePath}`);
  }
  // ⚠ Garde INDISPENSABLE, et le meme piege que pour `dealloc` quelques lignes
  // plus haut.
  //
  // Ce remplacement n'etait PAS conditionne. Sur un arbre deja patche, il
  // reappliquait donc son tableau a chaque execution : chaque passage
  // reinjectait un `CFRelease` supplementaire dans `invalidate`, qui en
  // accumulait jusqu'a libere le tap plusieurs fois — un over-release, qui
  // crash aussitot, sur un chemin different de celui qu'on cherchait a
  // corriger.
  //
  // Detecte via le corps du motif, comme pour `dealloc` : une recherche globale
  // verrait le `CFRelease` du dealloc et croirait l'invalidate deja corrige.
  if (!invalidateMatch[0].includes('CFRelease(_audioProcessingTap)')) {
    tapSource = tapSource.replace(
      invalidatePattern,
      [
        '- (void)invalidate {',
        '  os_unfair_lock_lock(&_lock);',
        '',
        '  _isInvalidated = YES;',
        '  self.sampleBufferCallback = nil;',
        '',
        '  if (_isTapInstalled) {',
        '    [_player.currentItem setAudioMix:nil];',
        '    _isTapInstalled = NO;',
        '',
        '    if (_audioProcessingTap) {',
        '      AVAudioTapProcessorContext *context = (AVAudioTapProcessorContext *)MTAudioProcessingTapGetStorage(_audioProcessingTap);',
        '      if (context) {',
        '        context->isValid = NO;',
        '        context->self = NULL;',
        '      }',
        '      CFRelease(_audioProcessingTap);',
        '      _audioProcessingTap = NULL;',
        '    }',
        '  }',
        '',
        '  os_unfair_lock_unlock(&_lock);',
        '}',
        '',
        '- (void)dealloc'
      ].join('\n')
    );
  }
  // `uninstallTap` fait `_audioProcessingTap = NULL` SANS jamais liberer le
  // tap : la reference part, l objet reste vivant cote CoreMedia. Le
  // `dealloc` qui suit alors (`installTap` invalide puis remplace le
  // processeur) detruit le DSP pendant que ce tap peut encore appeler
  // `tapProcess` — qui passe par `context->self`, un `__bridge` non retenu.
  // C'est la fuite qui rend le use-after-free possible, et elle vient
  // d'AMONT, pas du patch.
  //
  // Le `CFRelease` attend la chute a zero de la reference : quand il rend la
  // main, plus aucun callback ne peut courir, donc `MASAudioDSPDestroy` peut
  // suivre sans risque.
  const uninstallPattern = /- \(void\)uninstallTap \{[\s\S]*?\n\}/;
  const uninstallMatch = tapSource.match(uninstallPattern);
  if (!uninstallMatch) {
    throw new Error(`[audio-equalizer] Could not find iOS uninstallTap in ${tapSourcePath}`);
  }
  if (!uninstallMatch[0].includes('CFRelease(_audioProcessingTap)')) {
    tapSource = tapSource.replace(
      uninstallPattern,
      [
        '- (void)uninstallTap {',
        '  os_unfair_lock_lock(&_lock);',
        '',
        '  if (_isTapInstalled && !_isInvalidated) {',
        '    [_player.currentItem setAudioMix:nil];',
        '    _isTapInstalled = NO;',
        '',
        '    if (_audioProcessingTap) {',
        '      AVAudioTapProcessorContext *context = (AVAudioTapProcessorContext *)MTAudioProcessingTapGetStorage(_audioProcessingTap);',
        '      if (context) {',
        '        context->isValid = NO;',
        '        context->self = NULL;',
        '      }',
        '      CFRelease(_audioProcessingTap);',
        '      _audioProcessingTap = NULL;',
        '    }',
        '  }',
        '',
        '  os_unfair_lock_unlock(&_lock);',
        '}'
      ].join('\n')
    );
  }
  const tapPreparePattern = /void tapPrepare\([^\n]*\) \{[\s\S]*?\n\}\n\nvoid tapProcess/;
  if (!tapPreparePattern.test(tapSource)) {
    throw new Error(`[audio-equalizer] Could not find iOS tap preparation function in ${tapSourcePath}`);
  }
  tapSource = tapSource.replace(
    tapPreparePattern,
    `void tapPrepare(MTAudioProcessingTapRef tap, CMItemCount maxFrames, const AudioStreamBasicDescription *processingFormat) {
  AVAudioTapProcessorContext *context = (AVAudioTapProcessorContext *)MTAudioProcessingTapGetStorage(tap);
  if (!context) {
    return;
  }
  context->supportedTapProcessingFormat = processingFormat->mFormatID == kAudioFormatLinearPCM && (processingFormat->mFormatFlags & kAudioFormatFlagIsFloat);
  context->isNonInterleaved = (processingFormat->mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0;
  if (!context->supportedTapProcessingFormat) {
    NSLog(@"Audio equalizer requires floating-point linear PCM.");
  }
  if (context->self) {
    AudioTapProcessor *processor = (__bridge AudioTapProcessor *)context->self;
    [processor setSampleRate:processingFormat->mSampleRate];
  }
}

void tapProcess`
  );
  const tapProcessPattern = /void tapProcess\([^\n]*\) \{[\s\S]*?\n\}\n\n\n@end/;
  if (!tapProcessPattern.test(tapSource)) {
    throw new Error(`[audio-equalizer] Could not find iOS tap process function in ${tapSourcePath}`);
  }
  tapSource = tapSource.replace(
    tapProcessPattern,
    `void tapProcess(MTAudioProcessingTapRef tap, CMItemCount numberFrames, MTAudioProcessingTapFlags flags, AudioBufferList *bufferListInOut, CMItemCount *numberFramesOut, MTAudioProcessingTapFlags *flagsOut) {
  AVAudioTapProcessorContext *context = (AVAudioTapProcessorContext *)MTAudioProcessingTapGetStorage(tap);
  OSStatus status = MTAudioProcessingTapGetSourceAudio(tap, numberFrames, bufferListInOut, flagsOut, NULL, numberFramesOut);
  if (status != noErr || !context || !context->isValid || !context->self) {
    return;
  }

  AudioTapProcessor *processor = (__bridge AudioTapProcessor *)context->self;
  if (context->supportedTapProcessingFormat) {
    // ⚠ Accesor C, PAS la propriete processor.dspState. Lire la propriete
    // serait un message send a objc_msgSend vers un objet engage dans
    // dealloc, ce qui est indefini et tue le process sur le thread de rendu.
    MASAudioDSPProcess(MASAudioDSPGetState(processor), bufferListInOut, *numberFramesOut, context->isNonInterleaved);
  }

  SampleBufferCallback callback = processor.sampleBufferCallback;
  if (callback && context->supportedTapProcessingFormat && bufferListInOut && bufferListInOut->mNumberBuffers > 0) {
    callback(&bufferListInOut->mBuffers[0], (long)*numberFramesOut, 0.0);
  }
}


@end`
  );
  fs.writeFileSync(tapSourcePath, tapSource, 'utf8');

    const newSetDSPFunc = '  func setDSP(enabled: Bool, bands: [Double], preamp: Double, balance: Double, stereo: Double, limit: Bool, reverb: [Double]) {\n' +
      '    equalizerEnabled = enabled\n' +
      '    equalizerBands = (0..<10).map { index in\n' +
      '      guard index < bands.count, bands[index].isFinite else { return 0 }\n' +
      '      return max(-12, min(12, bands[index]))\n' +
      '    }\n' +
      '    equalizerPreamp = preamp.isFinite ? max(-6, min(6, preamp)) : 0\n' +
      '    dspBalance = balance\n' +
      '    dspStereo = stereo\n' +
      '    dspLimit = limit\n' +
      '    let revEnabled = reverb.count > 0 && reverb[0] > 0.5\n' +
      '    dspReverb = revEnabled\n' +
      '    dspRoom = reverb.count > 1 ? reverb[1] : 40.0\n' +
      '    dspDamp = reverb.count > 2 ? reverb[2] : 50.0\n' +
      '    dspMix = reverb.count > 3 ? reverb[3] : 25.0\n' +
      '    audioProcessor?.setDSPEnabled(equalizerEnabled, bands: equalizerBands.map { NSNumber(value: $0) }, preamp: equalizerPreamp, balance: dspBalance, stereo: dspStereo, limit: dspLimit, reverb: dspReverb, room: dspRoom, damp: dspDamp, mix: dspMix)\n' +
      '    updateAudioTap()\n' +
      '  }\n\n' +
      '  private func updateAudioTap() {\n' +
      '    let hasDsp = equalizerEnabled || dspBalance != 0.0 || dspStereo != 0.0 || dspLimit || dspReverb\n' +
      '    guard hasDsp || samplingEnabled else {\n' +
      '      shouldInstallAudioTap = false\n' +
      '      uninstallTap()\n' +
      '      return\n' +
      '    }\n' +
      '    if isLoaded {\n' +
      '      installTap()\n' +
      '    } else {\n' +
      '      shouldInstallAudioTap = true\n' +
      '    }\n' +
      '  }';

    const oldSetDSPPattern = /  func setDSP\(enabled: Bool, bands: \[Double\], preamp: Double, balance: Double, stereo: Double, limit: Bool, reverb: Bool, room: Double, damp: Double, mix: Double\) \{[\s\S]*?\n  private func updateAudioTap\(\) \{[\s\S]*?\n  \}/;

    if (oldSetDSPPattern.test(player)) {
      player = player.replace(oldSetDSPPattern, newSetDSPFunc);
    } else if (!player.includes('func setDSP(enabled: Bool, bands: [Double], preamp: Double, balance: Double, stereo: Double, limit: Bool, reverb: [Double])')) {
      player = player.replace(
        '  var samplingEnabled = false\n',
        '  var samplingEnabled = false\n  private var equalizerEnabled = false\n  private var equalizerBands = [Double](repeating: 0, count: 10)\n  private var equalizerPreamp = 0.0\n  private var dspBalance = 0.0\n  private var dspStereo = 0.0\n  private var dspLimit = false\n  private var dspReverb = false\n  private var dspRoom = 0.0\n  private var dspDamp = 0.0\n  private var dspMix = 0.0\n'
      );
      player = player.replace(
        /  func setSamplingEnabled\(enabled: Bool\) \{[\s\S]*?\n  \}/,
        '  func setSamplingEnabled(enabled: Bool) {\n    guard samplingEnabled != enabled else { return }\n    samplingEnabled = enabled\n    updateAudioTap()\n  }\n\n' + newSetDSPFunc
      );
    }
    player = player.replace(
      'if shouldInstallAudioTap || samplingEnabled {',
      'if shouldInstallAudioTap || samplingEnabled || equalizerEnabled {'
    );
    player = player.replace(
      'if self.samplingEnabled && self.isLoaded {',
      'if (self.samplingEnabled || self.equalizerEnabled) && self.isLoaded {'
    );
    player = player.replace(
      /let wasSamplingEnabled = samplingEnabled\b/g,
      'let wasSamplingEnabled = samplingEnabled || equalizerEnabled'
    );
    player = player.replace(
      'if samplingEnabled {\n      uninstallTap()',
      'if samplingEnabled || equalizerEnabled {\n      uninstallTap()'
    );
    player = player.replace(
      '    guard audioProcessor?.isTapInstalled != true else {\n      tapInstalled = true',
      '    audioProcessor?.setDSPEnabled(equalizerEnabled, bands: equalizerBands.map { NSNumber(value: $0) }, preamp: equalizerPreamp, balance: dspBalance, stereo: dspStereo, limit: dspLimit, reverb: dspReverb, room: dspRoom, damp: dspDamp, mix: dspMix)\n\n    guard audioProcessor?.isTapInstalled != true else {\n      tapInstalled = true'
    );
    player = player.replace(
      '    audioProcessor = AudioTapProcessor(player: ref)\n    let success',
      '    audioProcessor = AudioTapProcessor(player: ref)\n    audioProcessor?.setDSPEnabled(equalizerEnabled, bands: equalizerBands.map { NSNumber(value: $0) }, preamp: equalizerPreamp, balance: dspBalance, stereo: dspStereo, limit: dspLimit, reverb: dspReverb, room: dspRoom, damp: dspDamp, mix: dspMix)\n    let success'
    );

    if (!player.includes('func setDSP(enabled: Bool') ||
      !player.includes('audioProcessor?.setDSPEnabled(equalizerEnabled, bands: equalizerBands.map { NSNumber(value: $0) }, preamp: equalizerPreamp, balance: dspBalance, stereo: dspStereo, limit: dspLimit, reverb: dspReverb, room: dspRoom, damp: dspDamp, mix: dspMix)')) {
      throw new Error(`[audio-equalizer] Could not patch iOS AudioPlayer in ${playerPath}`);
    }
  player = player.replace(
    /if samplingEnabled \{\n\s*uninstallTap\(\)/g,
    'if (samplingEnabled || equalizerEnabled) {\n      uninstallTap()'
  );
  player = player.replace(
    /let wasSamplingEnabled = samplingEnabled(?: \|\| equalizerEnabled)*/g,
    'let wasSamplingEnabled = samplingEnabled || equalizerEnabled'
  );
  fs.writeFileSync(playerPath, player, 'utf8');

  let moduleContent = fs.readFileSync(modulePath, 'utf8');
  moduleContent = moduleContent.replace(
    /\n[ \t]*Function\("setEqualizer"\) \{[^\n]*\n[\s\S]*?\n[ \t]*\}/g,
    ''
  );
  moduleContent = moduleContent.replace(
    /\n[ \t]*Function\("setDSP"\) \{[^\n]*\n[\s\S]*?\n[ \t]*\}/g,
    ''
  );
  const samplingAnchor = '      Function("setAudioSamplingEnabled")';
  if (!moduleContent.includes(samplingAnchor)) {
    throw new Error(`[audio-equalizer] Could not find iOS AudioPlayer API insertion point in ${modulePath}`);
  }
  moduleContent = moduleContent.replace(
    samplingAnchor,
    '      Function("setDSP") { (player: AudioPlayer, enabled: Bool, bands: [Double], preamp: Double, balance: Double, stereo: Double, limit: Bool, reverb: [Double]) in\n        player.setDSP(enabled: enabled, bands: bands, preamp: preamp, balance: balance, stereo: stereo, limit: limit, reverb: reverb)\n      }\n\n' + samplingAnchor
  );
  fs.writeFileSync(modulePath, moduleContent, 'utf8');
}

if (!fs.existsSync(androidRoot) || !fs.existsSync(iosRoot)) {
  throw new Error('[audio-equalizer] expo-audio native sources are missing; install dependencies before patching.');
}

patchAndroid();
patchIos();
console.log('[audio-equalizer] Native Android and iOS equalizers installed.');
