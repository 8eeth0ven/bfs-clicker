import Foundation
import CoreFoundation
import Vision
import ImageIO

// Offline Vision OCR helper. All inputs are passed as arguments, never shell code.
let aliases = ["eng":"en-US", "chi_sim":"zh-Hans", "chi_tra":"zh-Hant"]
func stop(_ message:String) -> Never { FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1) }
// Vision can return a ROI edge as -9.5e-10 normalized units: this produced
// 269.9999996px for the exact 270px boundary of an unchanged source image.
// Stabilize only regional mappings within one millionth of an original pixel;
// larger subpixel/whole-pixel extensions and the default path remain unchanged.
func stableRegionalPixel(_ value:Double) -> Double {
    let nearest=value.rounded()
    return abs(value-nearest)<=0.000001 ? nearest:value
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
let supported: [String]
do { supported = try request.supportedRecognitionLanguages() } catch { stop("VISION_LANGUAGE_LIST_FAILED") }
let available = aliases.filter { pair in supported.contains(pair.value) }.map { $0.key }.sorted()
if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--list-langs" {
    print(available.joined(separator:"\n")); exit(0)
}
guard CommandLine.arguments.count == 3 || (CommandLine.arguments.count == 5 && CommandLine.arguments[3] == "--region") else { stop("VISION_ARGUMENT_INVALID") }
let path = CommandLine.arguments[1], languages = CommandLine.arguments[2].split(separator:"+").map(String.init)
guard !languages.isEmpty, languages.allSatisfy({ available.contains($0) }) else { stop("VISION_LANGUAGE_UNAVAILABLE") }
request.recognitionLanguages = languages.compactMap { aliases[$0] }
var appliedRegion: [String:Double]? = nil
if CommandLine.arguments.count == 5 {
    let raw = CommandLine.arguments[4]
    guard raw.utf8.count <= 2048, let data = raw.data(using:.utf8),
          let object = (try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
          Set(object.keys) == Set(["x","y","width","height"]) else { stop("VISION_REGION_INVALID") }
    var values:[String:Double] = [:]
    for key in ["x","y","width","height"] {
        guard let number=object[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { stop("VISION_REGION_INVALID") }
        values[key]=number.doubleValue
    }
    let x=values["x"]!, y=values["y"]!, w=values["width"]!, h=values["height"]!
    guard x>=0, y>=0, w>0, h>0, x+w<=1, y+h<=1 else { stop("VISION_REGION_INVALID") }
    request.regionOfInterest=CGRect(x:x,y:1-y-h,width:w,height:h)
    appliedRegion=values
}
guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath:path) as CFURL,nil), let image = CGImageSourceCreateImageAtIndex(source,0,nil) else { stop("VISION_IMAGE_INVALID") }
do { try VNImageRequestHandler(cgImage:image,options:[:]).perform([request]) } catch { stop("VISION_RECOGNITION_FAILED") }
var tokens:[[String:Any]] = []
for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let text = candidate.string
    let ranges: [Range<String.Index>]
    if text.rangeOfCharacter(from:.whitespacesAndNewlines) == nil { ranges = [text.startIndex..<text.endIndex] }
    else { var words:[Range<String.Index>] = []; text.enumerateSubstrings(in:text.startIndex..<text.endIndex,options:[.byWords,.substringNotRequired]) { _, range, _, _ in words.append(range) }; ranges = words }
    for range in ranges {
        guard let box = try? candidate.boundingBox(for:range) else { continue }
        let rect = box.boundingBox
        // Vision's text candidate bounds are relative to the processed ROI,
        // verified against known source pixels; map back to full-image pixels.
        let rx=appliedRegion?["x"] ?? 0, ry=appliedRegion?["y"] ?? 0
        let rw=appliedRegion?["width"] ?? 1, rh=appliedRegion?["height"] ?? 1
        let rawLeft=(rx + rect.minX * rw) * Double(image.width)
        let rawTop=(ry + (1 - rect.maxY) * rh) * Double(image.height)
        let rawRight=(rx + rect.maxX * rw) * Double(image.width)
        let rawBottom=(ry + (1 - rect.minY) * rh) * Double(image.height)
        let left = max(0,Int(floor(appliedRegion == nil ? rawLeft:stableRegionalPixel(rawLeft))))
        let top = max(0,Int(floor(appliedRegion == nil ? rawTop:stableRegionalPixel(rawTop))))
        let right = min(image.width,Int(ceil(appliedRegion == nil ? rawRight:stableRegionalPixel(rawRight))))
        let bottom = min(image.height,Int(ceil(appliedRegion == nil ? rawBottom:stableRegionalPixel(rawBottom))))
        if right > left && bottom > top { tokens.append(["text":String(text[range]),"confidence":Double(candidate.confidence),"bounds":["x":left,"y":top,"width":right-left,"height":bottom-top]]) }
    }
}
var output:[String:Any] = ["width":image.width,"height":image.height,"tokens":tokens]
if let region=appliedRegion { output["region"]=region }
guard let data = try? JSONSerialization.data(withJSONObject:output,options:[.sortedKeys]), let line = String(data:data,encoding:.utf8) else { stop("VISION_OUTPUT_INVALID") }
print(line)
