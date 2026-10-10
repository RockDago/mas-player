#import <AudioToolbox/AudioToolbox.h>
#import <Foundation/Foundation.h>
#import <MacTypes.h>

/**
 * `ItemCount` est le nom moderne du type ; `CMItemCount` en est l'ancien nom.
 *
 * Les SDK iOS récents ont retiré `CMItemCount` (erreur « unknown type name
 * 'CMItemCount'; did you mean 'ItemCount'? »), tandis que les SDK plus anciens
 * ne connaissent que `CMItemCount`. Ce fichier se compile avec les deux.
 *
 * Ne pas écrire le type en clair dans les signatures : la version qui marche
 * dépend du SDK du runner, pas du dépôt. Ce typedef est le seul endroit où la
 * décision est prise, donc le seul endroit à corriger si Apple renomme encore.
 *
 * `MacTypes.h` est importé explicitement parce que `ItemCount` n'y arrive
 * qu'en *transitive* via AudioToolbox, et l'import transitif a disparu — c'est
 * l'origine du symptôme, pas du contenu de la signature.
 */
typedef ItemCount MASFrameCount;

typedef struct MASAudioDSPState MASAudioDSPState;

MASAudioDSPState *MASAudioDSPCreate(void);
void MASAudioDSPDestroy(MASAudioDSPState *state);
void MASAudioDSPSetParameters(MASAudioDSPState *state, BOOL enabled, NSArray<NSNumber *> *bands, double preamp, double balance, double stereoExpansion, BOOL limitEnabled, BOOL reverbEnabled, double roomSize, double damping, double reverbMix);
void MASAudioDSPSetSampleRate(MASAudioDSPState *state, double sampleRate);
void MASAudioDSPProcess(MASAudioDSPState *state, AudioBufferList *bufferList, MASFrameCount frameCount, BOOL nonInterleaved);
