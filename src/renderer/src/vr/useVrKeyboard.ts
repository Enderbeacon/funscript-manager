import { useEffect } from 'react'
import { ipcInvoke } from '../ipc'

/** Fields the headset keyboard types into; checkboxes and sliders are not. */
const TEXT_TYPES = new Set(['text', 'search', 'password', 'number', 'url', ''])

function isTextField(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
  if (target instanceof HTMLTextAreaElement) return true
  return target instanceof HTMLInputElement && TEXT_TYPES.has(target.type)
}

/**
 * Brings up SteamVR's keyboard whenever a text field on a VR page takes focus,
 * and puts it away when the field lets go.
 *
 * The keyboard starts from what the field already holds and sends each key as
 * it is pressed, appended at the end — so the caret goes to the end too, or a
 * click into the middle of the text would have letters land in two places.
 */
export function useVrKeyboard(): void {
  useEffect(() => {
    const onFocusIn = (event: FocusEvent): void => {
      const field = event.target
      if (!isTextField(field) || field.readOnly || field.disabled) return
      try {
        const end = field.value.length
        field.setSelectionRange(end, end)
      } catch {
        // Number fields have no caret to place.
      }
      void ipcInvoke('vr:keyboard', { open: true, text: field.value.slice(0, 256) }).catch(() => {})
    }
    const onFocusOut = (event: FocusEvent): void => {
      if (!isTextField(event.target)) return
      // Focus moving straight to another field opens the keyboard again for it.
      if (isTextField(event.relatedTarget)) return
      void ipcInvoke('vr:keyboard', { open: false, text: '' }).catch(() => {})
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [])
}
