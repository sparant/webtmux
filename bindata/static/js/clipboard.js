// Copy text to the system clipboard, from whichever browser context this page
// happens to be in.
//
// navigator.clipboard exists only in a SECURE context. webtmux is normally
// reached through an ssh tunnel at http://localhost:8090 — which counts as
// secure — but the LAN fallback (WEBTMUX_BIND=0.0.0.0, plain http to a host IP)
// does not, and there the API is simply missing. A copy button that silently
// does nothing on half the ways this app is reached isn't a button, so fall back
// to the old execCommand('copy') trick on a throwaway textarea.
//
// Returns a Promise<boolean> — copied or not — so the caller can say which.

export async function copyText(text, { nav = globalThis.navigator, doc = globalThis.document } = {}) {
  const s = String(text ?? '');
  if (!s) return false;
  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(s);
      return true;
    } catch (_) {
      // Denied permission or a non-secure context that still exposes the object;
      // fall through to the legacy path rather than reporting failure.
    }
  }
  if (!doc?.body || !doc.execCommand) return false;
  try {
    const ta = doc.createElement('textarea');
    ta.value = s;
    // Off-screen but focusable: execCommand('copy') copies the SELECTION, so the
    // element has to be in the document and selected, and display:none can be
    // neither.
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    ta.select();
    const ok = doc.execCommand('copy');
    doc.body.removeChild(ta);
    return !!ok;
  } catch (_) {
    return false;
  }
}
