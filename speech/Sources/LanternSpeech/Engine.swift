import Foundation
import SpeakerKit
import TTSKit
import WhisperKit

struct SpeechSegment: Codable {
    let speaker: Int
    let start: Float
    let end: Float
    let text: String
}

struct Timings: Codable {
    let transcribe: Double
    let diarize: Double
}

struct TranscriptOut: Codable {
    let duration: Float
    let speakers: Int
    let segments: [SpeechSegment]
    let timings: Timings
}

enum EngineError: Error, CustomStringConvertible {
    case noTranscription

    var description: String {
        switch self {
        case .noTranscription: return "WhisperKit returned no transcription for this audio"
        }
    }
}

/// Holds the three Argmax kits, loaded once so every request is fast.
/// An actor so requests run one at a time and never share a model mid-call.
actor Engine {
    private let whisper: WhisperKit
    private let speakerKit: SpeakerKit
    private var tts: TTSKit?
    private let settings: Settings

    struct Settings {
        let modelsDir: URL
        let whisperModel: String
        let whisperFolder: String?
        let speakerFolder: String?
        let ttsFolder: URL?
        let language: String
    }

    init(settings: Settings) async throws {
        self.settings = settings

        log("Loading WhisperKit (\(settings.whisperModel))…")
        let whisperConfig = WhisperKitConfig(
            model: settings.whisperModel,
            downloadBase: settings.modelsDir,
            modelFolder: settings.whisperFolder,
            verbose: false,
            prewarm: true,
            load: true,
            download: settings.whisperFolder == nil
        )
        whisper = try await WhisperKit(whisperConfig)
        log("WhisperKit ready: \(whisper.modelFolder?.path ?? "?")")

        log("Loading SpeakerKit…")
        let speakerConfig = PyannoteConfig(
            downloadBase: settings.modelsDir.path,
            modelFolder: settings.speakerFolder,
            download: settings.speakerFolder == nil,
            load: true,
            verbose: false
        )
        speakerKit = try await SpeakerKit(speakerConfig)
        log("SpeakerKit ready")
    }

    func whisperFolder() -> String? { whisper.modelFolder?.path }

    /// Transcribe an audio file, then label each part with a speaker.
    func transcribe(path: String, numberOfSpeakers: Int?) async throws -> TranscriptOut {
        let frames = try AudioProcessor.loadAudioAsFloatArray(fromPath: path)
        let duration = Float(frames.count) / Float(WhisperKit.sampleRate)

        var options = DecodingOptions(
            language: settings.language,
            skipSpecialTokens: true,
            wordTimestamps: true
        )
        options.chunkingStrategy = .vad

        let t0 = Date()
        let results = await whisper.transcribe(audioArrays: [frames], decodeOptions: options)
        guard let first = results.first, let transcription = first, !transcription.isEmpty else {
            throw EngineError.noTranscription
        }
        let t1 = Date()

        let diarization = try await speakerKit.diarize(
            audioArray: frames,
            options: PyannoteDiarizationOptions(numberOfSpeakers: numberOfSpeakers)
        )
        let t2 = Date()

        let segments: [SpeechSegment] = diarization
            .addSpeakerInfo(to: transcription)
            .flatMap { $0 }
            .compactMap { segment in
                let text = segment.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { return nil }
                return SpeechSegment(
                    speaker: segment.speaker.speakerId ?? -1,
                    start: segment.startTime,
                    end: segment.endTime,
                    text: text
                )
            }

        return TranscriptOut(
            duration: duration,
            speakers: Set(segments.map(\.speaker).filter { $0 >= 0 }).count,
            segments: segments,
            timings: Timings(transcribe: t1.timeIntervalSince(t0), diarize: t2.timeIntervalSince(t1))
        )
    }

    /// Text to a WAV file's bytes. TTSKit loads on first use to keep startup light.
    func speak(text: String, voice: String?) async throws -> Data {
        let kit = try await loadTTS()
        let result = try await kit.generate(text: text, voice: voice)
        return Wav.encode(samples: result.audio, sampleRate: result.sampleRate)
    }

    func loadTTS() async throws -> TTSKit {
        if let tts { return tts }
        log("Loading TTSKit…")
        let model = TTSModelVariant.qwen3TTS_0_6b
        let tokenizerDir = settings.modelsDir.appendingPathComponent("tts-tokenizer")
        let hasLocalTokenizer = FileManager.default.fileExists(
            atPath: tokenizerDir.appendingPathComponent("tokenizer.json").path)

        let config = TTSKitConfig(
            model: model,
            modelFolder: settings.ttsFolder,
            downloadBase: settings.modelsDir,
            tokenizerFolder: hasLocalTokenizer ? tokenizerDir : nil,
            verbose: false
        )
        let kit = try await TTSKit(config)
        try await kit.loadModels()
        tts = kit
        log("TTSKit ready: \(kit.modelFolder?.path ?? "?")")

        if !hasLocalTokenizer {
            keepTokenizer(repo: model.tokenizerRepo, in: tokenizerDir)
        }
        return kit
    }

    /// TTSKit fetches its tokenizer into the shared Hugging Face folder in Documents.
    /// Copy it next to the other models so later runs load it from disk with no network.
    private func keepTokenizer(repo: String, in destination: URL) {
        let files = FileManager.default
        guard let documents = files.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let source = documents.appendingPathComponent("huggingface/models/\(repo)")
        guard files.fileExists(atPath: source.appendingPathComponent("tokenizer.json").path) else {
            log("TTS tokenizer not found at \(source.path); it will be fetched again next time")
            return
        }
        do {
            try files.createDirectory(at: destination, withIntermediateDirectories: true)
            for name in try files.contentsOfDirectory(atPath: source.path) where name.hasSuffix(".json") {
                let target = destination.appendingPathComponent(name)
                if !files.fileExists(atPath: target.path) {
                    try files.copyItem(at: source.appendingPathComponent(name), to: target)
                }
            }
            log("Saved the TTS tokenizer to \(destination.path)")
        } catch {
            log("Could not save the TTS tokenizer: \(error)")
        }
    }
}

func log(_ message: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    FileHandle.standardError.write(Data("[\(stamp)] \(message)\n".utf8))
}
