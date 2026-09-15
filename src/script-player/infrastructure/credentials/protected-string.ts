import { safeStorage } from 'electron'
import { AppError } from '@shared/errors'

const PREFIX = 'fsmgr-safe:v1:'

export function isProtectedString(value: string): boolean {
  return value.startsWith(PREFIX)
}

export function protectString(value: string): string {
  if (!value || isProtectedString(value)) return value
  if (!safeStorage.isEncryptionAvailable()) throw new AppError('credential_storage_unavailable')
  return `${PREFIX}${safeStorage.encryptString(value).toString('base64')}`
}

export function unprotectString(value: string): string {
  if (!isProtectedString(value)) throw new Error('protected credential required')
  const encrypted = Buffer.from(value.slice(PREFIX.length), 'base64')
  return safeStorage.decryptString(encrypted)
}
