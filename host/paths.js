import { posix, win32 } from 'node:path'

// On Windows, "\folder" and "/folder" depend on the current drive even though
// path.win32.isAbsolute() returns true. Require a drive or UNC share instead.
export function isFullPath(path, platform = process.platform) {
  if (typeof path !== 'string') return false
  if (platform !== 'win32') return posix.isAbsolute(path)
  return win32.isAbsolute(path) && win32.parse(path).root.length > 1
}
