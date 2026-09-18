#!/usr/bin/env node
/**
 * `npm run dev`, plus a window showing the VR panel at the headset's size.
 *
 *   npm run dev:vr
 */
import { spawn } from 'node:child_process'

const child = spawn('npx', ['electron-vite', 'dev', '--remoteDebuggingPort', '9222', '--inspect', '5858'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, FSMGR_VR_PREVIEW: '1' }
})
child.on('exit', (code) => process.exit(code ?? 0))
