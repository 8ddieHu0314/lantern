import Foundation

/// Minimal 16-bit PCM mono WAV writer, so the service needs no audio file APIs to answer.
enum Wav {
    static func encode(samples: [Float], sampleRate: Int) -> Data {
        var data = Data()
        func append(_ string: String) { data.append(contentsOf: Array(string.utf8)) }
        func u32(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }

        let dataBytes = UInt32(samples.count * 2)
        append("RIFF"); u32(36 + dataBytes); append("WAVE")
        append("fmt "); u32(16); u16(1); u16(1)
        u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
        append("data"); u32(dataBytes)
        for sample in samples {
            let clipped = max(-1, min(1, sample))
            u16(UInt16(bitPattern: Int16(clipped * 32767)))
        }
        return data
    }
}
