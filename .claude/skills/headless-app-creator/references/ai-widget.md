# AI Thinking Widget — Complete Reference

The standardized "Claude is working" indicator used across all headless app pages. It's a fixed pill at the bottom of the viewport that slides up with a spring animation when AI is processing, and fades out when done.

---

## HTML

Place this at the bottom of `<body>`, just before `</body>`, on every page:

```html
<!-- AI Working indicator -->
<div id="ai-status-bar" class="ai-status-bar" aria-live="polite" style="display:none">
  <div class="ai-status-inner">
    <div class="ai-orb">
      <div class="ai-orb-dot"></div>
      <div class="ai-orb-ring"></div>
      <div class="ai-orb-ring"></div>
    </div>
    <div class="ai-bars">
      <span></span><span></span><span></span><span></span><span></span><span></span>
    </div>
    <span id="ai-status-text" class="ai-status-text">Claude is thinking…</span>
  </div>
</div>
```

**Why `aria-live="polite"`:** Screen readers announce text changes without interrupting, so users with assistive tech get the status update without being disrupted.

**Why `style="display:none"`:** The bar is off-DOM until needed. The JS utility sets `display: ""` first, then adds `.active` in the next animation frame — this ensures the CSS transition fires (transitions don't fire on elements that were `display:none`).

---

## CSS

Add this entire block to your shared `styles.css`:

```css
/* ─── AI Working Status Bar ─────────────────────────────────────────────────── */
.ai-status-bar {
  position: fixed;
  bottom: 36px;
  left: 50%;
  transform: translateX(-50%) translateY(120px);
  z-index: 9999;
  opacity: 0;
  transition: transform 380ms cubic-bezier(0.34, 1.46, 0.64, 1), opacity 220ms ease;
  pointer-events: none;
}

.ai-status-bar.active {
  transform: translateX(-50%) translateY(0);
  opacity: 1;
}

.ai-status-inner {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 13px 24px 13px 18px;
  background: rgba(16, 22, 16, 0.92);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-radius: 999px;
  border: 1px solid rgba(15, 118, 110, 0.4);
  box-shadow:
    0 12px 40px rgba(0, 0, 0, 0.28),
    0 0 0 1px rgba(15, 118, 110, 0.12),
    0 0 24px rgba(15, 118, 110, 0.12) inset;
  color: #c8e8e5;
  font-size: 0.875rem;
  font-weight: 500;
  letter-spacing: 0.01em;
  white-space: nowrap;
}

/* Pulsing orb */
.ai-orb {
  position: relative;
  width: 10px;
  height: 10px;
  flex-shrink: 0;
}

.ai-orb-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #4dd9cc, #0f766e);
  box-shadow: 0 0 8px rgba(15, 118, 110, 0.8);
  position: relative;
  z-index: 1;
}

.ai-orb-ring {
  position: absolute;
  inset: -5px;
  border-radius: 50%;
  border: 1.5px solid rgba(15, 118, 110, 0.7);
  animation: ai-ring-expand 1.8s ease-out infinite;
}

.ai-orb-ring:nth-child(3) {
  animation-delay: 0.9s;
}

@keyframes ai-ring-expand {
  0%   { transform: scale(1);   opacity: 0.8; }
  100% { transform: scale(2.8); opacity: 0; }
}

/* Waveform bars */
.ai-bars {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 20px;
}

.ai-bars span {
  display: block;
  width: 3px;
  border-radius: 2px;
  background: linear-gradient(180deg, #4dd9cc, #0f766e);
  animation: ai-bar-wave 1s ease-in-out infinite;
  transform-origin: bottom center;
}

.ai-bars span:nth-child(1) { animation-delay: 0.00s; animation-duration: 0.90s; }
.ai-bars span:nth-child(2) { animation-delay: 0.13s; animation-duration: 1.00s; }
.ai-bars span:nth-child(3) { animation-delay: 0.26s; animation-duration: 0.85s; }
.ai-bars span:nth-child(4) { animation-delay: 0.39s; animation-duration: 1.05s; }
.ai-bars span:nth-child(5) { animation-delay: 0.52s; animation-duration: 0.95s; }
.ai-bars span:nth-child(6) { animation-delay: 0.65s; animation-duration: 0.88s; }

@keyframes ai-bar-wave {
  0%, 100% { height: 4px;  opacity: 0.35; }
  50%       { height: 20px; opacity: 1;    }
}

/* Shimmer text */
.ai-status-text {
  background: linear-gradient(
    90deg,
    #c8e8e5 0%,
    #4dd9cc 40%,
    #c8e8e5 60%,
    #c8e8e5 100%
  );
  background-size: 250% 100%;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: ai-shimmer 2.4s ease-in-out infinite;
}

@keyframes ai-shimmer {
  0%   { background-position: 200% 0;  }
  100% { background-position: -200% 0; }
}
```

---

## JavaScript (utils.js)

```js
// ─── AI Working indicator ────────────────────────────────────────────────────
let _aiWorkingTimer = null;

export function showAiWorking(text = "Claude is thinking…") {
  const bar = document.getElementById("ai-status-bar");
  const textEl = document.getElementById("ai-status-text");
  if (!bar || !textEl) return;

  clearTimeout(_aiWorkingTimer);
  textEl.textContent = text;
  bar.style.display = "";
  // Double rAF: first frame takes element off display:none, second fires transition
  requestAnimationFrame(() => {
    requestAnimationFrame(() => bar.classList.add("active"));
  });
}

export function hideAiWorking() {
  const bar = document.getElementById("ai-status-bar");
  if (!bar) return;
  clearTimeout(_aiWorkingTimer);
  bar.classList.remove("active");
  // Wait for transition to finish before hiding from layout
  _aiWorkingTimer = setTimeout(() => { bar.style.display = "none"; }, 350);
}
```

---

## Usage pattern

```js
import { showAiWorking, hideAiWorking } from "./utils.js";

async function sendMessage() {
  showAiWorking("Claude is thinking…");
  try {
    // ... fetch / stream
    showAiWorking("Claude is writing…"); // update text mid-stream if desired
  } finally {
    hideAiWorking(); // always hide, even on error
  }
}
```

**Updating text mid-flight:** Call `showAiWorking("new text")` again at any point — it resets the timer and updates the label without re-triggering the slide animation.

**Customizing the text:** Pass task-specific labels like `"Generating section 3…"`, `"Analyzing files…"`, `"Running verification…"` to give users a meaningful status rather than a generic indicator.
