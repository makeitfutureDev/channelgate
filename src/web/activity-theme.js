// Match the admin/login brand without loading the authenticated admin stylesheet.
// These self-hosted fonts and favicon are already public login assets.
export const ACTIVITY_THEME_CSS = `
@font-face{font-family:Poppins;font-style:normal;font-weight:400;font-display:swap;src:url("/fonts/poppins-400-latin.woff2") format("woff2")}
@font-face{font-family:Poppins;font-style:normal;font-weight:600;font-display:swap;src:url("/fonts/poppins-600-latin.woff2") format("woff2")}
@font-face{font-family:Poppins;font-style:normal;font-weight:700;font-display:swap;src:url("/fonts/poppins-700-latin.woff2") format("woff2")}
:root{
  color-scheme:dark;--bg:#122424;--panel:#1e3535;--panel-2:#243f3f;--panel-dark:#182d2d;
  --ink:#fff;--muted:#91c9ce;--faint:rgba(145,201,206,.75);--line:rgba(145,201,206,.18);--line-soft:rgba(145,201,206,.09);
  --orange:#fe3a02;--orange-soft:rgba(254,58,2,.14);--teal:#317b80;--ok:#4ec77a;--warn:#e8b04b;--danger:#e5604d;
  --font:Poppins,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 var(--font);-webkit-font-smoothing:antialiased}
::selection{background:var(--orange-soft)}
button,input{font:inherit}
button,a,input{-webkit-tap-highlight-color:transparent}
button,a{touch-action:manipulation}
button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid var(--orange);outline-offset:4px}
a{color:var(--muted);text-decoration:none}
a:hover{text-decoration:underline;color:var(--ink)}
a[aria-disabled=true]{color:var(--faint);cursor:default;pointer-events:none}
button{cursor:pointer}
button:disabled{cursor:wait;opacity:.6}
[hidden]{display:none!important}
.brand{display:flex;align-items:center;gap:12px}
.brand-mark{display:grid;place-items:center;width:42px;height:42px;border:1px solid var(--line);border-radius:10px;background:#173030;color:var(--orange);font-size:29px;font-weight:700;line-height:1}
.brand .wm{font-size:17px;font-weight:700;letter-spacing:.01em;line-height:1.2}
.brand .o{color:var(--orange)}
.brand .prod{margin-top:4px;color:var(--muted);font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase}
h1{margin:0;font-size:30px;font-weight:600;line-height:1.25;letter-spacing:-.035em}
h1::after{content:"";display:block;width:36px;height:3px;margin-top:12px;border-radius:2px;background:var(--orange)}
`;

export const ACTIVITY_BRAND = `<div class="brand"><span class="brand-mark" aria-hidden="true">#</span><div><div class="wm"><span class="o">#makeit</span>future<span class="o">.</span></div><div class="prod">ChannelGate</div></div></div>`;
