#!/usr/bin/env node
/**
 * Build the SteamVR overlay helper (native/vr-overlay) into resources/vr-overlay,
 * which electron-builder ships beside the app.
 *
 * Needs Visual Studio with the C++ desktop workload; vswhere finds it.
 *
 *   node scripts/build-vr-overlay.mjs
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'native', 'vr-overlay')
const obj = join(src, 'build')
const out = join(root, 'resources', 'vr-overlay')

const vswhere = join(
  process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
  'Microsoft Visual Studio', 'Installer', 'vswhere.exe'
)
if (!existsSync(vswhere)) throw new Error('Visual Studio not found (no vswhere.exe)')
const vsPath = execFileSync(vswhere, [
  '-latest', '-products', '*',
  '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  '-property', 'installationPath'
]).toString().trim()
if (!vsPath) throw new Error('Visual Studio has no C++ build tools')
const vcvars = join(vsPath, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')

mkdirSync(obj, { recursive: true })
mkdirSync(out, { recursive: true })

const openvr = join(src, 'third_party', 'openvr')
const cl = [
  'cl', '/nologo', '/std:c++17', '/O2', '/EHsc', '/W4', '/MT', '/utf-8',
  `/I"${openvr}"`,
  `/Fo"${obj}\\\\"`,
  `/Fe"${join(out, 'vr-overlay.exe')}"`,
  `"${join(src, 'src', 'main.cpp')}"`,
  '/link', `/LIBPATH:"${openvr}"`,
  'openvr_api.lib', 'd3d11.lib', 'dxgi.lib'
].join(' ')

// cmd's own quoting: the whole line goes inside one pair of outer quotes.
const script = join(obj, 'build.cmd')
writeFileSync(script, `@echo off\r\ncall "${vcvars}" >nul || exit /b 1\r\n${cl}\r\n`)
execFileSync('cmd.exe', ['/d', '/c', script], { stdio: 'inherit' })

copyFileSync(join(openvr, 'openvr_api.dll'), join(out, 'openvr_api.dll'))
// Its license travels with it (BSD-3-Clause asks for the notice alongside).
copyFileSync(join(openvr, 'LICENSE'), join(out, 'OPENVR_LICENSE.txt'))
// SteamVR input manifest and default bindings, read from beside the exe.
for (const f of readdirSync(join(src, 'input'))) {
  copyFileSync(join(src, 'input', f), join(out, f))
}
console.log(`built ${out}`)
