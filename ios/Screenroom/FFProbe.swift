import Foundation
import UIKit
import Libavformat
import Libavcodec
import Libavutil
import Libswscale

/// Reads a film with FFmpeg (the libraries mpv's engine comes with), the way ffprobe does on the desktop: every
/// stream with its codec, channels, language and flags, the tags, the length and the built-in cover. Also grabs a
/// picture from films Apple's frameworks can't open (MKV, AVI …).
enum FFProbe {
    struct Result {
        var streams: [[String: Any]] = []
        var tags: [String: String] = [:]
        var duration: Double = 0
        var cover: Data?
    }

    private static let quiet: Void = { av_log_set_level(-8) }() // AV_LOG_QUIET

    private static func dict(_ d: OpaquePointer?) -> [String: String] {
        var out: [String: String] = [:]
        guard let d else { return out }
        var prev: UnsafeMutablePointer<AVDictionaryEntry>?
        while let e = av_dict_get(d, "", prev.map { UnsafePointer($0) }, 2) { // AV_DICT_IGNORE_SUFFIX: every entry
            if let k = e.pointee.key, let v = e.pointee.value { out[String(cString: k).lowercased()] = String(cString: v) }
            prev = e
        }
        return out
    }

    private static func open(_ url: URL) -> UnsafeMutablePointer<AVFormatContext>? {
        _ = quiet
        var ctx: UnsafeMutablePointer<AVFormatContext>?
        guard avformat_open_input(&ctx, url.path, nil, nil) == 0, let fc = ctx else { return nil }
        guard avformat_find_stream_info(fc, nil) >= 0 else { avformat_close_input(&ctx); return nil }
        return fc
    }

    static func read(_ url: URL) -> Result? {
        guard let fc = open(url) else { return nil }
        var ctx: UnsafeMutablePointer<AVFormatContext>? = fc
        defer { avformat_close_input(&ctx) }
        var r = Result()
        if fc.pointee.duration > 0 { r.duration = Double(fc.pointee.duration) / 1_000_000 }
        r.tags = dict(fc.pointee.metadata)
        for i in 0..<Int(fc.pointee.nb_streams) {
            guard let s = fc.pointee.streams[i], let par = s.pointee.codecpar else { continue }
            let p = par.pointee
            let disp = s.pointee.disposition
            var st: [String: Any] = [
                "index": i,
                "codec_name": String(cString: avcodec_get_name(p.codec_id)),
                "tags": dict(s.pointee.metadata),
                "disposition": ["default": disp & 0x1 != 0 ? 1 : 0, "forced": disp & 0x40 != 0 ? 1 : 0,
                                "attached_pic": disp & 0x400 != 0 ? 1 : 0],
            ]
            if let prof = avcodec_profile_name(p.codec_id, p.profile) { st["profile"] = String(cString: prof) }
            if p.bit_rate > 0 { st["bit_rate"] = Int(p.bit_rate) }
            if p.codec_type == AVMEDIA_TYPE_VIDEO {
                if disp & 0x400 != 0 { // the built-in cover picture
                    let pkt = s.pointee.attached_pic
                    if r.cover == nil, pkt.size > 0, let d = pkt.data { r.cover = Data(bytes: d, count: Int(pkt.size)) }
                }
                st["codec_type"] = "video"
                st["width"] = Int(p.width)
                st["height"] = Int(p.height)
                let fr = s.pointee.avg_frame_rate
                if fr.num > 0 && fr.den > 0 { st["avg_frame_rate"] = "\(fr.num)/\(fr.den)" }
                if p.color_trc == AVCOL_TRC_SMPTE2084 { st["color_transfer"] = "smpte2084" }
                if p.color_trc == AVCOL_TRC_ARIB_STD_B67 { st["color_transfer"] = "arib-std-b67" }
                var dovi = false
                if let sd = p.coded_side_data {
                    for j in 0..<Int(p.nb_coded_side_data) where sd[j].type == AV_PKT_DATA_DOVI_CONF { dovi = true }
                }
                if dovi { st["side_data_list"] = [["side_data_type": "DOVI configuration record"]] }
            } else if p.codec_type == AVMEDIA_TYPE_AUDIO {
                st["codec_type"] = "audio"
                st["channels"] = Int(p.ch_layout.nb_channels)
                st["sample_rate"] = String(p.sample_rate)
            } else if p.codec_type == AVMEDIA_TYPE_SUBTITLE {
                st["codec_type"] = "subtitle"
            } else {
                continue
            }
            r.streams.append(st)
        }
        return r
    }

    /// A picture from the film, `fraction` of the way in, at most `maxWidth` wide.
    static func frame(_ url: URL, at fraction: Double, maxWidth: Int32 = 1280) -> CGImage? {
        guard let fc = open(url) else { return nil }
        var ctx: UnsafeMutablePointer<AVFormatContext>? = fc
        defer { avformat_close_input(&ctx) }
        let vi = av_find_best_stream(fc, AVMEDIA_TYPE_VIDEO, -1, -1, nil, 0)
        guard vi >= 0, let s = fc.pointee.streams[Int(vi)], let par = s.pointee.codecpar,
              let codec = avcodec_find_decoder(par.pointee.codec_id) else { return nil }
        var cc: UnsafeMutablePointer<AVCodecContext>? = avcodec_alloc_context3(codec)
        defer { avcodec_free_context(&cc) }
        guard let c = cc, avcodec_parameters_to_context(c, par) >= 0 else { return nil }
        c.pointee.thread_count = 2
        guard avcodec_open2(c, codec, nil) == 0 else { return nil }
        if fc.pointee.duration > 0 {
            av_seek_frame(fc, -1, Int64(Double(fc.pointee.duration) * fraction), 1) // AVSEEK_FLAG_BACKWARD
        }
        var pkt: UnsafeMutablePointer<AVPacket>? = av_packet_alloc()
        defer { av_packet_free(&pkt) }
        var frm: UnsafeMutablePointer<AVFrame>? = av_frame_alloc()
        defer { av_frame_free(&frm) }
        guard let packet = pkt, let f = frm else { return nil }
        var got = false
        var reads = 0
        while !got && reads < 3000 && av_read_frame(fc, packet) >= 0 {
            reads += 1
            if packet.pointee.stream_index == vi, avcodec_send_packet(c, packet) >= 0, avcodec_receive_frame(c, f) == 0 { got = true }
            av_packet_unref(packet)
        }
        if !got { avcodec_send_packet(c, nil); got = avcodec_receive_frame(c, f) == 0 }
        guard got else { return nil }
        let w = f.pointee.width, h = f.pointee.height
        guard w > 0, h > 0 else { return nil }
        let ow = min(w, maxWidth)
        let oh = max(2, Int32((Double(h) * Double(ow) / Double(w)).rounded()) & ~1)
        guard let sws = sws_getContext(w, h, AVPixelFormat(rawValue: numericCast(f.pointee.format)), ow, oh, AV_PIX_FMT_RGBA,
                                       2, nil, nil, nil) else { return nil } // SWS_BILINEAR
        defer { sws_freeContext(sws) }
        let stride = Int(ow) * 4
        var buf = [UInt8](repeating: 0, count: stride * Int(oh))
        let src: [UnsafePointer<UInt8>?] = [f.pointee.data.0, f.pointee.data.1, f.pointee.data.2, f.pointee.data.3].map { $0.map { UnsafePointer($0) } }
        let srcStride: [Int32] = [f.pointee.linesize.0, f.pointee.linesize.1, f.pointee.linesize.2, f.pointee.linesize.3]
        let dstStride: [Int32] = [Int32(stride), 0, 0, 0]
        buf.withUnsafeMutableBufferPointer { bp in
            let dst: [UnsafeMutablePointer<UInt8>?] = [bp.baseAddress, nil, nil, nil]
            _ = sws_scale(sws, src, srcStride, 0, h, dst, dstStride)
        }
        guard let provider = CGDataProvider(data: Data(buf) as CFData) else { return nil }
        return CGImage(width: Int(ow), height: Int(oh), bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: stride,
                       space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }
}
