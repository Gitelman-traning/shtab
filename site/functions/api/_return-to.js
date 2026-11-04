export function safeReturn(value) {
  if(typeof value!=='string' || value.length>2048 || !value.startsWith('/') || /[\\\u0000-\u001f]/.test(value)) return '/';
  try {
    const u=new URL(value,'https://shtab.invalid');
    const path=decodeURIComponent(u.pathname);
    if(u.origin!=='https://shtab.invalid' || path.startsWith('//') || /[\\\u0000-\u001f]/.test(path) || /^\/(?:__|api(?:\/|$)|%)/i.test(path)) return '/';
    return u.pathname+u.search+u.hash;
  } catch { return '/'; }
}
