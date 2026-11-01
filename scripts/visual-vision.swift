import Foundation
import CoreFoundation
import Vision
import ImageIO

// Offline Vision OCR helper. All inputs are passed as arguments, never shell code.
let fieldEvidenceEnabled = CommandLine.arguments.last == "--field-evidence"
let invocation = fieldEvidenceEnabled ? Array(CommandLine.arguments.dropLast()) : CommandLine.arguments
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
if invocation.count == 2 && invocation[1] == "--list-langs" && !fieldEvidenceEnabled {
    print(available.joined(separator:"\n")); exit(0)
}
guard invocation.count == 3 || (invocation.count == 5 && invocation[3] == "--region") else { stop("VISION_ARGUMENT_INVALID") }
let path = invocation[1], languages = invocation[2].split(separator:"+").map(String.init)
guard !languages.isEmpty, languages.allSatisfy({ available.contains($0) }) else { stop("VISION_LANGUAGE_UNAVAILABLE") }
request.recognitionLanguages = languages.compactMap { aliases[$0] }
var appliedRegion: [String:Double]? = nil
if invocation.count == 5 {
    let raw = invocation[4]
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

if fieldEvidenceEnabled {
    // Structured evidence is opt-in. Default tokens/regions retain their
    // original output. Range boxes are native queries, not glyph identities.
    func evidenceBox(_ rect:CGRect)->[String:Any] {
        let rx=appliedRegion?["x"] ?? 0, ry=appliedRegion?["y"] ?? 0
        let rw=appliedRegion?["width"] ?? 1, rh=appliedRegion?["height"] ?? 1
        let l=(rx+rect.minX*rw)*Double(image.width), t=(ry+(1-rect.maxY)*rh)*Double(image.height)
        let r=(rx+rect.maxX*rw)*Double(image.width), b=(ry+(1-rect.minY)*rh)*Double(image.height)
        let left=max(0,Int(floor(appliedRegion == nil ? l:stableRegionalPixel(l))))
        let top=max(0,Int(floor(appliedRegion == nil ? t:stableRegionalPixel(t))))
        let right=min(image.width,Int(ceil(appliedRegion == nil ? r:stableRegionalPixel(r))))
        let bottom=min(image.height,Int(ceil(appliedRegion == nil ? b:stableRegionalPixel(b))))
        return ["rawNormalized":["x":rect.minX,"y":rect.minY,"width":rect.width,"height":rect.height],"rawImagePixels":["left":l,"top":t,"right":r,"bottom":b],"bounds":["x":left,"y":top,"width":right-left,"height":bottom-top]]
    }
    var candidates:[[String:Any]]=[]
    var totalWords=0, totalUnits=0
    for (id,observation) in (request.results ?? []).enumerated() {
        guard let candidate=observation.topCandidates(1).first else {continue}
        let text=candidate.string
        totalUnits += text.utf16.count
        guard candidates.count<128, text.utf16.count<=4096, totalUnits<=16384 else {stop("VISION_FIELD_EVIDENCE_LIMIT")}
        func span(_ range:Range<String.Index>)->[String:Any] {
            var item:[String:Any]=["text":String(text[range]),"utf16Start":text[..<range.lowerBound].utf16.count,"utf16End":text[..<range.upperBound].utf16.count]
            if let box=try? candidate.boundingBox(for:range){item["box"]=evidenceBox(box.boundingBox)}
            else{item["boxUnavailable"]=true}
            return item
        }
        var words:[Range<String.Index>]=[]
        text.enumerateSubstrings(in:text.startIndex..<text.endIndex,options:[.byWords,.substringNotRequired]){_,range,_,_ in words.append(range)}
        totalWords += words.count
        guard totalWords<=1024 else {stop("VISION_FIELD_EVIDENCE_LIMIT")}
        candidates.append(["id":id,"text":text,"confidence":Double(candidate.confidence),"candidateBox":span(text.startIndex..<text.endIndex),"observationBox":evidenceBox(observation.boundingBox),"wordSpans":words.map(span)])
    }
    output["fieldEvidence"]=["schemaVersion":1,"offsetUnit":"utf16","coordinateSpace":"image_pixels","segmentation":"foundation_by_words","candidates":candidates]
}
guard let data = try? JSONSerialization.data(withJSONObject:output,options:[.sortedKeys]), let line = String(data:data,encoding:.utf8) else { stop("VISION_OUTPUT_INVALID") }
print(line)
