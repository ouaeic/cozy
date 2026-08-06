// Moves the pointer, so the control-panel test can prove the reveal actually
// works rather than assuming it. CGEvent is the same mechanism the OS uses, so
// the main process's cursor watcher sees a genuine move.
//
// Compiled on demand by test/bar.test.mjs. Usage: movecursor <x> <y>

import CoreGraphics
import Foundation

// `movecursor read` prints the current position. Posting a synthetic move
// requires Accessibility permission for the *parent* process; without it macOS
// drops the event silently and returns success, so the only way to know whether
// it worked is to look afterwards.
if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "read" {
  let p = CGEvent(source: nil)?.location ?? .zero
  print("\(Int(p.x)) \(Int(p.y))")
  exit(0)
}

guard CommandLine.arguments.count == 3,
      let x = Double(CommandLine.arguments[1]),
      let y = Double(CommandLine.arguments[2]) else {
  FileHandle.standardError.write("usage: movecursor <x> <y> | movecursor read\n".data(using: .utf8)!)
  exit(1)
}

let point = CGPoint(x: x, y: y)
guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                          mouseCursorPosition: point, mouseButton: .left) else {
  FileHandle.standardError.write("could not create the event\n".data(using: .utf8)!)
  exit(1)
}
event.post(tap: .cghidEventTap)
