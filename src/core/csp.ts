let allowed: boolean | null = null;

/** Whether the page's CSP permits `new Function` / eval (strict hosts such as Claude artifacts forbid it). Probed once. */
export function evalAllowed(): boolean {
  if (allowed === null) {
    try {
      new Function('');
      allowed = true;
    } catch {
      allowed = false;
    }
  }
  return allowed;
}
