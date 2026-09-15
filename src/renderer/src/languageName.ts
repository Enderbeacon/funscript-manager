/**
 * A language code as the name of a language.
 *
 * Subtitles are marked with codes — `en`, `zh-CN`, and whatever a file's
 * author typed — and a menu of codes is a menu nobody can read at a glance.
 * The browser already knows every language's name in every language we ship,
 * so the row says "Chinesisch (vereinfacht)" to someone reading German and
 * "Chinese (Simplified)" to someone reading English.
 *
 * Null when the code means nothing to it: an invented marker is still the
 * best thing to show, since it is what the file itself says.
 */
export function languageName(code: string, uiLanguage: string): string | null {
  try {
    const named = new Intl.DisplayNames([uiLanguage], { type: 'language' }).of(code)
    return named && named.toLowerCase() !== code.toLowerCase() ? named : null
  } catch {
    return null
  }
}
