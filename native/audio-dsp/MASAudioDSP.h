#import <AudioToolbox/AudioToolbox.h>
#import <Foundation/Foundation.h>

typedef struct MASAudioDSPState MASAudioDSPState;

MASAudioDSPState *MASAudioDSPCreate(void);
void MASAudioDSPDestroy(MASAudioDSPState *state);
void MASAudioDSPSetParameters(MASAudioDSPState *state, BOOL enabled, NSArray<NSNumber *> *bands, double preamp, double balance, double stereoExpansion, BOOL limitEnabled, BOOL reverbEnabled, double roomSize, double damping, double reverbMix);
void MASAudioDSPSetSampleRate(MASAudioDSPState *state, double sampleRate);
void MASAudioDSPProcess(MASAudioDSPState *state, AudioBufferList *bufferList, CMItemCount frameCount, BOOL nonInterleaved);
