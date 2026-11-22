// Perso channel: reload this page once the Hub runs a newer release, unless an edit is open.
let base = "";
const editing = () => { const a = document.activeElement; return Boolean(a && (a.isContentEditable || /^(TEXTAREA|INPUT)$/.test(a.tagName))); };
async function check() {
  if (document.hidden) return;
  try {
    const { release } = await (await fetch("/api/health", { cache: "no-store" })).json();
    if (!release) return clearInterval(timer);
    if (!base) base = release;
    else if (release !== base && !editing()) location.reload();
  } catch {}
}
const timer = setInterval(check, 5000);
document.addEventListener("visibilitychange", check);
check();
