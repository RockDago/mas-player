#import "MASAudioDSP.h"
#import <math.h>
#import <os/lock.h>
#import <stdlib.h>
#import <string.h>

static const double MASAudioDSPFrequencies[] = {
  31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0
};
static const NSUInteger MASAudioDSPBandCount = 10;

/**
 * Delai moyen des 4 peignes, en secondes (44,1 kHz : 1116, 1188, 1277, 1356).
 *
 * C'est ce delai qui commande la decroissance : `RT60 = -D·ln(1000)/ln(fb)`.
 * Il doit entrer dans la conversion knob -> feedback, sinon le RT60 demande
 * n'est pas celui qu'on obtient. Lu par `sync-check.cjs`, qui échoue si la
 * constante change d'un côté et pas de l'autre.
 */
static const double MASAudioDSPCombDelaySeconds = 0.0280;

/**
 * Normalisation appliquee au wet apres la somme des 4 peignes.
 *
 * Quatre peignes en parallele ont un gain de boucle qui diverge quand `fb`
 * approche 1 : sans cette division, le knob Room *ajoutait* du niveau au lieu
 * d'elargir la piece, et la queue ne redescendait jamais (mesure : 9,6 s a fond,
 * avec +4,5 dB de pic sur le seul wet). 1/4 ramene ce gain sous 0 dB pour toute
 * la plage du knob. C'est l'equivalent de la compensation de gain du Freeverb
 * canonique (`damp * roomscale * 0.5`), absente de cette implementation.
 */
static const double MASAudioDSPCombNormalization = 0.25;

typedef struct {
  double b0, b1, b2, a1, a2, z1, z2;
} MASAudioDSPBiquad;

// Simple delay line struct for reverb
typedef struct {
  double *buffer;
  int length;
  int index;
  // `calloc` peut échouer ; sans ce drapeau, `DelayLineProcessComb` déréférence
  // un NULL sur le thread de rendu — un segment SIGSEGV qui tue le process
  // entier, sans exception rattrapable.
  BOOL allocated;
} DelayLine;

struct MASAudioDSPState {
  os_unfair_lock lock;
  BOOL enabled;
  BOOL hasProcessing;
  double sampleRate;
  
  // EQ
  double gains[10];
  double preamp;
  double linearPreamp;
  MASAudioDSPBiquad filters[10];
  MASAudioDSPBiquad channelStates[2][10]; // 0=L, 1=R (assuming stereo max)

  // Balance & Stereo
  double balance;
  double stereoExpansion;
  
  // Limit
  BOOL limitEnabled;

  // Reverb
  BOOL reverbEnabled;
  double roomSize;
  double damping;
  double reverbMix;
  
  // Delay lines for basic reverb (Comb filters)
  DelayLine combsL[4];
  DelayLine combsR[4];
  DelayLine allpassesL[2];
  DelayLine allpassesR[2];
};

static void DelayLineInit(DelayLine *dl, int length) {
    dl->length = length > 0 ? length : 1;
    dl->index = 0;
    dl->buffer = calloc((size_t)dl->length, sizeof(double));
    dl->allocated = (dl->buffer != NULL);
}

static void DelayLineFree(DelayLine *dl) {
    if (dl->buffer) free(dl->buffer);
    dl->buffer = NULL;
    dl->allocated = NO;
    dl->length = 0;
    dl->index = 0;
}

static double DelayLineProcessComb(DelayLine *dl, double input, double feedback, double damp, double *store) {
    if (!dl->allocated || dl->length <= 0) return 0.0;
    double output = dl->buffer[dl->index];
    *store = (output * (1.0 - damp)) + (*store * damp);
    dl->buffer[dl->index] = input + (*store * feedback);
    dl->index = (dl->index + 1) % dl->length;
    return output;
}

static double DelayLineProcessAllpass(DelayLine *dl, double input) {
    if (!dl->allocated || dl->length <= 0) return 0.0;
    double bufout = dl->buffer[dl->index];
    double output = -input + bufout;
    dl->buffer[dl->index] = input + (bufout * 0.5);
    dl->index = (dl->index + 1) % dl->length;
    return output;
}

static void MASAudioDSPUpdateCoefficients(MASAudioDSPState *state) {
  const double sampleRate = fmax(8000.0, state->sampleRate);
  for (NSUInteger index = 0; index < MASAudioDSPBandCount; index++) {
    const double frequency = fmin(MASAudioDSPFrequencies[index], sampleRate * 0.49);
    const double amplitude = pow(10.0, state->gains[index] / 40.0);
    const double omega = 2.0 * M_PI * frequency / sampleRate;
    const double alpha = sin(omega) / (2.0 * 1.41421356237); // Q=0.707
    const double cosine = cos(omega);
    const double a0 = 1.0 + alpha / amplitude;
    
    state->filters[index].b0 = (1.0 + alpha * amplitude) / a0;
    state->filters[index].b1 = (-2.0 * cosine) / a0;
    state->filters[index].b2 = (1.0 - alpha * amplitude) / a0;
    state->filters[index].a1 = (-2.0 * cosine) / a0;
    state->filters[index].a2 = (1.0 - alpha / amplitude) / a0;
  }
}

MASAudioDSPState *MASAudioDSPCreate(void) {
  MASAudioDSPState *state = calloc(1, sizeof(MASAudioDSPState));
  if (!state) return NULL;
  
  state->lock = OS_UNFAIR_LOCK_INIT;
  state->sampleRate = 44100.0;
  MASAudioDSPUpdateCoefficients(state);
  
  // Init simple reverb delay lines (lengths scaled for 44.1kHz roughly)
  DelayLineInit(&state->combsL[0], 1116);
  DelayLineInit(&state->combsL[1], 1188);
  DelayLineInit(&state->combsL[2], 1277);
  DelayLineInit(&state->combsL[3], 1356);
  DelayLineInit(&state->combsR[0], 1116+23);
  DelayLineInit(&state->combsR[1], 1188+23);
  DelayLineInit(&state->combsR[2], 1277+23);
  DelayLineInit(&state->combsR[3], 1356+23);
  
  DelayLineInit(&state->allpassesL[0], 225);
  DelayLineInit(&state->allpassesL[1], 341);
  DelayLineInit(&state->allpassesR[0], 225+23);
  DelayLineInit(&state->allpassesR[1], 341+23);
  
  return state;
}

void MASAudioDSPDestroy(MASAudioDSPState *state) {
  if (state) {
    for (int i=0; i<4; i++) { DelayLineFree(&state->combsL[i]); DelayLineFree(&state->combsR[i]); }
    for (int i=0; i<2; i++) { DelayLineFree(&state->allpassesL[i]); DelayLineFree(&state->allpassesR[i]); }
    free(state);
  }
}

void MASAudioDSPSetParameters(MASAudioDSPState *state, BOOL enabled, NSArray<NSNumber *> *bands, double preamp, double balance, double stereoExpansion, BOOL limitEnabled, BOOL reverbEnabled, double roomSize, double damping, double reverbMix) {
  if (!state) return;
  os_unfair_lock_lock(&state->lock);
  
  state->enabled = enabled;
  state->preamp = isfinite(preamp) ? fmax(-6.0, fmin(6.0, preamp)) : 0.0;
  state->linearPreamp = pow(10.0, state->preamp / 20.0);
  
  state->balance = isfinite(balance) ? fmax(-1.0, fmin(1.0, balance)) : 0.0;
  state->stereoExpansion = isfinite(stereoExpansion) ? fmax(-1.0, fmin(1.0, stereoExpansion)) : 0.0;
  state->limitEnabled = limitEnabled;
  
  state->reverbEnabled = reverbEnabled;
  state->roomSize = isfinite(roomSize) ? fmax(0.0, fmin(100.0, roomSize))/100.0 : 0.0;
  state->damping = isfinite(damping) ? fmax(0.0, fmin(100.0, damping))/100.0 : 0.0;
  state->reverbMix = isfinite(reverbMix) ? fmax(0.0, fmin(100.0, reverbMix))/100.0 : 0.0;

  BOOL hasEq = state->enabled && (state->preamp != 0.0);
  for (NSUInteger index = 0; index < MASAudioDSPBandCount; index++) {
    double gain = index < bands.count ? bands[index].doubleValue : 0.0;
    state->gains[index] = isfinite(gain) ? fmax(-12.0, fmin(12.0, gain)) : 0.0;
    hasEq = hasEq || (state->enabled && state->gains[index] != 0.0);
  }
  state->hasProcessing = hasEq || state->balance != 0.0 || state->stereoExpansion != 0.0 || state->limitEnabled || state->reverbEnabled;
  
  MASAudioDSPUpdateCoefficients(state);
  os_unfair_lock_unlock(&state->lock);
}

void MASAudioDSPSetSampleRate(MASAudioDSPState *state, double sampleRate) {
  if (!state || !isfinite(sampleRate) || sampleRate <= 0.0) return;
  os_unfair_lock_lock(&state->lock);
  state->sampleRate = sampleRate;
  MASAudioDSPUpdateCoefficients(state);
  os_unfair_lock_unlock(&state->lock);
}

// Biquad process
static double MASAudioDSPFilterSample(MASAudioDSPState *state, NSUInteger channel, double sample) {
  double output = sample;
  for (NSUInteger i = 0; i < MASAudioDSPBandCount; i++) {
    if (state->gains[i] == 0.0) continue;
    MASAudioDSPBiquad *f = &state->filters[i];
    MASAudioDSPBiquad *s = &state->channelStates[channel][i];
    double out = (f->b0 * output) + s->z1;
    s->z1 = (f->b1 * output) - (f->a1 * out) + s->z2;
    s->z2 = (f->b2 * output) - (f->a2 * out);
    output = out;
  }
  return output;
}

// Global damp states for reverb
static double dampStateL[4] = {0};
static double dampStateR[4] = {0};

void MASAudioDSPProcess(MASAudioDSPState *state, AudioBufferList *bufferList, MASFrameCount frameCount, BOOL nonInterleaved) {
  if (!state || !state->hasProcessing) return;
  if (!bufferList || bufferList->mNumberBuffers == 0) return;

  os_unfair_lock_lock(&state->lock);

  double preamp = state->enabled ? state->linearPreamp : 1.0;
  double balL = state->balance < 0 ? 1.0 : (1.0 - state->balance);
  double balR = state->balance > 0 ? 1.0 : (1.0 + state->balance);
  double stereo = state->stereoExpansion;
  BOOL limit = state->limitEnabled;
  BOOL reverb = state->reverbEnabled;
  
  // Loi de duree : le knob pilote un RT60 de 0,30 s a 4,00 s (cf.
  // `reverbRt60Seconds` dans src/constants/presets.ts, la meme loi que
  // celle affichee dans l'interface et appliquee par le moteur web).
  //
  // La version anterieure derivait le feedback directement du knob
  // (`roomSize * 0.28 + 0.7`) sans jamais borne le RT60 obtenu : a fond
  // la queue mesurait 9,6 s.
  //
  // ⚠ Le RT60 d'un peigne n'est PAS `exp(-6,908/RT60)` : cela ne tient que si
  // une boucle dure exactement 1 s. Or un peigne de ce reseau mesure ~28 ms
  // (1116 a 1356 echantillons a 44,1 kHz), donc la boucle qui decide de la
  // decroissance fait ~36 tours en 1 s. Sans le delai, room 100 % donnait
  // fb = 0,963 et un RT60 reel de 0,14 s au lieu de 4 s — soit un reverb
  // inexistant, le symptome exact dont l'utilisateur se plaignait.
  //
  // D'ou le facteur MASAudioDSPCombDelaySeconds dans la conversion :
  // `fb = exp(-ln(1000) * D / RT60)`.
  const double rt60 = 0.3 + (4.0 - 0.3) * pow(state->roomSize, 1.6);
  double roomSize = fmin(
      0.98,
      exp(-log(1000.0) * MASAudioDSPCombDelaySeconds / fmax(0.01, rt60)));
  double damp = state->damping * 0.4;
  double mix = state->reverbMix * 0.5; // Max 50% wet

  // Le wet est normalise par `MASAudioDSPCombNormalization` (0.25) juste apres
  // la somme des 4 peignes — voir le commentaire a cet endroit. C'est cette
  // normalisation qui remplace la compensation par `1/(1-fb)` : elle borne le
  // gain du reseau a -12 dB quelle que soit la taille de la piece, sans
  // introduire de division ni dependre du feedback.

  if (nonInterleaved && bufferList->mNumberBuffers >= 2) {
    float *leftChannel = (float *)bufferList->mBuffers[0].mData;
    float *rightChannel = (float *)bufferList->mBuffers[1].mData;

    // Le tap peut rendre une liste vide ou tronquée (début/fin de piste,
    // reprise apres interruption). Sans ce garde, `leftChannel[i]` dereference
    // NULL ou sort du tampon — SIGSEGV sur le thread de rendu, qui tue le
    // process entier. Le nombre de trames est borne par ce que le tampon
    // contient reellement, pas par ce que le tap annonce.
    if (leftChannel == NULL || rightChannel == NULL) {
      os_unfair_lock_unlock(&state->lock);
      return;
    }
    const MASFrameCount maxFrames = (MASFrameCount)MIN(
        (uint64_t)frameCount,
        MIN((uint64_t)(bufferList->mBuffers[0].mDataByteSize / sizeof(float)),
            (uint64_t)(bufferList->mBuffers[1].mDataByteSize / sizeof(float))));

    for (ItemCount i = 0; i < maxFrames; i++) {
      double l = leftChannel[i] * preamp;
      double r = rightChannel[i] * preamp;

      // EQ
      if (state->enabled) {
        l = MASAudioDSPFilterSample(state, 0, l);
        r = MASAudioDSPFilterSample(state, 1, r);
      }

      // Stereo Expansion (Mid-Side)
      if (stereo != 0.0) {
          double m = (l + r) * 0.5;
          double s = (l - r) * 0.5;
          s *= (1.0 + stereo);
          l = m + s;
          r = m - s;
      }

      // Balance
      l *= balL;
      r *= balR;

      // Reverb (Simple Freeverb)
      if (reverb) {
          double outL = 0, outR = 0;
          for (int c=0; c<4; c++) {
              outL += DelayLineProcessComb(&state->combsL[c], l, roomSize, damp, &dampStateL[c]);
              outR += DelayLineProcessComb(&state->combsR[c], r, roomSize, damp, &dampStateR[c]);
          }
          // Normalisation du wet : voir MASAudioDSPCombNormalization. Elle
          // borne le gain du reseau de peignes, que la somme des 4 laissait
          // diverger quand le feedback montait.
          outL *= MASAudioDSPCombNormalization;
          outR *= MASAudioDSPCombNormalization;
          for (int a=0; a<2; a++) {
              outL = DelayLineProcessAllpass(&state->allpassesL[a], outL);
              outR = DelayLineProcessAllpass(&state->allpassesR[a], outR);
          }
          l = (l * (1.0 - mix)) + (outL * mix);
          r = (r * (1.0 - mix)) + (outR * mix);
      }

      // Limiter (Soft clip)
      if (limit) {
          l = l > 1.0 ? 1.0 : (l < -1.0 ? -1.0 : l); // Hard clip as fallback
          r = r > 1.0 ? 1.0 : (r < -1.0 ? -1.0 : r);
      }

      leftChannel[i] = (float)l;
      rightChannel[i] = (float)r;
    }
  } else if (!nonInterleaved && bufferList->mNumberBuffers == 1) {
    float *data = (float *)bufferList->mBuffers[0].mData;
    NSUInteger channels = bufferList->mBuffers[0].mNumberChannels;

    // Meme garde que dans le cas non entrelace : `data` peut etre NULL, et
    // `mNumberChannels` peut valoir plus que ce que le tampon contient
    // effectivement. `mDataByteSize` borne l'ecriture a la zone reellement
    // allouee.
    if (data == NULL || channels < 2) {
      os_unfair_lock_unlock(&state->lock);
      return;
    }
    const MASFrameCount maxFrames = (MASFrameCount)MIN(
        (uint64_t)frameCount,
        (uint64_t)(bufferList->mBuffers[0].mDataByteSize / (sizeof(float) * channels)));

    if (channels >= 2) {
      for (ItemCount i = 0; i < maxFrames; i++) {
        double l = data[i * channels] * preamp;
        double r = data[i * channels + 1] * preamp;

        if (state->enabled) {
          l = MASAudioDSPFilterSample(state, 0, l);
          r = MASAudioDSPFilterSample(state, 1, r);
        }

        if (stereo != 0.0) {
            double m = (l + r) * 0.5;
            double s = (l - r) * 0.5;
            s *= (1.0 + stereo);
            l = m + s;
            r = m - s;
        }

        l *= balL;
        r *= balR;

        if (reverb) {
            double outL = 0, outR = 0;
            for (int c=0; c<4; c++) {
                outL += DelayLineProcessComb(&state->combsL[c], l, roomSize, damp, &dampStateL[c]);
                outR += DelayLineProcessComb(&state->combsR[c], r, roomSize, damp, &dampStateR[c]);
            }
            outL *= MASAudioDSPCombNormalization;
            outR *= MASAudioDSPCombNormalization;
            for (int a=0; a<2; a++) {
                outL = DelayLineProcessAllpass(&state->allpassesL[a], outL);
                outR = DelayLineProcessAllpass(&state->allpassesR[a], outR);
            }
            l = (l * (1.0 - mix)) + (outL * mix);
            r = (r * (1.0 - mix)) + (outR * mix);
        }

        if (limit) {
            l = l > 1.0 ? 1.0 : (l < -1.0 ? -1.0 : l);
            r = r > 1.0 ? 1.0 : (r < -1.0 ? -1.0 : r);
        }

        data[i * channels] = (float)l;
        data[i * channels + 1] = (float)r;
      }
    }
  }

  os_unfair_lock_unlock(&state->lock);
}
