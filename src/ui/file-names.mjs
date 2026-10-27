const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g;
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * A file name base from a title: no separators or Windows-forbidden characters, no bidi/zero-width controls,
 * no Windows device names, no leading or trailing space, dot or dash (also after the 80-character cut).
 * Commas, apostrophes, parentheses and single spaces stay. Empty result: `fallback`.
 */
export function safeFileBase(title, fallback = '') {
  const clean = value => value.replace(/^[\s.-]+|[\s.-]+$/g, '');
  let name = String(title || '').normalize('NFC').replace(INVISIBLE, '').replace(UNSAFE, '-').replace(/\s+/g, ' ');
  name = clean(name);
  if ([...name].length > 80) name = clean([...name].slice(0, 80).join(''));
  if (!name) return fallback;
  return WINDOWS_RESERVED.test(name) ? '_' + name : name;
}
