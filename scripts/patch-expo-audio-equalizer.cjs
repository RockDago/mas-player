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
  const samplingAnchor = '      Function("setAudioSamplingEnabled")';
  if (!moduleContent.includes(samplingAnchor)) {
    throw new Error(`[audio-equalizer] Could not find Android AudioPlayer API insertion point in ${modulePath}`);
  }
  if (!moduleContent.includes('Function("setDSP")')) {
    moduleContent = moduleContent.replace(
      samplingAnchor,
      '      Function("setDSP") { _: AudioPlayer, enabled: Boolean, bands: List<Double>, preamp: Double, balance: Double, stereo: Double, limit: Boolean, reverb: Boolean, room: Double, damp: Double, mix: Double ->\n        expo.modules.audiodsp.AudioDSPProcessor.update(enabled, bands, preamp, balance, stereo, limit, reverb, room, damp, mix)\n      }\n\n' + samplingAnchor
    );
  }
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
      '@property (nonatomic, readonly) BOOL isTapInstalled;\n@property (nonatomic, readonly) MASAudioDSPState *dspState;\n- (void)setDSPEnabled:(BOOL)enabled bands:(NSArray<NSNumber *> *)bands preamp:(double)preamp balance:(double)balance stereo:(double)stereo limit:(BOOL)limit reverb:(BOOL)reverb room:(double)room damp:(double)damp mix:(double)mix;\n- (void)setSampleRate:(double)sampleRate;'
    );
    fs.writeFileSync(tapHeaderPath, header, 'utf8');
  }

  let tapSource = fs.readFileSync(tapSourcePath, 'utf8');
  if (!tapSource.includes('#import "MASAudioDSP.h"')) {
    tapSource = tapSource.replace(
      '#import "AudioTapProcessor.h"',
      '#import "AudioTapProcessor.h"\n#import "MASAudioDSP.h"'
    );
  }
  if (!tapSource.includes('_dspState = MASAudioDSPCreate()')) {
    tapSource = tapSource.replace(
      '  _audioProcessingTap = NULL;\n',
      '  _audioProcessingTap = NULL;\n    _dspState = MASAudioDSPCreate();\n'
    );
    tapSource = tapSource.replace(
      '- (BOOL)isTapInstalled {',
      '- (void)setDSPEnabled:(BOOL)enabled bands:(NSArray<NSNumber *> *)bands preamp:(double)preamp balance:(double)balance stereo:(double)stereo limit:(BOOL)limit reverb:(BOOL)reverb room:(double)room damp:(double)damp mix:(double)mix {\n  MASAudioDSPSetParameters(_dspState, enabled, bands, preamp, balance, stereo, limit, reverb, room, damp, mix);\n}\n\n- (void)setSampleRate:(double)sampleRate {\n  MASAudioDSPSetSampleRate(_dspState, sampleRate);\n}\n\n- (BOOL)isTapInstalled {'
    );
    tapSource = tapSource.replace(
      '- (void)dealloc {\n  [self invalidate];\n}',
      '- (void)dealloc {\n  [self invalidate];\n  MASAudioDSPDestroy(_dspState);\n  _dspState = NULL;\n}'
    );
  }
  tapSource = tapSource.replace(
    'context->supportedTapProcessingFormat = true;',
    'context->supportedTapProcessingFormat = processingFormat->mFormatID == kAudioFormatLinearPCM && (processingFormat->mFormatFlags & kAudioFormatFlagIsFloat);'
  );
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
    MASAudioDSPProcess(processor.dspState, bufferListInOut, *numberFramesOut, context->isNonInterleaved);
  }

  SampleBufferCallback callback = processor.sampleBufferCallback;
  if (callback && context->supportedTapProcessingFormat && bufferListInOut && bufferListInOut->mNumberBuffers > 0) {
    callback(&bufferListInOut->mBuffers[0], (long)*numberFramesOut, 0.0);
  }
}


@end`
  );
  fs.writeFileSync(tapSourcePath, tapSource, 'utf8');

  let player = fs.readFileSync(playerPath, 'utf8');
  if (!player.includes('func setDSP(enabled: Bool')) {
    player = player.replace(
      '  var samplingEnabled = false\n',
      '  var samplingEnabled = false\n  private var equalizerEnabled = false\n  private var equalizerBands = [Double](repeating: 0, count: 10)\n  private var equalizerPreamp = 0.0\n  private var dspBalance = 0.0\n  private var dspStereo = 0.0\n  private var dspLimit = false\n  private var dspReverb = false\n  private var dspRoom = 0.0\n  private var dspDamp = 0.0\n  private var dspMix = 0.0\n'
    );
    player = player.replace(
      /  func setSamplingEnabled\(enabled: Bool\) \{[\s\S]*?\n  \}/,
      '  func setSamplingEnabled(enabled: Bool) {\n    guard samplingEnabled != enabled else { return }\n    samplingEnabled = enabled\n    updateAudioTap()\n  }\n\n  func setDSP(enabled: Bool, bands: [Double], preamp: Double, balance: Double, stereo: Double, limit: Bool, reverb: Bool, room: Double, damp: Double, mix: Double) {\n    equalizerEnabled = enabled\n    equalizerBands = (0..<10).map { index in\n      guard index < bands.count, bands[index].isFinite else { return 0 }\n      return max(-12, min(12, bands[index]))\n    }\n    equalizerPreamp = preamp.isFinite ? max(-6, min(6, preamp)) : 0\n    dspBalance = balance\n    dspStereo = stereo\n    dspLimit = limit\n    dspReverb = reverb\n    dspRoom = room\n    dspDamp = damp\n    dspMix = mix\n    audioProcessor?.setDSPEnabled(equalizerEnabled, bands: equalizerBands.map { NSNumber(value: $0) }, preamp: equalizerPreamp, balance: dspBalance, stereo: dspStereo, limit: dspLimit, reverb: dspReverb, room: dspRoom, damp: dspDamp, mix: dspMix)\n    updateAudioTap()\n  }\n\n  private func updateAudioTap() {\n    let hasDsp = equalizerEnabled || dspBalance != 0.0 || dspStereo != 0.0 || dspLimit || dspReverb\n    guard hasDsp || samplingEnabled else {\n      shouldInstallAudioTap = false\n      uninstallTap()\n      return\n    }\n    if isLoaded {\n      installTap()\n    } else {\n      shouldInstallAudioTap = true\n    }\n  }'
    );
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
const samplingAnchor = '      Function("setAudioSamplingEnabled")';
if (!moduleContent.includes(samplingAnchor)) {
  throw new Error(`[audio-equalizer] Could not find iOS AudioPlayer API insertion point in ${modulePath}`);
}
if (!moduleContent.includes('Function("setDSP")')) {
  moduleContent = moduleContent.replace(
    samplingAnchor,
    '      Function("setDSP") { (player: AudioPlayer, enabled: Bool, bands: [Double], preamp: Double, balance: Double, stereo: Double, limit: Bool, reverb: Bool, room: Double, damp: Double, mix: Double) in\n        player.setDSP(enabled: enabled, bands: bands, preamp: preamp, balance: balance, stereo: stereo, limit: limit, reverb: reverb, room: room, damp: damp, mix: mix)\n      }\n\n' + samplingAnchor
  );
}
fs.writeFileSync(modulePath, moduleContent, 'utf8');
}

if (!fs.existsSync(androidRoot) || !fs.existsSync(iosRoot)) {
  throw new Error('[audio-equalizer] expo-audio native sources are missing; install dependencies before patching.');
}

patchAndroid();
patchIos();
console.log('[audio-equalizer] Native Android and iOS equalizers installed.');
