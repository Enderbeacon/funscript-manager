/**
 * electron-vite `?modulePath` imports: the worker file is bundled as a
 * separate chunk and the import resolves to its output file path,
 * suitable for `new Worker(path)`.
 */
declare module '*.worker?modulePath' {
  const modulePath: string
  export default modulePath
}
