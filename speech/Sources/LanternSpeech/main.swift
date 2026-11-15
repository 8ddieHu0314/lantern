import Foundation
import Hummingbird
import NIOCore
import NIOFoundationCompat

// Lantern speech service: WhisperKit (speech to text), SpeakerKit (who spoke)
// and TTSKit (text to speech), all on-device, behind a small localhost API.
//
//   GET  /health                        -> {"status":"ok", ...}
//   POST /transcribe?speakers=2         body: audio file (wav, m4a, mp3)
//                                       -> {"duration", "speakers", "segments":[{"speaker","start","end","text"}], "timings"}
//   POST /speak  {"text": "...", "voice": "aiden"}   -> audio/wav
//
// Run with --selftest to download/load every model, speak a sentence,
// transcribe it back, print the result and exit.

let env = ProcessInfo.processInfo.environment
let port = Int(env["LANTERN_SPEECH_PORT"] ?? "") ?? 8001
let modelsDir = URL(fileURLWithPath: env["LANTERN_MODELS_DIR"] ?? "../models/argmax").standardizedFileURL

let selftest = CommandLine.arguments.contains("--selftest")
let whisperModel = env["LANTERN_WHISPER_MODEL"] ?? "large-v3-v20240930_626MB"

// Once a model is on disk, load it from its folder and skip the downloader, so the
// service starts with no network. The self-test (run by setup) always goes through
// the downloader so anything missing gets fetched.
let hub = modelsDir.appendingPathComponent("models/argmaxinc")
func onDisk(_ relativePath: String) -> String? {
    let path = hub.appendingPathComponent(relativePath).path
    return !selftest && FileManager.default.fileExists(atPath: path) ? path : nil
}

let settings = Engine.Settings(
    modelsDir: modelsDir,
    whisperModel: whisperModel,
    whisperFolder: env["LANTERN_WHISPER_FOLDER"] ?? onDisk("whisperkit-coreml/openai_whisper-\(whisperModel)"),
    speakerFolder: env["LANTERN_SPEAKER_FOLDER"] ?? onDisk("speakerkit-coreml"),
    ttsFolder: (env["LANTERN_TTS_FOLDER"] ?? onDisk("ttskit-coreml")).map { URL(fileURLWithPath: $0) },
    language: env["LANTERN_LANGUAGE"] ?? "en"
)

try FileManager.default.createDirectory(at: modelsDir, withIntermediateDirectories: true)
log("Models folder: \(modelsDir.path)")
let engine = try await Engine(settings: settings)

if selftest {
    let sentence = "What happened this morning? I slipped on the ice and landed on my right hand."
    log("Self-test: speaking \"\(sentence)\"")
    let wav = try await engine.speak(text: sentence, voice: nil)
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("lantern-selftest.wav")
    try wav.write(to: path)
    log("Self-test: wrote \(wav.count) bytes to \(path.path), transcribing it back…")
    let out = try await engine.transcribe(path: path.path, numberOfSpeakers: nil)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted]
    print(String(decoding: try encoder.encode(out), as: UTF8.self))
    log("Self-test passed. Whisper folder: \(await engine.whisperFolder() ?? "?")")
    exit(0)
}

if env["LANTERN_PRELOAD_TTS"] == "1" {
    _ = try await engine.loadTTS()
}

struct SpeakRequest: Decodable {
    let text: String
    let voice: String?
}

struct Health: ResponseEncodable {
    let status: String
    let whisperFolder: String?
}

extension TranscriptOut: ResponseEncodable {}

let router = Router()

router.get("health") { _, _ -> Health in
    Health(status: "ok", whisperFolder: await engine.whisperFolder())
}

router.post("transcribe") { request, _ -> TranscriptOut in
    let body = try await request.body.collect(upTo: 300 * 1024 * 1024)
    guard body.readableBytes > 0 else {
        throw HTTPError(.badRequest, message: "Send the audio file as the request body.")
    }
    let contentType = request.headers[.contentType] ?? ""
    let ext = contentType.contains("mp4") || contentType.contains("m4a") ? "m4a"
        : contentType.contains("mpeg") ? "mp3" : "wav"
    let path = FileManager.default.temporaryDirectory
        .appendingPathComponent("lantern-\(UUID().uuidString).\(ext)")
    try Data(buffer: body).write(to: path)
    defer { try? FileManager.default.removeItem(at: path) }

    let speakers = request.uri.queryParameters.get("speakers", as: Int.self)
    log("Transcribing \(body.readableBytes) bytes (speakers: \(speakers.map(String.init) ?? "auto"))")
    do {
        let out = try await engine.transcribe(path: path.path, numberOfSpeakers: speakers)
        log(String(format: "Done: %.1fs audio, %d segments, transcribe %.1fs, diarize %.1fs",
                   out.duration, out.segments.count, out.timings.transcribe, out.timings.diarize))
        return out
    } catch {
        log("Transcribe failed: \(error)")
        throw HTTPError(.internalServerError, message: "Transcription failed: \(error)")
    }
}

router.post("speak") { request, context -> Response in
    let req = try await request.decode(as: SpeakRequest.self, context: context)
    let text = req.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { throw HTTPError(.badRequest, message: "text is empty") }
    do {
        let wav = try await engine.speak(text: text, voice: req.voice)
        return Response(
            status: .ok,
            headers: [.contentType: "audio/wav"],
            body: ResponseBody(byteBuffer: ByteBuffer(data: wav))
        )
    } catch {
        log("Speak failed: \(error)")
        throw HTTPError(.internalServerError, message: "Speech generation failed: \(error)")
    }
}

let app = Application(
    router: router,
    configuration: .init(address: .hostname("127.0.0.1", port: port))
)
log("Lantern speech service listening on http://127.0.0.1:\(port)")
try await app.runService()
