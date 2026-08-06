import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { join, normalize, extname, sep } from 'node:path'

// Why a custom scheme instead of loading file:// directly:
//
// The Faces window is opened with window.open() so that it lands in the SAME
// renderer process as the Stage — that's what lets the Stage hand it live
// MediaStreams and render into its document. Chromium only does that for
// SAME-ORIGIN documents, and every file:// URL is an opaque origin, so a
// packaged build would silently lose the connection between the two windows.
//
// `app://cozy/...` is a standard, secure origin. Both windows share it, the
// opener relationship survives, and we get a proper secure context for
// getUserMedia into the bargain.

export const APP_ORIGIN = 'app://cozy'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: {
        standard: true, // gives it a real, comparable origin
        secure: true, // treated as a trustworthy context
        supportFetchAPI: true,
        codeCache: true,
      },
    },
  ])
}

export function serveRenderer(rendererDir: string): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)

    // Read with fs rather than net.fetch(file://). In a packaged build these
    // files live inside app.asar; Electron's fs layer understands that archive
    // and the network stack does not — fetching them as file:// URLs yields
    // nothing and the window comes up black.
    const relative = normalize(decodeURIComponent(url.pathname))
      .replace(/^[/\\]+/, '')
      .split(/[/\\]/)
      .filter((part) => part !== '..') // no climbing out of the bundle
      .join(sep)

    const path = join(rendererDir, relative || 'index.html')

    try {
      const body = await readFile(path)
      return new Response(body, {
        status: 200,
        headers: { 'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream' },
      })
    } catch {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
    }
  })
}
