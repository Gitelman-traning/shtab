export function goalTerms(row) {
  function amount(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
    const n=Number(value);
    return Number.isFinite(n) && n>=0 && n<=Number.MAX_SAFE_INTEGER ? n : null;
  }
  const goal=amount(row?.goal,null), base=amount(row?.base,25000), rate=amount(row?.rate,1500);
  if (!(goal>0) || base===null || rate===null) return null;
  return {goal,base,rate};
}
