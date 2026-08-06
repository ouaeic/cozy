// Reports the on-screen window list with its CoreGraphics layer, which is the
// ground truth for z-order on macOS.
//
// Needed because the overlay sets content protection (NSWindowSharingNone) to
// keep itself out of shared screens — which also makes it invisible to
// screencapture, so pixel sampling can never confirm it is on top. The window
// server still knows, and this asks it.
//
// Compiled on demand by test/fullscreen.test.mjs. Requires Xcode command line
// tools, which any Mac that can build this app already has.

import CoreGraphics
import Foundation

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
  FileHandle.standardError.write("could not read the window list\n".data(using: .utf8)!)
  exit(1)
}

// Front to back, as the window server orders them.
var out: [[String: Any]] = []
for (index, window) in list.enumerated() {
  let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
  out.append([
    "order": index,
    "owner": window[kCGWindowOwnerName as String] as? String ?? "",
    "name": window[kCGWindowName as String] as? String ?? "",
    "pid": window[kCGWindowOwnerPID as String] as? Int ?? 0,
    "layer": window[kCGWindowLayer as String] as? Int ?? 0,
    "alpha": window[kCGWindowAlpha as String] as? Double ?? 0,
    "x": bounds["X"] as? Double ?? 0,
    "y": bounds["Y"] as? Double ?? 0,
    "w": bounds["Width"] as? Double ?? 0,
    "h": bounds["Height"] as? Double ?? 0,
  ])
}

let data = try JSONSerialization.data(withJSONObject: out, options: [])
FileHandle.standardOutput.write(data)
