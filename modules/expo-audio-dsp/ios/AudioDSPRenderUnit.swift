import AudioToolbox
import AVFoundation

final class AudioDSPRenderState {
    static let shared = AudioDSPRenderState()

    let spatial = SpatialState()
    let reverb = ReverbState()
    let limiter = LimiterState()

    func prepare(sampleRate: Double) {
        limiter.prepare(sampleRate: sampleRate)
    }

    func process(_ buffer: AVAudioPCMBuffer) {
        guard let channels = buffer.floatChannelData else { return }
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return }

        if buffer.format.channelCount >= 2 {
            spatial.process(left: channels[0], right: channels[1], frameCount: frames)
            reverb.process(left: channels[0], right: channels[1], frameCount: frames)
            limiter.processChannels(
                left: channels[0],
                right: channels[1],
                frameCount: frames,
                sampleRate: buffer.format.sampleRate
            )
        } else {
            reverb.processMono(samples: channels[0], frameCount: frames)
            limiter.processChannels(
                left: channels[0],
                right: nil,
                frameCount: frames,
                sampleRate: buffer.format.sampleRate
            )
        }
    }
}

private final class RenderBufferHolder {
    var buffer: AVAudioPCMBuffer?
}

final class AudioDSPRenderUnit: AUAudioUnit {
    static let componentDescription = AudioComponentDescription(
        componentType: kAudioUnitType_Effect,
        componentSubType: 0x4d415344,
        componentManufacturer: 0x4d415350,
        componentFlags: 0,
        componentFlagsMask: 0
    )

    static let registerSubclassOnce: Void = {
        AUAudioUnit.registerSubclass(
            AudioDSPRenderUnit.self,
            as: componentDescription,
            name: "MAS Player DSP",
            version: 1
        )
    }()

    private let renderBuffer = RenderBufferHolder()
    private var inputBusArray: AUAudioUnitBusArray!
    private var outputBusArray: AUAudioUnitBusArray!
    // Pas `renderBlock` : `AUAudioUnit` expose déjà une propriété de ce nom
    // (readonly, `AURenderBlock`). La redéclarer ici — même `private` — la masque
    // et casse le build. Le bloc s'installe via `internalRenderBlock`.
    private var masRenderBlock: AUInternalRenderBlock!

    override init(
        componentDescription: AudioComponentDescription,
        options: AudioComponentInstantiationOptions = []
    ) throws {
        try super.init(componentDescription: componentDescription, options: options)

        guard let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2) else {
            throw NSError(domain: "MASPlayer.AudioDSP", code: Int(kAudioUnitErr_FormatNotSupported))
        }

        let inputBus = try AUAudioUnitBus(format: format)
        let outputBus = try AUAudioUnitBus(format: format)
        inputBusArray = AUAudioUnitBusArray(audioUnit: self, busType: .input, busses: [inputBus])
        outputBusArray = AUAudioUnitBusArray(audioUnit: self, busType: .output, busses: [outputBus])

        let holder = renderBuffer
        let state = AudioDSPRenderState.shared
        masRenderBlock = { actionFlags, timestamp, frameCount, _, outputData, _, pullInputBlock in
            // `outputData` n'est pas optionnel dans `AUInternalRenderBlock` : seul
            // `pullInputBlock` (le pull du bus d'entrée) peut manquer.
            guard let pullInputBlock, let buffer = holder.buffer else {
                return kAudioUnitErr_NoConnection
            }
            // `frameCount` est un `AUAudioFrameCount` (UInt32), comme `frameCapacity`.
            guard frameCount <= buffer.frameCapacity else {
                return kAudioUnitErr_TooManyFramesToProcess
            }

            buffer.frameLength = frameCount
            let status = pullInputBlock(
                actionFlags,
                timestamp,
                frameCount,
                0,
                buffer.mutableAudioBufferList
            )
            guard status == noErr else { return status }

            state.process(buffer)

            let outputBuffers = UnsafeMutableAudioBufferListPointer(outputData)
            let processedBuffers = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
            guard outputBuffers.count == processedBuffers.count else {
                return kAudioUnitErr_FormatNotSupported
            }

            for index in 0..<outputBuffers.count {
                let output = outputBuffers[index]
                let processed = processedBuffers[index]
                guard let processedData = processed.mData else {
                    return kAudioUnitErr_FormatNotSupported
                }
                if output.mData == nil {
                    outputBuffers[index].mData = processedData
                    outputBuffers[index].mDataByteSize = processed.mDataByteSize
                } else if output.mData != processedData {
                    memcpy(output.mData, processedData, Int(processed.mDataByteSize))
                }
            }
            return noErr
        }
    }

    override var inputBusses: AUAudioUnitBusArray {
        inputBusArray
    }

    override var outputBusses: AUAudioUnitBusArray {
        outputBusArray
    }

    override var internalRenderBlock: AUInternalRenderBlock {
        masRenderBlock
    }

    override var canProcessInPlace: Bool {
        false
    }

    override func shouldChange(to format: AVAudioFormat, for bus: AUAudioUnitBus) -> Bool {
        format.commonFormat == .pcmFormatFloat32
    }

    override func allocateRenderResources() throws {
        try super.allocateRenderResources()

        let format = outputBusses[0].format
        guard format.commonFormat == .pcmFormatFloat32,
              inputBusses[0].format == format,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: maximumFramesToRender) else {
            throw NSError(domain: "MASPlayer.AudioDSP", code: Int(kAudioUnitErr_FormatNotSupported))
        }
        renderBuffer.buffer = buffer
    }

    override func deallocateRenderResources() {
        renderBuffer.buffer = nil
        super.deallocateRenderResources()
    }
}
