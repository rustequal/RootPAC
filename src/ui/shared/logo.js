export const LOGO = `<svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden="true">
  <rect x="1.5" y="1.5" width="29" height="29" rx="9" fill="#1b1f26" stroke="#2c323d"/>
  <path d="M9 22V10h6a3.5 3.5 0 0 1 0 7h-2l4.5 5" stroke="#6aa2ff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="23" cy="11.5" r="2.4" fill="#7ddfa0"/>
</svg>`;

export function header(title) {
  const node = document.createElement("header");
  node.innerHTML = LOGO;
  const heading = document.createElement("h1");
  heading.textContent = title;
  node.append(heading);
  return node;
}
